import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import { ROUTE, peso, pct, scoreText, usePeriod, useStpMeta, apiError } from './stpUtils';
import { Kpi, Bar, PeriodSelect } from './StpBits';
import { CapacityModal } from './StpForms';

// STP > Rep workload: accounts owned against each rep's capacity for the period. Over 100% is
// highlighted.
export default function StpReps() {
  const { can } = useAuth();
  const [fy, setFy] = usePeriod();
  const { meta } = useStpMeta(fy);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [capacityFor, setCapacityFor] = useState(undefined); // undefined = closed, null = any rep, rep = that rep

  const load = useCallback(() => {
    api.get('/stp/reps', { params: { fiscal_year: fy } }).then(({ data: d }) => { setData(d); setError(''); })
      .catch((e) => setError(apiError(e, 'Could not load rep workload.')));
  }, [fy]);
  useEffect(() => { load(); }, [load]);

  const isAdmin = can(ROUTE, 'can_delete');
  // Capacity can be set for anyone on the rep list, not only reps already carrying accounts.
  const capacityReps = (() => {
    const byId = new Map((meta?.reps || []).map((r) => [r.id, { ...r }]));
    (data?.reps || []).forEach((r) => byId.set(r.id, r));
    return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  })();

  const k = data?.kpis;
  return (
    <div>
      <div className="stp-head">
        <div>
          <h1>Rep workload</h1>
          <p className="stp-sub">Accounts owned against each rep's capacity, with targets and average account score</p>
        </div>
        <div className="stp-actions">
          <PeriodSelect fy={fy} setFy={setFy} years={meta?.fiscal_years} />
          {isAdmin && <button className="btn btn-primary" onClick={() => setCapacityFor(null)}>Set capacity</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!data ? <LoadingSpinner /> : (
        <>
          <div className="stp-kpis">
            <Kpi label="Active reps" value={k.active_reps} hint="Assigned to territories" />
            <Kpi label="Average workload" value={pct(k.average_workload)} hint="Accounts ÷ capacity" />
            <Kpi label="Over capacity" value={k.over_capacity} hint="Reps above 100%" />
            <Kpi label="Unassigned territories" value={k.unassigned_territories} hint="Need a rep" />
          </div>
          <div className="card">
            <div className="table-wrap">
              <table className="stp-table">
                <thead>
                  <tr><th>Rep</th><th className="stp-num">Territories</th><th className="stp-num">Accounts / capacity</th><th>Workload</th>
                    <th className="stp-num">Total target</th><th className="stp-num">Avg score</th><th>Tier A / B / C</th><th /></tr>
                </thead>
                <tbody>
                  {data.reps.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No reps have territories or accounts in FY {fy} yet.</td></tr>}
                  {data.reps.map((r) => (
                    <tr key={r.id} className={r.over_capacity ? 'stp-over' : ''}>
                      <td><strong>{r.display_name}</strong></td>
                      <td className="stp-num">{r.territory_count}</td>
                      <td className="stp-num">{r.accounts_owned} / {r.account_capacity ?? <span className="muted">not set</span>}</td>
                      <td>{r.workload_pct == null ? <span className="muted">—</span> : <Bar value={r.workload_pct} over={r.over_capacity} />}</td>
                      <td className="stp-num">{peso(r.total_target)}</td>
                      <td className="stp-num">{scoreText(r.average_score)}</td>
                      <td>{r.tier_counts.A} / {r.tier_counts.B} / {r.tier_counts.C}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <Link className="btn btn-sm" to={`/stp/accounts?fy=${fy}&rep=${r.id}`}>View accounts</Link>
                        {isAdmin && <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => setCapacityFor(r)}>Capacity</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="stp-legend"><span>Reps over 100% workload are highlighted in orange.</span></div>
          </div>
        </>
      )}
      {capacityFor !== undefined && (
        <CapacityModal reps={capacityReps} fy={fy} current={capacityFor} onClose={() => setCapacityFor(undefined)}
          onSaved={() => { setCapacityFor(undefined); load(); }} />
      )}
    </div>
  );
}
