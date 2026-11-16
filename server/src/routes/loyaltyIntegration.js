const crypto = require('crypto');
const express = require('express');
const pool = require('../db');

// Read-only feed for the GraphicStar Rewards website (graphicstar.ph/rewards).
//
// The website's admin links each Rewards member to an ERP customer, then pulls that customer's
// sales invoices to award loyalty points. It is a server-to-server caller with no ERP user
// behind it, so it cannot use the 8h login JWT: it sends a fixed key instead.
//
//   LOYALTY_API_KEY=<long random string>      (same value as ERP_API_KEY on the website)
//
// Unset, every route answers 503 -- the feed is off until someone deliberately turns it on.
// Nothing here writes, and only customer identity + invoice totals leave the ERP.

const router = express.Router();

const keyMatches = (given) => {
  const expected = process.env.LOYALTY_API_KEY || '';
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

router.use((req, res, next) => {
  if (!process.env.LOYALTY_API_KEY) return res.status(503).json({ error: 'Loyalty integration is disabled' });
  if (!keyMatches(req.get('x-api-key'))) return res.status(401).json({ error: 'Invalid API key' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const customerFields = 'c.id, c.customer_code, c.name, c.company_name, c.is_active';
const shape = (c) => ({
  id: c.id,
  customer_code: c.customer_code || null,
  name: c.name,
  company_name: c.company_name || null,
  is_active: !!c.is_active,
});

// GET /customers?q=reyes  -- name / company / code search for the Verification page picker.
router.get('/customers', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ data: [] });
    const like = `%${q}%`;
    const [rows] = await pool.query(
      `SELECT ${customerFields} FROM customers c
        WHERE c.name LIKE ? OR c.company_name LIKE ? OR c.customer_code = ? OR c.id = ?
        ORDER BY c.is_active DESC, c.name LIMIT 25`,
      [like, like, q, /^\d+$/.test(q) ? Number(q) : -1]
    );
    res.json({ data: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

// GET /customers/:id
router.get('/customers/:id', async (req, res, next) => {
  try {
    const [[c]] = await pool.query(`SELECT ${customerFields} FROM customers c WHERE c.id = ?`, [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    res.json({ data: shape(c) });
  } catch (err) {
    next(err);
  }
});

// GET /customers/:id/invoices?since=2025-01-01
// Every invoice for the customer since the date, cancelled/void included so the website can take
// back points for an invoice that was cancelled after it was counted.
router.get('/customers/:id/invoices', async (req, res, next) => {
  try {
    const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.since || '')) ? req.query.since : '2025-01-01';
    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount, si.amount_due, si.status
         FROM sales_invoices si
         JOIN sales_orders so ON so.id = si.sales_order_id
        WHERE so.customer_id = ? AND si.date_created >= ?
        ORDER BY si.date_created, si.id`,
      [req.params.id, since]
    );
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        invoice_no: r.invoice_no,
        date: r.date_created instanceof Date ? r.date_created.toISOString().slice(0, 10) : String(r.date_created),
        gross_amount: Number(r.gross_amount) || 0,
        amount_due: Number(r.amount_due) || 0,
        status: r.status,
        cancelled: ['cancelled', 'void'].includes(r.status),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
