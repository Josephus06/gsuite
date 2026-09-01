const express = require('express');
const pool = require('../db');
const { upperCustomerName } = require('../lib/customerName');
const { costing } = require('../lib/costing');

const router = express.Router();

// The API behind the customer-facing quote site (separate repo, gsuite_web, separate domain).
//
// UNAUTHENTICATED BY DESIGN -- these are the only routes in this app a stranger may call, so the
// surface is deliberately tiny and read-mostly:
//
//   GET  /api/public/products        published catalog + each product's editable defaults
//   POST /api/public/products/:slug/price   price one configuration (no writes)
//   POST /api/public/quotes          save it as a real estimate
//
// It never exposes cost. A customer sees prices and totals; the costing brackets, material costs
// and GP that produce them stay inside the ERP. Nothing here accepts a process or material id
// from the caller either -- the configuration is looked up from web_product_lines and only the
// customer-editable numbers (size, quantity) are taken from the request. Otherwise anyone could
// post a quote against any process in the system at any size.
//
// Pricing runs through shared/costing.js, the same module the estimate wizard imports, so a
// customer's quote and an in-house estimate for identical inputs cannot disagree.

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

// Clamps a customer-supplied number to the range the catalog allows, falling back to the default
// when it is missing or not a number. A quote request is public input: it gets bounded here
// rather than trusted.
function clamp(value, fallback, min, max) {
  // null and '' both coerce to 0 through Number(), which is finite -- so without this check a
  // field the caller simply did not send became a real zero and was clamped up to the minimum,
  // quietly replacing the product's default. The menu defaulted to 10 instead of 40 that way.
  if (value === null || value === undefined || value === '') return num(fallback);
  const n = Number(value);
  if (!Number.isFinite(n)) return num(fallback);
  let out = n;
  if (min !== null && min !== undefined && out < Number(min)) out = Number(min);
  if (max !== null && max !== undefined && out > Number(max)) out = Number(max);
  return out;
}

async function loadProduct(slug) {
  const [[product]] = await pool.query(
    `SELECT p.*, jt.display_name AS job_type_name,
            loc.location_name, t.code AS tax_code, t.rate AS tax_rate
       FROM web_products p
       LEFT JOIN job_types jt ON jt.id = p.job_type_id
       LEFT JOIN locations loc ON loc.id = p.office_location_id
       LEFT JOIN taxes t ON t.id = p.tax_id
      WHERE p.slug = ? AND p.is_published = 1`, [slug]
  );
  if (!product) return null;
  const [lines] = await pool.query(
    `SELECT l.*, pr.process_name AS process_name, i.display_name AS item_name, u.code AS item_unit_code
       FROM web_product_lines l
       LEFT JOIN processes pr ON pr.id = l.process_id
       LEFT JOIN inventories i ON i.id = l.item_id
       LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
      WHERE l.web_product_id = ?
      ORDER BY l.line_no, l.id`, [product.id]
  );
  return { product, lines };
}

// Prices one configuration of a product. Returns per-line prices and a total, and nothing about
// what any of it costs to make.
async function priceConfiguration(product, lines, requested, headerQty) {
  const { computeAutoPricing } = await costing();
  const byLineId = new Map((Array.isArray(requested) ? requested : []).map((r) => [Number(r.line_id), r]));

  const priced = [];
  let total = 0;
  for (const line of lines) {
    const req = byLineId.get(Number(line.id)) || {};

    // Only the fields the catalog marks editable are taken from the caller; everything else comes
    // from the stored default.
    const qty = line.allow_qty ? clamp(req.qty, line.default_qty, 0, null) : num(line.default_qty);
    const length = line.allow_size
      ? clamp(req.length, line.default_length, line.min_length, line.max_length) : num(line.default_length);
    const width = line.allow_size
      ? clamp(req.width, line.default_width, line.min_width, line.max_width) : num(line.default_width);
    const processQty = line.allow_qty ? clamp(req.process_qty, line.default_process_qty, 0, null) : num(line.default_process_qty);

    const [brackets] = line.process_id
      ? await pool.query('SELECT * FROM process_cost_brackets WHERE process_id = ? ORDER BY qty_min', [line.process_id])
      : [[]];
    const [[inventory]] = line.item_id
      ? await pool.query('SELECT * FROM inventories WHERE id = ?', [line.item_id])
      : [[null]];

    const computed = computeAutoPricing({
      brackets, inventory: inventory || null,
      processQty, qty, length, width, uom: line.uom,
    }) || {};

    const linePrice = round2(computed.total_price);
    total += linePrice;
    priced.push({
      line_id: line.id,
      line_no: line.line_no,
      label: line.label || line.process_name || line.item_name,
      // Process names in the master carry embedded newlines; collapse them so the table stays on
      // one row per line.
      process_name: (line.process_name || '').replace(/\s+/g, ' ').trim() || null,
      process_uom: line.uom || null,
      category: null,
      parts: null,
      item_name: line.item_name || null,
      unit: line.uom || line.item_unit_code || null,
      allow_qty: !!line.allow_qty,
      allow_size: !!line.allow_size,
      min_length: line.min_length, max_length: line.max_length,
      min_width: line.min_width, max_width: line.max_width,
      // Echoed back as applied, so the site shows what was actually used after clamping rather
      // than what was asked for.
      qty, length, width, process_qty: processQty,
      price: linePrice,
    });
  }

  // The header block, laid out like the ERP's own estimate table so a customer and the sales team
  // are reading the same document. Qty is the finished-piece count the customer asks for; the
  // per-unit price falls out of the work, it is not a rate anyone types in.
  const qty = clamp(headerQty, product.default_qty, product.min_qty, product.max_qty) || 1;
  const subtotal = round2(total);
  const taxRate = Number(product.tax_rate || 0);
  const taxAmount = round2(subtotal * taxRate / 100);

  return {
    lines: priced,
    total: subtotal,
    header: {
      job_type: product.job_type_name || null,
      description: product.name,
      qty,
      units: 'PC/S',
      price_per_unit: round2(subtotal / qty),
      subtotal,
      // No discounting on a self-service quote -- a discount is a decision someone makes, so the
      // columns are shown at zero rather than being offered to the customer.
      disc_percent: 0,
      disc_amount: 0,
      disc_price_per_unit: round2(subtotal / qty),
      net_of_tax: subtotal,
      tax_code: product.tax_code || null,
      tax_amount: taxAmount,
      gross_amount: round2(subtotal + taxAmount),
    },
  };
}

// --- catalog -----------------------------------------------------------------------------
router.get('/products', async (req, res, next) => {
  try {
    const [products] = await pool.query(
      `SELECT p.id, p.slug, p.name, p.tagline, p.description, p.image_url,
              p.default_qty, p.min_qty, p.max_qty, p.lead_time_days, jt.display_name AS job_type_name
         FROM web_products p
         LEFT JOIN job_types jt ON jt.id = p.job_type_id
        WHERE p.is_published = 1
        ORDER BY p.sort_order, p.name`
    );
    res.json(products);
  } catch (err) { next(err); }
});

router.get('/products/:slug', async (req, res, next) => {
  try {
    const found = await loadProduct(req.params.slug);
    if (!found) return res.status(404).json({ error: 'Product not found' });
    const priced = await priceConfiguration(found.product, found.lines, [], null);
    const { product } = found;
    return res.json({
      slug: product.slug, name: product.name, tagline: product.tagline,
      description: product.description, image_url: product.image_url,
      lead_time_days: product.lead_time_days,
      default_qty: product.default_qty, min_qty: product.min_qty, max_qty: product.max_qty,
      ...priced,
    });
  } catch (err) { return next(err); }
});

// --- live pricing ------------------------------------------------------------------------
router.post('/products/:slug/price', async (req, res, next) => {
  try {
    const found = await loadProduct(req.params.slug);
    if (!found) return res.status(404).json({ error: 'Product not found' });
    const priced = await priceConfiguration(found.product, found.lines, req.body?.lines, req.body?.qty);
    return res.json(priced);
  } catch (err) { return next(err); }
});

// --- submit ------------------------------------------------------------------------------
//
// Saves the configuration as a real estimate. It is priced again here from the stored catalog
// rather than trusting the total the browser sends -- the client's figure is a display, not an
// input.
//
// The estimate lands in For CSA Assignment with no sales rep: nobody took this enquiry, so there
// is no one to attribute it to until the Marketing Manager assigns someone.
router.post('/quotes', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { slug, lines, contact } = req.body || {};
    const name = (contact?.name || '').trim();
    const email = (contact?.email || '').trim();
    if (!slug) return res.status(400).json({ error: 'Choose a product first.' });
    if (!name) return res.status(400).json({ error: 'Your name is required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });

    const found = await loadProduct(slug);
    if (!found) return res.status(404).json({ error: 'Product not found' });
    const priced = await priceConfiguration(found.product, found.lines, lines, req.body?.qty);
    const { product } = found;

    await conn.beginTransaction();

    // Find the customer by the email on their contact record before creating one, so a returning
    // visitor does not spawn a duplicate customer on every quote. `customers` itself holds no
    // contact details -- name, email and phone live on customer_contacts -- so the lookup and the
    // insert both go through there.
    const company = (contact?.company || '').trim();
    const [[existing]] = await conn.query(
      `SELECT c.id FROM customers c
         JOIN customer_contacts cc ON cc.customer_id = c.id
        WHERE cc.email = ? ORDER BY c.id LIMIT 1`, [email]
    );
    let customerId = existing?.id || null;
    if (!customerId) {
      const [ins] = await conn.query(
        `INSERT INTO customers (name, company_name, sales_division_id, is_active, source)
         VALUES (?, ?, ?, TRUE, 'website')`,
        [upperCustomerName((company || name).slice(0, 255)), upperCustomerName(company.slice(0, 255)) || null,
          product.sales_division_id || null]
      );
      customerId = ins.insertId;
      await conn.query('UPDATE customers SET customer_code = ? WHERE id = ?', [`WEB-${customerId}`, customerId]);
      await conn.query(
        `INSERT INTO customer_contacts (customer_id, contact_name, email, phone, is_primary)
         VALUES (?, ?, ?, ?, TRUE)`,
        [customerId, name.slice(0, 255), email.slice(0, 255), (contact?.phone || '').slice(0, 50) || null]
      );
      if ((contact?.address || '').trim()) {
        await conn.query(
          `INSERT INTO customer_addresses (customer_id, address_type, address_line, is_default)
           VALUES (?, 'Billing', ?, TRUE)`,
          [customerId, contact.address.slice(0, 255)]
        );
      }
    }

    // The visitor's details go in the estimate's own contact fields, not buried in the memo --
    // whoever picks this up in For CSA Assignment needs someone to call.
    const description = `${product.name} - website quote for ${company || name}`;
    const [est] = await conn.query(
      `INSERT INTO estimates
         (estimate_no, date_created, customer_id, contract_description, production_lead_time,
          status, sales_division_id, web_source,
          contact_email, contact_phone, shipping_address,
          subtotal, net_of_tax, total_amount, memo)
       VALUES ('', CURDATE(), ?, ?, ?, 'for_csa_assignment', ?, 'website',
               ?, ?, ?, ?, ?, ?, ?)`,
      [customerId, description.slice(0, 255), product.lead_time_days || 0,
        product.sales_division_id || null,
        email.slice(0, 255), (contact?.phone || '').slice(0, 50) || null,
        (contact?.address || '').slice(0, 255) || null,
        priced.total, priced.total, priced.total,
        `Submitted from the website by ${name}.`]
    );
    const estimateId = est.insertId;
    await conn.query('UPDATE estimates SET estimate_no = ? WHERE id = ?', [`EST-W${estimateId}`, estimateId]);

    // One job-order line carrying the whole configuration, with the process/material detail
    // underneath it, so it opens in the ERP exactly like an estimate raised in-house.
    const [jo] = await conn.query(
      `INSERT INTO estimate_job_orders
         (estimate_id, line_no, job_type_id, description, quantity, units, price_per_unit,
          subtotal, net_of_tax, gross_amount)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [estimateId, product.job_type_id || null, product.name.slice(0, 255),
        num(product.default_qty) || 1, 'PCS',
        priced.total, priced.total, priced.total, priced.total]
    );

    let lineNo = 1;
    for (const p of priced.lines) {
      const src = found.lines.find((l) => Number(l.id) === Number(p.line_id));
      await conn.query(
        `INSERT INTO estimate_job_order_processes
           (estimate_job_order_id, line_no, process_id, item_id, process_qty, qty,
            length, width, uom, total_price, net_of_tax, gross_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jo.insertId, lineNo, src?.process_id || null, src?.item_id || null,
          p.process_qty, p.qty, p.length, p.width, p.unit, p.price, p.price, p.price]
      );
      lineNo += 1;
    }

    await conn.commit();
    return res.status(201).json({
      estimate_no: `EST-W${estimateId}`,
      total: priced.total,
      message: 'Your quotation has been received. A representative will be in touch shortly.',
    });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
