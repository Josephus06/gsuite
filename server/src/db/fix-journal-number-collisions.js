// Journal numbers T1S gave its OWN journals that the source later used for different, real ones.
//
// On 2026-09-18/19 T1S generated void-reversal journals (the backfill) and bank-only journals,
// numbering them after the last journal it held. The source kept running until the 2026-09-30
// cut-over and issued those same numbers (JRNL-5946..6087) to its own journals -- payroll, 13th
// month, amortization -- which the catch-up then skipped as "already present". Found 2026-10-01
// (JRNL-6074: T1S's reversal of CHK-10833 vs the source's Aug 12-26 payroll).
//
// Fix: give each colliding T1S journal a fresh number above every existing one (its id, lines,
// links and amounts are untouched -- bank reconciliation and cheques link by id), so
// import-journals.js can bring the source's real journals in under their own numbers.
// Reads /root/match2026/journal-collisions.json (from the collision check). Backs up first.
//
//   node src/db/fix-journal-number-collisions.js            preview
//   node src/db/fix-journal-number-collisions.js --apply
// Droplet and office replicate: run on ONE box (droplet).
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  const coll = JSON.parse(fs.readFileSync('/root/match2026/journal-collisions.json', 'utf8'));
  const nos = coll.map((c) => c.no);
  const [rows] = await pool.query('SELECT * FROM journals WHERE journal_no IN (?) ORDER BY id', [nos]);
  const [[mx]] = await pool.query("SELECT MAX(CAST(SUBSTRING(journal_no, 6) AS UNSIGNED)) m FROM journals WHERE journal_no REGEXP '^JRNL-[0-9]+$'");
  // Above both T1S's highest and the source's highest colliding number.
  let next = Math.max(Number(mx.m) || 0, ...nos.map((n) => Number(n.slice(5)))) + 1;
  const plan = rows.map((r) => ({ id: r.id, from: r.journal_no, to: `JRNL-${next++}` }));
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLY' : 'PREVIEW'}`);
  console.log(`colliding T1S journals: ${rows.length} (listed ${nos.length}); renumber ${plan[0]?.from} -> ${plan[0]?.to} ... ${plan.at(-1)?.from} -> ${plan.at(-1)?.to}`);
  if (!APPLY) { await pool.end(); return; }

  fs.writeFileSync('/root/match2026/journal-collisions-backup.json', JSON.stringify(rows));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of plan) {
      await conn.query('UPDATE journals SET journal_no = ? WHERE id = ? AND journal_no = ?', [p.to, p.id, p.from]);
      // Where a cheque/invoice/DT void recorded the reversal's number in its own history.
      await conn.query("UPDATE audit_logs SET new_value = ? WHERE field_name = 'reversal_journal_no' AND new_value = ?", [p.to, p.from]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('Journal', ?, 'Updated', 'journal_no', ?, ?, 1)`, [p.id, p.from, p.to]);
    }
    await conn.commit();
    fs.writeFileSync('/root/match2026/journal-renumber-plan.json', JSON.stringify(plan));
    console.log(`Committed: ${plan.length} journal(s) renumbered. Backup + plan in /root/match2026/.`);
  } catch (e) { await conn.rollback(); console.error('FAILED (rolled back):', e.message); process.exitCode = 1; } finally { conn.release(); }
  await pool.end();
})();
