const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { insertNumbered } = require('../lib/docNumber');
const { outstandingMovements, movement, bookBalance } = require('../lib/bankLedger');
const { proposeMatches, reconciliationSummary } = require('../lib/bankMatching');

const router = express.Router();
const ROUTE = '/accounting/bank-reconciliation';

// Bank Reconciliation. Import the statement, let the system propose a match for each line, have a
// person confirm those proposals, then -- and only then -- reconcile.
//
// The rule the whole feature turns on: NOTHING IS CLEARED UNTIL A PERSON SAYS SO. Every proposal
// lands unconfirmed, and finishing is refused while any remains unreviewed or the difference is
// not zero. See lib/bankMatching.js for how proposals are arrived at, and lib/bankLedger.js for
// where the book side comes from (the documents, not the GL -- measured, see create script).

const trunc = (v, n) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
const money = (v) => Number(Number(v || 0).toFixed(2));

// Statement files arrive as a data URL, the way every other upload in this system does, and are
// parsed server-side. exceljs reads both .xlsx and .csv, so no new dependency and no format lock:
// the importer is told which column means what rather than assuming one bank's layout, because
// these 49 accounts span EWB, BPI, BDO, CBC and Security Bank and no two will agree.
async function parseStatement(dataUrl, fileName) {
  const base64 = String(dataUrl).split(',')[1];
  if (!base64) throw Object.assign(new Error('That file could not be read.'), { status: 400 });
  const buffer = Buffer.from(base64, 'base64');

  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName || '')) {
    const { Readable } = require('stream');
    await workbook.csv.read(Readable.from(buffer.toString('utf8')));
  } else {
    await workbook.xlsx.load(buffer);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw Object.assign(new Error('That file has no sheets.'), { status: 400 });

  const rows = [];
  sheet.eachRow((row) => {
    // .values is 1-based with a leading hole; slice it off so column 1 is index 0.
    rows.push(row.values.slice(1).map((v) => {
      if (v == null) return '';
      if (typeof v === 'object' && v.richText) return v.richText.map((t) => t.text).join('');
      if (typeof v === 'object' && v.text) return v.text;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return v;
    }));
  });
  return rows;
}

// A cell that is meant to be a number, however the bank wrote it: "1,234.56", "(1,234.56)" for a
// negative, a bare number, or blank. Parentheses are accounting notation for negative and are the
// single commonest way a naive parser gets the SIGN of a whole statement backwards.
function num(cell) {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'number') return cell;
  let s = String(cell).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/[(),\s₱$]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

// Excel dates arrive as Date objects (already stringified above), CSV dates as text in whatever
// order the bank likes. Day-first and month-first are told apart where possible; where they are
// genuinely ambiguous the ISO form the sheet gave is preferred.
function asDate(cell) {
  if (!cell) return null;
  const s = String(cell).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = `20${y}`;
    // A value above 12 can only be the day, which settles the order without guessing.
    const day = Number(a) > 12 ? a : b;
    const month = Number(a) > 12 ? b : a;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Listing and lookups                                                         */
/* -------------------------------------------------------------------------- */

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.account_id) { where.push('r.account_id = ?'); params.push(req.query.account_id); }
    if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }

    const [rows] = await pool.query(
      `SELECT r.id, r.recon_no, r.statement_date, r.opening_balance, r.statement_balance, r.status,
              r.reconciled_at, r.created_at,
              a.account_code, a.account_name,
              u.display_name AS reconciled_by_name,
              (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.reconciliation_id = r.id) AS line_count,
              (SELECT COUNT(*) FROM bank_statement_lines l
                WHERE l.reconciliation_id = r.id AND l.status IN ('confirmed', 'bank_only', 'ignored')) AS settled_count
         FROM bank_reconciliations r
         JOIN chart_of_accounts a ON a.id = r.account_id
         LEFT JOIN users u ON u.id = r.reconciled_by_user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.statement_date DESC, r.id DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The bank accounts that can be reconciled, with where each one got to last time -- so the next
// statement's opening balance is not a figure somebody has to go and look up.
//
// POSTABLE ACCOUNTS, not active ones, and the distinction matters here more than anywhere.
// Filtering on is_active returns the twelve SUMMARY headers -- "Eastwest Bank", "Bank of the
// Philippine Islands" -- which are the only bank rows flagged active, and which hold no
// transactions whatsoever. The accounts that actually carry the cheques and deposits, like
// 11301 EWB Disb Acct. 200001413952 with its 9,610 cheques, are all is_active = 0.
//
// So the rule is the one routes/cheques.js already uses to fill its own bank picker: everything
// that is not a summary. Same accounts, same list, nothing to reconcile that cannot be paid from.
router.get('/meta/accounts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.account_code, a.account_name,
              (SELECT r.statement_balance FROM bank_reconciliations r
                WHERE r.account_id = a.id AND r.status = 'reconciled'
                ORDER BY r.statement_date DESC, r.id DESC LIMIT 1) AS last_statement_balance,
              (SELECT r.statement_date FROM bank_reconciliations r
                WHERE r.account_id = a.id AND r.status = 'reconciled'
                ORDER BY r.statement_date DESC, r.id DESC LIMIT 1) AS last_statement_date
         FROM chart_of_accounts a
        WHERE a.detail_type = 'Bank' AND (a.is_summary = 0 OR a.is_summary IS NULL)
        ORDER BY a.account_code`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------------------- */
/* Opening one                                                                 */
/* -------------------------------------------------------------------------- */

// Everything the working screen needs: the statement, what each line is matched to, and the book
// movements still outstanding.
async function loadWorkspace(id) {
  const [[recon]] = await pool.query(
    `SELECT r.*, a.account_code, a.account_name,
            u.display_name AS reconciled_by_name, c.display_name AS created_by_name
       FROM bank_reconciliations r
       JOIN chart_of_accounts a ON a.id = r.account_id
       LEFT JOIN users u ON u.id = r.reconciled_by_user_id
       LEFT JOIN users c ON c.id = r.created_by_user_id
      WHERE r.id = ?`, [id]);
  if (!recon) return null;

  const [lines] = await pool.query(
    'SELECT * FROM bank_statement_lines WHERE reconciliation_id = ? ORDER BY line_no', [id]);
  const [matches] = await pool.query(
    `SELECT m.*, u.display_name AS confirmed_by_name
       FROM bank_reconciliation_matches m
       LEFT JOIN users u ON u.id = m.confirmed_by_user_id
      WHERE m.reconciliation_id = ?`, [id]);

  // This reconciliation's own matched documents must stay visible while it is being worked on,
  // which is what includeReconciliationId does -- everything cleared on ANY OTHER reconciliation
  // is correctly gone.
  const movements = await outstandingMovements(recon.account_id, {
    asOf: recon.statement_date, includeReconciliationId: recon.id,
  });

  const byKey = new Map(movements.map((m) => [`${m.source_kind}:${m.source_id}`, m]));
  const matchByLine = new Map();
  for (const m of matches) {
    m.document = byKey.get(`${m.source_kind}:${m.source_id}`) || null;
    if (m.statement_line_id) matchByLine.set(String(m.statement_line_id), m);
  }
  for (const l of lines) l.match = matchByLine.get(String(l.id)) || null;

  // Outstanding = a book movement no match in this reconciliation has claimed. Those are the
  // deposits in transit and unpresented cheques the statement is reconciled by.
  const claimed = new Set(matches.map((m) => `${m.source_kind}:${m.source_id}`));
  const outstanding = movements.filter((m) => !claimed.has(`${m.source_kind}:${m.source_id}`));

  const book = await bookBalance(recon.account_id, recon.statement_date);
  const summary = reconciliationSummary({
    statementBalance: recon.statement_balance, bookBalance: book, outstanding,
  });

  // What still needs a person. Finishing is refused while this is non-zero.
  const awaiting = lines.filter((l) => l.status === 'matched' || l.status === 'unmatched').length;

  return { ...recon, lines, outstanding, summary, awaiting_review: awaiting };
}

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await loadWorkspace(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    return res.json(data);
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Starting one                                                                */
/* -------------------------------------------------------------------------- */

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const accountId = Number(req.body.account_id);
    const statementDate = trunc(req.body.statement_date, 10);
    if (!accountId) return res.status(400).json({ error: 'Choose a bank account.' });
    if (!statementDate) return res.status(400).json({ error: 'Enter the statement date.' });

    const [[account]] = await conn.query(
      "SELECT id FROM chart_of_accounts WHERE id = ? AND detail_type = 'Bank'", [accountId]);
    if (!account) return res.status(400).json({ error: 'That is not a bank account.' });

    // One open reconciliation per account at a time. Two people working the same account from
    // different statements would each see the other's matches as already claimed.
    const [[open]] = await conn.query(
      "SELECT recon_no FROM bank_reconciliations WHERE account_id = ? AND status = 'open' LIMIT 1", [accountId]);
    if (open) {
      return res.status(409).json({ error: `${open.recon_no} is still open on this account. Finish or delete it first.` });
    }

    await conn.beginTransaction();
    const { id, no } = await insertNumbered(conn, {
      table: 'bank_reconciliations', column: 'recon_no', prefix: 'BREC-',
      run: (docNo) => conn.query(
        `INSERT INTO bank_reconciliations
           (recon_no, account_id, statement_date, opening_balance, statement_balance, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [docNo, accountId, statementDate, money(req.body.opening_balance), money(req.body.statement_balance), req.user.id],
      ),
    });
    await conn.commit();
    return res.status(201).json({ id, recon_no: no });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

// Preview an uploaded file without committing to it -- the first rows, so the importer can be told
// which column is the date, which the amount, and so on. Nothing is stored.
router.post('/preview', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const rows = await parseStatement(req.body.data, req.body.file_name);
    res.json({
      total_rows: rows.length,
      columns: Math.max(...rows.map((r) => r.length), 0),
      rows: rows.slice(0, 15),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* Importing and matching                                                      */
/* -------------------------------------------------------------------------- */

// mapping: { date, description, reference, amount } or { date, description, reference, debit, credit }
// -- zero-based column indexes. `skip_rows` drops the header rows the bank puts on top.
router.post('/:id/import', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[recon]] = await conn.query('SELECT * FROM bank_reconciliations WHERE id = ?', [req.params.id]);
    if (!recon) return res.status(404).json({ error: 'Not found' });
    if (recon.status !== 'open') return res.status(409).json({ error: 'This reconciliation is already finished.' });

    const map = req.body.mapping || {};
    if (map.amount === undefined && map.debit === undefined && map.credit === undefined) {
      return res.status(400).json({ error: 'Say which column holds the amount.' });
    }
    if (map.date === undefined) return res.status(400).json({ error: 'Say which column holds the date.' });

    const rows = await parseStatement(req.body.data, req.body.file_name);
    const skip = Number(req.body.skip_rows) || 0;
    const body = rows.slice(skip);

    const pick = (row, idx) => (idx === undefined || idx === null || idx === '' ? null : row[Number(idx)]);

    const lines = [];
    for (const row of body) {
      const date = asDate(pick(row, map.date));
      let amount;
      if (map.amount !== undefined && map.amount !== '') {
        amount = num(pick(row, map.amount));
      } else {
        // Separate debit and credit columns. Debit on a bank statement is money LEAVING the
        // account, so it becomes negative here -- the same sign convention the book side uses.
        const debit = num(pick(row, map.debit)) || 0;
        const credit = num(pick(row, map.credit)) || 0;
        amount = credit - Math.abs(debit);
      }
      // A row with no date or no amount is a subtotal, a heading or a blank -- not a transaction.
      if (!date || amount === null || amount === 0) continue;
      lines.push({
        txn_date: date,
        description: trunc(pick(row, map.description), 500),
        reference: trunc(pick(row, map.reference), 120),
        amount: money(amount),
        raw_row: JSON.stringify(row).slice(0, 65000),
      });
    }

    if (!lines.length) {
      return res.status(400).json({ error: 'No transaction rows were found with that column mapping.' });
    }

    await conn.beginTransaction();
    // Re-importing replaces what was there. Its matches go with it (ON DELETE CASCADE), which is
    // what releases those documents to be claimed again -- a half-imported statement left behind
    // would hold documents hostage on a reconciliation nobody is working.
    await conn.query('DELETE FROM bank_statement_lines WHERE reconciliation_id = ?', [req.params.id]);
    let n = 0;
    for (const l of lines) {
      n += 1;
      await conn.query(
        `INSERT INTO bank_statement_lines
           (reconciliation_id, line_no, txn_date, description, reference, amount, raw_row)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.params.id, n, l.txn_date, l.description, l.reference, l.amount, l.raw_row],
      );
    }
    await conn.query(
      'UPDATE bank_reconciliations SET statement_file_name = ?, imported_at = NOW(), updated_at = NOW() WHERE id = ?',
      [trunc(req.body.file_name, 255), req.params.id],
    );
    await conn.commit();

    const matched = await runMatching(req.params.id);
    return res.json({ imported: n, ...matched });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  } finally {
    conn.release();
  }
});

// Propose a match for every line still awaiting one. Confirmed lines are left alone, so re-running
// never undoes somebody's review.
async function runMatching(reconciliationId) {
  const [[recon]] = await pool.query('SELECT * FROM bank_reconciliations WHERE id = ?', [reconciliationId]);
  const [lines] = await pool.query(
    "SELECT * FROM bank_statement_lines WHERE reconciliation_id = ? AND status IN ('unmatched', 'matched') ORDER BY line_no",
    [reconciliationId]);

  // Clear only the UNCONFIRMED proposals before re-proposing.
  await pool.query(
    `DELETE m FROM bank_reconciliation_matches m
       JOIN bank_statement_lines l ON l.id = m.statement_line_id
      WHERE m.reconciliation_id = ? AND m.confirmed_at IS NULL`, [reconciliationId]);

  const movements = await outstandingMovements(recon.account_id, {
    asOf: recon.statement_date, includeReconciliationId: recon.id,
  });
  // Documents already confirmed on this reconciliation are not available to propose again.
  const [confirmed] = await pool.query(
    'SELECT source_kind, source_id FROM bank_reconciliation_matches WHERE reconciliation_id = ? AND confirmed_at IS NOT NULL',
    [reconciliationId]);
  const taken = new Set(confirmed.map((c) => `${c.source_kind}:${c.source_id}`));
  const available = movements.filter((m) => !taken.has(`${m.source_kind}:${m.source_id}`));

  const { proposals } = proposeMatches(lines, available);

  for (const p of proposals) {
    // The unique key on (source_kind, source_id) is the backstop: if another reconciliation
    // claimed this document between the read and the write, the insert is refused and the line
    // simply stays unmatched rather than clearing something twice.
    try {
      await pool.query(
        `INSERT INTO bank_reconciliation_matches
           (reconciliation_id, statement_line_id, source_kind, source_id, amount, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [reconciliationId, p.statement_line_id, p.source_kind, p.source_id, p.amount, p.confidence],
      );
      await pool.query("UPDATE bank_statement_lines SET status = 'matched' WHERE id = ?", [p.statement_line_id]);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }

  const byConfidence = proposals.reduce((acc, p) => ({ ...acc, [p.confidence]: (acc[p.confidence] || 0) + 1 }), {});
  return { proposed: proposals.length, by_confidence: byConfidence, unmatched: lines.length - proposals.length };
}

router.post('/:id/rematch', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[recon]] = await pool.query('SELECT status FROM bank_reconciliations WHERE id = ?', [req.params.id]);
    if (!recon) return res.status(404).json({ error: 'Not found' });
    if (recon.status !== 'open') return res.status(409).json({ error: 'This reconciliation is already finished.' });
    return res.json(await runMatching(req.params.id));
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Reviewing                                                                   */
/* -------------------------------------------------------------------------- */

// Confirm a proposed match -- this is the act the whole feature is built around.
router.post('/:id/lines/:lineId/confirm', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[line]] = await pool.query(
      'SELECT * FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?', [req.params.lineId, req.params.id]);
    if (!line) return res.status(404).json({ error: 'Not found' });

    const [[match]] = await pool.query(
      'SELECT * FROM bank_reconciliation_matches WHERE statement_line_id = ?', [line.id]);
    if (!match) return res.status(400).json({ error: 'There is nothing matched to this line yet.' });

    await pool.query(
      'UPDATE bank_reconciliation_matches SET confirmed_at = NOW(), confirmed_by_user_id = ? WHERE id = ?',
      [req.user.id, match.id]);
    await pool.query("UPDATE bank_statement_lines SET status = 'confirmed' WHERE id = ?", [line.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Reject a proposal: the line goes back to unmatched and the document is released.
router.post('/:id/lines/:lineId/reject', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[line]] = await pool.query(
      'SELECT * FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?', [req.params.lineId, req.params.id]);
    if (!line) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM bank_reconciliation_matches WHERE statement_line_id = ?', [line.id]);
    await pool.query("UPDATE bank_statement_lines SET status = 'unmatched' WHERE id = ?", [line.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// Match a line to a document by hand, for what the matcher could not work out.
router.post('/:id/lines/:lineId/match', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[recon]] = await pool.query('SELECT * FROM bank_reconciliations WHERE id = ?', [req.params.id]);
    if (!recon) return res.status(404).json({ error: 'Not found' });
    if (recon.status !== 'open') return res.status(409).json({ error: 'This reconciliation is already finished.' });

    const [[line]] = await pool.query(
      'SELECT * FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?', [req.params.lineId, req.params.id]);
    if (!line) return res.status(404).json({ error: 'Not found' });

    const { source_kind: kind, source_id: sourceId } = req.body;
    // The amount is read from the DOCUMENT, never taken from the browser -- otherwise a
    // reconciliation could be balanced by sending a figure that suits.
    const doc = await movement(recon.account_id, kind, sourceId);
    if (!doc) return res.status(400).json({ error: 'That document is not on this bank account.' });

    await pool.query('DELETE FROM bank_reconciliation_matches WHERE statement_line_id = ?', [line.id]);
    try {
      await pool.query(
        `INSERT INTO bank_reconciliation_matches
           (reconciliation_id, statement_line_id, source_kind, source_id, amount, confidence, confirmed_at, confirmed_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'manual', NOW(), ?)`,
        [req.params.id, line.id, kind, sourceId, doc.amount, req.user.id],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'That document has already been cleared on another reconciliation.' });
      }
      throw err;
    }
    await pool.query("UPDATE bank_statement_lines SET status = 'confirmed' WHERE id = ?", [line.id]);
    return res.json({ ok: true, amount: doc.amount });
  } catch (err) { return next(err); }
});

// A line that is the bank's own doing -- a charge, interest, a debit memo. It has no document
// because none was ever raised; it is accounted for by naming the account it belongs to.
router.post('/:id/lines/:lineId/bank-only', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[line]] = await pool.query(
      'SELECT * FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?', [req.params.lineId, req.params.id]);
    if (!line) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM bank_reconciliation_matches WHERE statement_line_id = ?', [line.id]);
    await pool.query(
      "UPDATE bank_statement_lines SET status = 'bank_only', bank_only_account_id = ?, note = ? WHERE id = ?",
      [req.body.account_id || null, trunc(req.body.note, 255), line.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Finishing                                                                   */
/* -------------------------------------------------------------------------- */

router.post('/:id/reconcile', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const data = await loadWorkspace(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    if (data.status !== 'open') return res.status(409).json({ error: 'This reconciliation is already finished.' });
    if (!data.lines.length) return res.status(409).json({ error: 'Import the statement first.' });

    // Two conditions, and both are the point of the exercise.
    if (data.awaiting_review > 0) {
      return res.status(409).json({
        error: `${data.awaiting_review} statement line(s) still need review. Confirm each match, or mark the line as a bank charge.`,
      });
    }
    if (!data.summary.balanced) {
      return res.status(409).json({
        error: `This does not balance yet -- a difference of ${data.summary.difference.toFixed(2)} remains.`,
      });
    }

    await pool.query(
      `UPDATE bank_reconciliations
          SET status = 'reconciled', reconciled_at = NOW(), reconciled_by_user_id = ?, updated_at = NOW()
        WHERE id = ?`, [req.user.id, req.params.id]);
    return res.json({ ok: true, status: 'reconciled' });
  } catch (err) { return next(err); }
});

// Reopening releases nothing but the lock: the matches stay, so reopening to fix one line does not
// throw away the review of the other four hundred.
router.post('/:id/reopen', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const [[recon]] = await pool.query('SELECT status FROM bank_reconciliations WHERE id = ?', [req.params.id]);
    if (!recon) return res.status(404).json({ error: 'Not found' });
    if (recon.status !== 'reconciled') return res.status(409).json({ error: 'This one is not finished.' });
    await pool.query(
      `UPDATE bank_reconciliations
          SET status = 'open', reopened_at = NOW(), reopened_by_user_id = ?, updated_at = NOW()
        WHERE id = ?`, [req.user.id, req.params.id]);
    return res.json({ ok: true, status: 'open' });
  } catch (err) { return next(err); }
});

// Deleting an unfinished one releases every document it had claimed (ON DELETE CASCADE on the
// matches), so a false start does not hold cheques hostage.
router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[recon]] = await pool.query('SELECT status FROM bank_reconciliations WHERE id = ?', [req.params.id]);
    if (!recon) return res.status(404).json({ error: 'Not found' });
    if (recon.status === 'reconciled') {
      return res.status(409).json({ error: 'A finished reconciliation cannot be deleted. Reopen it first.' });
    }
    await pool.query('DELETE FROM bank_reconciliations WHERE id = ?', [req.params.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* The statement                                                               */
/* -------------------------------------------------------------------------- */

router.get('/:id/export', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const data = await loadWorkspace(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Reconciliation');
    sheet.columns = [{ width: 14 }, { width: 18 }, { width: 44 }, { width: 18 }];

    const put = (a, b, c, d, bold = false) => {
      const row = sheet.addRow([a, b, c, d]);
      if (bold) row.font = { bold: true };
      return row;
    };
    put(`${data.account_code} ${data.account_name}`, '', '', '', true);
    put(`Bank Reconciliation as at ${String(data.statement_date).slice(0, 10)}`, '', '', '', true);
    put(data.recon_no, '', '', '');
    sheet.addRow([]);

    const s = data.summary;
    put('Balance per bank statement', '', '', s.statement_balance, true);
    put('Add: deposits in transit', '', '', s.deposits_in_transit);
    put('Less: outstanding cheques and payments', '', '', -s.outstanding_payments);
    put('Adjusted bank balance', '', '', s.adjusted_bank_balance, true);
    put('Balance per book', '', '', s.book_balance, true);
    put('Difference', '', '', s.difference, true);
    sheet.addRow([]);

    put('OUTSTANDING ITEMS', '', '', '', true);
    put('Date', 'Document', 'Payee / Memo', 'Amount', true);
    for (const m of data.outstanding) {
      put(String(m.txn_date).slice(0, 10), m.doc_no, m.party || m.memo || '', Number(m.amount));
    }
    sheet.addRow([]);

    const bankOnly = data.lines.filter((l) => l.status === 'bank_only');
    if (bankOnly.length) {
      put('BANK CHARGES AND OTHER BANK-ONLY ITEMS', '', '', '', true);
      put('Date', 'Reference', 'Description', 'Amount', true);
      for (const l of bankOnly) {
        put(String(l.txn_date).slice(0, 10), l.reference || '', l.description || '', Number(l.amount));
      }
    }

    sheet.getColumn(4).numFmt = '#,##0.00';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${data.recon_no}-${String(data.statement_date).slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  } catch (err) { return next(err); }
});

module.exports = router;
