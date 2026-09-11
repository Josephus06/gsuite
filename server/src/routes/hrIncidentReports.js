const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// HRD > Incident Report. HR's queue: every charge that has been filed, and what HR decided.
//
// Its own permission scope, separate from Violations. The supervisor who witnessed something
// reports it; HR rules on it. Those are different people and the grid should be able to say so.
const ROUTE = '/hrd/incident-reports';

// for_evaluation is where every report starts, the moment a violation is filed.
// under_review means HR has picked it up. The three endings are deliberately distinct: a charge
// that was found to have happened, one that was not, and one closed without a finding.
const STATUSES = ['for_evaluation', 'under_review', 'substantiated', 'unsubstantiated', 'dismissed'];
const OPEN_STATUSES = ['for_evaluation', 'under_review'];

// What HR can recommend. Deliberately short and neutral -- the wording of an actual sanction
// belongs in the NTE that follows, not in a dropdown.
const RECOMMENDATIONS = [
  'none', 'verbal_warning', 'written_warning', 'final_warning',
  'suspension', 'termination', 'further_investigation',
];

const trunc = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));

const BASE_SELECT = `
  SELECT ir.id, ir.incident_no, ir.status, ir.hr_findings, ir.recommendation, ir.recommendation_notes,
         ir.evaluated_at, ir.created_at,
         v.id AS violation_id, v.violation_no, v.violation_date, v.employee_id, v.employee_name,
         v.employee_code, v.department_name, v.position_title, v.violation_name, v.violation_category,
         v.violation_severity, v.place, v.details,
         ru.display_name AS reported_by_name, eu.display_name AS evaluated_by_name
    FROM hr_incident_reports ir
    JOIN hr_violations v ON v.id = ir.violation_id
    LEFT JOIN users ru ON ru.id = v.reported_by_user_id
    LEFT JOIN users eu ON eu.id = ir.evaluated_by_user_id`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    // 'open' is the default view, because a queue nobody can see the end of stops being a queue.
    const status = String(req.query.status || 'open');
    if (status === 'open') {
      where.push(`ir.status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`);
      params.push(...OPEN_STATUSES);
    } else if (status && status !== 'all') {
      where.push('ir.status = ?');
      params.push(status);
    }
    if (req.query.severity) { where.push('v.violation_severity = ?'); params.push(req.query.severity); }
    if (req.query.employee_id) { where.push('v.employee_id = ?'); params.push(req.query.employee_id); }
    if (req.query.from) { where.push('v.violation_date >= ?'); params.push(req.query.from); }
    if (req.query.to) { where.push('v.violation_date <= ?'); params.push(req.query.to); }
    if (req.query.search) {
      where.push('(ir.incident_no LIKE ? OR v.violation_no LIKE ? OR v.employee_name LIKE ? OR v.violation_name LIKE ?)');
      const q = `%${req.query.search}%`;
      params.push(q, q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `${BASE_SELECT} ${whereSql} ORDER BY ir.status = 'for_evaluation' DESC, v.violation_date DESC, ir.id DESC LIMIT 500`,
      params,
    );

    // The counts the HR screen leads with: what is waiting, what is in hand, what is finished.
    const [[counts]] = await pool.query(
      `SELECT SUM(status = 'for_evaluation') AS for_evaluation,
              SUM(status = 'under_review') AS under_review,
              SUM(status IN ('substantiated', 'unsubstantiated', 'dismissed')) AS closed,
              COUNT(*) AS total
         FROM hr_incident_reports`,
    );
    res.json({ rows, counts });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ir]] = await pool.query(`${BASE_SELECT} WHERE ir.id = ?`, [req.params.id]);
    if (!ir) return res.status(404).json({ error: 'Not found' });

    // The employee's other charges. A first offence and a fourth call for different answers, and
    // that context has to be on the screen where the decision is actually made.
    const [history] = await pool.query(
      `SELECT v.id, v.violation_no, v.violation_date, v.violation_name, v.violation_severity,
              ir2.incident_no, ir2.status, ir2.recommendation
         FROM hr_violations v
         LEFT JOIN hr_incident_reports ir2 ON ir2.violation_id = v.id
        WHERE v.employee_id = ? AND v.id <> ?
        ORDER BY v.violation_date DESC, v.id DESC LIMIT 30`,
      [ir.employee_id, ir.violation_id],
    );
    return res.json({ ...ir, history });
  } catch (err) { return next(err); }
});

// HR's evaluation. can_edit here is the right to rule on somebody's conduct record, which is why
// it is a grant on this page and not on the one where charges are raised.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[ir]] = await pool.query('SELECT id, status FROM hr_incident_reports WHERE id = ?', [req.params.id]);
    if (!ir) return res.status(404).json({ error: 'Not found' });

    const fields = [];
    const params = [];

    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status.' });
      fields.push('status = ?'); params.push(req.body.status);
      // Stamped when the report reaches an ending, not when someone merely opens it. That stamp is
      // what protects a decided report from being withdrawn on the Violations side.
      if (!OPEN_STATUSES.includes(req.body.status)) {
        fields.push('evaluated_at = NOW()', 'evaluated_by_user_id = ?');
        params.push(req.user.id);
      } else {
        fields.push('evaluated_at = NULL', 'evaluated_by_user_id = NULL');
      }
    }
    if (req.body.hr_findings !== undefined) {
      fields.push('hr_findings = ?'); params.push(trunc(req.body.hr_findings, 4000));
    }
    if (req.body.recommendation !== undefined) {
      const rec = req.body.recommendation === '' || req.body.recommendation == null ? null : String(req.body.recommendation);
      if (rec !== null && !RECOMMENDATIONS.includes(rec)) {
        return res.status(400).json({ error: 'Unknown recommendation.' });
      }
      fields.push('recommendation = ?'); params.push(rec);
    }
    if (req.body.recommendation_notes !== undefined) {
      fields.push('recommendation_notes = ?'); params.push(trunc(req.body.recommendation_notes, 1000));
    }

    if (!fields.length) return res.json({ ok: true });
    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    await pool.query(`UPDATE hr_incident_reports SET ${fields.join(', ')} WHERE id = ?`, params);

    // The charge follows its report rather than carrying a status of its own that could disagree
    // with it. One fact, one place.
    if (req.body.status !== undefined) {
      const violationStatus = OPEN_STATUSES.includes(req.body.status) ? 'filed' : req.body.status;
      await pool.query(
        `UPDATE hr_violations v JOIN hr_incident_reports ir ON ir.violation_id = v.id
            SET v.status = ?, v.updated_at = NOW() WHERE ir.id = ?`,
        [violationStatus, req.params.id],
      );
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.get('/meta/options', requireAuth, requirePermission(ROUTE, 'can_view'), (req, res) => {
  res.json({ statuses: STATUSES, recommendations: RECOMMENDATIONS });
});

module.exports = router;
