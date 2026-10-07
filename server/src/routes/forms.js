const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { insertNumbered } = require('../lib/docNumber');
const { computeLiquidationGl } = require('../lib/glImpact');
const {
  DEPARTMENT_NOTED_TYPES, isDepartmentNoter, departmentsHeadedBy, notersFor,
  AP_NOTED_TYPES, isAccountsPayable, notersForDoc,
} = require('../lib/formNoters');

const router = express.Router();

// Forms -- the request forms ported from the Booking system's Request module. Four printed company
// forms sharing one approval chain. See db/create-forms.js for the schema and what changed in the
// port.
//
//   draft -> submitted -> noted -> approved
//                     \-> rejected -> (owner edits) -> back to noted or submitted
//
// EVERY STEP IS REQUIRED. Approving reads only from NOTED, so a department head's sign-off cannot
// be skipped by whoever approves. The source allowed submitted -> approved directly; it does not
// here. A form from a department with no head recorded therefore has nowhere to go until one is,
// which is why the refusal says so by name.
//
// TWO PAGES GATE THIS, and the split is the point:
//
//   /forms           the person filing. can_add raises and submits, can_edit revises, can_delete
//                    discards a draft, can_print prints, can_view_all widens "my forms" to all.
//   /forms/approval  the people ruling. can_edit NOTES, can_approve APPROVES or REJECTS.
//
// The source gated these on roles -- 'unitadmin' noted, 'administrator' approved. Two actions on
// the approval page say the same thing in the vocabulary this system already has, and keep the two
// stages separately grantable.
//
// EXCEPT FOR NOTING A LIQUIDATION OR A PAYMENT, which is not a permission at all: it is the head
// of the department the form came from, read off that department's ticket approver list. A
// permission cannot express "for YOUR department only", and an expense claim noted by the head of
// some other department is not the sign-off anybody wanted. See lib/formNoters.js.
//
// So a head needs no grant on /forms/approval to note their own department's forms, and holding
// can_edit there does NOT let somebody note a liquidation from a department they do not head.
const ROUTE = '/forms';
const APPROVAL_ROUTE = '/forms/approval';

const TYPES = ['liquidation', 'payment', 'fund_transfer', 'business_trip', 'revolving_fund'];
const TYPE_LABELS = {
  liquidation: 'Liquidation',
  payment: 'Request for Payment',
  fund_transfer: 'RFP (Fund Transfer)',
  business_trip: 'Business Trip',
  revolving_fund: 'Revolving Fund',
};

// The six purposes printed on the liquidation form. 'others' is the one that carries free text.
const PURPOSES = [
  'business_travel_allowance', 'mobilization_installation', 'site_inspection',
  'representation', 'employees_benefit', 'others',
];

// A form that has left the owner's hands. Everything an approver can act on.
// RFP (Fund Transfer) is a Request for Payment plus the bank it is paid from and the bank it goes to
// (2026-10-07): same details table, same approval path; only From and To are added.
const PAYMENT_TYPES = ['payment', 'fund_transfer'];

// The accounts From / To may name: the actual bank accounts under Cash in Bank (11000), each with the
// bank it sits under. Not the Cash on Hand funds (also typed "Bank"), and not the summary headings
// that only group accounts. is_active is not consulted: every bank account in the chart reads
// inactive (an import artifact, 2026-10-07), and the accounting Fund Transfer lists them all too.
const BANK_ACCOUNTS_SQL = `
  SELECT a.id, a.account_code, a.account_name, COALESCE(IF(p.account_code = '11000', NULL, p.account_name), a.account_name) AS bank_name
    FROM chart_of_accounts a
    JOIN chart_of_accounts p ON p.id = a.parent_account_id
    LEFT JOIN chart_of_accounts gp ON gp.id = p.parent_account_id
   WHERE a.detail_type = 'Bank' AND COALESCE(a.is_summary, 0) = 0
     AND (p.account_code = '11000' OR gp.account_code = '11000')`;

const WORKFLOW_STATUSES = ['submitted', 'noted', 'approved', 'rejected'];

const trunc = (v, n) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
// Dates arrive as 'YYYY-MM-DD' from a date input, or blank. A blank must be NULL, not '' -- MySQL
// would store '0000-00-00' for the latter and the printed form would show a date nobody entered.
const date = (v) => (v == null || String(v).trim() === '' ? null : String(v).slice(0, 10));
const time = (v) => (v == null || String(v).trim() === '' ? null : String(v).slice(0, 5));

function badType(type) {
  return !TYPES.includes(type);
}

// The department picker sends a NAME, since that is what prints. Exact match only: a fuzzy match
// would route somebody's expense claim to the head of a department it never came from, which is
// worse than leaving it unrouted and saying so.
async function resolveDepartmentId(q, name) {
  if (!name) return null;
  const [[d]] = await q.query('SELECT id FROM departments WHERE name = ? LIMIT 1', [name]);
  return d ? d.id : null;
}

// Items are required on the three money forms and meaningless on a business trip. Returns an error
// string or null, so the caller answers with one 400 rather than a chain of ifs.
function readItems(body, { required }) {
  const rows = Array.isArray(body.items) ? body.items : [];
  const clean = rows
    .map((r) => ({
      item_date: date(r.date ?? r.item_date),
      particulars: trunc(r.particulars, 255),
      amount: num(r.amount),
    }))
    .filter((r) => r.particulars || r.amount);

  if (required && clean.length === 0) return { error: 'Add at least one line.' };
  for (const r of clean) {
    if (!r.particulars) return { error: 'Every line needs particulars.' };
    if (r.amount == null || !Number.isFinite(r.amount)) return { error: `Line "${r.particulars}" needs an amount.` };
    if (r.amount < 0) return { error: `Line "${r.particulars}" cannot be a negative amount.` };
  }
  return { items: clean };
}

// Sum of the lines, and what is left of the starting balance after them. Computed here rather than
// taken from the form: these two numbers appear on the printed document and must agree with the
// lines above them, which they cannot if somebody types them by hand.
function totals(items, startingBalance) {
  const spent = Number(items.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2));
  const start = Number(startingBalance || 0);
  return { reimbursement_amount: spent, ending_balance: Number((start - spent).toFixed(2)) };
}

async function loadFull(id) {
  const [[doc]] = await pool.query(
    `SELECT f.*, u.display_name AS owner_name, u.username AS owner_username,
            nu.display_name AS noted_by_name, au.display_name AS approved_by_name,
            ru.display_name AS rejected_by_name,
            ca.account_code AS credit_account_code, ca.account_name AS credit_account_name
       FROM form_requests f
       LEFT JOIN chart_of_accounts ca ON ca.id = f.credit_account_id
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN users nu ON nu.id = f.noted_by
       LEFT JOIN users au ON au.id = f.approved_by
       LEFT JOIN users ru ON ru.id = f.rejected_by
      WHERE f.id = ?`, [id],
  );
  if (!doc) return null;

  const [items] = await pool.query(
    `SELECT i.id, i.item_date, i.particulars, i.amount, i.rejection_remark, i.cogs_account_id,
            a.account_code AS cogs_account_code, a.account_name AS cogs_account_name
       FROM form_request_items i LEFT JOIN chart_of_accounts a ON a.id = i.cogs_account_id
      WHERE i.form_request_id = ? ORDER BY i.id`,
    [id]);
  doc.items = items;

  if (doc.type === 'liquidation') {
    const [[d]] = await pool.query('SELECT * FROM form_liquidation_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
    const [p] = await pool.query(
      'SELECT purpose, other_text FROM form_liquidation_purposes WHERE form_request_id = ? ORDER BY id', [id]);
    doc.purposes = p;
  } else if (PAYMENT_TYPES.includes(doc.type)) {
    const [[d]] = await pool.query(
      `SELECT d.*, fa.account_code AS from_account_code, fa.account_name AS from_account_name,
              ta.account_code AS to_account_code, ta.account_name AS to_account_name
         FROM form_payment_details d
         LEFT JOIN chart_of_accounts fa ON fa.id = d.from_account_id
         LEFT JOIN chart_of_accounts ta ON ta.id = d.to_account_id
        WHERE d.form_request_id = ?`, [id]);
    doc.detail = d || null;
  } else if (doc.type === 'revolving_fund') {
    const [[d]] = await pool.query('SELECT * FROM form_revolving_fund_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
  } else if (doc.type === 'business_trip') {
    const [[d]] = await pool.query('SELECT * FROM form_business_trip_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
  }
  return doc;
}

// Who may look at one form. Its owner always; anyone holding can_view_all on /forms; the approvers,
// who cannot rule on what they cannot read; and the head of the department it came from, for the
// same reason -- they are the one who has to note it.
async function maySee(userId, doc) {
  // Heading the department comes first because it is the one route in that does NOT depend on a
  // page grant -- a head may hold nothing on /forms and still have to note this.
  if (await isDepartmentNoter(userId, doc.department_id)) return true;
  // AP has to open every liquidation it notes, whoever's department it came from.
  if (AP_NOTED_TYPES.includes(doc.type) && await isAccountsPayable(userId)) return true;
  if (await userCan(userId, APPROVAL_ROUTE, 'can_view')) return true;
  if (await userCan(userId, ROUTE, 'can_view_all')) return true;
  // Your own form, provided you still hold the module at all.
  return doc.user_id === userId && userCan(userId, ROUTE, 'can_view');
}

// May this user note this particular form, and if not, why not? One answer used by the button, the
// endpoint and the explanation on screen, so the three cannot disagree.
async function mayNote(userId, doc) {
  // A liquidation is noted by Accounts Payable, and only once every item has its COGS account --
  // the COGS check is in the note route itself, so the screen can say what is missing.
  if (AP_NOTED_TYPES.includes(doc.type)) {
    if (await isAccountsPayable(userId)) return { allowed: true };
    const ap = await notersForDoc(doc);
    return {
      allowed: false,
      reason: ap.length
        ? `Only Accounts Payable can note a liquidation: ${ap.map((u) => u.display_name).join(' or ')}.`
        : 'Nobody is marked Accounts Payable, so nobody can note this. Tick "Accounts Payable" on the AP staff under Users & Permissions.',
    };
  }
  if (DEPARTMENT_NOTED_TYPES.includes(doc.type)) {
    if (!doc.department_id) {
      return {
        allowed: false,
        reason: doc.department
          ? `"${doc.department}" is not a department in this system, so nobody heads it. An approver can still approve this directly.`
          : 'This form has no department, so there is no head to note it. An approver can still approve it directly.',
      };
    }
    if (await isDepartmentNoter(userId, doc.department_id)) return { allowed: true };

    const heads = await notersFor(doc.department_id);
    return {
      allowed: false,
      reason: heads.length
        ? `Only the head of ${doc.department} can note this: ${heads.map((h) => h.display_name).join(' or ')}.`
        : `${doc.department} has no head recorded, so nobody can note this. Add one under that department's ticket approvers, or have an approver approve it directly.`,
    };
  }

  // Business trip and revolving fund keep the plain permission gate.
  if (await userCan(userId, APPROVAL_ROUTE, 'can_edit')) return { allowed: true };
  return { allowed: false, reason: 'You do not have permission to note this form.' };
}

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

// The owner's list. Shows your own forms, or everyone's if you hold can_view_all.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];

    if (!(await userCan(req.user.id, ROUTE, 'can_view_all'))) {
      where.push('f.user_id = ?');
      params.push(req.user.id);
    }
    if (req.query.status) { where.push('f.status = ?'); params.push(req.query.status); }
    if (req.query.type && TYPES.includes(req.query.type)) { where.push('f.type = ?'); params.push(req.query.type); }
    if (req.query.search) {
      where.push('(f.request_no LIKE ? OR f.name LIKE ? OR f.department LIKE ? OR u.display_name LIKE ?)');
      const like = `%${req.query.search}%`;
      params.push(like, like, like, like);
    }

    const [rows] = await pool.query(
      `SELECT f.id, f.request_no, f.type, f.status, f.department, f.name, f.created_at, f.submitted_at,
              u.display_name AS owner_name,
              (SELECT COALESCE(SUM(i.amount), 0) FROM form_request_items i WHERE i.form_request_id = f.id) AS total_amount
         FROM form_requests f
         LEFT JOIN users u ON u.id = f.user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY f.id DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The approval queue. Only what has actually been sent for a decision -- a draft is nobody's
// business but its owner's.
//
// Two ways in, because noting a liquidation is not a permission: either can_view on the approval
// page, which shows everything, or heading a department, which shows that department's forms. A
// head who had to be granted the whole approval page to find their own team's expense claims would
// also be granted sight of every other department's.
router.get('/approval/queue', requireAuth, async (req, res, next) => {
  try {
    const canSeeAll = await userCan(req.user.id, APPROVAL_ROUTE, 'can_view');
    const headOf = canSeeAll ? [] : await departmentsHeadedBy(req.user.id);
    // Accounts Payable sees every liquidation, since it notes them all.
    const isAp = canSeeAll ? false : await isAccountsPayable(req.user.id);
    if (!canSeeAll && headOf.length === 0 && !isAp) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }

    const where = ['f.status IN (?)'];
    const params = [WORKFLOW_STATUSES];
    if (!canSeeAll) {
      const mine = [];
      if (headOf.length) { mine.push('(f.department_id IN (?) AND f.type IN (?))'); params.push(headOf, DEPARTMENT_NOTED_TYPES); }
      if (isAp) { mine.push('f.type IN (?)'); params.push(AP_NOTED_TYPES); }
      where.push(`(${mine.join(' OR ')})`);
    }
    if (req.query.status && WORKFLOW_STATUSES.includes(req.query.status)) {
      where.push('f.status = ?'); params.push(req.query.status);
    }
    if (req.query.type && TYPES.includes(req.query.type)) { where.push('f.type = ?'); params.push(req.query.type); }

    const [rows] = await pool.query(
      `SELECT f.id, f.request_no, f.type, f.status, f.department, f.name, f.created_at, f.submitted_at, f.noted_at,
              u.display_name AS owner_name,
              (SELECT COALESCE(SUM(i.amount), 0) FROM form_request_items i WHERE i.form_request_id = f.id) AS total_amount
         FROM form_requests f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY FIELD(f.status, 'submitted', 'noted', 'rejected', 'approved'), f.id DESC`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The accounts a liquidation item can be charged to -- active, postable Expense accounts (cost of
// sales sits there in this chart). For Accounts Payable only, who assigns them.
// The Chart of Accounts for AP's two pickers on a liquidation -- each item's COGS account and the
// credit account. The WHOLE active chart (asked 2026-10-06: "wire it to chart of account"): the first
// cut filtered to account_type 'Expense' / is_summary = 0, which on the live chart returned nothing.
async function activeAccounts() {
  const [rows] = await pool.query(
    'SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE is_active = 1 ORDER BY account_code');
  return rows;
}
router.get('/meta/credit-accounts', requireAuth, async (req, res, next) => {
  try {
    if (!(await isAccountsPayable(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable sets this.' });
    res.json(await activeAccounts());
  } catch (err) { next(err); }
});

// The liquidation's credit account, while it waits to be noted. Empty = the default (13305).
router.put('/:id/credit-account', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, type, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!AP_NOTED_TYPES.includes(doc.type)) return res.status(409).json({ error: 'Only a liquidation has a credit account.' });
    if (!(await isAccountsPayable(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable sets this.' });
    if (doc.status !== 'submitted') return res.status(409).json({ error: 'The credit account can only be set while the liquidation is waiting to be noted.' });
    const accountId = req.body?.credit_account_id ? Number(req.body.credit_account_id) : null;
    if (accountId) {
      const [[acct]] = await pool.query(
        'SELECT id FROM chart_of_accounts WHERE id = ? AND is_active = 1', [accountId]);
      if (!acct) return res.status(400).json({ error: 'Choose an active account from the Chart of Accounts.' });
    }
    await pool.query('UPDATE form_requests SET credit_account_id = ?, updated_at = NOW() WHERE id = ?', [accountId, doc.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/meta/cogs-accounts', requireAuth, async (req, res, next) => {
  try {
    if (!(await isAccountsPayable(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable assigns COGS.' });
    res.json(await activeAccounts());
  } catch (err) { next(err); }
});

// Assign one liquidation item's COGS account (asked 2026-10-06). Accounts Payable, while the
// liquidation is waiting to be noted -- every item needs one before AP can note it.
router.put('/:id/items/:itemId/cogs', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, type, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!AP_NOTED_TYPES.includes(doc.type)) return res.status(409).json({ error: 'Only a liquidation\'s items take a COGS account.' });
    if (!(await isAccountsPayable(req.user.id))) return res.status(403).json({ error: 'Only Accounts Payable assigns COGS.' });
    if (doc.status !== 'submitted') return res.status(409).json({ error: 'COGS can only be assigned while the liquidation is waiting to be noted.' });
    const accountId = req.body?.cogs_account_id ? Number(req.body.cogs_account_id) : null;
    if (accountId) {
      const [[acct]] = await pool.query(
        'SELECT id FROM chart_of_accounts WHERE id = ? AND is_active = 1', [accountId]);
      if (!acct) return res.status(400).json({ error: 'Choose an active account from the Chart of Accounts.' });
    }
    const [r] = await pool.query(
      'UPDATE form_request_items SET cogs_account_id = ? WHERE id = ? AND form_request_id = ?',
      [accountId, req.params.itemId, doc.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/meta/options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // Departments come from the same list every other module uses, so a form's department is a
    // real one rather than whatever was typed that day.
    const [departments] = await pool.query('SELECT id, name FROM departments ORDER BY name');
    // From / To on an RFP (Fund Transfer): the bank accounts under Cash in Bank (BANK_ACCOUNTS_SQL).
    const [bankAccounts] = await pool.query(`${BANK_ACCOUNTS_SQL} ORDER BY a.account_code`);
    res.json({
      types: TYPES.map((t) => ({ key: t, label: TYPE_LABELS[t] })),
      purposes: PURPOSES,
      departments: departments.map((d) => d.name),
      bank_accounts: bankAccounts,
      can: {
        note: await userCan(req.user.id, APPROVAL_ROUTE, 'can_edit'),
        approve: await userCan(req.user.id, APPROVAL_ROUTE, 'can_approve'),
        view_all: await userCan(req.user.id, ROUTE, 'can_view_all'),
      },
    });
  } catch (err) { next(err); }
});

// Opening one form. Gated by maySee ALONE, not by can_view on /forms as well: the head of a
// department has to be able to open the forms only they can note, and heading a department is not
// a page grant. Requiring both would leave a head able to note a form they cannot read.
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await loadFull(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to view.' });

    doc.type_label = TYPE_LABELS[doc.type] || doc.type;
    doc.is_owner = doc.user_id === req.user.id;

    const note = await mayNote(req.user.id, doc);
    doc.can_note = note.allowed;
    // Why not, when not -- shown against a form that is sitting at SUBMITTED, so a dead end reads
    // as "waiting on X" rather than as a missing button.
    doc.note_blocked_reason = note.allowed ? null : note.reason;
    // Who it is waiting on, named, whoever is looking. The owner wants to know who to chase.
    doc.noters = (await notersForDoc(doc)).map((h) => h.display_name);
    // A liquidation's items each need a COGS account before it can be noted; AP assigns them.
    doc.needs_cogs = AP_NOTED_TYPES.includes(doc.type);
    doc.cogs_missing = doc.needs_cogs ? doc.items.filter((i) => !i.cogs_account_id).length : 0;
    doc.can_set_cogs = doc.needs_cogs && note.allowed && doc.status === 'submitted';
    // The entry it posts on approval (lib/glImpact.js computeLiquidationGl), shown as it stands now.
    if (doc.needs_cogs) {
      doc.gl_impact = await computeLiquidationGl(doc, doc.items);
      doc.gl_posts = doc.status === 'approved';
    }

    doc.can_approve = await userCan(req.user.id, APPROVAL_ROUTE, 'can_approve');
    return res.json(doc);
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Creating                                                                    */
/* -------------------------------------------------------------------------- */

// Writes the side table for whichever type this is, and returns the computed totals so the caller
// can report them. Shared by create and update so the two cannot drift apart.
async function writeDetail(conn, docId, type, body, items) {
  if (type === 'liquidation' || type === 'revolving_fund') {
    const table = type === 'liquidation' ? 'form_liquidation_details' : 'form_revolving_fund_details';
    const t = totals(items, body.starting_balance);
    const cols = {
      form_request_id: docId,
      week_no: trunc(body.week_no, 50),
      date_from: date(body.date_from),
      date_to: date(body.date_to),
      cash_advance_amount: num(body.cash_advance_amount),
      cash_advance_date: date(body.cash_advance_date),
      previous_balance: num(body.previous_balance),
      starting_balance: num(body.starting_balance),
      reimbursement_amount: t.reimbursement_amount,
      ending_balance: t.ending_balance,
    };
    // form_no is on the liquidation only -- it is the pre-printed serial on that pad.
    if (type === 'liquidation') cols.form_no = trunc(body.form_no, 50);
    const keys = Object.keys(cols);
    await conn.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((k) => cols[k]),
    );
    return t;
  }

  if (PAYMENT_TYPES.includes(type)) {
    const total = Number(items.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2));
    const banks = type === 'fund_transfer';
    await conn.query(
      `INSERT INTO form_payment_details (form_request_id, payable_to, address, doc_date, total_amount, from_account_id, to_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, trunc(body.payable_to, 255), trunc(body.address, 255), date(body.date ?? body.doc_date), total,
        banks ? Number(body.from_account_id) || null : null, banks ? Number(body.to_account_id) || null : null],
    );
    return { total_amount: total };
  }

  // business_trip
  await conn.query(
    `INSERT INTO form_business_trip_details
       (form_request_id, driver_name, vehicle_plate_no, speedometer_begin, speedometer_end,
        total_mileage_km, trip_date, time_out, time_in, purpose, checked_by, noted_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [docId, trunc(body.driver_name, 255), trunc(body.vehicle_plate_no, 255),
      trunc(body.speedometer_begin, 255), trunc(body.speedometer_end, 255),
      num(body.total_mileage_km), date(body.trip_date), time(body.time_out), time(body.time_in),
      trunc(body.purpose, 4000), trunc(body.checked_by, 255), trunc(body.noted_by, 255)],
  );
  return {};
}

// From and To on an RFP (Fund Transfer) must be Bank accounts in the chart of accounts -- the only
// ones the picker offers, checked here so a hand-made request cannot name any other account.
async function badBanks(type, body) {
  if (type !== 'fund_transfer') return null;
  const ids = [Number(body.from_account_id), Number(body.to_account_id)];
  const [rows] = await pool.query(`SELECT x.id FROM (${BANK_ACCOUNTS_SQL}) x WHERE x.id IN (?)`, [ids]);
  return rows.length === 2 ? null : 'From and To must both be bank accounts under Cash in Bank.';
}

// Validation that differs by type. Returns an error string, or null when the body is good.
function validate(type, body, items) {
  if (PAYMENT_TYPES.includes(type) && !trunc(body.payable_to, 255)) return 'Payable To is required.';
  if (type === 'fund_transfer') {
    if (!Number(body.from_account_id)) return 'Choose the bank the funds come From.';
    if (!Number(body.to_account_id)) return 'Choose the bank the funds go To.';
    if (Number(body.from_account_id) === Number(body.to_account_id)) return 'From and To must be different banks.';
  }
  if (type === 'business_trip') {
    if (!trunc(body.driver_name, 255)) return 'Driver name is required.';
    if (!trunc(body.vehicle_plate_no, 255)) return 'Vehicle plate number is required.';
    if (!date(body.trip_date)) return 'Trip date is required.';
  }
  if (type !== 'business_trip' && items.length === 0) return 'Add at least one line.';
  return null;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { type } = req.body;
  if (badType(type)) return res.status(400).json({ error: 'Choose which form this is.' });

  const parsed = readItems(req.body, { required: type !== 'business_trip' });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const items = parsed.items;

  const problem = validate(type, req.body, items) || await badBanks(type, req.body);
  if (problem) return res.status(400).json({ error: problem });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // A form starts as a DRAFT even though the button says Save: nothing reaches an approver until
    // its owner submits it, which is a second, deliberate action.
    // The department is stored twice on purpose: the NAME is what prints and is frozen, the ID is
    // the live link that says whose head has to note it. See db/add-form-department-id.js.
    const departmentName = trunc(req.body.department, 255);
    const departmentId = await resolveDepartmentId(conn, departmentName);

    const { id, no } = await insertNumbered(conn, {
      table: 'form_requests', column: 'request_no', prefix: 'REQ-',
      run: (docNo) => conn.query(
        `INSERT INTO form_requests (request_no, type, user_id, department, department_id, name, status)
         VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
        [docNo, type, req.user.id, departmentName, departmentId, trunc(req.body.name, 255)],
      ),
    });

    for (const it of items) {
      await conn.query(
        'INSERT INTO form_request_items (form_request_id, item_date, particulars, amount) VALUES (?, ?, ?, ?)',
        [id, it.item_date, it.particulars, it.amount],
      );
    }

    await writeDetail(conn, id, type, req.body, items);

    if (type === 'liquidation') {
      const chosen = (Array.isArray(req.body.purposes) ? req.body.purposes : []).filter((p) => PURPOSES.includes(p));
      for (const p of chosen) {
        await conn.query(
          'INSERT INTO form_liquidation_purposes (form_request_id, purpose, other_text) VALUES (?, ?, ?)',
          [id, p, p === 'others' ? trunc(req.body.purpose_other_text, 255) : null],
        );
      }
    }

    await conn.commit();
    return res.status(201).json({ id, request_no: no });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

/* -------------------------------------------------------------------------- */
/* Editing                                                                     */
/* -------------------------------------------------------------------------- */

// After the owner revises a REJECTED form it goes back where it came from: to NOTED if it had been
// noted, otherwise to SUBMITTED. The rejection is cleared along with the per-line remarks, because
// they describe a version that no longer exists.
//
// This is why noted_at/noted_by are not wiped on rejection -- they are the memory this reads.
async function restoreAfterRevision(conn, doc) {
  if (doc.status !== 'rejected') return doc.status;
  // A revised LIQUIDATION goes back to AP (SUBMITTED) whatever it was: its items are re-saved
  // without their COGS accounts, and AP must assign those again before it can be noted.
  const backToNoted = !!(doc.noted_at && doc.noted_by) && !AP_NOTED_TYPES.includes(doc.type);
  await conn.query(
    `UPDATE form_requests
        SET status = ?, submitted_at = COALESCE(submitted_at, NOW()),
            approved_at = NULL, approved_by = NULL,
            rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL
      WHERE id = ?`,
    [backToNoted ? 'noted' : 'submitted', doc.id],
  );
  await conn.query('UPDATE form_request_items SET rejection_remark = NULL WHERE form_request_id = ?', [doc.id]);
  return backToNoted ? 'noted' : 'submitted';
}

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[doc]] = await conn.query('SELECT * FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person who filed this form can edit it.' });
    // Editing an approved form would change a document somebody has already signed off.
    if (!['draft', 'rejected'].includes(doc.status)) {
      return res.status(409).json({ error: `A ${doc.status} form cannot be edited.` });
    }

    const parsed = readItems(req.body, { required: doc.type !== 'business_trip' });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const items = parsed.items;

    const problem = validate(doc.type, req.body, items) || await badBanks(doc.type, req.body);
    if (problem) return res.status(400).json({ error: problem });

    await conn.beginTransaction();

    const departmentName = trunc(req.body.department, 255);
    await conn.query(
      'UPDATE form_requests SET department = ?, department_id = ?, name = ?, updated_at = NOW() WHERE id = ?',
      [departmentName, await resolveDepartmentId(conn, departmentName), trunc(req.body.name, 255), doc.id],
    );

    // Lines are replaced wholesale rather than diffed. They carry nothing worth preserving across
    // an edit -- no id is referenced anywhere else, and the rejection remarks against them are
    // being cleared by this very revision.
    await conn.query('DELETE FROM form_request_items WHERE form_request_id = ?', [doc.id]);
    for (const it of items) {
      await conn.query(
        'INSERT INTO form_request_items (form_request_id, item_date, particulars, amount) VALUES (?, ?, ?, ?)',
        [doc.id, it.item_date, it.particulars, it.amount],
      );
    }

    const detailTable = {
      liquidation: 'form_liquidation_details',
      payment: 'form_payment_details',
      fund_transfer: 'form_payment_details',
      revolving_fund: 'form_revolving_fund_details',
      business_trip: 'form_business_trip_details',
    }[doc.type];
    await conn.query(`DELETE FROM ${detailTable} WHERE form_request_id = ?`, [doc.id]);
    await writeDetail(conn, doc.id, doc.type, req.body, items);

    if (doc.type === 'liquidation') {
      await conn.query('DELETE FROM form_liquidation_purposes WHERE form_request_id = ?', [doc.id]);
      const chosen = (Array.isArray(req.body.purposes) ? req.body.purposes : []).filter((p) => PURPOSES.includes(p));
      for (const p of chosen) {
        await conn.query(
          'INSERT INTO form_liquidation_purposes (form_request_id, purpose, other_text) VALUES (?, ?, ?)',
          [doc.id, p, p === 'others' ? trunc(req.body.purpose_other_text, 255) : null],
        );
      }
    }

    const status = await restoreAfterRevision(conn, doc);
    await conn.commit();
    return res.json({ ok: true, status });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, user_id, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person who filed this form can discard it.' });
    // Once it has been sent for a decision it is part of somebody's queue, and deleting it would
    // remove a document an approver may already have acted on.
    if (doc.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be discarded.' });

    // The side tables and lines go with it -- every one is ON DELETE CASCADE.
    await pool.query('DELETE FROM form_requests WHERE id = ?', [doc.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

/* -------------------------------------------------------------------------- */
/* Workflow                                                                    */
/* -------------------------------------------------------------------------- */

// Submitting is the owner's own act, which is why it is gated on can_add rather than on the
// approval page: filing a form and sending it are the same job.
router.post('/:id/submit', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, user_id, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person who filed this form can submit it.' });
    if (doc.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be submitted.' });

    await pool.query(
      "UPDATE form_requests SET status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = ?", [doc.id]);
    return res.json({ ok: true, status: 'submitted' });
  } catch (err) { return next(err); }
});

// Noting. Deliberately NOT wrapped in requirePermission: who may note depends on the form's type
// and its department, which cannot be known before the form is loaded.
router.post('/:id/note', requireAuth, async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      'SELECT id, type, status, department_id, department FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const { allowed, reason } = await mayNote(req.user.id, doc);
    if (!allowed) return res.status(403).json({ error: reason });

    if (doc.status !== 'submitted') return res.status(409).json({ error: 'Only a submitted form can be noted.' });
    if (AP_NOTED_TYPES.includes(doc.type)) {
      const [[m]] = await pool.query(
        'SELECT COUNT(*) AS n FROM form_request_items WHERE form_request_id = ? AND cogs_account_id IS NULL', [doc.id]);
      if (Number(m.n)) {
        return res.status(409).json({ error: `Select an account for every item first -- ${m.n} item(s) still have none.` });
      }
    }

    await pool.query(
      "UPDATE form_requests SET status = 'noted', noted_at = NOW(), noted_by = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, doc.id]);
    return res.json({ ok: true, status: 'noted' });
  } catch (err) { return next(err); }
});

router.post('/:id/approve', requireAuth, requirePermission(APPROVAL_ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      'SELECT id, type, status, department, department_id FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // NOTING IS A GATE, not a step that can be skipped. The source allowed submitted -> approved
    // directly; here a form must be noted by its department's head first, so the head's sign-off
    // cannot be bypassed by whoever approves.
    //
    // The cost of that is real and deliberate: a form from a department with no head recorded has
    // nowhere to go, so the refusal names who is missing rather than just saying no.
    if (doc.status === 'submitted') {
      const heads = await notersForDoc(doc);
      if (AP_NOTED_TYPES.includes(doc.type) && heads.length === 0) {
        return res.status(409).json({ error: 'This liquidation has to be noted by Accounts Payable first, and nobody is marked Accounts Payable.' });
      }
      if (DEPARTMENT_NOTED_TYPES.includes(doc.type) && heads.length === 0) {
        return res.status(409).json({
          error: `This has to be noted before it can be approved, and ${doc.department || 'its department'} has no head recorded to note it. Add one under that department's ticket approvers.`,
        });
      }
      return res.status(409).json({
        error: heads.length
          ? `This has to be noted first, by ${heads.map((h) => h.display_name).join(' or ')}.`
          : 'This has to be noted before it can be approved.',
      });
    }
    if (doc.status !== 'noted') {
      return res.status(409).json({ error: 'Only a noted form can be approved.' });
    }

    await pool.query(
      "UPDATE form_requests SET status = 'approved', approved_at = NOW(), approved_by = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, doc.id]);
    return res.json({ ok: true, status: 'approved' });
  } catch (err) { return next(err); }
});

// Rejecting carries per-line remarks as well as a reason, so the owner is told WHICH expense is the
// problem rather than only that something is.
router.post('/:id/reject', requireAuth, requirePermission(APPROVAL_ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[doc]] = await conn.query('SELECT id, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!['submitted', 'noted'].includes(doc.status)) {
      return res.status(409).json({ error: 'Only a submitted or noted form can be rejected.' });
    }

    await conn.beginTransaction();
    // noted_at/noted_by are deliberately NOT cleared: they are how the form finds its way back to
    // NOTED once the owner has revised it.
    await conn.query(
      `UPDATE form_requests SET status = 'rejected', rejected_at = NOW(), rejected_by = ?,
              rejection_reason = ?, updated_at = NOW() WHERE id = ?`,
      [req.user.id, trunc(req.body.reason, 2000) || 'Rejected', doc.id],
    );

    const remarks = req.body.line_remarks && typeof req.body.line_remarks === 'object' ? req.body.line_remarks : {};
    for (const [itemId, remark] of Object.entries(remarks)) {
      // Scoped to this form's own lines, so a remark cannot be written onto somebody else's form
      // by posting a stray id.
      await conn.query(
        'UPDATE form_request_items SET rejection_remark = ? WHERE id = ? AND form_request_id = ?',
        [trunc(remark, 2000), Number(itemId), doc.id],
      );
    }

    await conn.commit();
    return res.json({ ok: true, status: 'rejected' });
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

/* -------------------------------------------------------------------------- */
/* Printing                                                                    */
/* -------------------------------------------------------------------------- */

// A business trip prints once NOTED; everything else needs APPROVED. That asymmetry is the
// source's and it is deliberate -- the trip sheet goes out with the driver, and waiting on a final
// approval would mean the vehicle leaves without its paperwork.
router.get('/:id/print', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const doc = await loadFull(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!(await maySee(req.user.id, doc))) return res.status(403).json({ error: 'This form is not yours to view.' });

    const allowed = doc.type === 'business_trip' ? ['noted', 'approved'] : ['approved'];
    if (!allowed.includes(doc.status)) {
      return res.status(403).json({
        error: doc.type === 'business_trip'
          ? 'A business trip can be printed once it has been noted.'
          : 'Only an approved form can be printed.',
      });
    }

    doc.type_label = TYPE_LABELS[doc.type] || doc.type;

    // The three signatures, fetched HERE and nowhere else. They are a few KB of PNG each and only
    // the printed sheet has anywhere to put them -- loading them on every form view would put
    // three images through the wire to render a screen that shows none of them.
    //
    // Read from the user the WORKFLOW RECORDED -- owner, noted_by, approved_by -- not from whoever
    // is printing. The signature is drawn onto a decision that was already made and already
    // attributed; it never makes one. Where somebody has no signature on file the line stays blank
    // to be signed by hand, exactly as the form worked before.
    const signers = [doc.user_id, doc.noted_by, doc.approved_by].filter(Boolean);
    if (signers.length) {
      const [sigs] = await pool.query(
        'SELECT id, signature_data FROM users WHERE id IN (?) AND signature_data IS NOT NULL', [signers]);
      const byId = new Map(sigs.map((s) => [String(s.id), s.signature_data]));
      doc.owner_signature = byId.get(String(doc.user_id)) || null;
      doc.noted_signature = byId.get(String(doc.noted_by)) || null;
      doc.approved_signature = byId.get(String(doc.approved_by)) || null;
    }
    return res.json(doc);
  } catch (err) { return next(err); }
});

module.exports = router;
