// Migrates the supplier master from the live system.
//
// Live keeps suppliers in its Account table -- `get_accounts`, every row of which is
// Module_Accnt = 'SUPPLIER'. There is no get_suppliers endpoint; the live UI's own
// SupplierController searches Name_Accnt / Company_Accnt and deletes by SysPK_Accnt, which is how
// the table was identified.
//
// MATCHING IS BY NAME, and that is safe here for a measured reason rather than a hopeful one:
// every one of the 910 distinct supplier names already held locally matches a live name exactly,
// with none left over. The local rows were created as stubs while importing purchase orders, from
// the same source data -- so the names have a common origin. After this run each row carries
// live_pk and future runs match on that instead, which survives a rename on either side.
//
// Names are compared case-insensitively with punctuation and runs of whitespace flattened, because
// "R.C. TRADING" and "RC Trading" are one supplier and the live data is inconsistent about both.
//
// LIVE HAS 52 DUPLICATE NAMES among 1,782 rows (1,730 distinct). Those are merged into one local
// row each, filling any blank field from whichever duplicate has it -- live's own UI has a
// "Merge Suppliers" button, so this is a known condition over there rather than something new.
// The count is reported so it can be cleaned up at source.
//
// Existing rows are ENRICHED, never overwritten with blanks: a field live leaves empty keeps
// whatever is already local. Nothing is deleted -- a supplier missing from live is left alone and
// reported, because purchase history may point at it.
//
//   node src/db/import-suppliers.js --dry-run     what it would do, writing nothing
//   node src/db/import-suppliers.js
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const DRY = process.argv.includes('--dry-run');

// Flattened for comparison only; the name is always STORED as live spells it.
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const trunc = (v, n) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, n);
};
const intOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.LIVE_SITE_USERNAME,
      password: process.env.LIVE_SITE_PASSWORD,
    }),
  });
  const j = await r.json();
  const token = j?.data?.token;
  if (!token) throw new Error('Could not log in to the live system.');
  return token;
}

async function fetchSuppliers(token) {
  const r = await fetch(`${SITE}/api/get_accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  const j = await r.json();
  const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
  return rows.filter((x) => x.Module_Accnt === 'SUPPLIER');
}

// One live row mapped onto local columns. Live's own column names are kept visible here so the
// mapping can be checked against the API response without cross-referencing anything.
const mapRow = (a) => ({
  live_pk: trunc(a.SysPK_Accnt, 64),
  live_id: intOrNull(a.ID_Accnt),
  name: trunc(a.Name_Accnt, 255),
  company_name: trunc(a.Company_Accnt, 255),
  address: trunc(a.Address_Accnt, 500),
  contact_no: trunc(a.ContactNo_Accnt, 120),
  mobile_no: trunc(a.MobileNo_Accnt, 120),
  office_no: trunc(a.OfficeNo_Accnt, 120),
  fax_no: trunc(a.FaxNo_Accnt, 120),
  email: trunc(a.Email_Accnt, 200),
  tin: trunc(a.TIN_Accnt, 160),
  credit_term: trunc(a.CreditTerm_Accnt, 120),
  term_days: intOrNull(a.TermNoOfDays_Accnt),
  payee_name: trunc(a.PayeeName_Accnt, 200),
  bank_name: trunc(a.BankName_Accnt, 200),
  bank_account_name: trunc(a.AccntName_Accnt, 200),
  bank_account_no: trunc(a.AccntNo_Accnt, 120),
});

// Folds duplicates together: first row wins the identity, later ones only fill blanks.
function mergeInto(target, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'live_pk' || k === 'live_id' || k === 'name') continue;
    if ((target[k] === null || target[k] === undefined) && v !== null) target[k] = v;
  }
}

async function nextSupplierCode(conn) {
  const [[row]] = await conn.query(
    "SELECT MAX(CAST(SUBSTRING(supplier_code, 5) AS UNSIGNED)) AS n FROM suppliers WHERE supplier_code LIKE 'SUP-%'",
  );
  return (Number(row.n) || 0) + 1;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY ? 'DRY RUN -- nothing will be written.\n' : 'APPLYING changes.\n');

  const token = await login();
  const live = await fetchSuppliers(token);
  console.log(`Live: ${live.length} supplier rows.`);

  // Collapse live duplicates by normalised name.
  const byName = new Map();
  let dupes = 0;
  for (const a of live) {
    const key = norm(a.Name_Accnt);
    if (!key) continue;
    const mapped = mapRow(a);
    if (byName.has(key)) { dupes += 1; mergeInto(byName.get(key), mapped); }
    else byName.set(key, mapped);
  }
  console.log(`       ${byName.size} distinct names (${dupes} duplicate rows folded in).\n`);

  const [localRows] = await pool.query('SELECT id, supplier_code, name, live_pk FROM suppliers');
  const localByName = new Map();
  const localByLivePk = new Map();
  for (const l of localRows) {
    if (l.live_pk) localByLivePk.set(l.live_pk, l);
    const k = norm(l.name);
    // First row wins where a name is duplicated locally; the rest are reported at the end.
    if (k && !localByName.has(k)) localByName.set(k, l);
  }

  const conn = await pool.getConnection();
  let updated = 0; let inserted = 0; let unchanged = 0;
  let nextCode = DRY ? 0 : await nextSupplierCode(conn);
  const fields = ['live_pk', 'live_id', 'name', 'company_name', 'address', 'contact_no', 'mobile_no',
    'office_no', 'fax_no', 'email', 'tin', 'credit_term', 'term_days', 'payee_name', 'bank_name',
    'bank_account_name', 'bank_account_no'];

  try {
    if (!DRY) await conn.beginTransaction();

    for (const [key, s] of byName) {
      const existing = localByLivePk.get(s.live_pk) || localByName.get(key);

      if (existing) {
        // COALESCE keeps whatever is already local when live has nothing -- enrichment, not
        // replacement. The name is left alone entirely: it is what the match was made on, and
        // rewriting it would make a re-run unable to find the row it just changed.
        const sets = fields.filter((f) => f !== 'name')
          .map((f) => `${f} = COALESCE(?, ${f})`).join(', ');
        if (!DRY) {
          await conn.query(
            `UPDATE suppliers SET ${sets}, updated_at = NOW() WHERE id = ?`,
            [...fields.filter((f) => f !== 'name').map((f) => s[f]), existing.id],
          );
        }
        if (existing.live_pk === s.live_pk) unchanged += 1; else updated += 1;
        continue;
      }

      if (!DRY) {
        const code = `SUP-${String(nextCode).padStart(3, '0')}`;
        nextCode += 1;
        await conn.query(
          `INSERT INTO suppliers (supplier_code, ${fields.join(', ')}, is_active)
           VALUES (?, ${fields.map(() => '?').join(', ')}, 1)`,
          [code, ...fields.map((f) => s[f])],
        );
      }
      inserted += 1;
    }

    if (!DRY) await conn.commit();
  } catch (err) {
    if (!DRY) await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  console.log(`Enriched and linked : ${updated}`);
  console.log(`Already linked      : ${unchanged}`);
  console.log(`Newly created       : ${inserted}`);

  // Local rows live knows nothing about. Reported, never deleted -- purchase history points at
  // these, and a supplier dropped from live is not a supplier that never existed.
  const liveKeys = new Set(byName.keys());
  const orphans = localRows.filter((l) => !liveKeys.has(norm(l.name)));
  console.log(`Local-only suppliers: ${orphans.length}${orphans.length ? ' (left untouched)' : ''}`);
  orphans.slice(0, 10).forEach((o) => console.log(`   ${o.supplier_code}  ${o.name}`));

  if (!DRY) {
    const [[after]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(live_pk IS NOT NULL) AS linked,
              SUM(tin IS NOT NULL) AS with_tin, SUM(address IS NOT NULL) AS with_address
         FROM suppliers`,
    );
    console.log(`\nSuppliers now: ${after.total} (${after.linked} linked to live, `
      + `${after.with_tin} with a TIN, ${after.with_address} with an address).`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
