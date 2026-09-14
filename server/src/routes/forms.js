const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { insertNumbered } = require('../lib/docNumber');
const {
  DEPARTMENT_NOTED_TYPES, isDepartmentNoter, departmentsHeadedBy, notersFor,
} = require('../lib/formNoters');

const router = express.Router();

// Forms -- the request forms ported from the Booking system's Request module. Four printed company
// forms sharing one approval chain. See db/create-forms.js for the schema and what changed in the
// port.
//
//   draft -> submitted -> noted -> approved
//                     \-> rejected -> (owner edits) -> back to noted or submitted
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

const TYPES = ['liquidation', 'payment', 'business_trip', 'revolving_fund'];
const TYPE_LABELS = {
  liquidation: 'Liquidation',
  payment: 'Request for Payment',
  business_trip: 'Business Trip',
  revolving_fund: 'Revolving Fund',
};

// The six purposes printed on the liquidation form. 'others' is the one that carries free text.
const PURPOSES = [
  'business_travel_allowance', 'mobilization_installation', 'site_inspection',
  'representation', 'employees_benefit', 'others',
];

// A form that has left the owner's hands. Everything an approver can act on.
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
            ru.display_name AS rejected_by_name
       FROM form_requests f
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN users nu ON nu.id = f.noted_by
       LEFT JOIN users au ON au.id = f.approved_by
       LEFT JOIN users ru ON ru.id = f.rejected_by
      WHERE f.id = ?`, [id],
  );
  if (!doc) return null;

  const [items] = await pool.query(
    'SELECT id, item_date, particulars, amount, rejection_remark FROM form_request_items WHERE form_request_id = ? ORDER BY id',
    [id]);
  doc.items = items;

  if (doc.type === 'liquidation') {
    const [[d]] = await pool.query('SELECT * FROM form_liquidation_details WHERE form_request_id = ?', [id]);
    doc.detail = d || null;
    const [p] = await pool.query(
      'SELECT purpose, other_text FROM form_liquidation_purposes WHERE form_request_id = ? ORDER BY id', [id]);
    doc.purposes = p;
  } else if (doc.type === 'payment') {
    const [[d]] = await pool.query('SELECT * FROM form_payment_details WHERE form_request_id = ?', [id]);
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
  if (await userCan(userId, APPROVAL_ROUTE, 'can_view')) return true;
  if (await userCan(userId, ROUTE, 'can_view_all')) return true;
  // Your own form, provided you still hold the module at all.
  return doc.user_id === userId && userCan(userId, ROUTE, 'can_view');
}

// May this user note this particular form, and if not, why not? One answer used by the button, the
// endpoint and the explanation on screen, so the three cannot disagree.
async function mayNote(userId, doc) {
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
    if (!canSeeAll && headOf.length === 0) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }

    const where = ['f.status IN (?)'];
    const params = [WORKFLOW_STATUSES];
    if (!canSeeAll) {
      where.push('f.department_id IN (?)');
      params.push(headOf);
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

router.get('/meta/options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // Departments come from the same list every other module uses, so a form's department is a
    // real one rather than whatever was typed that day.
    const [departments] = await pool.query('SELECT id, name FROM departments ORDER BY name');
    res.json({
      types: TYPES.map((t) => ({ key: t, label: TYPE_LABELS[t] })),
      purposes: PURPOSES,
      departments: departments.map((d) => d.name),
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
    doc.noters = DEPARTMENT_NOTED_TYPES.includes(doc.type)
      ? (await notersFor(doc.department_id)).map((h) => h.display_name)
      : [];

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

  if (type === 'payment') {
    const total = Number(items.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2));
    await conn.query(
      `INSERT INTO form_payment_details (form_request_id, payable_to, address, doc_date, total_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [docId, trunc(body.payable_to, 255), trunc(body.address, 255), date(body.date ?? body.doc_date), total],
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

// Validation that differs by type. Returns an error string, or null when the body is good.
function validate(type, body, items) {
  if (type === 'payment' && !trunc(body.payable_to, 255)) return 'Payable To is required.';
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

  const problem = validate(type, req.body, items);
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
  const backToNoted = !!(doc.noted_at && doc.noted_by);
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

    const problem = validate(doc.type, req.body, items);
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

    await pool.query(
      "UPDATE form_requests SET status = 'noted', noted_at = NOW(), noted_by = ?, updated_at = NOW() WHERE id = ?",
      [req.user.id, doc.id]);
    return res.json({ ok: true, status: 'noted' });
  } catch (err) { return next(err); }
});

router.post('/:id/approve', requireAuth, requirePermission(APPROVAL_ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query('SELECT id, status FROM form_requests WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    // Noting is a step, not a gate: a submitted form can be approved without it, as in the source.
    if (!['submitted', 'noted'].includes(doc.status)) {
      return res.status(409).json({ error: 'Only a submitted or noted form can be approved.' });
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
    return res.json(doc);
  } catch (err) { return next(err); }
});

module.exports = router;
