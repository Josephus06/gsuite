// The sales import (import-sales.js) wrote every Job Order as Released, whatever the source had it at.
// A JO the source still has in design -- Planned - Pending for BOM, sub-status Pending / For Design
// Supervisor / FOR ARTIST BOM / For Approval -- read "Released" here: SO-60582's seven unfinished JOs
// were For Artist BOM at the source and Released (then Completed) in T1S, and could not be put on the
// Design Schedule (2026-11-03). This takes each such JO's status from the source.
//
// The list is every JOBORDER the source has at Planned - Pending for BOM (get_transactions, read-only).
// A JO here is moved back only when it is still Released and nothing has happened to it in T1S:
// no assembly build, nothing built or inspected, not invoiced, and no status change in its audit log.
// One with T1S work is listed and left. Mapping, as import-nsso-chain.js reads the source:
//   Pending -> Pending, For Design Supervisor -> For Design Supervisor, FOR ARTIST BOM -> For Artist,
//   For Approval -> Sales Approval, For Revision -> For Artist (Revision); production stage cleared
//   (a JO in design is not on the production ladder yet, as a new JO is not).
//
//   node src/db/fix-planned-jos-from-source.js                      # preview
//   node src/db/fix-planned-jos-from-source.js JO-60582-4-10        # preview one
//   node src/db/fix-planned-jos-from-source.js --apply --by=<user id>
// Droplet, office and SM replicate: run on ONE box (the droplet).
require('dotenv').config();
const pool = require('../db');

const SITE = 'http://gsuite.graphicstar.com.ph';
const APPLY = process.argv.includes('--apply');
const byArg = process.argv.find((a) => a.startsWith('--by='));
const BY = byArg ? Number(byArg.split('=')[1]) : 1;
const ONE = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const PLANNED = 'Planned - Pending for BOM';
const SUB = { pending: 'Pending', 'for design supervisor': 'For Design Supervisor', 'for artist bom': 'For Artist',
  'for approval': 'Sales Approval', 'for revision': 'For Artist (Revision)' };
const n = (v) => Number(v || 0);
const rowsOf = (r) => (Array.isArray(r?.data?.[0]) ? r.data[0] : r?.data) || [];

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST} -- ${APPLY ? 'APPLYING' : 'PREVIEW'}`);
  const login = await fetch(`${SITE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }) });
  const token = (await login.json())?.data?.token;
  if (!token) throw new Error('Source login failed.');
  const call = async (body) => rowsOf(await (await fetch(`${SITE}/api/get_transactions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json());

  const where = { Module_TransH: 'JOBORDER', Status_TransH: PLANNED, ...(ONE ? { UserPK_TransH: ONE } : {}) };
  const source = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const page = await call({ where, limit: 1000, offset });
    source.push(...page);
    if (page.length < 1000) break;
  }
  const subByNo = new Map(source.map((s) => [s.UserPK_TransH, SUB[String(s.SubStatus_TransH || '').trim().toLowerCase()] || 'Pending']));
  console.log(`${source.length} JO(s) at ${PLANNED} in the source`);
  if (!source.length) { await pool.end(); return; }

  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.status, jo.sub_status, jo.production_stage, jo.quantity_built, jo.quantity_inspected,
            (SELECT COUNT(*) FROM assembly_builds b WHERE b.job_order_id = jo.id AND b.status <> 'cancelled') AS builds,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.auditable_type = 'JobOrder' AND a.auditable_id = jo.id
                AND (a.event_type IN ('Approved', 'Status Change') OR a.field_name IN ('status', 'sub_status', 'production_stage'))) AS changes
       FROM job_orders jo WHERE jo.job_order_no IN (?) AND jo.status = 'Released'`,
    [[...subByNo.keys()]]);

  let moved = 0; const left = [];
  for (const jo of jos) {
    if (n(jo.builds) || n(jo.quantity_built) || n(jo.quantity_inspected) || jo.production_stage === 'invoiced' || n(jo.changes)) {
      left.push(`${jo.job_order_no} (${jo.production_stage}, builds ${n(jo.builds)}, built ${n(jo.quantity_built)}, inspected ${n(jo.quantity_inspected)}, status changes ${n(jo.changes)})`);
      continue;
    }
    const sub = subByNo.get(jo.job_order_no);
    moved += 1;
    console.log(`  ${jo.job_order_no}: Released / ${jo.sub_status} / ${jo.production_stage} -> ${PLANNED} / ${sub}`);
    if (!APPLY) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE job_orders SET status = ?, sub_status = ?, production_stage = NULL, updated_at = NOW() WHERE id = ? AND status = 'Released'",
        [PLANNED, sub, jo.id]);
      for (const [field, oldValue, newValue] of [['status', jo.status, PLANNED], ['sub_status', jo.sub_status, sub], ['production_stage', jo.production_stage, null]]) {
        if (oldValue === newValue) continue;
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('JobOrder', ?, 'Status Change', ?, ?, ?, ?)`, [jo.id, `${field} (from source)`, oldValue, newValue, BY]);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }

  if (left.length) console.log(`Left alone -- worked on in T1S:\n  ${left.join('\n  ')}`);
  console.log(`${moved} JO(s) ${APPLY ? 'put back' : 'to put back'} to ${PLANNED}; ${left.length} left alone.`);
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
