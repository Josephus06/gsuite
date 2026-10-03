// Fills in what import-deposits.js left out of the source's Bank Deposits: the customer payments
// each one deposited, and its Other Deposit / Cash Back lines. Those deposits arrived as header +
// total only (BD-22321: 9,892.19 and an empty Payments tab).
//
// import-deposits.js said the source does not expose a deposit's composition. It does: the
// source's own deposit view asks get_transactions for the deposit with the includes
//   transaction_transactionledgertransactions   one row per payment (Amount_LdgrTr, the payment's
//                                               transaction PK in SysFK_TransHSL_LdgrTr)
//   transaction_transactionledgerentries        Module 'X' rows, ModuleTrans 'Other Deposit' (CR)
//                                               or 'Cash Back' (DR): account, location, dept,
//                                               method, memo
// BD-22321 = PAY-59803 2,142.32 + PAY-59731 1,800 + PAY-59706 500 + Other Deposit 5,600 (23000)
//            - Cash Back 100.42 (30701) - 49.71 (14200).
//
// Per deposit, all or nothing, and only when it ties: payments + other - cash back must equal the
// T1S total_amount, every payment must exist in T1S, and none may already belong to another
// deposit. Anything else is listed and left alone. Only deposits with no payments and no lines yet
// are touched, so it is safe to re-run. Linking a payment sets deposit_id and status 'deposited'
// (what the T1S deposit form does). Voided deposits are skipped.
//
// What it changes elsewhere: nothing in the reports. Before the cut-over the ledger is the source's
// own figures (lib/openingBalances.js), and bankLedger reads deposit total_amount, which does not
// change. The deposit's GL Impact tab now shows its real lines instead of "all Undeposited Funds".
//
// Droplet and office replicate: run on ONE. Every run writes a rollback file first.
//   node src/db/import-deposit-details.js --from=2026-01-01 --to=2026-09-30 --dry-run
//   node src/db/import-deposit-details.js --only=BD-22321
//   node src/db/import-deposit-details.js --from=2026-01-01 --to=2026-09-30
//   node src/db/import-deposit-details.js --restore=<rollback file>
require('dotenv').config();
const fs = require('fs');
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const DRY = process.argv.includes('--dry-run');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const one = (res) => (Array.isArray(res?.data?.[0]) ? res.data[0] : (Array.isArray(res?.data) ? res.data : []))[0];

async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  const token = (await r.json())?.data?.token;
  if (!token) throw new Error('Source login failed.');
  return token;
}

async function sourceDeposit(token, bdNo) {
  const body = {
    where: { Module_TransH: 'DEPOSIT', UserPK_TransH: bdNo },
    include: [
      ['transaction_transactionledgerentries', 'transactionledgerentry_coa', 'transactionledgerentry_location', 'transactionledgerentry_department'],
      ['transaction_transactionledgertransactions', ['transactionledgertransaction_transactionsl']],
    ],
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await fetch(`${SITE}/api/get_transactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      return one(await r.json()) || null;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
}

async function restore(file) {
  const rb = JSON.parse(fs.readFileSync(file, 'utf8'));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let p = 0; let l = 0;
    for (const d of rb.deposits) {
      for (const x of d.payments) {
        const [r] = await conn.query('UPDATE customer_payments SET deposit_id = ?, status = ? WHERE id = ? AND deposit_id = ?', [x.deposit_id_before, x.status_before, x.id, d.deposit_id]);
        p += r.affectedRows;
      }
      if (d.line_ids.length) { const [r] = await conn.query('DELETE FROM bank_deposit_lines WHERE id IN (?) AND deposit_id = ?', [d.line_ids, d.deposit_id]); l += r.affectedRows; }
    }
    await conn.commit();
    console.log(`Restored: ${p} payment(s) unlinked, ${l} line(s) removed.`);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

async function main() {
  console.log(`${DRY ? 'DRY RUN -- ' : ''}DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (arg('restore')) return restore(arg('restore'));

  const where = ["d.status <> 'void'"];
  const params = [];
  if (arg('only')) { where.push('d.bd_no IN (?)'); params.push(arg('only').split(',')); }
  if (arg('from')) { where.push('d.date_created >= ?'); params.push(arg('from')); }
  if (arg('to')) { where.push('d.date_created <= ?'); params.push(arg('to')); }
  if (!arg('only') && !arg('from')) throw new Error('Give --only=BD-... or --from=YYYY-MM-DD [--to=...].');
  // customer_payments.deposit_id has no index: read the deposits that already have detail once,
  // rather than a NOT EXISTS per deposit.
  const [inRange] = await pool.query(`SELECT d.id, d.bd_no, d.date_created, d.total_amount FROM bank_deposits d WHERE ${where.join(' AND ')} ORDER BY d.date_created, d.id`, params);
  const [hasPay] = await pool.query('SELECT DISTINCT deposit_id FROM customer_payments WHERE deposit_id IS NOT NULL');
  const [hasLine] = await pool.query('SELECT DISTINCT deposit_id FROM bank_deposit_lines');
  const filled = new Set([...hasPay, ...hasLine].map((r) => Number(r.deposit_id)));
  const deps = inRange.filter((d) => !filled.has(Number(d.id)));
  console.log(`${deps.length} deposit(s) without payments or lines in range.`);

  const [coa] = await pool.query('SELECT id, account_code FROM chart_of_accounts');
  const acctId = new Map(coa.map((c) => [String(c.account_code).trim(), c.id]));
  const byName = async (sql) => new Map((await pool.query(sql))[0].map((r) => [norm(r.name), r.id]));
  const locId = await byName('SELECT id, location_name AS name FROM locations');
  const deptId = await byName('SELECT id, name FROM departments');
  const methodId = await byName('SELECT id, name FROM payment_methods');

  const token = await login();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rbFile = arg('rollback-dir') ? `${arg('rollback-dir')}/deposit-details-rollback-${stamp}.json` : `deposit-details-rollback-${stamp}.json`;
  const rollback = { written_at: stamp, deposits: [] };
  const skipped = []; let done = 0; let nPay = 0; let nLine = 0;

  for (const [i, d] of deps.entries()) {
    const t = await sourceDeposit(token, d.bd_no);
    const skip = (why) => skipped.push({ bd_no: d.bd_no, date: d.date_created, total: Number(d.total_amount), why });
    if (!t) { skip('not found in the source'); continue; }
    if (t.Status_TransH === 'VOID') { skip('void in the source'); continue; }

    const links = (t.transaction_transactionledgertransactions || []).filter((p) => !Number(p.IsVoided_LdgrTr));
    const payNos = links.map((p) => p.transactionledgertransaction_transactionsl?.UserPK_TransH).filter(Boolean);
    if (payNos.length !== links.length) { skip('a payment link has no document number'); continue; }
    const lines = [];
    let bad = null;
    for (const e of (t.transaction_transactionledgerentries || []).filter((x) => x.Module_LdgrEntries === 'X')) {
      const kind = e.ModuleTrans_LdgrEntries === 'Other Deposit' ? 'other' : e.ModuleTrans_LdgrEntries === 'Cash Back' ? 'cashback' : null;
      if (!kind) { bad = `unknown line kind ${e.ModuleTrans_LdgrEntries}`; break; }
      // The source keeps empty starter rows (0.00, sometimes no account): nothing to carry over.
      if (!r2(Number(e.CRAmount_LdgrEntries) - Number(e.DRAmount_LdgrEntries))) continue;
      const code = String(e.transactionledgerentry_coa?.UserPK_COA || '').trim();
      if (!acctId.has(code)) { bad = `account ${code || '?'} not in T1S`; break; }
      const amount = r2(kind === 'other' ? Number(e.CRAmount_LdgrEntries) - Number(e.DRAmount_LdgrEntries) : Number(e.DRAmount_LdgrEntries) - Number(e.CRAmount_LdgrEntries));
      if (amount <= 0) { bad = `${kind} line of ${amount}`; break; }
      lines.push({
        line_type: kind, amount, account_id: acctId.get(code),
        payment_method_id: kind === 'other' ? (methodId.get(norm(e.Method_LdgrEntries)) || null) : null,
        location_id: locId.get(norm(e.transactionledgerentry_location?.Name_Loc)) || null,
        department_id: deptId.get(norm(e.transactionledgerentry_department?.Name_Dept)) || null,
        memo: e.Memo_LdgrEntries ? String(e.Memo_LdgrEntries).slice(0, 1000) : null,
      });
    }
    if (bad) { skip(bad); continue; }

    let pays = [];
    if (payNos.length) [pays] = await pool.query('SELECT id, customer_payment_no, payment_amount, status, deposit_id FROM customer_payments WHERE customer_payment_no IN (?)', [payNos]);
    const missing = payNos.filter((n) => !pays.some((p) => p.customer_payment_no === n));
    if (missing.length) { skip(`payment(s) not in T1S: ${missing.join(', ')}`); continue; }
    const taken = pays.filter((p) => p.deposit_id);
    if (taken.length) { skip(`already in another deposit: ${taken.map((p) => p.customer_payment_no).join(', ')}`); continue; }
    const voided = pays.filter((p) => p.status === 'voided');
    if (voided.length) { skip(`payment voided in T1S: ${voided.map((p) => p.customer_payment_no).join(', ')}`); continue; }

    const sumLinks = r2(links.reduce((s, p) => s + Number(p.Amount_LdgrTr), 0));
    const other = r2(lines.filter((l) => l.line_type === 'other').reduce((s, l) => s + l.amount, 0));
    const back = r2(lines.filter((l) => l.line_type === 'cashback').reduce((s, l) => s + l.amount, 0));
    if (Math.abs(r2(sumLinks + other - back) - Number(d.total_amount)) > 0.01) { skip(`does not tie: payments ${sumLinks} + other ${other} - cash back ${back} vs total ${d.total_amount}`); continue; }
    if (!links.length && !lines.length) { skip('the source has no payments or lines either'); continue; }

    if (!DRY) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const rec = { deposit_id: d.id, bd_no: d.bd_no, payments: pays.map((p) => ({ id: p.id, deposit_id_before: null, status_before: p.status })), line_ids: [] };
        if (pays.length) {
          const [r] = await conn.query("UPDATE customer_payments SET deposit_id = ?, status = 'deposited' WHERE id IN (?) AND deposit_id IS NULL", [d.id, pays.map((p) => p.id)]);
          if (r.affectedRows !== pays.length) throw new Error(`${d.bd_no}: a payment changed under us`);
        }
        const no = { other: 0, cashback: 0 };
        for (const l of lines) {
          no[l.line_type] += 1;
          const [r] = await conn.query(
            `INSERT INTO bank_deposit_lines (deposit_id, line_type, line_no, amount, account_id, payment_method_id, department_id, location_id, memo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [d.id, l.line_type, no[l.line_type], l.amount, l.account_id, l.payment_method_id, l.department_id, l.location_id, l.memo]);
          rec.line_ids.push(r.insertId);
        }
        await conn.commit();
        rollback.deposits.push(rec);
        fs.writeFileSync(rbFile, JSON.stringify(rollback)); // after every deposit, so a crash still leaves a usable rollback
      } catch (e) { await conn.rollback(); conn.release(); skip(`write failed: ${e.message}`); continue; }
      conn.release();
    }
    done += 1; nPay += pays.length; nLine += lines.length;
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${deps.length}  filled ${done}, skipped ${skipped.length}`);
  }

  console.log(`\n${DRY ? 'Would fill' : 'Filled'} ${done} deposit(s): ${nPay} payment link(s), ${nLine} line(s). Skipped ${skipped.length}.`);
  const why = {};
  for (const s of skipped) { const k = s.why.replace(/:.*/, ''); why[k] = (why[k] || 0) + 1; }
  console.log('Skipped by reason:', why);
  for (const s of skipped.slice(0, 40)) console.log(`  ${s.bd_no} ${s.date} ${s.total}  ${s.why}`);
  const skipFile = rbFile.replace('rollback', 'skipped');
  fs.writeFileSync(skipFile, JSON.stringify(skipped, null, 1));
  console.log(`Skipped list: ${skipFile}${DRY ? '' : `\nRollback: ${rbFile}`}`);
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
