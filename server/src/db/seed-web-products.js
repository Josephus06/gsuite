// Seeds the four common products the quote site opens with: Flyers, Menu (Sintra Board),
// Picture Frame (Wood), Yearbook.
//
// Each is a pointer at real ERP data -- a job type, a costing-bracketed process, and a material
// -- so the site prices through shared/costing.js exactly as the estimate wizard does. Nothing
// here invents a price.
//
// RESOLVED BY NAME, NEVER BY HARD-CODED ID. Process and item ids differ between this database and
// Railway, and a seed carrying literal ids would quietly point at the wrong process in
// production. Anything that cannot be resolved is reported and left unpublished rather than
// guessed at -- an unpublished product is invisible to the site, so a half-configured product
// cannot reach a customer.
//
// Products are seeded UNPUBLISHED. Publishing is a decision for whoever checks the prices look
// right, made from the admin screen, not a side effect of running a script.
//
// IDEMPOTENT: matches on slug and leaves an existing product alone.
//
//   node src/db/seed-web-products.js --dry-run
//   node src/db/seed-web-products.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

// `processMatch` / `itemMatch` are LIKE patterns tried in order; the first hit wins.
const PRODUCTS = [
  {
    slug: 'flyers', name: 'Flyers', tagline: 'Short-run flyers, printed sharp',
    description: 'Full-colour flyers on coated stock. Choose your size and quantity and the price updates as you go.',
    jobType: ['%SMALL FORMAT%', '%DIGITAL%', '%PRINT%'],
    defaultQty: 100, minQty: 50, maxQty: 10000, leadTime: 3,
    lines: [
      { label: 'Printing', processMatch: ['DPOD - Printing Toner - 4/4', 'Branch - Printing Toner - 4/4'],
        itemMatch: ['%C2S%', '%BOOK PAPER%', '%SUBSTANCE 20%'],
        qty: 100, length: 8.5, width: 11, uom: 'IN', minL: 3, maxL: 13, minW: 2, maxW: 19 },
    ],
  },
  {
    slug: 'menu-sintra-board', name: 'Menu (Sintra Board)', tagline: 'Rigid, wipe-clean menu boards',
    description: 'Menus mounted on Sintra board -- durable enough for daily service. Set the panel size and how many you need.',
    jobType: ['%SIGNAGE%', '%LARGE FORMAT%', '%MODULAR%'],
    defaultQty: 10, minQty: 1, maxQty: 500, leadTime: 5,
    lines: [
      { label: 'Printing', processMatch: ['DPOD - Printing Toner - 4/0', 'Branch - Printing Toner - 4/0'],
        itemMatch: ['%SINTRA%', '%PVC%'],
        qty: 10, length: 11, width: 17, uom: 'IN', minL: 6, maxL: 48, minW: 6, maxW: 96 },
    ],
  },
  {
    slug: 'picture-frame-wood', name: 'Picture Frame (Wood)', tagline: 'Solid wood frames, made to size',
    description: 'Wooden frames cut to your dimensions. Tell us the size and quantity and see the price straight away.',
    jobType: ['%FRAME%', '%AWARD%', '%ACCESSORIES%'],
    defaultQty: 1, minQty: 1, maxQty: 200, leadTime: 7,
    lines: [
      { label: 'Frame', processMatch: ['%Frame%', '%Fabrication%', '%Installation%'],
        itemMatch: ['%WOOD%', '%PLY%'],
        qty: 1, length: 12, width: 16, uom: 'IN', minL: 4, maxL: 60, minW: 4, maxW: 60 },
    ],
  },
  {
    slug: 'yearbook', name: 'Yearbook', tagline: 'Bound yearbooks, start to finish',
    description: 'Perfect-bound yearbooks printed and finished in house. Set your page count and copies.',
    jobType: ['%SMALL FORMAT%', '%BOOK%', '%DIGITAL%'],
    defaultQty: 50, minQty: 10, maxQty: 5000, leadTime: 21,
    lines: [
      { label: 'Printing', processMatch: ['DPOD - Printing Toner - 4/4', 'Branch - Printing Toner - 4/4'],
        itemMatch: ['%BOOK PAPER%', '%C2S%'],
        qty: 50, length: 8.5, width: 11, uom: 'IN', minL: 5, maxL: 12, minW: 5, maxW: 17 },
    ],
  },
];

async function findFirst(sql, patterns) {
  for (const p of patterns) {
    const [[row]] = await pool.query(sql, [p]);
    if (row) return row;
  }
  return null;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const [[dept]] = await pool.query("SELECT id FROM departments WHERE name = 'Marketing' LIMIT 1");
  const [[div]] = await pool.query("SELECT id FROM sales_divisions WHERE name = 'Marketing' LIMIT 1");
  if (!dept || !div) console.log('!! Marketing department/division missing -- quotes will save without one.');

  for (const p of PRODUCTS) {
    const [[exists]] = await pool.query('SELECT id FROM web_products WHERE slug = ?', [p.slug]);
    if (exists) { console.log(`${p.slug.padEnd(22)} already present (id ${exists.id}) -- left alone.`); continue; }

    const jobType = await findFirst(
      'SELECT id, display_name FROM job_types WHERE display_name LIKE ? AND is_active = 1 LIMIT 1', p.jobType);

    const resolved = [];
    const problems = [];
    for (const l of p.lines) {
      // Only a process that actually has costing brackets can be priced; one without would return
      // a null price and read as free.
      const proc = await findFirst(
        `SELECT p.id, p.process_name FROM processes p
          WHERE p.process_name LIKE ? AND EXISTS(SELECT 1 FROM process_cost_brackets b WHERE b.process_id = p.id)
          ORDER BY p.id LIMIT 1`, l.processMatch);
      const item = await findFirst(
        `SELECT id, display_name FROM inventories
          WHERE display_name LIKE ? AND (item_type IS NULL OR item_type NOT IN ('Service','Non-Inventory','Landed Cost','Discount'))
          ORDER BY id LIMIT 1`, l.itemMatch);
      if (!proc) problems.push(`no bracketed process matching ${l.processMatch[0]}`);
      if (!item) problems.push(`no material matching ${l.itemMatch[0]}`);
      resolved.push({ ...l, proc, item });
    }

    console.log(`${p.slug.padEnd(22)} job type: ${jobType ? jobType.display_name : 'NONE'}`);
    for (const r of resolved) {
      console.log(`  ${String(r.label).padEnd(10)} process: ${r.proc ? r.proc.process_name.slice(0, 40) : 'NONE'}`
        + ` | material: ${r.item ? r.item.display_name.slice(0, 34) : 'NONE'}`);
    }
    if (problems.length) console.log(`  !! ${problems.join('; ')} -- seeded unpublished.`);

    if (DRY_RUN) continue;

    const [ins] = await pool.query(
      `INSERT INTO web_products
         (slug, name, tagline, description, job_type_id, sales_division_id, department_id,
          default_qty, min_qty, max_qty, lead_time_days, sort_order, is_published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [p.slug, p.name, p.tagline, p.description, jobType?.id || null,
        div?.id || null, dept?.id || null,
        p.defaultQty, p.minQty, p.maxQty, p.leadTime, PRODUCTS.indexOf(p)]
    );
    let lineNo = 1;
    for (const r of resolved) {
      await pool.query(
        `INSERT INTO web_product_lines
           (web_product_id, line_no, label, process_id, item_id, default_process_qty, default_qty,
            default_length, default_width, uom, allow_qty, allow_size,
            min_length, max_length, min_width, max_width)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        [ins.insertId, lineNo, r.label, r.proc?.id || null, r.item?.id || null,
          r.qty, r.qty, r.length, r.width, r.uom, r.minL, r.maxL, r.minW, r.maxW]
      );
      lineNo += 1;
    }
    console.log(`  -> created (id ${ins.insertId}), unpublished.`);
  }

  const [[n]] = await pool.query('SELECT COUNT(*) AS n, SUM(is_published) AS pub FROM web_products');
  console.log(`\nweb_products: ${n.n} total, ${Number(n.pub || 0)} published.`);
  console.log('Publish from Master Lists once the prices look right.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
