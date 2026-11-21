import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import SearchInput from '../../components/SearchInput';
import { displayAuditTime } from '../../utils/dates';
import { ROUTE, peso, pct, date, FLAG_LABELS, usePeriod, useStpMeta, apiError } from './stpUtils';
import { Icon, Avatar, Kpi, Bar, StatusPill, Empty, PeriodSelect } from './StpBits';
import { TerritoryModal } from './StpForms';

// STP > Overview: the period's territories against target and potential, the tier mix, and the
// accounts that need attention. Scores come from the last scoring run, never worked out here.

const TIER_KEYS = ['A', 'B', 'C', 'Prospect'];
const tierLabel = (k) => (k === 'Prospect' ? 'Prospect' : `Tier ${k}`);

const STEPS = [
  ['map', '1. Create territories', 'An area, its rep and its ₱ target for the year.'],
  ['user', '2. Assign accounts', 'Customers, CRM leads or new prospects, with their annual potential and visit cadence.'],
  ['volume', '3. Recalculate scores', 'Recency, Frequency, Volume and Character from real invoices give each account Tier A, B or C.'],
  ['visit', '4. Log visits', 'Reps log each visit; overdue visits and at-risk customers are flagged here.'],
];

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
  const tc = data?.tier_counts;
  const tierTotal = tc ? TIER_KEYS.reduce((n, k) => n + tc[k], 0) : 0;
  const attention = (data?.needs_attention || []).flatMap((a) => a.flags.map((f) => ({ ...a, flag: f })));
  const empty = data && data.territories.length === 0;
  const due = data?.visits_due_7;

  return (
    <div className="stp-page">
      <div className="stp-head">
        <div>
          <h1>Sales Territory Planning</h1>
          <p className="stp-sub">Territories, targets and coverage for FY {fy}</p>
        </div>
        <div className="stp-actions">
          <PeriodSelect fy={fy} setFy={setFy} years={meta?.fiscal_years} />
          {can(ROUTE, 'can_edit') && !empty && (
            <button className="btn" onClick={recalculate} disabled={recalculating}>{recalculating ? 'Recalculating…' : 'Recalculate scores'}</button>
          )}
          {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} />New territory</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="check" />{notice}</div>}

      {!data && <LoadingSpinner />}

      {empty && (
        <div className="card">
          <Empty icon="map" title={`No territories for FY ${fy} yet`}
            action={can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} />Create the first territory</button>}>
            Split your market into territories (e.g. <em>Cebu City North: Banilad, Talamban, Lahug</em>), each with a rep and a yearly
            target. Then assign customers to them; the system grades every customer A, B or C from their real invoices and payments.
          </Empty>
          <div className="stp-plan" style={{ marginTop: 8 }}>
            {STEPS.map(([icon, k, v]) => (
              <div className="stp-tile" key={k}><Icon name={icon} /><div><div className="v" style={{ fontSize: 14 }}>{k}</div><div className="s">{v}</div></div></div>
            ))}
          </div>
        </div>
      )}

      {data && !empty && (
        <>
          <div className="stp-kpis">
            <Kpi icon="target" label="Total target" value={peso(s.total_target)} hint={`${s.territory_count} territor${s.territory_count === 1 ? 'y' : 'ies'}`} />
            <Kpi icon="potential" label="Annual potential" value={peso(s.total_potential)} hint={`${s.account_count} account${s.account_count === 1 ? '' : 's'}`} />
            <Kpi icon="revenue" tone="success" label="Current revenue" value={peso(s.current_revenue)} hint={`Invoiced in FY ${fy}`} />
            <Kpi icon="penetration" tone="neutral" label="Penetration" value={pct(s.penetration)} hint="Revenue ÷ potential" />
            <Kpi icon="calendar" tone={due.overdue ? 'warning' : 'primary'} label="Visits due in 7 days" value={due.count}
              hint={[due.next && `Next: ${date(due.next)}`, due.overdue && `${due.overdue} overdue`].filter(Boolean).join(' · ') || 'None scheduled'} />
          </div>

          <div className="stp-layout">
            <div className="card">
              <div className="stp-card-head">
                <h2><Icon name="map" />Territories <span className="stp-count">{data.territories.length}</span></h2>
                <div style={{ minWidth: 200, flex: '0 1 260px' }}>
                  <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Territory or rep" aria-label="Search territories" />
                </div>
              </div>
              <div className="table-wrap">
                <table className="stp-table wide">
                  <thead>
                    <tr>
                      <th>Territory</th><th>Rep</th><th className="stp-num">Accounts</th><th className="stp-num">Potential</th>
                      <th className="stp-num">Revenue</th><th className="stp-num">Target</th><th className="stp-num">Target / potential</th>
                      <th>Penetration</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {territories.length === 0 && (
                      <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No territory matches.</td></tr>
                    )}
                    {territories.map((t) => (
                      <tr key={t.id} className="stp-click" onClick={() => navigate(`/stp/territories/${t.id}?fy=${fy}`)}>
                        <td>
                          <div className="stp-who"><div>
                            <Link to={`/stp/territories/${t.id}?fy=${fy}`} onClick={(e) => e.stopPropagation()} className="name">{t.name}</Link>
                            {t.coverage_area && <div className="sub">{t.coverage_area}</div>}
                          </div></div>
                        </td>
                        <td>{t.rep_name ? <span className="stp-who"><Avatar name={t.rep_name} size={26} />{t.rep_name}</span> : <span className="muted">Unassigned</span>}</td>
                        <td className="stp-num">{t.account_count}</td>
                        <td className="stp-num">{peso(t.total_potential)}</td>
                        <td className="stp-num">{peso(t.current_revenue)}</td>
                        <td className="stp-num">{peso(t.target_amount)}</td>
                        <td className="stp-num">{pct(t.target_vs_potential)}</td>
                        <td><Bar value={t.penetration} over={t.penetration > 1} /></td>
                        <td><StatusPill status={t.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="stp-side">
              <div className="card">
                <div className="stp-card-head"><h3><Icon name="volume" />Account tiers (RFVC)</h3></div>
                {tierTotal > 0 && (
                  <div className="stp-mix" role="img" aria-label={TIER_KEYS.map((k) => `${tierLabel(k)} ${tc[k]}`).join(', ')}>
                    {TIER_KEYS.filter((k) => tc[k]).map((k) => (
                      <span key={k} className={k} style={{ flex: tc[k] }} title={`${tierLabel(k)}: ${tc[k]}`} />
                    ))}
                  </div>
                )}
                <div className="stp-tiers">
                  {TIER_KEYS.map((k) => (
                    <div className="row" key={k}>
                      <span><span className={`swatch stp-mix-${k}`} />{tierLabel(k)}</span>
                      <strong>{tc[k]}</strong>
                    </div>
                  ))}
                </div>
                <p className="stp-foot"><Icon name="history" size={14} />
                  {data.scores_calculated_at ? `Scores last calculated ${displayAuditTime(data.scores_calculated_at)}` : 'Scores not calculated yet.'}
                </p>
              </div>
              <div className="card">
                <div className="stp-card-head">
                  <h3><Icon name="alert" />Needs attention</h3>
                  {attention.length > 0 && <span className="stp-count">{attention.length}</span>}
                </div>
                {attention.length === 0 ? (
                  <p className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}><Icon name="check" size={16} />Nothing flagged.</p>
                ) : (
                  <div className="stp-attention">
                    {attention.map((a) => (
                      <Link key={`${a.id}-${a.flag}`} to={`/stp/accounts/${a.id}?fy=${fy}`} className={a.flag === 'unvisited_prospect' ? 'info' : ''}>
                        <Icon name={a.flag === 'unvisited_prospect' ? 'visit' : 'alert'} size={18} />
                        <div>
                          <div className="kind">{FLAG_LABELS[a.flag]}</div>
                          <div><strong>{a.account_name}</strong> · {attentionText(a, a.flag)}</div>
                        </div>
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
