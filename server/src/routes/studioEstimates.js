const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

// The T1S end of the studio's "Create Estimate" (2026-11-25). The studio posts a draft
// (routes/studioEstimateIntegration.js) and opens /estimates/new?studio_draft=<id>; the Estimate
// form reads the prefill here, makes the estimate with its own saves and pricing, and links it.
//
//   GET  /api/studio-estimate-drafts/job-types          sign category -> Job Type mapping
//   PUT  /api/studio-estimate-drafts/job-types/:code    { job_type_id }
//   GET  /api/studio-estimate-drafts/:id/prefill        what the Estimate form fills itself with
//   POST /api/studio-estimate-drafts/:id/link           { estimate_id }: ties them, attaches files

const router = express.Router();
const ESTIMATES = '/estimates';
const JOB_TYPES_PAGE = '/3d-studio/job-types';
const MATERIALS_PROCESS_CODE = '3DS-MATERIALS';

router.get('/job-types', requireAuth, requirePermission(JOB_TYPES_PAGE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.category_code, m.category_name, m.job_type_id, jt.display_name AS job_type_name, m.updated_at
         FROM studio_category_job_types m LEFT JOIN job_types jt ON jt.id = m.job_type_id
        ORDER BY m.category_name, m.category_code`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.put('/job-types/:code', requireAuth, requirePermission(JOB_TYPES_PAGE, 'can_edit'), async (req, res, next) => {
  try {
    const jobTypeId = req.body?.job_type_id ? Number(req.body.job_type_id) : null;
    if (jobTypeId) {
      const [[jt]] = await pool.query('SELECT id FROM job_types WHERE id = ?', [jobTypeId]);
      if (!jt) return res.status(400).json({ error: 'Job type not found' });
    }
    const [r] = await pool.query(
      'UPDATE studio_category_job_types SET job_type_id = ?, updated_by_user_id = ?, updated_at = NOW() WHERE category_code = ?',
      [jobTypeId, req.user.id, req.params.code]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Category not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

async function findDraft(publicId) {
  const [[d]] = await pool.query(
    `SELECT d.*, e.estimate_no FROM studio_estimate_drafts d LEFT JOIN estimates e ON e.id = d.estimate_id
      WHERE d.public_id = ?`, [String(publicId)]);
  return d || null;
}

const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Nothing is saved here: the form shows it, Sales adds labour / installation and changes what they
// need, and the estimate is made by the form's own saves, priced by T1S as if typed in.
router.get('/:id/prefill', requireAuth, requirePermission(ESTIMATES, 'can_add'), async (req, res, next) => {
  try {
    const d = await findDraft(req.params.id);
    if (!d) return res.status(404).json({ error: 'This 3D Studio estimate link is not valid. Press Create Estimate in the studio again.' });
    if (d.estimate_id) return res.status(409).json({ error: `Estimate ${d.estimate_no || ''} was already made from this link. Press Create Estimate in the studio again for a new one.` });

    const [[proc]] = await pool.query('SELECT id, default_location_id FROM processes WHERE process_code = ? AND is_active = 1', [MATERIALS_PROCESS_CODE]);
    if (!proc) return res.status(500).json({ error: `Process ${MATERIALS_PROCESS_CODE} is missing -- run db/create-studio-estimate-drafts.js.` });

    const warnings = [];
    let customer = null;
    if (d.customer_erp_id) {
      [[customer]] = await pool.query('SELECT id, name FROM customers WHERE id = ?', [d.customer_erp_id]);
      if (!customer) warnings.push(`The studio's customer (T1S id ${d.customer_erp_id}) is not in T1S -- pick the customer.`);
    } else {
      warnings.push(`${d.customer_name || 'The customer'} is not linked to a T1S customer in the studio -- pick the customer.`);
    }
    const [[contact]] = customer ? await pool.query(
      `SELECT id, email, title, phone FROM customer_contacts WHERE customer_id = ?
        ORDER BY is_primary DESC, is_default_bill_to DESC, id LIMIT 1`, [customer.id]) : [[null]];
    const [[mapping]] = d.category_code ? await pool.query(
      'SELECT job_type_id FROM studio_category_job_types WHERE category_code = ?', [d.category_code]) : [[null]];
    if (!mapping?.job_type_id) warnings.push(`No Job Type is set for "${d.category_name || d.category_code || 'this sign category'}" (Sales > 3D Studio Job Types) -- pick the job type on the line.`);

    const bom = asJson(d.bom) || [];
    const ids = bom.map((l) => l.inventory_id).filter(Boolean);
    const [items] = ids.length ? await pool.query(
      `SELECT i.id, i.item_code, i.is_active, i.is_length_based, i.is_width_based, u.code AS unit
         FROM inventories i LEFT JOIN units_of_measure u ON u.id = i.base_unit_id WHERE i.id IN (?)`, [ids]) : [[]];
    const byId = new Map(items.map((i) => [i.id, i]));
    const processes = [];
    for (const l of bom) {
      const item = byId.get(l.inventory_id);
      if (!item) { warnings.push(`${l.item_code} is no longer in T1S -- left out.`); continue; }
      if (!item.is_active) warnings.push(`${l.item_code} is inactive in T1S.`);
      // Length / area items go in as pieces x size in MM; the estimate's pricing converts mm into the
      // item's own LMTR / SQFT. A countable item is a plain quantity.
      const sized = item.is_length_based && l.length_mm;
      processes.push({
        process_id: proc.id,
        location_id: proc.default_location_id || '',
        item_id: item.id,
        qty: Number(l.quantity),
        unit: item.unit || '',
        length: sized ? Number(l.length_mm) : '',
        width: sized && item.is_width_based && l.width_mm ? Number(l.width_mm) : '',
        uom: sized ? 'MM' : (item.unit || ''),
        remarks: [l.section, l.description, l.note].filter(Boolean).join(' - ').slice(0, 255),
      });
    }
    const ref = `3D Studio ${d.project_number || ''}${d.revision_label ? `, ${d.revision_label}` : ''}`.trim();
    const mm = (v) => (v === null || v === undefined ? '' : Number(v));
    res.json({
      draft: {
        id: d.public_id, project_number: d.project_number, project_title: d.project_title,
        revision_label: d.revision_label, category_name: d.category_name, studio_user_name: d.studio_user_name,
      },
      header: {
        customer_id: customer?.id || '',
        contact_person_id: contact?.id || '',
        contact_email: contact?.email || '',
        contact_title: contact?.title || '',
        contact_phone: contact?.phone || '',
        contract_description: d.project_title,
        shipping_address: d.site_address || '',
        memo: `From ${ref}`,
      },
      job_orders: [{
        job_type_id: mapping?.job_type_id || '',
        description: d.project_title,
        quantity: Number(d.quantity) || 1,
        units: 'PC/S',
        length: mm(d.length_mm),
        width: mm(d.width_mm),
        height: mm(d.height_mm),
        uom: 'MM',
        remarks: ref,
        processes,
      }],
      warnings,
    });
  } catch (err) { next(err); }
});

// Called by the Estimate form once its estimate exists: ties the draft to it (so the link cannot
// make a second estimate) and copies the render and drawing set onto its attachments.
router.post('/:id/link', requireAuth, requirePermission(ESTIMATES, 'can_add'), async (req, res, next) => {
  const estimateId = Number(req.body?.estimate_id);
  if (!Number.isInteger(estimateId) || estimateId <= 0) return res.status(400).json({ error: 'estimate_id is required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[d]] = await conn.query('SELECT id, estimate_id FROM studio_estimate_drafts WHERE public_id = ? FOR UPDATE', [String(req.params.id)]);
    if (!d) { await conn.rollback(); return res.status(404).json({ error: 'Draft not found' }); }
    if (d.estimate_id === estimateId) { await conn.rollback(); return res.json({ ok: true, already: true }); }
    if (d.estimate_id) { await conn.rollback(); return res.status(409).json({ error: 'An estimate was already made from this link.' }); }
    const [[est]] = await conn.query('SELECT id FROM estimates WHERE id = ?', [estimateId]);
    if (!est) { await conn.rollback(); return res.status(404).json({ error: 'Estimate not found' }); }
    await conn.query('UPDATE studio_estimate_drafts SET estimate_id = ?, used_at = NOW() WHERE id = ?', [estimateId, d.id]);
    await conn.query(
      `INSERT INTO estimate_attachments (estimate_id, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       SELECT ?, file_name, mime_type, size_bytes, file_data, ? FROM studio_estimate_draft_files
        WHERE draft_id = ? ORDER BY kind = 'render' DESC, id`, [estimateId, req.user.id, d.id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
