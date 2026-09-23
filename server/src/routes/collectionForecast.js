const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/treasury/collection-forecast';

// Treasury > Collection Forecast. Treasury puts a date on an open invoice saying when they
// expect to collect it, then reads the month back as a calendar of who owes what and when.
//
// WHAT COUNTS AS OPEN: amount_due > 0 and not cancelled -- what the Invoice screen itself calls
// outstanding. AR Aging answers a deliberately different question (it rebuilds balances from
// documents and so also counts 1,363 invoices marked paid with nothing recorded behind them);
// putting those on a collection worklist would have Treasury chasing invoices their own screen
// calls Paid In Full. See lib/arAging.js for why that report is right to differ.
const OPEN_INVOICE = 'si.amount_due > 0 AND si.cancelled_at IS NULL';

const clampPage = (v) => Math.max(1, Number(v) || 1);
const clampLimit = (v) => Math.min(200, Math.max(1, Number(v) || 25));
const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---- the worklist: open invoices to plan ----
//
// Filterable by customer, which is the way Treasury actually works -- you ring one customer and
// settle every invoice of theirs in one call, rather than working down a mixed list.
router.get('/open', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, customer_id: customerId, forecast } = req.query;
    const where = [OPEN_INVOICE];
    const params = [];

    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
    // Which half of the worklist to show: what still needs planning, or what has been planned.
    if (forecast === 'unset') where.push('si.collection_forecast_date IS NULL');
    if (forecast === 'set') where.push('si.collection_forecast_date IS NOT NULL');
    if (search) {
      where.push('(si.invoice_no LIKE ? OR c.name LIKE ? OR si.po_no LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const baseFrom = `FROM sales_invoices si
       JOIN sales_orders so ON so.id = si.sales_order_id
       JOIN customers c ON c.id = so.customer_id
       LEFT JOIN users fu ON fu.id = si.collection_forecast_set_by_user_id`;
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(si.amount_due), 0) AS outstanding ${baseFrom} ${whereSql}`,
      params,
    );
    const page = clampPage(req.query.page);
    const limit = clampLimit(req.query.limit);
    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.po_no,
              si.gross_amount, si.amount_due, si.status,
              si.collection_forecast_date, si.collection_forecast_set_at,
              fu.display_name AS collection_forecast_set_by,
              c.id AS customer_id, c.name AS customer_name
       ${baseFrom} ${whereSql}
       ORDER BY si.date_due IS NULL, si.date_due ASC, si.id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    return res.json({
      rows,
      total: Number(totals.total) || 0,
      outstanding: Number(totals.outstanding) || 0,
      page,
      limit,
    });
  } catch (err) {
    return next(err);
  }
});

// The customers who have anything open, for the filter. Only those with open invoices: a picker
// listing all 21,718 customers when 300-odd owe anything is a list nobody can use.
router.get('/customers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.name, COUNT(*) AS open_invoices, COALESCE(SUM(si.amount_due), 0) AS outstanding
         FROM sales_invoices si
         JOIN sales_orders so ON so.id = si.sales_order_id
         JOIN customers c ON c.id = so.customer_id
        WHERE ${OPEN_INVOICE}
        GROUP BY c.id, c.name
        ORDER BY c.name`,
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ---- setting the forecast, in bulk ----
//
// Bulk because that is the actual task: one call to a customer settles when every one of their
// open invoices is expected, and setting them one at a time would be the same decision typed
// ten times. A null date clears the forecast, which is how a plan gets withdrawn.
router.put('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { invoice_ids: invoiceIds, forecast_date: forecastDate } = req.body;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one invoice.' });
    }
    if (forecastDate !== null && forecastDate !== '' && !isIsoDate(forecastDate)) {
      return res.status(400).json({ error: 'Enter a valid forecast date.' });
    }
    const date = forecastDate === '' ? null : forecastDate;

    // Only ever open invoices. Without this an id for a settled or cancelled invoice -- stale
    // because someone else collected it while this list sat open -- would still be stamped with
    // a collection date, putting money on the calendar that has already arrived.
    const [result] = await pool.query(
      `UPDATE sales_invoices si
          SET si.collection_forecast_date = ?,
              si.collection_forecast_set_by_user_id = ?,
              si.collection_forecast_set_at = ?
        WHERE si.id IN (?) AND ${OPEN_INVOICE}`,
      [date, date ? req.user.id : null, date ? new Date() : null, invoiceIds],
    );
    return res.json({
      updated: result.affectedRows,
      // Said plainly rather than swallowed: the caller asked for n and got fewer, and the
      // difference is invoices that stopped being open since the list was drawn.
      skipped: invoiceIds.length - result.affectedRows,
      forecast_date: date,
    });
  } catch (err) {
    return next(err);
  }
});

// ---- the calendar: a month of expected collections ----
//
// Grouped by DAY then by CUSTOMER, because the question the calendar answers is "who is paying
// us on the 23rd and how much", not "which invoice numbers". Each customer carries its invoice
// count and total so the day reads at a glance, and the invoices themselves ride along so the
// day popup can expand a customer without another request per row.
router.get('/calendar', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    const start = `${month}-01`;
    // Last day of the month, worked out by asking for day 0 of the next one.
    const [y, m] = month.split('-').map(Number);
    const endDate = new Date(y, m, 0);
    const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    const { customer_id: customerId } = req.query;
    const where = [OPEN_INVOICE, 'si.collection_forecast_date BETWEEN ? AND ?'];
    const params = [start, end];
    if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }

    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.amount_due,
              si.collection_forecast_date, c.id AS customer_id, c.name AS customer_name
         FROM sales_invoices si
         JOIN sales_orders so ON so.id = si.sales_order_id
         JOIN customers c ON c.id = so.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.name, si.date_due IS NULL, si.date_due, si.id`,
      params,
    );

    // Shaped here rather than in the client so the calendar and its popup can never disagree
    // about a day's total -- they read the same numbers.
    const days = new Map();
    for (const r of rows) {
      const key = String(r.collection_forecast_date).slice(0, 10);
      if (!days.has(key)) days.set(key, new Map());
      const byCustomer = days.get(key);
      if (!byCustomer.has(r.customer_id)) {
        byCustomer.set(r.customer_id, {
          customerId: r.customer_id, customerName: r.customer_name, invoiceCount: 0, total: 0, invoices: [],
        });
      }
      const group = byCustomer.get(r.customer_id);
      group.invoiceCount += 1;
      group.total += Number(r.amount_due) || 0;
      group.invoices.push({
        id: r.id,
        invoiceNo: r.invoice_no,
        dateCreated: String(r.date_created).slice(0, 10),
        dateDue: r.date_due ? String(r.date_due).slice(0, 10) : null,
        amountDue: Number(r.amount_due) || 0,
      });
    }

    const calendar = [...days.entries()]
      .map(([day, byCustomer]) => {
        const customers = [...byCustomer.values()].sort((a, b) => b.total - a.total);
        return {
          day,
          customers,
          invoiceCount: customers.reduce((s, x) => s + x.invoiceCount, 0),
          total: customers.reduce((s, x) => s + x.total, 0),
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day));

    return res.json({
      month,
      calendar,
      invoiceCount: rows.length,
      total: calendar.reduce((s, d) => s + d.total, 0),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
