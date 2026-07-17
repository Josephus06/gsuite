import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { Sparkline, DonutChart, GaugeRing, BarList, Holo3DOrb, Holo3DBars, useCountUp } from '../components/charts';
import Avatar from '../components/Avatar';
import { parseUtc } from '../utils/datetime';

const STAT_TONES = ['purple', 'blue', 'green', 'lime'];

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
  const diffMs = Date.now() - parseUtc(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
function last6MonthLabels() {
  const now = new Date();
  const out = [];
  for (let i = 5; i >= 0; i--) {
    out.push(new Date(now.getFullYear(), now.getMonth() - i, 1).toLocaleDateString('en-US', { month: 'short' }));
  }
  return out;
}

// numericValue + format are opt-in: pass a raw number and a formatter to get an
// animated count-up on mount/update; omit them and pass a pre-formatted `value` for the
// old static behavior. `tone` picks one of the 4 solid-color card backgrounds (cycled
// automatically by <StatRow> below) -- text/icon/sparkline all render in white on top.
function StatCard({ label, value, numericValue, format, icon, tone = 'purple', trend }) {
  const animated = useCountUp(numericValue ?? 0);
  const displayValue = numericValue !== undefined ? (format ? format(animated) : Math.round(animated)) : value;
  return (
    <div className={`holo-card holo-stat-card tone-${tone}`}>
      <div className="holo-stat-top">
        <div>
          <div className="holo-stat-label">{label}</div>
          <div className="holo-stat-value">{displayValue}</div>
        </div>
        {icon && <div className="holo-stat-icon">{icon}</div>}
      </div>
      {trend && <Sparkline data={trend} color="rgba(255,255,255,0.85)" id={label.replace(/\s+/g, '-')} />}
    </div>
  );
}

// Renders a row of StatCards, auto-cycling through the 4 tones so callers don't have to
// hand-assign colors.
function StatRow({ cards }) {
  return (
    <div className="holo-grid">
      {cards.map((c, i) => <StatCard key={c.label} {...c} tone={STAT_TONES[i % STAT_TONES.length]} />)}
    </div>
  );
}

// Shared left-hand profile card: avatar (click to upload a new one), role, up to 3
// small progress rings, and a short real-data activity feed -- reused by every role's
// dashboard so "the card with pictures of the user" is consistent everywhere.
function ProfileCard({ user, roleLabel, rings, activity }) {
  return (
    <div className="holo-card dash-profile-card">
      <Avatar user={user} size={88} editable />
      <div className="dash-profile-name">{user?.display_name}</div>
      <div className="dash-profile-role">{roleLabel}</div>

      {rings && rings.length > 0 && (
        <div className="dash-rings-row">
          {rings.map((r) => (
            <div className="dash-ring-item" key={r.label}>
              <GaugeRing value={r.value} size={64} thickness={7} color={r.color} label={`${r.value}%`} />
              <div className="dash-ring-label">{r.label}</div>
            </div>
          ))}
        </div>
      )}

      {activity && activity.length > 0 && (
        <>
          <div className="dash-activity-heading">Recent Activity</div>
          <div className="holo-activity">
            {activity.map((a, i) => (
              <div className="holo-activity-row" key={i} style={a.onClick ? { cursor: 'pointer' } : undefined} onClick={a.onClick}>
                <div>
                  <div className="holo-activity-main">{a.title}</div>
                  <div className="holo-activity-sub">{a.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
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
          <h1>{user?.display_name}</h1>
          <div className="holo-sub">Here's what's happening across your pipeline today.</div>
        </div>
        <span className="holo-role-badge">{ROLE_LABELS[data.role] || data.role}</span>
      </div>

      {data.role === 'admin' && <AdminDashboard data={data} user={user} navigate={navigate} />}
      {data.role === 'design_supervisor' && <DesignSupervisorDashboard data={data} user={user} navigate={navigate} />}
      {data.role === 'artist' && <ArtistDashboard data={data} user={user} navigate={navigate} />}
      {!['admin', 'design_supervisor', 'artist'].includes(data.role) && <SalesDashboard data={data} user={user} />}
    </div>
  );
}

function AdminDashboard({ data, user, navigate }) {
  const trendingTotal = data.trendingJobTypes.reduce((s, j) => s + j.uses, 0);
  const jobTypeSegments = data.trendingJobTypes.map((j, i) => ({ label: j.name, value: j.uses, color: JOB_TYPE_COLORS[i % JOB_TYPE_COLORS.length] }));
  const approvalRingValue = data.rings?.find((r) => r.label === 'Estimates Approved')?.value ?? 0;
  const activity = data.recentEstimates.slice(0, 4).map((r) => ({
    title: `${r.estimateNo} · ${r.customerName}`,
    sub: `${timeAgo(r.createdAt)} · ₱${money(r.totalAmount)}`,
    onClick: () => navigate(`/estimates/${r.id}`),
  }));

  return (
    <>
      <StatRow cards={[
        { label: 'Total Active Users', value: data.activeUsers, icon: '👥' },
        { label: 'Sales This Month', value: `₱${money(data.salesThisMonth.amount)}`, icon: '📈', trend: data.trend },
        { label: 'Pending Approvals', value: data.pendingApprovals, icon: '⏳' },
        { label: 'Orders This Month', value: data.salesThisMonth.count, icon: '🧾' },
      ]} />

      <div className="dash-main-grid">
        <ProfileCard user={user} roleLabel={ROLE_LABELS.admin} rings={data.rings} activity={activity} />
        <div className="holo-card dash-chart-card">
          <h3>Org-Wide Sales Trend</h3>
          <div className="holo-tile-dark">
            <Holo3DOrb value={approvalRingValue} max={100} color="var(--holo-cyan)" sub="estimates approved" />
            <div style={{ padding: '10px 0', display: 'flex', justifyContent: 'center' }}>
              <Holo3DBars data={data.trend} color="#a78bfa" width={260} height={90} labels={last6MonthLabels()} />
            </div>
          </div>
        </div>
      </div>

      <div className="holo-grid holo-grid-wide">
        <div className="holo-card">
          <h3>Top Customers by Amount Ordered</h3>
          <BarList
            color="var(--dash-purple)"
            data={data.topCustomers.map((c) => ({ label: c.name, value: c.amount, color: '#7c6fe8' }))}
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
            color="var(--dash-blue)"
            data={data.salesByDepartment.map((d) => ({ label: d.name, value: d.amount, color: '#4f8cf7' }))}
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

function SalesDashboard({ data, user }) {
  const { summary, byRep, role } = data;
  const pipelineSegments = summary.pipeline.map((p) => ({ label: p.status.replaceAll('_', ' '), value: p.count, color: PIPELINE_COLORS[p.status] || '#8d90c4' }));
  const pipelineTotal = summary.pipeline.reduce((s, p) => s + p.count, 0);
  const activity = summary.pipeline.map((p) => ({
    title: p.status.replaceAll('_', ' '),
    sub: `${p.count} estimate${p.count === 1 ? '' : 's'}`,
  }));

  return (
    <>
      <StatRow cards={[
        { label: 'Weighted Sales (This Month)', numericValue: summary.weightedSales.amount, format: (v) => `₱${money(v)}`, icon: '⚖️', trend: summary.trend },
        { label: 'Total Paid Orders', numericValue: summary.paid.amount, format: (v) => `₱${money(v)}`, icon: '✅' },
        { label: 'Total Unpaid Orders', numericValue: summary.unpaid.amount, format: (v) => `₱${money(v)}`, icon: '🕓' },
        { label: 'Avg. Deal Size', numericValue: summary.avgDealSize, format: (v) => `₱${money(v)}`, icon: '💼' },
      ]} />

      <div className="dash-main-grid">
        <ProfileCard user={user} roleLabel={ROLE_LABELS[role] || role} rings={summary.rings} activity={activity} />
        <div className="holo-card dash-chart-card">
          <h3>KPI · Win Rate &amp; Weighted Sales Trend</h3>
          <div className="holo-tile-dark">
            <Holo3DOrb value={summary.kpi.winRate} max={100} color="var(--holo-cyan)" sub="win rate" />
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
            <div style={{ padding: '10px 0', display: 'flex', justifyContent: 'center' }}>
              <Holo3DBars data={summary.trend} color="#22d3ee" width={260} height={90} labels={last6MonthLabels()} />
            </div>
            <div className="holo-sub" style={{ textAlign: 'center' }}>Last 6 months, sales orders created</div>
          </div>
        </div>
      </div>

      <div className="holo-grid holo-grid-wide">
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

function DesignSupervisorDashboard({ data, user, navigate }) {
  const workloadData = data.workload.map((w, i) => ({ label: w.name, value: w.count, color: JOB_TYPE_COLORS[i % JOB_TYPE_COLORS.length] }));
  const activity = data.overdue.slice(0, 4).map((o) => ({
    title: `${o.jobOrderNo} · ${o.artistName || 'Unassigned'}`,
    sub: `Overdue · Planned End ${formatDateTime(o.plannedEndAt)}`,
    onClick: () => navigate(`/job-orders/${o.id}`),
  }));

  return (
    <>
      <StatRow cards={[
        { label: 'Pending My Assignment', value: data.pendingAssignment, icon: '📥' },
        { label: 'Not Yet Started', value: data.notStarted, icon: '⏸️' },
        { label: 'In Progress', value: data.inProgress, icon: '🎨' },
        { label: 'Pending Sales Approval', value: data.pendingSalesApproval, icon: '✅' },
      ]} />

      <div className="dash-main-grid">
        <ProfileCard user={user} roleLabel={ROLE_LABELS.design_supervisor} rings={data.rings} activity={activity} />
        <div className="holo-card dash-chart-card">
          <h3>In Progress &amp; Workload per Artist</h3>
          <div className="holo-tile-dark">
            <Holo3DOrb value={data.rings?.find((r) => r.label === 'In Progress')?.value ?? 0} max={100} color="var(--holo-cyan)" sub="in progress" />
            <div style={{ padding: '10px 0', display: 'flex', justifyContent: 'center' }}>
              <Holo3DBars
                data={data.workload.map((w) => w.count)}
                color="#a78bfa"
                width={Math.max(160, data.workload.length * 42)}
                height={90}
                labels={data.workload.map((w) => w.name.split(' ')[0])}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="holo-grid holo-grid-wide">
        <div className="holo-card">
          <h3>Workload per Artist</h3>
          <BarList color="var(--dash-purple)" data={workloadData} />
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

function ArtistDashboard({ data, user, navigate }) {
  const activity = data.schedule.slice(0, 4).map((r) => ({
    title: `${r.jobOrderNo} · ${r.customerName || '—'}`,
    sub: `${timerStatus(r)} · Planned End ${formatDateTime(r.plannedEndAt)}`,
    onClick: () => navigate(`/assigned-jo/${r.id}`),
  }));

  return (
    <>
      <StatRow cards={[
        { label: 'Active Job Orders', value: data.active, icon: '🎨' },
        { label: 'Not Yet Started', value: data.notStarted, icon: '⏸️' },
        { label: 'Completed This Month', value: data.completedThisMonth, icon: '✅' },
        { label: 'Avg. Performance', value: data.avgPerformance === null ? '—' : `${data.avgPerformance}%`, icon: '⚡' },
      ]} />

      <div className="dash-main-grid">
        <ProfileCard user={user} roleLabel={ROLE_LABELS.artist} rings={data.rings} activity={activity} />
        <div className="holo-card dash-chart-card">
          <h3>Performance</h3>
          <div className="holo-tile-dark">
            <Holo3DOrb value={data.avgPerformance ?? 0} max={100} color="var(--holo-amber)" sub="avg. performance" />
          </div>
        </div>
      </div>

      <div className="holo-card">
        <h3>My Schedule</h3>
        <ScheduleTable rows={data.schedule} navigate={(url) => navigate(url.replace('/job-orders/', '/assigned-jo/'))} showArtist={false} />
      </div>
    </>
  );
}
