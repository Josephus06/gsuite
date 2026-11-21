import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import SearchInput from '../../components/SearchInput';
import Pagination from '../../components/Pagination';
import { downloadFile } from '../../utils/downloadFile';
import { ROUTE, date, scoreText, SHORT_FLAG, FLAG_LABELS, usePeriod, useStpMeta, useSort, apiError } from './stpUtils';
import { ScoreChip, TierPill, PeriodSelect } from './StpBits';
import { AccountModal } from './StpForms';

// STP > Accounts: every customer / lead / prospect assigned to a territory in the period, with its
// latest RFVC scores. Filters live in the URL so Rep workload's "View accounts" can link straight
// to one rep's list.

const PAGE_SIZE = 20;
const FILTERS = ['search', 'territory', 'rep', 'tier', 'segment', 'overdue'];

export default function StpAccounts() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [fy, setFy] = usePeriod();
  const { meta } = useStpMeta(fy);
  const territories = meta?.territories || [];
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) || '']));
  const setFilter = (k, v) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (v) n.set(k, v); else n.delete(k);
    return n;
  }, { replace: true });

  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [assigning, setAssigning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { toggle, apply, arrow } = useSort('account_name');

  const load = useCallback(() => {
    setRows(null);
    api.get('/stp/accounts', { params: { fiscal_year: fy } })
      .then(({ data }) => { setRows(data); setError(''); })
      .catch((e) => setError(apiError(e, 'Could not load the accounts.')));
  }, [fy]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [fy, f.search, f.territory, f.rep, f.tier, f.segment, f.overdue]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = f.search.trim().toLowerCase();
    return rows.filter((a) => (!f.territory || String(a.territory_id) === f.territory)
      && (!f.rep || String(a.effective_owner_id) === f.rep)
      && (!f.tier || (f.tier === 'Prospect' ? !a.tier && a.is_prospect : a.tier === f.tier))
      && (!f.segment || a.segment === f.segment)
      && (!f.overdue || a.visit_overdue)
      && (!q || String(a.account_name || '').toLowerCase().includes(q)));
  }, [rows, f.search, f.territory, f.rep, f.tier, f.segment, f.overdue]);

  const sorted = apply(filtered, { tier: (a) => a.tier || (a.is_prospect ? 'P' : null) });
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function exportXlsx() {
    setExporting(true);
    try {
      await downloadFile('/stp/accounts/export', {
        fiscal_year: fy, search: f.search || undefined, territory_id: f.territory || undefined, rep_id: f.rep || undefined,
        tier: f.tier || undefined, segment: f.segment || undefined, overdue: f.overdue ? '1' : undefined,
      }, `STP-Accounts-FY${fy}.xlsx`);
    } catch (e) {
      setError(apiError(e, 'Could not export the accounts.'));
    } finally {
      setExporting(false);
    }
  }

  const th = (k, label, num) => (
    <th key={k} className={`sortable${num ? ' stp-num' : ''}`} onClick={() => toggle(k)}>{label}{arrow(k)}</th>
  );

  return (
    <div>
      <div className="stp-head">
        <div>
          <h1>Accounts</h1>
          <p className="stp-sub">Customers and prospects assigned to territories, scored by Recency, Frequency, Volume and Character</p>
        </div>
        <div className="stp-actions">
          <PeriodSelect fy={fy} setFy={setFy} years={meta?.fiscal_years} />
          <button className="btn" onClick={exportXlsx} disabled={exporting || !rows}>{exporting ? 'Exporting…' : 'Export'}</button>
          {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setAssigning(true)} disabled={!territories.length}
            title={territories.length ? undefined : `Create a territory for FY ${fy} first`}>+ Assign account</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <SearchInput value={f.search} onChange={(e) => setFilter('search', e.target.value)} placeholder="Account name" />
          </div>
          <div className="field">
            <label>Territory</label>
            <select value={f.territory} onChange={(e) => setFilter('territory', e.target.value)}>
              <option value="">All territories</option>
              {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Rep</label>
            <select value={f.rep} onChange={(e) => setFilter('rep', e.target.value)}>
              <option value="">All reps</option>
              {(meta?.reps || []).map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Tier</label>
            <select value={f.tier} onChange={(e) => setFilter('tier', e.target.value)}>
              <option value="">All tiers</option>
              {['A', 'B', 'C'].map((t) => <option key={t} value={t}>Tier {t}</option>)}
              <option value="Prospect">Prospect</option>
            </select>
          </div>
          <div className="field">
            <label>Segment</label>
            <select value={f.segment} onChange={(e) => setFilter('segment', e.target.value)}>
              <option value="">All segments</option>
              {(meta?.segments || []).map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="field field-checkbox" style={{ alignSelf: 'end', minHeight: 36 }}>
            <input id="stp-overdue" type="checkbox" checked={!!f.overdue} onChange={(e) => setFilter('overdue', e.target.checked ? '1' : '')} />
            <label htmlFor="stp-overdue">Overdue visits only</label>
          </div>
        </div>
      </div>

      <div className="card">
        {!rows ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="stp-table">
              <thead>
                <tr>
                  {th('account_name', 'Account')}{th('territory_name', 'Territory')}{th('owner_name', 'Owner')}{th('segment', 'Segment')}
                  {th('recency_score', 'R')}{th('frequency_score', 'F')}{th('volume_score', 'V')}{th('character_score', 'C')}
                  {th('total_score', 'Score', true)}{th('tier', 'Tier')}{th('next_visit_due', 'Next visit')}<th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 && (
                  <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    {rows.length ? 'No account matches these filters.' : `No accounts assigned for FY ${fy} yet.`}
                  </td></tr>
                )}
                {pageRows.map((a) => (
                  <tr key={a.id} className="stp-click" onClick={() => navigate(`/stp/accounts/${a.id}?fy=${fy}`)}>
                    <td><Link to={`/stp/accounts/${a.id}?fy=${fy}`} onClick={(e) => e.stopPropagation()}><strong>{a.account_name}</strong></Link></td>
                    <td>{a.territory_name}</td>
                    <td>{a.owner_name || <span className="muted">—</span>}</td>
                    <td>{a.segment}</td>
                    <td><ScoreChip value={a.recency_score} title={a.days_since_last_order != null ? `Last order ${a.days_since_last_order} days ago` : undefined} /></td>
                    <td><ScoreChip value={a.frequency_score} title={a.order_count != null ? `${a.order_count} orders` : undefined} /></td>
                    <td><ScoreChip value={a.volume_score} /></td>
                    <td><ScoreChip value={a.character_score} /></td>
                    <td className="stp-num"><strong>{scoreText(a.total_score)}</strong></td>
                    <td><TierPill tier={a.tier} prospect={a.is_prospect} short /></td>
                    <td style={{ whiteSpace: 'nowrap' }} className={a.visit_overdue ? 'stp-flag' : ''}>
                      {a.next_visit_due ? date(a.next_visit_due) : <span className="muted">Not scheduled</span>}
                    </td>
                    <td>{a.flags.map((fl) => <div key={fl} className="stp-flag" title={FLAG_LABELS[fl]}>{SHORT_FLAG[fl]}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="stp-legend">
          <span>R = Recency · F = Frequency · V = Volume · C = Character (paying habits) · each scored 1–5</span>
          {rows && <span>Showing {pageRows.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{(page - 1) * PAGE_SIZE + pageRows.length} of {sorted.length}</span>}
        </div>
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {assigning && (
        <AccountModal fy={fy} meta={meta} territories={territories} defaultTerritoryId={f.territory}
          onClose={() => setAssigning(false)} onSaved={(id) => { setAssigning(false); navigate(`/stp/accounts/${id}?fy=${fy}`); }} />
      )}
    </div>
  );
}
