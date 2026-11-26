const crypto = require('crypto');
const express = require('express');
const pool = require('../db');

// Signage Studio -> T1S: the studio's "Create Estimate" button (2026-11-25). The studio's server
// posts the project here as a draft and then sends the user's browser to
// /estimates/new?studio_draft=<id>; see db/create-studio-estimate-drafts.js for the agreed flow.
//
// Same caller and key as the studio's other feeds: x-api-key = MATERIAL_COSTING_API_KEY (the
// studio's ERP_API_KEY). Unset = 503.
//
//   POST /api/integrations/studio/estimate-drafts
//   {
//     project:  { id, number, title, site_address, quantity },
//     revision: { id, label },
//     category: { code, name } | null,          the studio's sign category (mapped to a Job Type here)
//     customer: { erp_customer_id, name },      erp_customer_id = T1S customers.id, null if not linked
//     size:     { length_mm, width_mm, height_mm },
//     created_by: { name, email, t1s_user_id },
//     led_summary: { ... },
//     bom:   [{ section, item_code, description, quantity, length_mm, width_mm, note }],
//     files: [{ kind: 'render' | 'drawing', file_name, mime_type, data: <base64> }]
//   }
//   201 { id, path: '/estimates/new?studio_draft=<id>' }
//   422 { error, problems: [{ line, item_code, problem }] }   nothing stored
//
// MILLIMETRES ONLY. A BOM line of an item priced by length (LMTR...) carries length_mm of one piece,
// by area (SQFT...) length_mm and width_mm of one piece, and quantity = pieces; a countable item
// carries a quantity in its own unit. The estimate's pricing converts mm into the item's unit.

const router = express.Router();

const keyMatches = (given) => {
  const expected = process.env.MATERIAL_COSTING_API_KEY || '';
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

router.use((req, res, next) => {
  if (!process.env.MATERIAL_COSTING_API_KEY) return res.status(503).json({ error: 'The 3D Studio integration is disabled' });
  if (!keyMatches(req.get('x-api-key'))) return res.status(401).json({ error: 'Invalid API key' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const FILE_KINDS = new Set(['render', 'drawing']);
const FILE_TYPES = /^(image\/(png|jpe?g|webp)|application\/pdf)$/i;
const FILE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_BOM_LINES = 300;
const optNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const text = (v, n) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);

router.post('/estimate-drafts', async (req, res, next) => {
  try {
    const b = req.body || {};
    const project = b.project || {};
    if (!project.id || !text(project.title, 200)) return res.status(400).json({ error: 'project.id and project.title are required' });
    const bom = Array.isArray(b.bom) ? b.bom : [];
    if (!bom.length) return res.status(400).json({ error: 'The design has no materials to estimate (bom is empty).' });
    if (bom.length > MAX_BOM_LINES) return res.status(400).json({ error: `bom has more than ${MAX_BOM_LINES} lines` });

    // Every line must be an active T1S item, with the numbers its pricing needs.
    const codes = [...new Set(bom.map((l) => String(l?.item_code || '').trim()).filter(Boolean))];
    const [items] = codes.length ? await pool.query(
      `SELECT i.id, i.item_code, i.display_name, i.is_active, i.is_length_based, i.is_width_based, u.code AS unit
         FROM inventories i LEFT JOIN units_of_measure u ON u.id = i.base_unit_id WHERE i.item_code IN (?)`, [codes]) : [[]];
    const byCode = new Map(items.map((i) => [i.item_code, i]));
    const problems = [];
    const lines = bom.map((l, idx) => {
      const line = idx + 1;
      const code = String(l?.item_code || '').trim();
      const item = byCode.get(code);
      const qty = Number(l?.quantity);
      const len = optNum(l?.length_mm);
      const wid = optNum(l?.width_mm);
      const what = code || text(l?.description, 80) || `line ${line}`;
      if (!code) problems.push({ line, item_code: null, problem: `${what}: not linked to a T1S item` });
      else if (!item) problems.push({ line, item_code: code, problem: 'not a T1S item' });
      else if (!item.is_active) problems.push({ line, item_code: code, problem: 'inactive in T1S' });
      if (!(qty > 0)) problems.push({ line, item_code: code || null, problem: 'quantity must be more than 0' });
      if (item?.is_length_based && !(len > 0)) problems.push({ line, item_code: code, problem: `priced by ${item.unit || 'length'}: needs length_mm of one piece` });
      if (item?.is_length_based && item?.is_width_based && !(wid > 0)) problems.push({ line, item_code: code, problem: `priced by ${item.unit || 'area'}: needs length_mm and width_mm of one piece` });
      return {
        line_no: line,
        section: text(l?.section, 80),
        item_code: code,
        inventory_id: item?.id || null,
        item_name: item?.display_name || null,
        description: text(l?.description, 300),
        quantity: qty,
        length_mm: item?.is_length_based ? len : null,
        width_mm: item?.is_length_based && item?.is_width_based ? wid : null,
        unit: item?.unit || null,
        note: text(l?.note, 300),
      };
    });

    const files = [];
    (Array.isArray(b.files) ? b.files : []).forEach((f, idx) => {
      const where = `file ${idx + 1}${f?.file_name ? ` (${f.file_name})` : ''}`;
      if (!FILE_KINDS.has(f?.kind)) { problems.push({ line: null, item_code: null, problem: `${where}: kind must be render or drawing` }); return; }
      if (!FILE_TYPES.test(String(f?.mime_type || ''))) { problems.push({ line: null, item_code: null, problem: `${where}: unsupported type ${f?.mime_type}` }); return; }
      const buf = Buffer.from(String(f?.data || '').split(',').pop(), 'base64');
      if (!buf.length) return;
      if (buf.length > FILE_MAX_BYTES) { problems.push({ line: null, item_code: null, problem: `${where}: larger than 25MB` }); return; }
      files.push({ kind: f.kind, file_name: String(f.file_name || `${f.kind}-${idx + 1}`).slice(0, 255), mime_type: String(f.mime_type).slice(0, 100), buf });
    });
    const led = b.led_summary && typeof b.led_summary === 'object' ? JSON.stringify(b.led_summary) : null;
    if (led && led.length > 64 * 1024) problems.push({ line: null, item_code: null, problem: 'led_summary is larger than 64KB' });
    if (problems.length) return res.status(422).json({ error: 'T1S cannot price this design yet', problems });

    const customerId = Number(b.customer?.erp_customer_id) || null;
    const publicId = crypto.randomUUID();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO studio_estimate_drafts
           (public_id, studio_project_id, project_number, project_title, revision_id, revision_label, category_code, category_name,
            customer_erp_id, customer_name, site_address, quantity, length_mm, width_mm, height_mm, bom, led_summary,
            studio_user_name, t1s_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [publicId, String(project.id).slice(0, 64), text(project.number, 40), text(project.title, 200),
          text(b.revision?.id, 64), text(b.revision?.label, 100), text(b.category?.code, 40), text(b.category?.name, 80),
          customerId, text(b.customer?.name, 200), text(project.site_address, 2000), Number(project.quantity) > 0 ? Number(project.quantity) : 1,
          optNum(b.size?.length_mm), optNum(b.size?.width_mm), optNum(b.size?.height_mm), JSON.stringify(lines), led,
          text(b.created_by?.name, 150), Number(b.created_by?.t1s_user_id) || null]);
      for (const f of files) {
        await conn.query(
          'INSERT INTO studio_estimate_draft_files (draft_id, kind, file_name, mime_type, size_bytes, file_data) VALUES (?, ?, ?, ?, ?, ?)',
          [r.insertId, f.kind, f.file_name, f.mime_type, f.buf.length, f.buf]);
      }
      // A category the mapping has never seen is listed for the admin, unmapped.
      if (text(b.category?.code, 40)) {
        await conn.query(
          'INSERT IGNORE INTO studio_category_job_types (category_code, category_name) VALUES (?, ?)',
          [text(b.category.code, 40), text(b.category.name, 80)]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.status(201).json({ id: publicId, path: `/estimates/new?studio_draft=${publicId}` });
  } catch (err) { next(err); }
});

module.exports = router;
