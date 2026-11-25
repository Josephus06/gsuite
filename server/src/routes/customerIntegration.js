const crypto = require('crypto');
const express = require('express');
const pool = require('../db');

// Read-only customer feed for the Signage Studio (its Customers, synced from T1S), 2026-11-25.
//
// Same caller and the same key as the Material Costing feed (routes/materialCostingIntegration.js):
// the studio's ERP_API_KEY = MATERIAL_COSTING_API_KEY here, sent as x-api-key. Unset = 503.
// Nothing here writes. Customer identity, contact and address leave the ERP -- no credit, terms,
// balances or sales figures.
//
//   GET /api/integrations/customers
//       ?status=active (default) | all        all = inactive ones too, so a sync can archive them
//       ?updated_since=2026-11-01             changed on or after (created_at when never updated)
//   GET /api/integrations/customers/:id
//
// MATCH ON `id`. It is T1S's own customer id and never changes. customer_code is passed along but
// only 55 of 21,562 customers have one (2026-11-25), so it cannot be the key.

const router = express.Router();

const keyMatches = (given) => {
  const expected = process.env.MATERIAL_COSTING_API_KEY || '';
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

router.use((req, res, next) => {
  if (!process.env.MATERIAL_COSTING_API_KEY) return res.status(503).json({ error: 'The customer feed is disabled' });
  if (!keyMatches(req.get('x-api-key'))) return res.status(401).json({ error: 'Invalid API key' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// One contact per customer: the primary one, else the default bill-to one, else the first added.
const SELECT = `SELECT c.id, c.customer_code, c.name, c.company_name, c.tin, c.customer_type, c.contact_no,
         c.address, c.bill_to_name, c.bill_to_address, c.is_active, c.created_at, c.updated_at,
         cc.contact_name, cc.email AS contact_email, cc.phone AS contact_phone,
         -- The Addresses tab, for customers whose own Address field is blank.
         (SELECT a.address_line FROM customer_addresses a WHERE a.customer_id = c.id
           ORDER BY a.is_default DESC, a.id LIMIT 1) AS listed_address
    FROM customers c
    LEFT JOIN customer_contacts cc ON cc.id = (
      SELECT x.id FROM customer_contacts x WHERE x.customer_id = c.id
       ORDER BY x.is_primary DESC, x.is_default_bill_to DESC, x.id LIMIT 1)`;

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
// Sessions run in UTC (db.js) and dates come back as strings.
const utc = (v) => (v ? `${String(v).replace(' ', 'T').slice(0, 19)}Z` : null);

const shape = (r) => ({
  id: r.id,
  customer_code: text(r.customer_code) || null,
  name: text(r.name),
  company_name: text(r.company_name) || text(r.name),
  contact_person: text(r.contact_name),
  email: text(r.contact_email),
  phone: text(r.contact_phone) || text(r.contact_no),
  address: text(r.address) || text(r.listed_address),
  bill_to_name: text(r.bill_to_name),
  bill_to_address: text(r.bill_to_address),
  tin: text(r.tin),
  customer_type: text(r.customer_type) || null,
  is_active: !!r.is_active,
  updated_at: utc(r.updated_at || r.created_at),
});

router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status === 'all' ? 'all' : 'active';
    const where = [];
    const params = [];
    if (status === 'active') where.push('c.is_active = 1');
    const since = String(req.query.updated_since || '').trim();
    if (since) {
      if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(since)) {
        return res.status(400).json({ error: 'updated_since must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS' });
      }
      where.push('COALESCE(c.updated_at, c.created_at) >= ?');
      params.push(since.replace('T', ' ').replace(/(\.\d+)?Z$/, ''));
    }
    const [rows] = await pool.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id`, params);
    res.json({ generated_at: new Date().toISOString(), status, count: rows.length, items: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id must be a T1S customer id' });
    const [[row]] = await pool.query(`${SELECT} WHERE c.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Customer not found' });
    res.json({ item: shape(row) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
