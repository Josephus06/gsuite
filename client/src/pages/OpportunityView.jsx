import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import ActivityTimeline from '../components/ActivityTimeline';
import LoadingSpinner from '../components/LoadingSpinner';

const STAGE_LABELS = { prospecting: 'Prospecting', qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
const STAGES = Object.keys(STAGE_LABELS);

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

export default function OpportunityView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [opp, setOpp] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    return api.get(`/opportunities/${id}`).then(({ data }) => { setOpp(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function moveStage(stage) {
    let lostReason = null;
    if (stage === 'lost') {
      lostReason = prompt('Reason this Opportunity was lost:');
      if (!lostReason) return;
    }
    try {
      await api.put(`/opportunities/${id}/stage`, { stage, lost_reason: lostReason });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to move stage');
    }
  }

  if (loading || !opp) return <LoadingSpinner />;

  const isClosed = opp.stage === 'won' || opp.stage === 'lost';

  return (
    <div>
      <div className="page-header">
        <div />
        <button className="btn btn-sm" onClick={() => navigate('/opportunities')}>Back</button>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Opportunity</h1>
          <span className="estimate-no">{opp.opportunity_no}</span>
        </div>
        <div className="estimate-status">
          {STAGE_LABELS[opp.stage]}
          {opp.stage === 'lost' && opp.lost_reason && <span style={{ opacity: 0.7 }}> · {opp.lost_reason}</span>}
        </div>
        <div className="estimate-detail-grid">
          <div>
            <div>Name : <span className="hi">{opp.name}</span></div>
            <div>Customer : <span className="hi">
              {opp.customer_id
                ? <button type="button" className="link-btn" onClick={() => navigate(`/customers/${opp.customer_id}`)}>{opp.customer_name}</button>
                : (opp.lead_company_name || '—')}
            </span></div>
            <div>Sales Rep : <span className="hi">{opp.sales_rep_name || '—'}</span></div>
          </div>
          <div>
            <div>Estimated Value : <span className="hi">{money(opp.estimated_value)}</span></div>
            <div>Expected Close : <span className="hi">{formatDate(opp.expected_close_date)}</span></div>
            {opp.estimate_no && <div>Linked Estimate : <span className="hi">{opp.estimate_no}</span></div>}
          </div>
          <div>
            <div>Memo : <span className="hi">{opp.memo || '—'}</span></div>
            <div>Created By : <span className="hi">{opp.created_by_name || '—'}</span></div>
          </div>
        </div>
      </div>

      {!isClosed && can('/opportunities', 'can_edit') && (
        <div className="card" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="muted">Move to:</span>
          {STAGES.filter((s) => s !== opp.stage).map((s) => (
            <button key={s} type="button" className="btn btn-sm" onClick={() => moveStage(s)}>{STAGE_LABELS[s]}</button>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Activity</h3>
        <ActivityTimeline relatedType="Opportunity" relatedId={opp.id} />
      </div>
    </div>
  );
}
