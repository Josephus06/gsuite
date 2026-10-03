// Read-only: do T1S's Commission Payables and Vouchers match the source? (asked 2026-10-03 --
// "commission released" has to agree.) Three checks:
//   1. every source payable / voucher number exists in T1S;
//   2. each voucher's total and status equal the source's;
//   3. each payable's amount paid (copied from the source) equals what T1S's own posted vouchers
//      release against it -- the figure the Commission report and the payable's Released read.
//
//   node src/db/compare-commission.js
require('dotenv').config();
const pool = require('../db');
const { login, listRows, api } = require('./lib/liveWindow');

const money = (v) => Number((Number(v) || 0).toFixed(2));
const voucherStatus = (s) => (/VOID|CANCEL/i.test(s || '') ? 'void' : 'posted');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const token = await login();
  const fetchAll = async (ep) => {
    const out = [];
    for (let off = 0; off < 5000; off += 100) {
      const b = listRows(await api(token, ep, { searchKey: '', limit: 100, offset: off }));
      if (!b.length) break; out.push(...b); if (b.length < 100) break;
    }
    return out;
  };
  const srcPay = await fetchAll('get_commission_payables');
  const srcVch = await fetchAll('get_commission_vouchers');

  const [pays] = await pool.query('SELECT id, commission_payable_no AS no, amount_paid, status FROM commission_payables');
  const [vchs] = await pool.query('SELECT id, voucher_no AS no, total_payments, status, created_by_user_id FROM commission_vouchers');
  const payNo = new Map(pays.map((p) => [p.no, p]));
  const vchNo = new Map(vchs.map((v) => [v.no, v]));

  const missPay = srcPay.filter((s) => !payNo.has(s.UserPK_TransH)).map((s) => s.UserPK_TransH);
  const missVch = srcVch.filter((s) => !vchNo.has(s.UserPK_TransH)).map((s) => s.UserPK_TransH);
  console.log(`\nPayables: source ${srcPay.length}, T1S ${pays.length}, missing ${missPay.length} ${missPay.join(' ')}`);
  console.log(`Vouchers: source ${srcVch.length}, T1S ${vchs.length}, missing ${missVch.length} ${missVch.join(' ')}`);

  let vDiff = 0;
  for (const s of srcVch) {
    const t = vchNo.get(s.UserPK_TransH); if (!t) continue;
    const d = [];
    if (money(t.total_payments) !== money(s.TotalAmount_TransH)) d.push(`total ${money(t.total_payments)} vs source ${money(s.TotalAmount_TransH)}`);
    if (t.status !== voucherStatus(s.Status_TransH)) d.push(`status ${t.status} vs source ${s.Status_TransH}`);
    if (d.length) { vDiff += 1; console.log(`  ${s.UserPK_TransH}: ${d.join('; ')}`); }
  }
  const t1sOnly = vchs.filter((v) => !srcVch.some((s) => s.UserPK_TransH === v.no));
  console.log(`Vouchers differing from source: ${vDiff}. In T1S only: ${t1sOnly.map((v) => `${v.no} (${v.status} ${money(v.total_payments)})`).join(', ') || 'none'}`);

  // Released per payable from T1S's own posted vouchers vs the paid amount carried from the source.
  const [rel] = await pool.query(
    `SELECT l.commission_payable_id AS id, SUM(l.released_amount) AS released
       FROM commission_voucher_lines l JOIN commission_vouchers v ON v.id = l.commission_voucher_id
      WHERE v.status <> 'void' GROUP BY l.commission_payable_id`);
  const relById = new Map(rel.map((r) => [r.id, money(r.released)]));
  let pDiff = 0; let totPaid = 0; let totRel = 0;
  for (const p of pays) {
    const r = relById.get(p.id) || 0; totPaid += money(p.amount_paid); totRel += r;
    if (Math.abs(r - money(p.amount_paid)) > 0.01) { pDiff += 1; if (pDiff <= 40) console.log(`  ${p.no}: paid (source) ${money(p.amount_paid)} vs released by T1S vouchers ${r}`); }
  }
  console.log(`Payables where vouchers' released != paid: ${pDiff} of ${pays.length}. Totals: paid ${totPaid.toFixed(2)}, released ${totRel.toFixed(2)}`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
