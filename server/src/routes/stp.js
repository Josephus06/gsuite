const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendXlsx, day } = require('../lib/xlsxExport');
const { businessToday } = require('../lib/crmCadence');
const {
  TERRITORY_STATUSES, SEGMENTS, CADENCES, effectiveLastVisit, nextVisitDue, isVisitOverdue, isVisitDueWithin,
  accountFlags, territoryMetrics, portfolioSummary, repMetrics, tierCounts, territoryConflict,
  validateTerritory, validateAccount, validateVisit,
} = require('../lib/stp');
const { TIERS, WARNING_LABELS, DEFAULT_SETTINGS, validateOverride, validateSettings } = require('../lib/stpScoring');
const {
  ACCOUNT_CUSTOMER, loadSettings, saveSettings, fiscalYearRevenue, lastCrmVisits, latestInvoiceTerm,
  recalculateScores, visibleRepIds,
} = require('../lib/stpScoringData');

// STP -- Sales Territory Planning. Territories per fiscal year, the customers / leads / prospects
// assigned to them, the visit log, rep capacity, and RFVC account scores. Registered by
// src/db/create-stp-module.js. One permission page:
//   STP View  = can_view   STP Edit = can_add / can_edit   STP Admin = can_delete
// Scores are read from stp_account_scores (lib/stpScoringData.js), never recomputed here.
const router = express.Router();
const ROUTE = '/stp';
const view = requirePermission(ROUTE, 'can_view');
const add = requirePermission(ROUTE, 'can_add');
const edit = requirePermission(ROUTE, 'can_edit');
const admin = requirePermission(ROUTE, 'can_delete');

const currentYear = () => Number(businessToday().slice(0, 4));
const fiscalYearOf = (q) => (/^\d{4}$/.test(String(q.fiscal_year || '')) ? Number(q.fiscal_year) : currentYear());
const bad = (res, errors) => res.status(400).json({ error: Array.isArray(errors) ? errors.join(' ') : errors });

// ---------------------------------------------------------------------------------------------
// Account rows, shared by every screen: the account, its territory and owner, and its LATEST
// score row, decorated with the visit dates and flags that are worked out on read.
// ---------------------------------------------------------------------------------------------
const ACCOUNT_SELECT = `
  SELECT a.id, a.territory_id, a.fiscal_year, a.customer_id, a.lead_id, a.prospect_name, a.segment, a.annual_potential,
         a.owner_user_id, a.visit_cadence, a.last_visit_date, a.notes, a.tier_override, a.tier_override_reason,
         a.tier_override_at, a.created_at, a.updated_at,
         tob.display_name AS tier_override_by, cu.display_name AS created_by, uu.display_name AS updated_by,
         t.name AS territory_name, t.rep_user_id AS territory_rep_id,
         COALESCE(a.owner_user_id, t.rep_user_id) AS effective_owner_id, ou.display_name AS owner_name,
         c.name AS customer_name, l.company_name AS lead_name, l.lead_no,
         COALESCE(c.name, l.company_name, a.prospect_name) AS account_name,
         ${ACCOUNT_CUSTOMER} AS scoring_customer_id,
         s.id AS score_id, s.period_start, s.period_end, s.is_prospect AS score_is_prospect, s.last_invoice_date,
         s.days_since_last_order, s.order_count, s.net_volume, s.avg_days_to_pay, s.avg_days_late, s.pct_on_time,
         s.overdue_balance, s.overdue_pct, s.recency_score, s.frequency_score, s.volume_score, s.character_score,
         s.character_source, s.total_score, s.computed_tier, s.warnings AS score_warnings, s.calculated_at
    FROM stp_accounts a
    JOIN stp_territories t ON t.id = a.territory_id
    LEFT JOIN customers c ON c.id = a.customer_id
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN users ou ON ou.id = COALESCE(a.owner_user_id, t.rep_user_id)
    LEFT JOIN users tob ON tob.id = a.tier_override_by_user_id
    LEFT JOIN users cu ON cu.id = a.created_by_user_id
    LEFT JOIN users uu ON uu.id = a.updated_by_user_id
    LEFT JOIN stp_account_scores s ON s.id = (SELECT MAX(id) FROM stp_account_scores WHERE account_id = a.id)`;

async function loadAccounts({ fiscalYear, territoryId, accountId, repIds }) {
  const where = [];
  const params = [];
  if (fiscalYear) { where.push('a.fiscal_year = ?'); params.push(fiscalYear); }
  if (territoryId) { where.push('a.territory_id = ?'); params.push(territoryId); }
  if (accountId) { where.push('a.id = ?'); params.push(accountId); }
  if (repIds) { where.push('COALESCE(a.owner_user_id, t.rep_user_id) IN (?)'); params.push(repIds.length ? repIds : [0]); }
  const [rows] = await pool.query(
    `${ACCOUNT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY account_name`, params);
  const crm = await lastCrmVisits(rows.map((r) => r.scoring_customer_id));
  const today = businessToday();
  return rows.map((r) => {
    const lastVisit = effectiveLastVisit(r.last_visit_date, crm.get(Number(r.scoring_customer_id)));
    const next = nextVisitDue(lastVisit, r.visit_cadence);
    // Not scored yet: a prospect if there is no customer behind it, else simply waiting for a run.
    const isProspect = r.score_id ? !!r.score_is_prospect : !r.scoring_customer_id;
    return {
      ...r,
      is_prospect: isProspect,
      last_visit: lastVisit,
      crm_last_visit: crm.get(Number(r.scoring_customer_id)) || null,
      next_visit_due: next,
      visit_overdue: isVisitOverdue(next, today),
      tier: r.tier_override || r.computed_tier || null,
      flags: accountFlags({ score_warnings: r.score_warnings, is_prospect: isProspect, last_visit: lastVisit }),
    };
  });
}

// A user sees an account when its effective owner is a rep they may see (null = everything).
const canSeeAccount = (repIds, a) => !repIds || repIds.includes(Number(a.effective_owner_id));

async function loadTerritories(fiscalYear, repIds) {
  const where = ['t.fiscal_year = ?'];
  const params = [fiscalYear];
  if (repIds) {
    where.push(`(t.rep_user_id IN (?) OR EXISTS (SELECT 1 FROM stp_accounts a2 WHERE a2.territory_id = t.id
                 AND COALESCE(a2.owner_user_id, t.rep_user_id) IN (?)))`);
    params.push(repIds.length ? repIds : [0], repIds.length ? repIds : [0]);
  }
  const [rows] = await pool.query(
    `SELECT t.*, ru.display_name AS rep_name, cu.display_name AS created_by, uu.display_name AS updated_by
       FROM stp_territories t
       LEFT JOIN users ru ON ru.id = t.rep_user_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users uu ON uu.id = t.updated_by_user_id
      WHERE ${where.join(' AND ')} ORDER BY t.name`, params);
  return rows;
}

async function withTerritoryMetrics(territories, accounts, fiscalYear) {
  const revenue = await fiscalYearRevenue(accounts.map((a) => a.scoring_customer_id), fiscalYear);
  return territories.map((t) => ({ ...t, ...territoryMetrics(t, accounts.filter((a) => Number(a.territory_id) === Number(t.id)), revenue) }));
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------
router.get('/meta', requireAuth, view, async (req, res, next) => {
  try {
    const fy = fiscalYearOf(req.query);
    const [reps] = await pool.query(
      `SELECT u.id, u.display_name FROM users u
        WHERE u.is_active = TRUE AND (u.is_account_officer = TRUE
           OR u.id IN (SELECT rep_user_id FROM stp_territories WHERE rep_user_id IS NOT NULL)
           OR u.id IN (SELECT owner_user_id FROM stp_accounts WHERE owner_user_id IS NOT NULL))
        ORDER BY u.display_name`);
    const [years] = await pool.query('SELECT DISTINCT fiscal_year FROM stp_territories ORDER BY fiscal_year');
    const fiscalYears = [...new Set([...years.map((y) => y.fiscal_year), currentYear(), currentYear() + 1, fy])].sort();
    const settings = await loadSettings();
    const [[last]] = await pool.query('SELECT MAX(calculated_at) AS at FROM stp_account_scores');
    const territories = (await loadTerritories(fy, await visibleRepIds(req.user.id)))
      .map((t) => ({ id: t.id, name: t.name, rep_user_id: t.rep_user_id, rep_name: t.rep_name, status: t.status }));
    res.json({
      territories, reps, fiscal_years: fiscalYears, current_year: currentYear(), today: businessToday(),
      statuses: TERRITORY_STATUSES, segments: SEGMENTS, cadences: CADENCES, tiers: TIERS, warning_labels: WARNING_LABELS,
      weights: settings.weights, window_months: settings.window_months, require_override_reason: settings.require_override_reason,
      scores_calculated_at: last.at,
    });
  } catch (err) { next(err); }
});

router.get('/lookup/customers', requireAuth, view, async (req, res, next) => {
  try {
    const q = String(req.query.search || '').trim();
    const [rows] = await pool.query(
      `SELECT id, customer_code, name FROM customers
        WHERE is_active = TRUE ${q ? 'AND (name LIKE ? OR customer_code LIKE ?)' : ''}
        ORDER BY name LIMIT 50`, q ? [`%${q}%`, `%${q}%`] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/lookup/leads', requireAuth, view, async (req, res, next) => {
  try {
    const q = String(req.query.search || '').trim();
    const [rows] = await pool.query(
      `SELECT id, lead_no, company_name, status FROM leads
        WHERE converted_customer_id IS NULL ${q ? 'AND (company_name LIKE ? OR lead_no LIKE ?)' : ''}
        ORDER BY company_name LIMIT 50`, q ? [`%${q}%`, `%${q}%`] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------
router.get('/overview', requireAuth, view, async (req, res, next) => {
  try {
    const fy = fiscalYearOf(req.query);
    const repIds = await visibleRepIds(req.user.id);
    const accounts = await loadAccounts({ fiscalYear: fy, repIds });
    const territories = await withTerritoryMetrics(await loadTerritories(fy, repIds), accounts, fy);
    const today = businessToday();
    const due = accounts.filter((a) => isVisitDueWithin(a.next_visit_due, today, 7));
    const upcoming = accounts.map((a) => a.next_visit_due).filter((d) => d && d >= today).sort()[0] || null;
    const [[last]] = await pool.query('SELECT MAX(calculated_at) AS at FROM stp_account_scores');
    res.json({
      fiscal_year: fy,
      summary: portfolioSummary(territories),
      visits_due_7: { count: due.length, overdue: accounts.filter((a) => a.visit_overdue).length, next: upcoming },
      territories,
      tier_counts: tierCounts(accounts),
      scores_calculated_at: last.at,
      needs_attention: accounts.filter((a) => a.flags.length).map((a) => ({
        id: a.id, account_name: a.account_name, flags: a.flags, avg_days_to_pay: a.avg_days_to_pay,
        days_since_last_order: a.days_since_last_order, character_source: a.character_source, overdue_balance: a.overdue_balance,
      })),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------------
// Territories
// ---------------------------------------------------------------------------------------------
router.get('/territories/:id', requireAuth, view, async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT fiscal_year FROM stp_territories WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Territory not found' });
    const repIds = await visibleRepIds(req.user.id);
    const [territory] = (await loadTerritories(t.fiscal_year, repIds)).filter((x) => Number(x.id) === Number(req.params.id));
    if (!territory) return res.status(404).json({ error: 'Territory not found' });
    const accounts = (await loadAccounts({ territoryId: territory.id })).filter((a) => canSeeAccount(repIds, a));
    const [withMetrics] = await withTerritoryMetrics([territory], accounts, territory.fiscal_year);
    res.json({ ...withMetrics, accounts });
  } catch (err) { next(err); }
});

async function checkRep(userId) {
  if (!userId) return null;
  const [[u]] = await pool.query('SELECT id FROM users WHERE id = ? AND is_active = TRUE', [userId]);
  return u ? null : 'That rep is not an active user.';
}

const duplicateName = (err) => err.code === 'ER_DUP_ENTRY' && /uq_stp_territory_name/.test(err.message);

router.post('/territories', requireAuth, add, async (req, res, next) => {
  try {
    const { errors, value } = validateTerritory(req.body);
    if (errors.length) return bad(res, errors);
    const repError = await checkRep(value.rep_user_id);
    if (repError) return bad(res, repError);
    const [r] = await pool.query(
      `INSERT INTO stp_territories (fiscal_year, name, rep_user_id, coverage_area, target_amount, status, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.fiscal_year, value.name, value.rep_user_id, value.coverage_area, value.target_amount, value.status, value.notes, req.user.id]);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (duplicateName(err)) return res.status(409).json({ error: `A territory with that name already exists for FY ${req.body.fiscal_year}.` });
    next(err);
  }
});

router.put('/territories/:id', requireAuth, edit, async (req, res, next) => {
  try {
    const [[current]] = await pool.query('SELECT id, fiscal_year FROM stp_territories WHERE id = ?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Territory not found' });
    const { errors, value } = validateTerritory(req.body);
    if (errors.length) return bad(res, errors);
    const repError = await checkRep(value.rep_user_id);
    if (repError) return bad(res, repError);
    if (value.fiscal_year !== Number(current.fiscal_year)) {
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stp_accounts WHERE territory_id = ?', [current.id]);
      if (n) return res.status(409).json({ error: `This territory has ${n} account(s) in FY ${current.fiscal_year}. Move them first, or create the territory again in FY ${value.fiscal_year}.` });
    }
    await pool.query(
      `UPDATE stp_territories SET fiscal_year = ?, name = ?, rep_user_id = ?, coverage_area = ?, target_amount = ?, status = ?,
              notes = ?, updated_by_user_id = ?, updated_at = NOW() WHERE id = ?`,
      [value.fiscal_year, value.name, value.rep_user_id, value.coverage_area, value.target_amount, value.status, value.notes,
        req.user.id, current.id]);
    res.json({ id: current.id });
  } catch (err) {
    if (duplicateName(err)) return res.status(409).json({ error: `A territory with that name already exists for FY ${req.body.fiscal_year}.` });
    next(err);
  }
});

// Blocked while it still has accounts -- they must be reassigned (or removed) first.
router.delete('/territories/:id', requireAuth, admin, async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT id, name FROM stp_territories WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Territory not found' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stp_accounts WHERE territory_id = ?', [t.id]);
    if (n) return res.status(409).json({ error: `${t.name} still has ${n} account(s). Reassign them to another territory before deleting it.` });
    await pool.query('DELETE FROM stp_territories WHERE id = ?', [t.id]);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------
function filterAccounts(accounts, q) {
  const search = String(q.search || '').trim().toLowerCase();
  return accounts.filter((a) => (!q.territory_id || Number(a.territory_id) === Number(q.territory_id))
    && (!q.rep_id || Number(a.effective_owner_id) === Number(q.rep_id))
    && (!q.tier || (q.tier === 'Prospect' ? a.is_prospect && !a.tier : a.tier === q.tier))
    && (!q.segment || a.segment === q.segment)
    && (!(q.overdue === '1' || q.overdue === 'true') || a.visit_overdue)
    && (!search || String(a.account_name || '').toLowerCase().includes(search)));
}

router.get('/accounts', requireAuth, view, async (req, res, next) => {
  try {
    const fy = fiscalYearOf(req.query);
    const accounts = await loadAccounts({ fiscalYear: fy, repIds: await visibleRepIds(req.user.id) });
    res.json(filterAccounts(accounts, req.query));
  } catch (err) { next(err); }
});

router.get('/accounts/export', requireAuth, view, async (req, res, next) => {
  try {
    const fy = fiscalYearOf(req.query);
    const accounts = filterAccounts(await loadAccounts({ fiscalYear: fy, repIds: await visibleRepIds(req.user.id) }), req.query);
    await sendXlsx(res, {
      filename: `STP-Accounts-FY${fy}.xlsx`,
      sheet: `Accounts FY${fy}`,
      columns: [
        { header: 'Account', key: 'account_name', width: 34 },
        { header: 'Type', key: 'kind', width: 10 },
        { header: 'Territory', key: 'territory_name', width: 24 },
        { header: 'Owner', key: 'owner_name', width: 20 },
        { header: 'Segment', key: 'segment', width: 12 },
        { header: 'Annual potential', key: 'annual_potential', width: 16, numFmt: '"₱"#,##0' },
        { header: 'R', key: 'recency_score', width: 5 },
        { header: 'F', key: 'frequency_score', width: 5 },
        { header: 'V', key: 'volume_score', width: 5 },
        { header: 'C', key: 'character_score', width: 5 },
        { header: 'Score', key: 'total_score', width: 8, numFmt: '0.00' },
        { header: 'Computed tier', key: 'computed_tier', width: 10 },
        { header: 'Tier override', key: 'tier_override', width: 10 },
        { header: 'Override reason', key: 'tier_override_reason', width: 30 },
        { header: 'Last visit', key: 'last_visit', width: 12 },
        { header: 'Next visit', key: 'next_visit_due', width: 12 },
        { header: 'Visit overdue', key: 'overdue', width: 10 },
        { header: 'Flags', key: 'flag_text', width: 30 },
      ],
      rows: accounts.map((a) => ({
        ...a,
        kind: a.customer_id ? 'Customer' : a.lead_id ? 'Lead' : 'Prospect',
        annual_potential: Number(a.annual_potential),
        total_score: a.total_score == null ? null : Number(a.total_score),
        last_visit: day(a.last_visit), next_visit_due: day(a.next_visit_due),
        overdue: a.visit_overdue ? 'Yes' : '',
        flag_text: a.flags.map((f) => WARNING_LABELS[f] || f).join(', '),
      })),
    });
  } catch (err) { next(err); }
});

router.get('/accounts/:id', requireAuth, view, async (req, res, next) => {
  try {
    const [account] = await loadAccounts({ accountId: req.params.id });
    if (!account || !canSeeAccount(await visibleRepIds(req.user.id), account)) return res.status(404).json({ error: 'Account not found' });
    const [history] = await pool.query(
      `SELECT id, period_start, period_end, recency_score, frequency_score, volume_score, character_score, total_score,
              computed_tier, calculated_at
         FROM stp_account_scores WHERE account_id = ? ORDER BY id DESC LIMIT 36`, [account.id]);
    const [visits] = await pool.query(
      `SELECT v.id, v.visit_date, v.notes, v.created_at, ru.display_name AS rep_name, cu.display_name AS created_by
         FROM stp_visits v LEFT JOIN users ru ON ru.id = v.rep_user_id LEFT JOIN users cu ON cu.id = v.created_by_user_id
        WHERE v.account_id = ? ORDER BY v.visit_date DESC, v.id DESC`, [account.id]);
    const revenue = await fiscalYearRevenue([account.scoring_customer_id], account.fiscal_year);
    const settings = await loadSettings();
    res.json({
      ...account,
      current_revenue: revenue.get(Number(account.scoring_customer_id)) || 0,
      credit_terms: await latestInvoiceTerm(account.scoring_customer_id),
      history, visits,
      weights: settings.weights, window_months: settings.window_months, require_override_reason: settings.require_override_reason,
    });
  } catch (err) { next(err); }
});

// Validates an account body against the data: territory, customer / lead, owner and the
// one-territory-per-period rule. Returns { errors, value } with fiscal_year filled from the territory.
async function checkAccount(body, id = null) {
  const { errors, value } = validateAccount(body);
  if (errors.length) return { errors };
  const [[territory]] = await pool.query('SELECT id, fiscal_year FROM stp_territories WHERE id = ?', [value.territory_id]);
  if (!territory) return { errors: ['That territory does not exist.'] };
  value.fiscal_year = Number(territory.fiscal_year);
  if (value.customer_id) {
    const [[c]] = await pool.query('SELECT id FROM customers WHERE id = ?', [value.customer_id]);
    if (!c) return { errors: ['That customer does not exist.'] };
  }
  if (value.lead_id) {
    const [[l]] = await pool.query('SELECT id FROM leads WHERE id = ?', [value.lead_id]);
    if (!l) return { errors: ['That lead does not exist.'] };
  }
  const repError = await checkRep(value.owner_user_id);
  if (repError) return { errors: [repError] };
  if (value.customer_id || value.lead_id) {
    const [existing] = await pool.query(
      `SELECT a.id, a.fiscal_year, a.customer_id, a.lead_id, t.name AS territory_name
         FROM stp_accounts a JOIN stp_territories t ON t.id = a.territory_id
        WHERE a.fiscal_year = ? AND (a.customer_id = ? OR a.lead_id = ?)`,
      [value.fiscal_year, value.customer_id || 0, value.lead_id || 0]);
    const conflict = territoryConflict(existing, { ...value, id });
    if (conflict) return { errors: [conflict], conflict: true };
  }
  return { errors: [], value };
}

const ACCOUNT_DUP = 'A customer can be in only one territory per period -- this one is already assigned for that fiscal year.';

router.post('/accounts', requireAuth, add, async (req, res, next) => {
  try {
    const { errors, value, conflict } = await checkAccount(req.body);
    if (errors.length) return res.status(conflict ? 409 : 400).json({ error: errors.join(' ') });
    const [r] = await pool.query(
      `INSERT INTO stp_accounts (territory_id, fiscal_year, customer_id, lead_id, prospect_name, segment, annual_potential,
              owner_user_id, visit_cadence, last_visit_date, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.territory_id, value.fiscal_year, value.customer_id, value.lead_id, value.prospect_name, value.segment,
        value.annual_potential, value.owner_user_id, value.visit_cadence, value.last_visit_date, value.notes, req.user.id]);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: ACCOUNT_DUP });
    next(err);
  }
});

router.put('/accounts/:id', requireAuth, edit, async (req, res, next) => {
  try {
    const [current] = await loadAccounts({ accountId: req.params.id });
    if (!current || !canSeeAccount(await visibleRepIds(req.user.id), current)) return res.status(404).json({ error: 'Account not found' });
    const { errors, value, conflict } = await checkAccount(req.body, current.id);
    if (errors.length) return res.status(conflict ? 409 : 400).json({ error: errors.join(' ') });
    await pool.query(
      `UPDATE stp_accounts SET territory_id = ?, fiscal_year = ?, customer_id = ?, lead_id = ?, prospect_name = ?, segment = ?,
              annual_potential = ?, owner_user_id = ?, visit_cadence = ?, last_visit_date = ?, notes = ?,
              updated_by_user_id = ?, updated_at = NOW() WHERE id = ?`,
      [value.territory_id, value.fiscal_year, value.customer_id, value.lead_id, value.prospect_name, value.segment,
        value.annual_potential, value.owner_user_id, value.visit_cadence, value.last_visit_date, value.notes, req.user.id, current.id]);
    res.json({ id: current.id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: ACCOUNT_DUP });
    next(err);
  }
});

router.delete('/accounts/:id', requireAuth, admin, async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM stp_accounts WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Account not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Tier override (STP Admin). The computed tier keeps being calculated and shown beside it.
router.put('/accounts/:id/tier-override', requireAuth, admin, async (req, res, next) => {
  try {
    const settings = await loadSettings();
    const check = validateOverride(req.body, settings.require_override_reason);
    if (!check.ok) return bad(res, check.error);
    const [r] = await pool.query(
      `UPDATE stp_accounts SET tier_override = ?, tier_override_reason = ?, tier_override_by_user_id = ?, tier_override_at = IF(? IS NULL, NULL, NOW()),
              updated_by_user_id = ?, updated_at = NOW() WHERE id = ?`,
      [check.tier, check.reason, check.tier ? req.user.id : null, check.tier, req.user.id, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Account not found' });
    res.json({ tier_override: check.tier });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------------
// Visits -- saving one moves the account's last visit date forward (never back).
// ---------------------------------------------------------------------------------------------
router.post('/accounts/:id/visits', requireAuth, add, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [account] = await loadAccounts({ accountId: req.params.id });
    if (!account || !canSeeAccount(await visibleRepIds(req.user.id), account)) return res.status(404).json({ error: 'Account not found' });
    const { errors, value } = validateVisit(req.body, businessToday());
    if (errors.length) return bad(res, errors);
    const repId = value.rep_user_id || account.effective_owner_id || req.user.id;
    await conn.beginTransaction();
    const [r] = await conn.query(
      'INSERT INTO stp_visits (account_id, rep_user_id, visit_date, notes, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
      [account.id, repId, value.visit_date, value.notes, req.user.id]);
    await conn.query(
      `UPDATE stp_accounts SET last_visit_date = GREATEST(COALESCE(last_visit_date, ?), ?), updated_by_user_id = ?, updated_at = NOW()
        WHERE id = ?`, [value.visit_date, value.visit_date, req.user.id, account.id]);
    await conn.commit();
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Removing a mistaken visit: if it was the one holding last_visit_date, fall back to the latest
// remaining logged visit (or none).
router.delete('/visits/:id', requireAuth, admin, async (req, res, next) => {
  try {
    const [[v]] = await pool.query(
      'SELECT v.id, v.account_id, v.visit_date, a.last_visit_date FROM stp_visits v JOIN stp_accounts a ON a.id = v.account_id WHERE v.id = ?',
      [req.params.id]);
    if (!v) return res.status(404).json({ error: 'Visit not found' });
    await pool.query('DELETE FROM stp_visits WHERE id = ?', [v.id]);
    if (String(v.last_visit_date).slice(0, 10) === String(v.visit_date).slice(0, 10)) {
      await pool.query(
        'UPDATE stp_accounts SET last_visit_date = (SELECT MAX(visit_date) FROM stp_visits WHERE account_id = ?) WHERE id = ?',
        [v.account_id, v.account_id]);
    }
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------------
// Rep workload and capacity
// ---------------------------------------------------------------------------------------------
router.get('/reps', requireAuth, view, async (req, res, next) => {
  try {
    const fy = fiscalYearOf(req.query);
    const repIds = await visibleRepIds(req.user.id);
    const accounts = await loadAccounts({ fiscalYear: fy, repIds });
    const territories = await loadTerritories(fy, repIds);
    const [capacity] = await pool.query('SELECT rep_user_id, account_capacity FROM stp_rep_capacity WHERE fiscal_year = ?', [fy]);
    const capBy = new Map(capacity.map((c) => [Number(c.rep_user_id), c.account_capacity]));
    const ids = new Set([
      ...territories.map((t) => t.rep_user_id), ...accounts.map((a) => a.effective_owner_id), ...capacity.map((c) => c.rep_user_id),
    ].filter(Boolean).map(Number).filter((id) => !repIds || repIds.includes(id)));
    const [users] = ids.size ? await pool.query('SELECT id, display_name FROM users WHERE id IN (?)', [[...ids]]) : [[]];
    const reps = users.map((u) => ({ id: u.id, display_name: u.display_name, ...repMetrics(u.id, territories, accounts, capBy.get(Number(u.id))) }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    const withLoad = reps.filter((r) => r.workload_pct != null);
    res.json({
      fiscal_year: fy,
      kpis: {
        active_reps: reps.filter((r) => r.territory_count > 0).length,
        average_workload: withLoad.length ? withLoad.reduce((s, r) => s + r.workload_pct, 0) / withLoad.length : null,
        over_capacity: reps.filter((r) => r.over_capacity).length,
        unassigned_territories: territories.filter((t) => !t.rep_user_id || t.status === 'Unassigned').length,
      },
      reps,
    });
  } catch (err) { next(err); }
});

router.put('/reps/:userId/capacity', requireAuth, admin, async (req, res, next) => {
  try {
    const fy = Number(req.body.fiscal_year);
    const cap = Number(req.body.account_capacity);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) return bad(res, 'Choose a valid period (fiscal year).');
    if (!Number.isInteger(cap) || cap < 1 || cap > 10000) return bad(res, 'Capacity must be a whole number of accounts, 1 or more.');
    const repError = await checkRep(Number(req.params.userId));
    if (repError) return bad(res, repError);
    await pool.query(
      `INSERT INTO stp_rep_capacity (rep_user_id, fiscal_year, account_capacity, created_by_user_id) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE account_capacity = VALUES(account_capacity), updated_by_user_id = VALUES(created_by_user_id), updated_at = NOW()`,
      [Number(req.params.userId), fy, cap, req.user.id]);
    res.json({ rep_user_id: Number(req.params.userId), fiscal_year: fy, account_capacity: cap });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------------
// Scoring settings and runs
// ---------------------------------------------------------------------------------------------
router.get('/settings', requireAuth, view, async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT s.updated_at, u.display_name AS updated_by FROM stp_scoring_settings s
         LEFT JOIN users u ON u.id = s.updated_by_user_id WHERE s.id = 1`);
    res.json({ settings: await loadSettings(), defaults: DEFAULT_SETTINGS, updated_at: row?.updated_at || null, updated_by: row?.updated_by || null });
  } catch (err) { next(err); }
});

// Save, then recalculate straight away so every screen reflects the new rules.
router.put('/settings', requireAuth, admin, async (req, res, next) => {
  try {
    const { settings, errors } = validateSettings(req.body);
    if (errors.length) return bad(res, errors);
    await saveSettings(settings, req.user.id);
    const run = await recalculateScores({ userId: req.user.id });
    res.json({ settings, run });
  } catch (err) { next(err); }
});

router.post('/recalculate', requireAuth, edit, async (req, res, next) => {
  try {
    // An earlier as-of date is allowed (e.g. to score against a database copy that stops early);
    // never a future one.
    const today = businessToday();
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.as_of || '')) && req.body.as_of <= today ? req.body.as_of : today;
    res.json(await recalculateScores({ asOf, userId: req.user.id }));
  } catch (err) { next(err); }
});

module.exports = router;
