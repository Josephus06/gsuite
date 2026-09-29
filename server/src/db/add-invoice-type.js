// Adds sales_invoices.invoice_type: 'SI' (Sales / Service Invoice) or 'DR' (Delivery Receipt).
//
// The source system types every invoice (Type_TransH: si / dr / bs) and the migration dropped it,
// so every invoice here read "SI". The type matters because a DR is not a BIR-registered sales
// invoice: it is left out of the BIR Sales Report and prints on plain paper only.
//
// 'bs' (Billing Statement) is stored as SI: the business replaced its billing statement with the
// pre-printed Service Invoice, and the two are the same document under an older name.
// Delivery Tickets are their own module and are untouched here.
//
// Must run on each database BEFORE the code that reads the column serves there -- the invoice
// list selects si.invoice_type. Droplet and office replicate: run on ONE of them. Railway: its own.
//
//   node src/db/add-invoice-type.js                 add the column (+ index)
//   node src/db/add-invoice-type.js --from-source   also label existing invoices from the source
//                                                   system's Type_TransH (read-only there)
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const FROM_SOURCE = process.argv.includes('--from-source');

async function hasColumn(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return r.n > 0;
}
async function hasIndex(table, index) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index]);
  return r.n > 0;
}

// Every invoice number the source system types 'dr'. The list is newest-first; paged to the end
// rather than stopped at a date, because a relabel has to reach the oldest DR too.
async function sourceDrNumbers() {
  const username = process.env.LIVE_SITE_USERNAME;
  const password = process.env.LIVE_SITE_PASSWORD;
  if (!username || !password) throw new Error('LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD are not configured.');
  const login = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  const token = (await login.json())?.data?.token;
  if (!token) throw new Error('Source system login failed.');

  const dr = new Set();
  const counts = {};
  for (let offset = 0; ; offset += 200) {
    let rows = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const r = await fetch(`${SITE}/api/get_invoices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ searchKey: '', limit: 200, offset }),
        });
        const j = await r.json();
        rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (j?.data || []);
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
    if (!rows.length) break;
    for (const x of rows) {
      const t = String(x.Type_TransH || '').toLowerCase();
      counts[t] = (counts[t] || 0) + 1;
      if (t === 'dr' && x.invc_pk) dr.add(String(x.invc_pk));
    }
    if (offset % 10000 === 0) console.log(`  read ${offset + rows.length} source invoices...`);
  }
  console.log('  source types:', counts);
  return [...dr];
}

async function main() {
  console.log(`DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  if (await hasColumn('sales_invoices', 'invoice_type')) {
    console.log('  sales_invoices.invoice_type already exists -- skipped.');
  } else {
    await pool.query(
      "ALTER TABLE sales_invoices ADD COLUMN invoice_type VARCHAR(2) NOT NULL DEFAULT 'SI', ALGORITHM=INSTANT"
    );
    console.log("  sales_invoices.invoice_type added (every existing invoice reads 'SI').");
  }
  if (!(await hasIndex('sales_invoices', 'idx_sales_invoices_invoice_type'))) {
    await pool.query('CREATE INDEX idx_sales_invoices_invoice_type ON sales_invoices (invoice_type)');
    console.log('  index idx_sales_invoices_invoice_type added.');
  }

  if (FROM_SOURCE) {
    const drNos = await sourceDrNumbers();
    let labelled = 0;
    for (let i = 0; i < drNos.length; i += 500) {
      const chunk = drNos.slice(i, i + 500);
      const [r] = await pool.query(
        "UPDATE sales_invoices SET invoice_type = 'DR' WHERE invoice_no IN (?) AND invoice_type <> 'DR'", [chunk]);
      labelled += r.affectedRows;
    }
    console.log(`  ${drNos.length} DR invoice(s) in the source; ${labelled} relabelled DR here.`);
  }

  const [types] = await pool.query('SELECT invoice_type, COUNT(*) AS n FROM sales_invoices GROUP BY invoice_type');
  console.log('  now:', types.map((t) => `${t.invoice_type} ${t.n}`).join(', '));
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
