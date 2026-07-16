import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

const STAGE_LABELS = { prospecting: 'Prospecting', qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
const OPEN_STAGES = ['prospecting', 'qualified', 'proposal', 'negotiation'];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }
function isOverdue(v) { return v && new Date(v) < new Date(new Date().toDateString()); }

// The "does this actually work as a CRM" payoff page -- aggregates the pipeline
// (Opportunities by stage) and open follow-ups (crm_activities' My Tasks endpoint)
// into one view, proving the data isn't just disconnected CRUD screens.
export default function CrmDashboard() {
  const navigate = useNavigate();
  const [opportunities, setOpportunities] = useState([]);
  const [leads, setLeads] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/opportunities'),
      api.get('/leads'),
      api.get('/crm-activities/my-tasks'),
    ]).then(([o, l, t]) => {
      setOpportunities(o.data);
      setLeads(l.data.rows);
      setTasks(t.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <LoadingSpinner />;

  const openOpps = opportunities.filter((o) => OPEN_STAGES.includes(o.stage));
  const wonOpps = opportunities.filter((o) => o.stage === 'won');
  const totalPipeline = openOpps.reduce((s, o) => s + Number(o.estimated_value || 0), 0);
  const totalWon = wonOpps.reduce((s, o) => s + Number(o.estimated_value || 0), 0);
  const winRate = opportunities.filter((o) => o.stage === 'won' || o.stage === 'lost').length
    ? Math.round((wonOpps.length / opportunities.filter((o) => o.stage === 'won' || o.stage === 'lost').length) * 100)
    : 0;
  const openLeads = leads.filter((l) => l.status !== 'converted').length;

  return (
    <div>
      <div className="page-header">
        <h1>CRM Dashboard</h1>
      </div>

      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
        <div className="card"><span className="muted">Open Pipeline Value</span><div className="hi-lg">{money(totalPipeline)}</div></div>
        <div className="card"><span className="muted">Open Opportunities</span><div className="hi-lg">{openOpps.length}</div></div>
        <div className="card"><span className="muted">Won This Period</span><div className="hi-lg">{money(totalWon)}</div></div>
        <div className="card"><span className="muted">Win Rate</span><div className="hi-lg">{winRate}%</div></div>
      </div>

      <div className="review-grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>Pipeline by Stage</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Stage</th><th>Count</th><th>Value</th></tr></thead>
              <tbody>
                {Object.entries(STAGE_LABELS).map(([key, label]) => {
                  const stageRows = opportunities.filter((o) => o.stage === key);
                  const value = stageRows.reduce((s, o) => s + Number(o.estimated_value || 0), 0);
                  return (
                    <tr key={key}>
                      <td>{label}</td>
                      <td>{stageRows.length}</td>
                      <td>{money(value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => navigate('/opportunities')}>View Pipeline</button>
        </div>

        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>My Open Tasks</h3>
          {tasks.length === 0 && <div className="empty-state">No open tasks.</div>}
          {tasks.map((t) => (
            <div key={t.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>{t.subject}</div>
              {t.due_date && (
                <div className="muted" style={{ fontSize: 12, color: isOverdue(t.due_date) ? 'var(--danger)' : undefined }}>
                  Due {formatDate(t.due_date)}{isOverdue(t.due_date) ? ' (Overdue)' : ''}
                </div>
              )}
            </div>
          ))}
          <h3 className="subsection">Leads</h3>
          <div>Open Leads: <strong>{openLeads}</strong></div>
          <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => navigate('/leads')}>View Leads</button>
        </div>
      </div>
    </div>
  );
}
