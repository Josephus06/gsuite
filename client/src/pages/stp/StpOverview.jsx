import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import SearchInput from '../../components/SearchInput';
import { displayAuditTime } from '../../utils/dates';
import { ROUTE, peso, pct, date, FLAG_LABELS, usePeriod, useStpMeta, apiError } from './stpUtils';
import { Kpi, Bar, StatusPill, TierPill, PeriodSelect } from './StpBits';
import { TerritoryModal } from './StpForms';

// STP > Overview: the period's territories against target and potential, the tier mix, and the
// accounts that need attention. Scores come from the last scoring run, never worked out here.

function attentionText(a, flag) {
  if (flag === 'big_buyer_slow_payer') {
    if (a.avg_days_to_pay != null) return `avg ${Math.round(a.avg_days_to_pay)} days to pay`;
    return `${peso(a.overdue_balance)} overdue`;
  }
  if (flag === 'slipping_away') return `no order in ${a.days_since_last_order} days`;
  return 'no visit logged';
}

export default function StpOverview() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [fy, setFy] = usePeriod();
  const { meta } = useStpMeta(fy);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | territory
  const [recalculating, setRecalculating] = useState(false);

  const load = useCallback(() => {
    api.get('/stp/overview', { params: { fiscal_year: fy } })
      .then(({ data: d }) => { setData(d); setError(''); })
      .catch((e) => setError(apiError(e, 'Could not load the overview.')));
  }, [fy]);
  useEffect(() => { load(); }, [load]);

  async function recalculate() {
    setRecalculating(true);
    setNotice('');
    try {
      const { data: r } = await api.post('/stp/recalculate');
      setNotice(`Scores recalculated: ${r.scored} scored, ${r.prospects} prospect(s), in ${(r.ms / 1000).toFixed(1)} s.`);
      load();
    } catch (e) {
      setError(apiError(e, 'Could not recalculate the scores.'));
    } finally {
      setRecalculating(false);
    }
  }

  const territories = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.territories || []).filter((t) => !q || t.name.toLowerCase().includes(q) || String(t.rep_name || '').toLowerCase().includes(q));
  }, [data, search]);

  const s = data?.summary;
  const attention = (data?.needs_attention || []).flatMap((a) => a.flags.map((f) => ({ ...a, flag: f })));

  return (
    <div>
      <div className="stp-head">
        <div>
          <h1>Sales Territory Planning</h1>
          <p className="stp-sub">Overview of territories, targets and coverage for FY {fy}</p>
        </div>
        <div className="stp-actions">
          <PeriodSelect fy={fy} setFy={setFy} years={meta?.fiscal_years} />
          {can(ROUTE, 'can_edit') && (
            <button className="btn" onClick={recalculate} disabled={recalculating}>{recalculating ? 'Recalculating…' : 'Recalculate scores'}</button>
          )}
          {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setEditing('new')}>+ New territory</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 16 }}>{notice}</div>}

      {!data ? <LoadingSpinner /> : (
        <>
          <div className="stp-kpis">
            <Kpi label="Total target" value={peso(s.total_target)} hint={`${s.territory_count} territories`} />
            <Kpi label="Annual potential" value={peso(s.total_potential)} hint={`${s.account_count} accounts`} />
            <Kpi label="Current revenue" value={peso(s.current_revenue)} hint={`Invoiced in FY ${fy}`} />
            <Kpi label="Penetration" value={pct(s.penetration)} hint="Revenue ÷ potential" />
            <Kpi label="Visits due in 7 days" value={data.visits_due_7.count}
              hint={[data.visits_due_7.next && `Next: ${date(data.visits_due_7.next)}`, data.visits_due_7.overdue && `${data.visits_due_7.overdue} overdue`].filter(Boolean).join(' · ') || 'None scheduled'} />
          </div>

          <div className="stp-layout">
            <div className="card">
              <div className="stp-card-head">
                <h2>Territories</h2>
                <div style={{ minWidth: 200, flex: '0 1 260px' }}>
                  <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Territory or rep" aria-label="Search territories" />
                </div>
              </div>
              <div className="table-wrap">
                <table className="stp-table">
                  <thead>
                    <tr>
                      <th>Territory</th><th>Rep</th><th className="stp-num">Accounts</th><th className="stp-num">Potential</th>
                      <th className="stp-num">Revenue</th><th className="stp-num">Target</th><th className="stp-num">Target / potential</th>
                      <th>Penetration</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {territories.length === 0 && (
                      <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        {data.territories.length ? 'No territory matches.' : `No territories for FY ${fy} yet.`}
                      </td></tr>
                    )}
                    {territories.map((t) => (
                      <tr key={t.id} className="stp-click" onClick={() => navigate(`/stp/territories/${t.id}?fy=${fy}`)}>
                        <td><Link to={`/stp/territories/${t.id}?fy=${fy}`} onClick={(e) => e.stopPropagation()}><strong>{t.name}</strong></Link></td>
                        <td>{t.rep_name || <span className="muted">Unassigned</span>}</td>
                        <td className="stp-num">{t.account_count}</td>
                        <td className="stp-num">{peso(t.total_potential)}</td>
                        <td className="stp-num">{peso(t.current_revenue)}</td>
                        <td className="stp-num">{peso(t.target_amount)}</td>
                        <td className="stp-num">{pct(t.target_vs_potential)}</td>
                        <td><Bar value={t.penetration} /></td>
                        <td><StatusPill status={t.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="stp-side">
              <div className="card">
                <div className="stp-card-head"><h3>Account tiers (RFVC)</h3></div>
                <div className="stp-tiers">
                  {['A', 'B', 'C'].map((t) => (
                    <div className="row" key={t}><TierPill tier={t} /><strong>{data.tier_counts[t]}</strong></div>
                  ))}
                  <div className="row"><TierPill prospect /><strong>{data.tier_counts.Prospect}</strong></div>
                </div>
                <p className="muted" style={{ marginBottom: 0 }}>
                  {data.scores_calculated_at ? `Scores last calculated ${displayAuditTime(data.scores_calculated_at)}` : 'Scores not calculated yet.'}
                </p>
              </div>
              <div className="card">
                <div className="stp-card-head"><h3>Needs attention</h3></div>
                {attention.length === 0 ? <p className="muted">Nothing flagged.</p> : (
                  <div className="stp-attention">
                    {attention.map((a) => (
                      <Link key={`${a.id}-${a.flag}`} to={`/stp/accounts/${a.id}?fy=${fy}`} className={a.flag === 'unvisited_prospect' ? 'item info' : ''}>
                        <div className="kind">{FLAG_LABELS[a.flag]}</div>
                        <div><strong>{a.account_name}</strong> · {attentionText(a, a.flag)}</div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {editing && (
        <TerritoryModal territory={editing === 'new' ? null : editing} fy={fy} meta={meta} onClose={() => setEditing(null)}
          onSaved={(id) => { setEditing(null); navigate(`/stp/territories/${id}?fy=${fy}`); }} />
      )}
    </div>
  );
}
