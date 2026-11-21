import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayAuditTime } from '../../utils/dates';
import { ROUTE, peso, date, scoreText, FLAG_LABELS, useStpMeta, apiError } from './stpUtils';
import { ScoreChip, Dots, TierPill } from './StpBits';
import { AccountModal, VisitModal, OverrideModal } from './StpForms';

// STP > Account detail: the RFVC scores with the real numbers behind each, the account plan, the
// score history and the visit log.

const FLAG_ADVICE = {
  big_buyer_slow_payer: (a) => `High Volume, but Character is ${a.character_score}/5. Review credit terms before the next order.`,
  slipping_away: (a) => `Volume is ${a.volume_score}/5, but there has been no order in ${a.days_since_last_order} days. Reach out before the account goes elsewhere.`,
  unvisited_prospect: () => 'No visit has been logged for this prospect yet. Schedule a first visit.',
};

function frequencyHint(count, months) {
  if (!count) return `No orders in the last ${months} months`;
  const days = Math.round((months * 30.4) / count);
  if (days <= 10) return `About ${Math.max(1, Math.round(count / (months * 4.35)))} order(s) a week`;
  if (days <= 45) return `About 1 order every ${Math.round(days / 7)} weeks`;
  return `About 1 order every ${Math.round(days / 30.4)} months`;
}

function FactorCard({ title, score, children }) {
  return (
    <div className="card">
      <div className="stp-factor-head"><span>{title}</span><ScoreChip value={score} /></div>
      <Dots value={score} />
      {children}
    </div>
  );
}

function characterFacts(a) {
  if (a.character_source === 'payments') {
    return {
      main: `Avg ${Math.round(a.avg_days_to_pay)} days to pay`,
      sub: [`${Number(a.avg_days_late) > 0 ? `${Math.round(a.avg_days_late)} days past terms` : 'within terms'}`,
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

  return (
    <div>
      <Link to={`/stp/accounts?fy=${a.fiscal_year}`} className="muted" style={{ fontSize: 13 }}>← Back to accounts</Link>
      <div className="stp-head" style={{ marginTop: 8 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {a.account_name} <TierPill tier={a.tier} prospect={a.is_prospect} />
          </h1>
          <p className="stp-sub">
            {a.segment} · <Link to={`/stp/territories/${a.territory_id}?fy=${a.fiscal_year}`}>{a.territory_name}</Link> · Owner: {a.owner_name || '—'}
            {a.customer_id ? ' · Customer' : a.lead_id ? ` · Lead ${a.lead_no || ''}` : ' · Prospect'} · FY {a.fiscal_year}
          </p>
        </div>
        <div className="stp-actions">
          {can(ROUTE, 'can_add') && <button className="btn" onClick={() => setModal('visit')}>Log visit</button>}
          {can(ROUTE, 'can_edit') && <button className="btn btn-primary" onClick={() => setModal('edit')}>Edit account</button>}
          {isAdmin && <button className="btn btn-danger" onClick={removeAccount}>Remove</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {a.flags.map((f) => (
        <div key={f} className="stp-banner" role="alert">
          <span aria-hidden="true">⚠</span>
          <div><strong>{FLAG_LABELS[f]}</strong>{FLAG_ADVICE[f](a)}</div>
        </div>
      ))}

      <div className="stp-factors">
        <div className="card stp-total">
          <div className="muted" style={{ fontSize: 13 }}>RFVC score</div>
          <div className="big">{scored ? scoreText(a.total_score) : '—'}</div>
          <div className="stp-fact-sub">
            {scored ? `out of 5 · ${equal ? `weights ${w.recency}% each` : `weights R ${w.recency} · F ${w.frequency} · V ${w.volume} · C ${w.character}`}`
              : a.is_prospect ? 'Prospect — no invoices to score yet' : 'Not scored yet — recalculate scores'}
          </div>
          <div style={{ margin: '10px 0' }}>
            {a.computed_tier ? <span className={`stp-pill tier-${a.computed_tier}`}>Computed tier {a.computed_tier}</span> : <TierPill prospect={a.is_prospect} />}
          </div>
          {a.tier_override && (
            <div className="stp-fact-sub" style={{ marginBottom: 8 }}>
              Override: <strong>Tier {a.tier_override}</strong>{a.tier_override_reason ? ` — ${a.tier_override_reason}` : ''}
              {a.tier_override_by && <> ({a.tier_override_by}, {displayAuditTime(a.tier_override_at)})</>}
            </div>
          )}
          {isAdmin && <button className="btn btn-sm" onClick={() => setModal('override')}>{a.tier_override ? 'Change override' : 'Override tier'}</button>}
        </div>

        <FactorCard title="Recency" score={a.recency_score}>
          <div className="stp-fact">{a.days_since_last_order != null ? `Last order ${a.days_since_last_order} days ago` : 'No orders yet'}</div>
          {a.last_invoice_date && <div className="stp-fact-sub">Invoice dated {date(a.last_invoice_date)}</div>}
        </FactorCard>
        <FactorCard title="Frequency" score={a.frequency_score}>
          <div className="stp-fact">{a.order_count != null ? `${a.order_count} orders in ${months} months` : '—'}</div>
          {a.order_count != null && <div className="stp-fact-sub">{frequencyHint(a.order_count, months)}</div>}
        </FactorCard>
        <FactorCard title="Volume" score={a.volume_score}>
          <div className="stp-fact">{a.net_volume != null ? `${peso(a.net_volume)} invoiced` : '—'}</div>
          {a.net_volume != null && <div className="stp-fact-sub">Last {months} months, net of credit memos</div>}
        </FactorCard>
        <FactorCard title="Character" score={a.character_score}>
          {scored ? <><div className="stp-fact">{ch.main}</div><div className="stp-fact-sub">{ch.sub}</div></> : <div className="stp-fact">—</div>}
        </FactorCard>
      </div>

      <div className="stp-two">
        <div className="card">
          <div className="stp-card-head"><h3>Account plan</h3></div>
          <div className="stp-plan">
            <div><div className="k">Annual potential</div><div className="v">{peso(a.annual_potential)}</div></div>
            <div><div className="k">Current revenue (FY {a.fiscal_year})</div><div className="v">{peso(a.current_revenue)}</div></div>
            <div><div className="k">Visit cadence</div><div className="v">{a.visit_cadence}</div></div>
            <div>
              <div className="k">Last visit</div>
              <div className="v">{date(a.last_visit)}</div>
              {a.crm_last_visit && a.crm_last_visit === a.last_visit && <div className="muted">from the CRM</div>}
            </div>
            <div>
              <div className="k">Next visit due</div>
              <div className={`v${a.visit_overdue ? ' stp-flag' : ''}`}>{a.next_visit_due ? date(a.next_visit_due) : 'Not scheduled'}{a.visit_overdue ? ' (overdue)' : ''}</div>
            </div>
            <div><div className="k">Credit terms</div><div className="v">{a.credit_terms || '—'}</div></div>
          </div>
          {a.notes && <p className="stp-fact-sub" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{a.notes}</p>}
        </div>

        <div className="card">
          <div className="stp-card-head"><h3>Score history</h3></div>
          <div className="table-wrap">
            <table className="stp-table">
              <thead><tr><th>Calculated</th><th>R</th><th>F</th><th>V</th><th>C</th><th className="stp-num">Score</th></tr></thead>
              <tbody>
                {a.history.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>No scoring runs yet.</td></tr>}
                {a.history.map((h) => (
                  <tr key={h.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{date(h.period_end)}</td>
                    <td><ScoreChip value={h.recency_score} /></td><td><ScoreChip value={h.frequency_score} /></td>
                    <td><ScoreChip value={h.volume_score} /></td><td><ScoreChip value={h.character_score} /></td>
                    <td className="stp-num"><strong>{scoreText(h.total_score)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="stp-card-head">
          <h3>Visit log</h3>
          {can(ROUTE, 'can_add') && <button className="btn btn-sm" onClick={() => setModal('visit')}>Log visit</button>}
        </div>
        {a.visits.length === 0 ? <p className="muted">No visits logged in STP yet.</p> : (
          <div className="table-wrap">
            <table className="stp-table">
              <thead><tr><th>Date</th><th>Rep</th><th>Notes</th><th>Logged by</th>{isAdmin && <th />}</tr></thead>
              <tbody>
                {a.visits.map((v) => (
                  <tr key={v.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{date(v.visit_date)}</td>
                    <td>{v.rep_name || '—'}</td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>{v.notes || <span className="muted">—</span>}</td>
                    <td className="muted">{v.created_by || '—'}</td>
                    {isAdmin && <td><button className="btn btn-sm btn-danger" onClick={() => removeVisit(v)}>Delete</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
