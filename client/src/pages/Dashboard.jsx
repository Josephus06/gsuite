import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { Sparkline, DonutChart, GaugeRing, BarList } from '../components/charts';

const ROLE_LABELS = {
  admin: 'Administrator',
  sales_manager: 'Sales Manager',
  supervisor: 'Sales Supervisor',
  account_officer: 'Account Officer',
  design_supervisor: 'Design Supervisor',
  artist: 'Artist',
};

// Mirrors AssignedJobOrders.jsx's own timerStatus() -- kept in sync since both derive
// the same Play/Hold/Stop state off the same three fields.
function timerStatus(row) {
  if (row.layoutEndedAt) return 'Completed';
  if (row.isRunning) return 'Running';
  if (row.layoutStartedAt) return 'Held';
  return 'Not Started';
}
const TIMER_STATUS_STYLE = {
  'Not Started': { background: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
  Held: { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' },
  Running: { background: 'rgba(34,211,238,0.15)', color: '#22d3ee' },
  Completed: { background: 'rgba(52,211,153,0.15)', color: '#34d399' },
};
function formatDateTime(v) { return v ? new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }

const JOB_TYPE_COLORS = ['#22d3ee', '#f472b6', '#a78bfa', '#fbbf24', '#34d399'];
const PIPELINE_COLORS = {
  pending_supervisor_approval: '#fbbf24',
  pending_customer_approval: '#f472b6',
  approved: '#34d399',
  cancelled: '#6b7280',
  disapproved: '#ef4444',
};
const STATUS_PILL_STYLE = {
  pending_supervisor_approval: { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' },
  pending_customer_approval: { background: 'rgba(244,114,182,0.15)', color: '#f472b6' },
  approved: { background: 'rgba(52,211,153,0.15)', color: '#34d399' },
  cancelled: { background: 'rgba(107,114,128,0.2)', color: '#9ca3af' },
  disapproved: { background: 'rgba(239,68,68,0.15)', color: '#ef4444' },
};

function money(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatCard({ label, value, icon, color, trend }) {
  return (
    <div className="holo-card holo-stat-card">
      <div className="holo-stat-top">
        <div>
          <div className="holo-stat-label">{label}</div>
          <div className="holo-stat-value" style={{ color }}>{value}</div>
        </div>
        {icon && (
          <div className="holo-stat-icon" style={{ color, background: `${color}22` }}>{icon}</div>
        )}
      </div>
      {trend && <Sparkline data={trend} color={color} id={label.replace(/\s+/g, '-')} />}
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/dashboard')
      .then(({ data }) => setData(data))
      .catch(() => setError('Could not load dashboard data.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="holo-dashboard"><p className="holo-empty">Loading dashboard...</p></div>;
  if (error || !data) return <div className="holo-dashboard"><p className="holo-empty">{error || 'No data.'}</p></div>;

  return (
    <div className="holo-dashboard">
      <div className="holo-header">
        <div>
          <h1>Welcome back, {user?.display_name}</h1>
          <div className="holo-sub">Here's what's happening across your pipeline today.</div>
        </div>
        <span className="holo-role-badge">{ROLE_LABELS[data.role] || data.role}</span>
      </div>

      {data.role === 'admin' && <AdminDashboard data={data} />}
      {data.role === 'design_supervisor' && <DesignSupervisorDashboard data={data} navigate={navigate} />}
      {data.role === 'artist' && <ArtistDashboard data={data} navigate={navigate} />}
      {!['admin', 'design_supervisor', 'artist'].includes(data.role) && <SalesDashboard data={data} />}
    </div>
  );
}

function AdminDashboard({ data }) {
  const trendingTotal = data.trendingJobTypes.reduce((s, j) => s + j.uses, 0);
  const jobTypeSegments = data.trendingJobTypes.map((j, i) => ({ label: j.name, value: j.uses, color: JOB_TYPE_COLORS[i % JOB_TYPE_COLORS.length] }));

  return (
    <>
      <div className="holo-grid">
        <StatCard label="Total Active Users" value={data.activeUsers} color="var(--holo-cyan)" icon="👥" />
        <StatCard label="Sales This Month" value={`₱${money(data.salesThisMonth.amount)}`} color="var(--holo-violet)" icon="📈" trend={data.trend} />
        <StatCard label="Pending Approvals" value={data.pendingApprovals} color="var(--holo-amber)" icon="⏳" />
        <StatCard label="Orders This Month" value={data.salesThisMonth.count} color="var(--holo-green)" icon="🧾" />
      </div>

      <div className="holo-grid holo-grid-wide">
        <div className="holo-card">
          <h3>Top Customers by Amount Ordered</h3>
          <BarList
            color="var(--holo-cyan)"
            data={data.topCustomers.map((c) => ({ label: c.name, value: c.amount, color: '#22d3ee' }))}
            formatValue={(v) => `₱${money(v)}`}
          />
        </div>

        <div className="holo-card">
          <h3>Most Trending Job Type</h3>
          {data.trendingJobTypes.length ? (
            <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <DonutChart data={jobTypeSegments} centerLabel={trendingTotal} centerSub="uses" />
              <div className="holo-legend" style={{ flex: 1, minWidth: 140 }}>
                {jobTypeSegments.map((s, i) => (
                  <div className="holo-legend-row" key={i}>
                    <span className="holo-legend-dot" style={{ background: s.color, color: s.color }} />
                    <span className="holo-legend-label">{s.label}</span>
                    <span className="holo-legend-value">{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : <p className="holo-empty">No job order lines yet.</p>}
        </div>

        <div className="holo-card">
          <h3>Sales Performance per Department</h3>
          <BarList
            color="var(--holo-magenta)"
            data={data.salesByDepartment.map((d) => ({ label: d.name, value: d.amount, color: '#f472b6' }))}
            formatValue={(v) => `₱${money(v)}`}
          />
        </div>

        <div className="holo-card">
          <h3>Recent Estimates</h3>
          {data.recentEstimates.length ? (
            <div className="holo-activity">
              {data.recentEstimates.map((r) => (
                <div className="holo-activity-row" key={r.id}>
                  <div>
                    <div className="holo-activity-main">{r.estimateNo} · {r.customerName}</div>
                    <div className="holo-activity-sub">{timeAgo(r.createdAt)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="holo-activity-amount">₱{money(r.totalAmount)}</div>
                    <span className="holo-status-pill" style={STATUS_PILL_STYLE[r.status]}>{r.status.replaceAll('_', ' ')}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="holo-empty">No estimates yet.</p>}
        </div>
      </div>
    </>
  );
}

function SalesDashboard({ data }) {
  const { summary, byRep, role } = data;
  const pipelineSegments = summary.pipeline.map((p) => ({ label: p.status.replaceAll('_', ' '), value: p.count, color: PIPELINE_COLORS[p.status] || '#8d90c4' }));
  const pipelineTotal = summary.pipeline.reduce((s, p) => s + p.count, 0);

  return (
    <>
      <div className="holo-grid">
        <StatCard label="Weighted Sales (This Month)" value={`₱${money(summary.weightedSales.amount)}`} color="var(--holo-cyan)" icon="⚖️" trend={summary.trend} />
        <StatCard label="Total Paid Orders" value={`₱${money(summary.paid.amount)}`} color="var(--holo-green)" icon="✅" />
        <StatCard label="Total Unpaid Orders" value={`₱${money(summary.unpaid.amount)}`} color="var(--holo-amber)" icon="🕓" />
        <StatCard label="Avg. Deal Size" value={`₱${money(summary.avgDealSize)}`} color="var(--holo-magenta)" icon="💼" />
      </div>

      <div className="holo-grid holo-grid-wide">
        <div className="holo-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <h3 style={{ alignSelf: 'flex-start' }}>KPI · Win Rate</h3>
          <GaugeRing value={summary.kpi.winRate} max={100} color="var(--holo-cyan)" label={`${summary.kpi.winRate}%`} sub="win rate" />
          <div style={{ display: 'flex', gap: 24, marginTop: 14, fontSize: 12.5 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'var(--holo-text-dim)' }}>Estimates Created</div>
              <div style={{ fontWeight: 700, color: '#fff' }}>{summary.kpi.estimatesCreated}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'var(--holo-text-dim)' }}>Approved</div>
              <div style={{ fontWeight: 700, color: '#fff' }}>{summary.kpi.estimatesApproved}</div>
            </div>
          </div>
        </div>

        <div className="holo-card">
          <h3>Estimate Pipeline</h3>
          {pipelineSegments.length ? (
            <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <DonutChart data={pipelineSegments} centerLabel={pipelineTotal} centerSub="estimates" />
              <div className="holo-legend" style={{ flex: 1, minWidth: 140 }}>
                {pipelineSegments.map((s, i) => (
                  <div className="holo-legend-row" key={i}>
                    <span className="holo-legend-dot" style={{ background: s.color, color: s.color }} />
                    <span className="holo-legend-label">{s.label}</span>
                    <span className="holo-legend-value">{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : <p className="holo-empty">No estimates yet.</p>}
        </div>

        <div className="holo-card">
          <h3>Weighted Sales Trend</h3>
          <div style={{ padding: '10px 0' }}>
            <Sparkline data={summary.trend} color="#22d3ee" width={320} height={90} id="trend-wide" />
          </div>
          <div className="holo-sub" style={{ marginTop: 8 }}>Last 6 months, sales orders created</div>
        </div>
      </div>

      {role !== 'account_officer' && (
        <div className="holo-card">
          <h3>{role === 'sales_manager' ? 'All Sales Users' : 'My Team'}</h3>
          {byRep.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="holo-rep-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Weighted Sales</th>
                    <th>Win Rate</th>
                    <th>Paid</th>
                    <th>Unpaid</th>
                  </tr>
                </thead>
                <tbody>
                  {byRep.map((r) => (
                    <tr key={r.userId}>
                      <td>{r.name}</td>
                      <td>₱{money(r.weightedSales.amount)}</td>
                      <td>{r.kpi.winRate}%</td>
                      <td>₱{money(r.paid.amount)}</td>
                      <td>₱{money(r.unpaid.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="holo-empty">No one reports to you yet.</p>}
        </div>
      )}
    </>
  );
}

function ScheduleTable({ rows, navigate, showArtist = true }) {
  if (!rows.length) return <p className="holo-empty">Nothing scheduled.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="holo-rep-table">
        <thead>
          <tr>
            <th>JO #</th>
            {showArtist && <th>Artist</th>}
            <th>Customer</th>
            <th>Description</th>
            <th>Planned Start</th>
            <th>Planned End</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const status = timerStatus(r);
            return (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/job-orders/${r.id}`)}>
                <td>{r.jobOrderNo}</td>
                {showArtist && <td>{r.artistName || '—'}</td>}
                <td>{r.customerName || '—'}</td>
                <td>{r.description}</td>
                <td>{formatDateTime(r.plannedStartAt)}</td>
                <td>{formatDateTime(r.plannedEndAt)}</td>
                <td><span className="holo-status-pill" style={TIMER_STATUS_STYLE[status]}>{status}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DesignSupervisorDashboard({ data, navigate }) {
  const workloadData = data.workload.map((w, i) => ({ label: w.name, value: w.count, color: JOB_TYPE_COLORS[i % JOB_TYPE_COLORS.length] }));

  return (
    <>
      <div className="holo-grid">
        <StatCard label="Pending My Assignment" value={data.pendingAssignment} color="var(--holo-amber)" icon="📥" />
        <StatCard label="Not Yet Started" value={data.notStarted} color="var(--holo-magenta)" icon="⏸️" />
        <StatCard label="In Progress" value={data.inProgress} color="var(--holo-cyan)" icon="🎨" />
        <StatCard label="Pending Sales Approval" value={data.pendingSalesApproval} color="var(--holo-green)" icon="✅" />
      </div>

      <div className="holo-grid holo-grid-wide">
        <div className="holo-card">
          <h3>Workload per Artist</h3>
          <BarList color="var(--holo-violet)" data={workloadData} />
        </div>

        <div className="holo-card">
          <h3>Running Past Planned End</h3>
          {data.overdue.length ? (
            <div className="holo-activity">
              {data.overdue.map((o) => (
                <div className="holo-activity-row" key={o.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/job-orders/${o.id}`)}>
                  <div>
                    <div className="holo-activity-main">{o.jobOrderNo} · {o.artistName || 'Unassigned'}</div>
                    <div className="holo-activity-sub">Planned End: {formatDateTime(o.plannedEndAt)}</div>
                  </div>
                  <span className="holo-status-pill" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>Overdue</span>
                </div>
              ))}
            </div>
          ) : <p className="holo-empty">Nothing currently running is overdue.</p>}
        </div>
      </div>

      <div className="holo-card">
        <h3>Artist Schedule</h3>
        <ScheduleTable rows={data.schedule} navigate={navigate} />
      </div>
    </>
  );
}

function ArtistDashboard({ data, navigate }) {
  return (
    <>
      <div className="holo-grid">
        <StatCard label="Active Job Orders" value={data.active} color="var(--holo-cyan)" icon="🎨" />
        <StatCard label="Not Yet Started" value={data.notStarted} color="var(--holo-magenta)" icon="⏸️" />
        <StatCard label="Completed This Month" value={data.completedThisMonth} color="var(--holo-green)" icon="✅" />
        <StatCard label="Avg. Performance" value={data.avgPerformance === null ? '—' : `${data.avgPerformance}%`} color="var(--holo-amber)" icon="⚡" />
      </div>

      <div className="holo-card">
        <h3>My Schedule</h3>
        <ScheduleTable rows={data.schedule} navigate={(url) => navigate(url.replace('/job-orders/', '/assigned-jo/'))} showArtist={false} />
      </div>
    </>
  );
}
