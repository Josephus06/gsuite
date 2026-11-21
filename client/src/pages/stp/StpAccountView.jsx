import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayAuditTime } from '../../utils/dates';
import { ROUTE, peso, date, scoreText, FLAG_LABELS, useStpMeta, apiError } from './stpUtils';
import { Icon, Avatar, ScoreChip, Steps, ScoreRing, TierPill, Bar, VisitStatus, ScoreTrend, Empty } from './StpBits';
import { AccountModal, VisitModal, OverrideModal } from './StpForms';

// STP > Account detail: the RFVC scores with the real numbers behind each, the account plan, the
// score history and the visit log.

const FLAG_ADVICE = {
  big_buyer_slow_payer: (a) => `High Volume, but Character is ${a.character_score}/5. Review credit terms before the next order.`,
  slipping_away: (a) => `Volume is ${a.volume_score}/5, but there has been no order in ${a.days_since_last_order} days. Reach out before the account goes elsewhere.`,
  unvisited_prospect: () => 'No visit has been logged for this prospect yet. Schedule a first visit.',
};

const band = (s) => (s == null ? '' : s >= 4 ? 'good' : s === 3 ? 'mid' : 'low');

function frequencyHint(count, months) {
  if (!count) return `No orders in the last ${months} months`;
  const perWeek = count / (months * 4.35);
  if (perWeek >= 1) return `About ${Math.round(perWeek)} order${Math.round(perWeek) === 1 ? '' : 's'} a week`;
  const days = Math.round((months * 30.4) / count);
  if (days <= 45) return `About 1 order every ${Math.max(1, Math.round(days / 7))} weeks`;
  return `About 1 order every ${Math.round(days / 30.4)} months`;
}

function FactorCard({ title, icon, score, children }) {
  return (
    <div className={`card stp-factor ${band(score)}`}>
      <div className="stp-factor-head">
        <span className="stp-factor-name"><Icon name={icon} size={16} />{title}</span>
        <span className="stp-factor-score">{score ?? '—'}<small>/5</small></span>
      </div>
      <Steps value={score} />
      {children}
    </div>
  );
}

function characterFacts(a) {
  if (a.character_source === 'payments') {
    return {
      main: `Avg ${Math.round(a.avg_days_to_pay)} days to pay`,
      sub: [Number(a.avg_days_late) > 0 ? `${Math.round(a.avg_days_late)} days past terms` : 'Within terms',
        a.pct_on_time != null && `${Math.round(a.pct_on_time)}% paid on time`, `${peso(a.overdue_balance)} overdue`].filter(Boolean).join(' · '),
    };
  }
  if (a.character_source === 'overdue') {
    return {
      main: `${peso(a.overdue_balance)} overdue`,
      sub: `${Math.round(Number(a.overdue_pct))}% of the window's purchases. No collection dates recorded yet, so this is scored on the overdue balance.`,
    };
  }
  return { main: 'No payment history yet', sub: 'Neutral score of 3 until invoices fall due.' };
}

export default function StpAccountView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [a, setA] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'edit' | 'visit' | 'override'
  const { meta } = useStpMeta(a?.fiscal_year);
  const isAdmin = can(ROUTE, 'can_delete');

  const load = useCallback(() => {
    api.get(`/stp/accounts/${id}`).then(({ data }) => { setA(data); setError(''); })
      .catch((e) => setError(apiError(e, 'Could not load the account.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function removeAccount() {
    if (!window.confirm(`Remove ${a.account_name} from ${a.territory_name}? Its visit log and score history go with it.`)) return;
    try {
      await api.delete(`/stp/accounts/${a.id}`);
      navigate(`/stp/accounts?fy=${a.fiscal_year}`);
    } catch (e) { setError(apiError(e, 'Could not remove the account.')); }
  }

  async function removeVisit(v) {
    if (!window.confirm(`Delete the visit of ${date(v.visit_date)}?`)) return;
    try { await api.delete(`/stp/visits/${v.id}`); load(); } catch (e) { setError(apiError(e, 'Could not delete the visit.')); }
  }

  if (error && !a) return <div className="error-banner">{error}</div>;
  if (!a) return <LoadingSpinner />;

  const w = a.weights || {};
  const equal = ['recency', 'frequency', 'volume', 'character'].every((k) => Number(w[k]) === Number(w.recency));
  const months = a.window_months || 12;
  const ch = characterFacts(a);
  const scored = a.score_id && !a.is_prospect;
  const potential = Number(a.annual_potential) || 0;
  const penetration = potential > 0 ? Number(a.current_revenue) / potential : null;
  const kind = a.customer_id ? 'Customer' : a.lead_id ? `Lead ${a.lead_no || ''}` : 'Prospect';
  const history = [...a.history].reverse(); // oldest first for the trend

  return (
    <div className="stp-page">
      <Link to={`/stp/accounts?fy=${a.fiscal_year}`} className="stp-back">← Back to accounts</Link>
      <div className="stp-head">
        <div className="stp-title">
          <Avatar name={a.account_name} size={52} tone={a.tier === 'C' ? 'warning' : a.tier ? 'primary' : 'neutral'} />
          <div style={{ minWidth: 0 }}>
            <h1>{a.account_name} <TierPill tier={a.tier} prospect={a.is_prospect} /></h1>
            <div className="stp-meta">
              <span className="stp-meta-chip"><Icon name="segment" size={13} />{a.segment}</span>
              <Link className="stp-meta-chip" to={`/stp/territories/${a.territory_id}?fy=${a.fiscal_year}`}><Icon name="map" size={13} />{a.territory_name}</Link>
              <span className="stp-meta-chip"><Icon name="user" size={13} />{a.owner_name || 'No owner'}</span>
              <span className="stp-meta-chip">{kind}</span>
              <span className="stp-meta-chip"><Icon name="calendar" size={13} />FY {a.fiscal_year}</span>
            </div>
          </div>
        </div>
        <div className="stp-actions">
          {can(ROUTE, 'can_add') && <button className="btn" onClick={() => setModal('visit')}><Icon name="visit" size={16} />Log visit</button>}
          {can(ROUTE, 'can_edit') && <button className="btn btn-primary" onClick={() => setModal('edit')}>Edit account</button>}
          {isAdmin && <button className="btn btn-danger" onClick={removeAccount}>Remove</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {a.flags.map((f) => (
        <div key={f} className="stp-banner" role="alert">
          <Icon name="alert" size={20} />
          <div><strong>{FLAG_LABELS[f]}</strong>{FLAG_ADVICE[f](a)}</div>
        </div>
      ))}

      <div className="stp-factors">
        <div className="card stp-total">
          <span className="cap">RFVC score</span>
          <ScoreRing value={scored ? a.total_score : null} tier={a.computed_tier} />
          <span className="note">
            {scored ? (equal ? `Weights ${w.recency}% each` : `Weights R ${w.recency} · F ${w.frequency} · V ${w.volume} · C ${w.character}`)
              : a.is_prospect ? 'Prospect — no invoices to score yet' : 'Not scored yet — recalculate scores'}
          </span>
          {a.computed_tier ? <span className={`stp-pill tier-${a.computed_tier}`}>Computed tier {a.computed_tier}</span> : null}
          {a.tier_override && (
            <span className="note">
              Override <strong>Tier {a.tier_override}</strong>{a.tier_override_reason ? ` — ${a.tier_override_reason}` : ''}
              {a.tier_override_by && <> · {a.tier_override_by}, {displayAuditTime(a.tier_override_at)}</>}
            </span>
          )}
          {isAdmin && <button className="btn btn-sm" onClick={() => setModal('override')}>{a.tier_override ? 'Change override' : 'Override tier'}</button>}
        </div>

        <FactorCard title="Recency" icon="recency" score={a.recency_score}>
          <div className="stp-fact">{a.days_since_last_order != null ? `Last order ${a.days_since_last_order} day${a.days_since_last_order === 1 ? '' : 's'} ago` : 'No orders yet'}</div>
          {a.last_invoice_date && <div className="stp-fact-sub">Invoice dated {date(a.last_invoice_date)}</div>}
        </FactorCard>
        <FactorCard title="Frequency" icon="frequency" score={a.frequency_score}>
          <div className="stp-fact">{a.order_count != null ? `${Number(a.order_count).toLocaleString()} orders in ${months} months` : '—'}</div>
          {a.order_count != null && <div className="stp-fact-sub">{frequencyHint(a.order_count, months)}</div>}
        </FactorCard>
        <FactorCard title="Volume" icon="volume" score={a.volume_score}>
          <div className="stp-fact">{a.net_volume != null ? `${peso(a.net_volume)} invoiced` : '—'}</div>
          {a.net_volume != null && <div className="stp-fact-sub">Last {months} months, net of credit memos</div>}
        </FactorCard>
        <FactorCard title="Character" icon="character" score={a.character_score}>
          {scored ? <><div className="stp-fact">{ch.main}</div><div className="stp-fact-sub">{ch.sub}</div></> : <div className="stp-fact">—</div>}
        </FactorCard>
      </div>

      <div className="stp-two">
        <div className="card">
          <div className="stp-card-head"><h3><Icon name="target" size={18} />Account plan</h3></div>
          <div className="stp-plan">
            <div className="stp-tile wide">
              <div className="row">
                <div>
                  <div className="k">Current revenue (FY {a.fiscal_year}) vs annual potential</div>
                  <div className="v">{peso(a.current_revenue)} <span className="s">of {potential ? peso(potential) : 'no potential set'}</span></div>
                </div>
                {!potential && can(ROUTE, 'can_edit') && <button type="button" className="stp-link-btn" onClick={() => setModal('edit')}>Set annual potential</button>}
              </div>
              {potential > 0 && <Bar value={penetration} over={penetration > 1} />}
            </div>
            <div className="stp-tile">
              <Icon name="visit" />
              <div>
                <div className="k">Last visit</div>
                <div className="v">{a.last_visit ? date(a.last_visit) : 'None yet'}</div>
                {a.crm_last_visit && a.crm_last_visit === a.last_visit && <div className="s">From the CRM</div>}
              </div>
            </div>
            <div className="stp-tile">
              <Icon name="calendar" />
              <div>
                <div className="k">Next visit · {a.visit_cadence}</div>
                <div className="v" style={{ marginTop: 4 }}><VisitStatus next={a.next_visit_due} overdue={a.visit_overdue} today={meta?.today || new Date().toISOString().slice(0, 10)} /></div>
              </div>
            </div>
            <div className="stp-tile">
              <Icon name="terms" />
              <div>
                <div className="k">Credit terms</div>
                <div className="v">{a.credit_terms || '—'}</div>
                <div className="s">From the latest invoice</div>
              </div>
            </div>
          </div>
          {a.notes && <p className="stp-fact-sub" style={{ whiteSpace: 'pre-wrap', marginTop: 14 }}>{a.notes}</p>}
        </div>

        <div className="card">
          <div className="stp-card-head">
            <h3><Icon name="history" size={18} />Score history</h3>
            <span className="stp-count">{a.history.length} run{a.history.length === 1 ? '' : 's'}</span>
          </div>
          {a.history.length === 0 ? (
            <Empty icon="history" title="No scoring runs yet">Scores appear after the nightly run or Recalculate scores.</Empty>
          ) : (
            <>
              <ScoreTrend points={history} />
              <div className="table-wrap">
                <table className="stp-table">
                  <thead><tr><th>Calculated</th><th>R · F · V · C</th><th className="stp-num">Score</th><th>Tier</th></tr></thead>
                  <tbody>
                    {a.history.slice(0, 8).map((h) => (
                      <tr key={h.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{date(h.period_end)}</td>
                        <td><span className="stp-chips"><ScoreChip value={h.recency_score} /><ScoreChip value={h.frequency_score} /><ScoreChip value={h.volume_score} /><ScoreChip value={h.character_score} /></span></td>
                        <td className="stp-num"><strong>{scoreText(h.total_score)}</strong></td>
                        <td>{h.computed_tier ? <TierPill tier={h.computed_tier} short /> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card stp-section">
        <div className="stp-card-head">
          <h3><Icon name="visit" size={18} />Visit log</h3>
          {can(ROUTE, 'can_add') && a.visits.length > 0 && <button className="btn btn-sm" onClick={() => setModal('visit')}>Log visit</button>}
        </div>
        {a.visits.length === 0 ? (
          <Empty icon="visit" title="No visits logged yet"
            action={can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setModal('visit')}>Log the first visit</button>}>
            Logging a visit sets the last-visit date and schedules the next one ({a.visit_cadence.toLowerCase()}).
          </Empty>
        ) : (
          <ul className="stp-timeline">
            {a.visits.map((v) => (
              <li key={v.id}>
                <Avatar name={v.rep_name || '?'} size={32} />
                <div className="body">
                  <div className="when">{date(v.visit_date)}</div>
                  <div className="who">{v.rep_name || 'Unknown rep'}{v.created_by && v.created_by !== v.rep_name ? ` · logged by ${v.created_by}` : ''}</div>
                  {v.notes && <div className="notes">{v.notes}</div>}
                </div>
                {isAdmin && <button className="btn btn-sm btn-danger" onClick={() => removeVisit(v)} style={{ alignSelf: 'flex-start' }}>Delete</button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {modal === 'edit' && (
        <AccountModal account={a} fy={a.fiscal_year} meta={meta} territories={meta?.territories || []}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
      {modal === 'visit' && <VisitModal account={a} meta={meta} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'override' && (
        <OverrideModal account={a} requireReason={a.require_override_reason} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}
