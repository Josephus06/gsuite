// Rebuilds the website catalogue from four real estimates the shop actually quoted.
//
// The first seed gave each product a single combined line, which is not how any of these jobs is
// costed. A real estimate is several process lines -- a layout fee, the printing, the cutting --
// each with its own process, material and unit. Priced as one line, a flyer job loses the layout
// fee and the cutting entirely, so the customer is quoted less than the work costs.
//
// Reference estimates (live), read line by line rather than transcribed from a screenshot:
//   A5 Flyers        EST-75531   5,541.76   3 lines
//   Glossy Menu      EST-107164  4,727.00   3 lines
//   Picture Frame    EST-104295    565.01   9 lines
//
// Lighted Store Signage (EST-14662) is deliberately NOT rebuilt. Its total is 59,467.00 but the
// ledger returns a single SITE INSPECTION line priced at zero, so whatever carries that value is
// not in the lines this reads. Modelling it from what came back would produce a product that
// quotes a few hundred pesos for a sixty-thousand-peso signage job. It stays as it is, unpublished.
//
// Processes and materials are matched BY NAME against the local masters, never by id -- ids
// differ between this database and Railway. Whitespace is normalised first because several live
// process names contain embedded newlines ("Branch - Cutting Manual - Easy\n - Lot").
//
// A line whose process has no costing brackets prices at zero, so those are reported and the
// product is left unpublished rather than quietly offering free work.
//
//   node src/db/rebuild-web-products-from-reference.js --dry-run
//   node src/db/rebuild-web-products-from-reference.js
const pool = require('../db');
const { costing } = require('../lib/costing');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const round2 = (n) => Number((Number(n) || 0).toFixed(2));

// label, process name, material name, unit, default process qty / qty / size, and what the
// customer is allowed to change on that line.
const CATALOGUE = [
  {
    slug: 'flyers', name: 'A5 Flyers', reference: 'EST-75531',
    tagline: 'Full-colour A5 flyers, cut and ready',
    description: 'A5 flyers printed 4/4 on 148gsm gloss, trimmed to size. Set how many sheets you need.',
    jobType: 'DPOD-FLYERS', leadTime: 3, defaultQty: 38, minQty: 10, maxQty: 5000,
    lines: [
      { label: 'Layout fee', proc: 'Layout Fee - Standard', item: 'SERVICE LABOR', uom: 'LOT',
        procQty: 1, qty: 1, allowQty: 0, allowSize: 0 },
      { label: 'Printing (4/4)', proc: 'Branch - Printing Toner - 4/4', item: 'IMARI 148 GSM GLOSSY 12.5" X 19"',
        uom: 'SHT', procQty: 38, qty: 38, allowQty: 1, allowSize: 0 },
      { label: 'Cutting', proc: 'Branch - Cutting Manual - Easy - Lot', item: 'SERVICE LABOR', uom: 'LOT',
        procQty: 2, qty: 2, allowQty: 0, allowSize: 0 },
    ],
  },
  {
    slug: 'menu-sintra-board', name: 'Glossy Menu', reference: 'EST-107164',
    tagline: 'Heavy gloss menus, printed one side',
    description: 'Menus printed 4/0 on 300gsm gloss stock and trimmed. Choose your quantity.',
    jobType: 'DPOD-MENU', leadTime: 5, defaultQty: 40, minQty: 10, maxQty: 2000,
    lines: [
      { label: 'Layout fee', proc: 'Layout Fee - Standard', item: 'SERVICE LABOR', uom: 'LOT',
        procQty: 2, qty: 2, allowQty: 0, allowSize: 0 },
      { label: 'Printing (4/0)', proc: 'Branch - Printing Toner - 4/0', item: 'IMARI 300 GSM GLOSSY 12.5" X 19"',
        uom: 'SHT', procQty: 40, qty: 40, allowQty: 1, allowSize: 0 },
      { label: 'Cutting', proc: 'DPOD - Cutting Manual', item: 'SERVICE LABOR', uom: 'LOT',
        procQty: 40, qty: 40, allowQty: 1, allowSize: 0 },
    ],
  },
  {
    slug: 'picture-frame-wood', name: 'Picture Frame', reference: 'EST-104295',
    tagline: 'Framed prints, cut to your size',
    description: 'A printed piece mounted and framed to your dimensions, with acrylic front and hanger fitted.',
    jobType: 'SIGN-CANVAS FRAME', leadTime: 7, defaultQty: 1, minQty: 1, maxQty: 100,
    // Size drives the laser cutting and the assembly lines, so those take the customer's
    // dimensions; the fixed-cost fittings do not.
    lines: [
      { label: 'Layout fee', proc: 'Layout Fee - Standard', item: 'SERVICE LABOR', uom: 'LOT',
        procQty: 1, qty: 1, allowQty: 0, allowSize: 0 },
      { label: 'Printing', proc: 'DPOD - Printing Toner - 4/0', item: 'SYMBOL FREELIFE RASTER 200GSM 13" X 19"',
        uom: 'SHT', procQty: 1, qty: 1, allowQty: 1, allowSize: 0 },
      { label: 'Acrylic front', proc: 'Signage-Cutting Laser-1.5mm Thickness-Size 8.0"', item: 'ACRYLIC CLEAR 1.5 MM 4\'X6\'',
        uom: 'CM', procQty: 1, qty: 1, length: 34.3, width: 25.7, allowQty: 0, allowSize: 1,
        minL: 10, maxL: 120, minW: 10, maxW: 120 },
      { label: 'Frame moulding', proc: 'Signage - Assembling (Lot) - Standard', item: 'SYNTHETIC POLYSTYRENE 8008M 9.5FT',
        uom: 'CM', procQty: 1, qty: 1, length: 34.3, allowQty: 0, allowSize: 1, minL: 10, maxL: 120 },
      { label: 'Backing board', proc: 'Signage - Assembling (Sqft)', item: 'SINTRALITE WHITE 4\'X8\' 1.5 MM',
        uom: 'CM', procQty: 1, qty: 1, length: 34.3, width: 25.7, allowQty: 0, allowSize: 1,
        minL: 10, maxL: 120, minW: 10, maxW: 120 },
      { label: 'Corner fixings', proc: 'Signage - Assembling (Lot) - Standard', item: 'ALFA V-NAILS 15MM (2,000PCS/BOX)',
        uom: 'PC', procQty: 1, qty: 1, allowQty: 0, allowSize: 0 },
      { label: 'Edge tape', proc: 'Signage - Assembling (Lot) - Standard', item: 'KRAFT PAPER TAPE 30MM X 30METERS',
        uom: 'IN', procQty: 1, qty: 1, length: 13.5, allowQty: 0, allowSize: 0 },
      { label: 'Hanger', proc: 'Signage - Assembling (Lot) - Standard', item: 'HOOK FRAME HANGER SAWTOOTH 40CM',
        uom: 'PC', procQty: 1, qty: 1, allowQty: 0, allowSize: 0 },
    ],
  },
];

async function findProcess(name) {
  const [rows] = await pool.query('SELECT id, process_name FROM processes');
  const want = norm(name);
  return rows.find((p) => norm(p.process_name) === want)
    // Live and local occasionally differ by a trailing qualifier; fall back to a prefix match
    // rather than dropping the line, but only when exactly one candidate matches.
    || (rows.filter((p) => norm(p.process_name).startsWith(want.slice(0, 28))).length === 1
      ? rows.find((p) => norm(p.process_name).startsWith(want.slice(0, 28))) : null)
    || null;
}

async function findItem(name) {
  const [[exact]] = await pool.query('SELECT id, display_name FROM inventories WHERE display_name = ? LIMIT 1', [name]);
  if (exact) return exact;
  const [[like]] = await pool.query(
    'SELECT id, display_name FROM inventories WHERE display_name LIKE ? ORDER BY id LIMIT 1', [`${name.slice(0, 24)}%`]);
  return like || null;
}

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  const { computeAutoPricing } = await costing();
  const [[dept]] = await pool.query("SELECT id FROM departments WHERE name = 'Marketing' LIMIT 1");
  const [[div]] = await pool.query("SELECT id FROM sales_divisions WHERE name = 'Marketing' LIMIT 1");

  for (const p of CATALOGUE) {
    console.log(`== ${p.name}  (reference ${p.reference})`);
    const [[jt]] = await pool.query('SELECT id, display_name FROM job_types WHERE display_name = ? LIMIT 1', [p.jobType]);
    if (!jt) console.log(`   !! job type ${JSON.stringify(p.jobType)} not found -- left unset`);

    const resolved = [];
    const problems = [];
    for (const l of p.lines) {
      const proc = await findProcess(l.proc);
      const item = await findItem(l.item);
      if (!proc) problems.push(`no process matching ${JSON.stringify(l.proc)}`);
      if (!item) problems.push(`no material matching ${JSON.stringify(l.item)}`);

      let brackets = [];
      if (proc) {
        [brackets] = await pool.query('SELECT * FROM process_cost_brackets WHERE process_id = ? ORDER BY qty_min', [proc.id]);
        if (!brackets.length) problems.push(`${proc.process_name.replace(/\s+/g, ' ')} has no costing brackets`);
      }
      const [[inv]] = item ? await pool.query('SELECT * FROM inventories WHERE id = ?', [item.id]) : [[null]];
      const price = round2((computeAutoPricing({
        brackets, inventory: inv || null, processQty: l.procQty, qty: l.qty,
        length: l.length, width: l.width, uom: l.uom,
      }) || {}).total_price);

      console.log(`   ${String(l.label).padEnd(16)} ${price.toFixed(2).padStart(10)}`
        + `  proc=${proc ? 'ok' : 'MISSING'} item=${item ? 'ok' : 'MISSING'}`
        + `${brackets.length ? '' : ' NO-BRACKETS'}`);
      resolved.push({ ...l, procId: proc?.id || null, itemId: item?.id || null, price });
    }

    const total = round2(resolved.reduce((s, r) => s + r.price, 0));
    console.log(`   TOTAL ${total.toFixed(2)}`);
    if (problems.length) console.log(`   !! ${problems.join('; ')}`);

    if (DRY_RUN) { console.log(''); continue; }

    const [[existing]] = await pool.query('SELECT id FROM web_products WHERE slug = ?', [p.slug]);
    let id = existing?.id;
    if (id) {
      await pool.query(
        `UPDATE web_products SET name=?, tagline=?, description=?, job_type_id=?, sales_division_id=?,
                department_id=?, default_qty=?, min_qty=?, max_qty=?, lead_time_days=?, is_published=0
          WHERE id=?`,
        [p.name, p.tagline, p.description, jt?.id || null, div?.id || null, dept?.id || null,
          p.defaultQty, p.minQty, p.maxQty, p.leadTime, id]
      );
      // Replaced wholesale: the old single-line shape has no correspondence to the new one, so
      // there is nothing to merge. Unpublished above first, so the site never serves a
      // half-rebuilt product.
      await pool.query('DELETE FROM web_product_lines WHERE web_product_id = ?', [id]);
    } else {
      const [ins] = await pool.query(
        `INSERT INTO web_products (slug, name, tagline, description, job_type_id, sales_division_id,
            department_id, default_qty, min_qty, max_qty, lead_time_days, sort_order, is_published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [p.slug, p.name, p.tagline, p.description, jt?.id || null, div?.id || null, dept?.id || null,
          p.defaultQty, p.minQty, p.maxQty, p.leadTime, CATALOGUE.indexOf(p)]
      );
      id = ins.insertId;
    }

    let n = 1;
    for (const r of resolved) {
      await pool.query(
        `INSERT INTO web_product_lines
           (web_product_id, line_no, label, process_id, item_id, default_process_qty, default_qty,
            default_length, default_width, uom, allow_qty, allow_size, min_length, max_length, min_width, max_width)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, n, r.label, r.procId, r.itemId, r.procQty, r.qty, r.length ?? null, r.width ?? null,
          r.uom, r.allowQty, r.allowSize, r.minL ?? null, r.maxL ?? null, r.minW ?? null, r.maxW ?? null]
      );
      n += 1;
    }
    console.log(`   -> saved (id ${id}), ${resolved.length} lines, unpublished\n`);
  }

  const [rows] = await pool.query(
    `SELECT p.name, p.is_published, (SELECT COUNT(*) FROM web_product_lines l WHERE l.web_product_id = p.id) AS line_count
       FROM web_products p ORDER BY p.sort_order`
  );
  console.log('catalogue now:');
  rows.forEach((r) => console.log(`  ${r.name.padEnd(24)} ${r.line_count} line(s)  ${r.is_published ? 'PUBLISHED' : 'draft'}`));
  console.log('\nCheck the Preview Price in Master Lists > Website Products, then publish.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
