import { Fragment, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { Sparkline, DonutChart, GaugeRing, BarList, Holo3DOrb, Holo3DBars, useCountUp } from '../components/charts';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import SyncFromSourceButton from '../components/SyncFromSourceButton';
import { parseUtc } from '../utils/datetime';
import { isPlanner } from '../utils/plannerRoles';
import Feed from './Feed';
import '../styles/feed.css';

// "20 August 2026" from a YYYY-MM-DD key. Built from the parts rather than new Date(key):
// a bare date string is parsed as UTC midnight, which displays as the previous day at UTC+8.
function formatDayHeading(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

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
// Incentive is earned in fractions of a peso -- 7.50 a layout, 5% of an NSTDJO line -- so it
// keeps two decimals where the whole-peso money() above would round 1,207.50 up to 1,208 and
// disagree with Reports > Artist Incentive, which shows the exact figure.
function money2(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
function StatCard({ label, value, numericValue, format, icon, tone = 'purple', trend, detail }) {
  const animated = useCountUp(numericValue ?? 0);
  const displayValue = numericValue !== undefined ? (format ? format(animated) : Math.round(animated)) : value;
  return (
    <div className={`holo-card holo-stat-card tone-${tone}`}>
      <div className="holo-stat-top">
        <div>
          <div className="holo-stat-label">{label}</div>
          <div className="holo-stat-value">{displayValue}</div>
          {/* Breaks the headline figure down without splitting it into a second card --
              the total is still the number the artist reads first. */}
          {detail && <div className="holo-stat-detail">{detail}</div>}
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

// /dashboard hosts two things now: the company newsfeed (default) and the role dashboards
// that used to live here on their own. The choice sticks per browser so someone who works
// out of the metrics view isn't sent back to the feed on every navigation.
const TAB_KEY = 'dashboard.tab';

export default function Dashboard() {
  const location = useLocation();
  const [tab, setTab] = useState(() => localStorage.getItem(TAB_KEY) || 'feed');

  // A #post-123 hash means someone opened a feed notification. Force the Feed tab even if
  // they were last on the dashboard -- and do it on every hash change, since clicking a
  // second notification while already on /dashboard doesn't remount this component.
  useEffect(() => {
    if (location.hash.startsWith('#post-')) setTab('feed');
  }, [location.hash, location.key]);

  function pick(next) {
    setTab(next);
    localStorage.setItem(TAB_KEY, next);
  }

  return (
    <>
      <div className={`fbfeed${tab === 'dashboard' ? ' plain' : ''}`} style={{ marginBottom: tab === 'dashboard' ? 0 : -16 }}>
        <div className="fb-tabs">
          <button type="button" className={`fb-tab${tab === 'feed' ? ' active' : ''}`} onClick={() => pick('feed')}>
            📰 Feed
          </button>
          <button type="button" className={`fb-tab${tab === 'dashboard' ? ' active' : ''}`} onClick={() => pick('dashboard')}>
            📊 My Dashboard
          </button>
        </div>
      </div>
      {tab === 'feed' ? <Feed /> : <RoleDashboard />}
    </>
  );
}

// The original dashboard, unchanged apart from being mounted behind the tab. Its /dashboard
// request only fires when the tab is actually opened, so the feed doesn't pay for it.
function RoleDashboard() {
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
          <div className="holo-sub">Good Day Graphicstarian </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* No `module` prop -> syncs ALL transaction types (SO/Invoice/DT/PO/Estimate) in one click. */}
          <SyncFromSourceButton label="Sync All from Source" />
          <span className="holo-role-badge">{ROLE_LABELS[data.role] || data.role}</span>
        </div>
      </div>

      {data.role === 'admin' && <AdminDashboard data={data} user={user} navigate={navigate} />}
      {data.role === 'design_supervisor' && <DesignSupervisorDashboard data={data} user={user} navigate={navigate} />}
      {data.role === 'artist' && <ArtistDashboard data={data} user={user} navigate={navigate} />}
      {!['admin', 'design_supervisor', 'artist'].includes(data.role) && <SalesDashboard data={data} user={user} navigate={navigate} />}
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
        {isPlanner(user) ? (
          // A planner opens this screen to answer "what is on the floor this month", not to
          // read a sales trend -- so the forecast calendar takes that panel for them.
          <ForecastCalendarCard navigate={navigate} />
        ) : (
          <div className="holo-card dash-chart-card">
            <h3>Org-Wide Sales Trend</h3>
            <div className="holo-tile-dark">
              <Holo3DOrb value={approvalRingValue} max={100} color="var(--holo-cyan)" sub="estimates approved" />
              <div style={{ padding: '10px 0', display: 'flex', justifyContent: 'center' }}>
                <Holo3DBars data={data.trend} color="#a78bfa" width={260} height={90} labels={last6MonthLabels()} />
              </div>
            </div>
          </div>
        )}
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

function SalesDashboard({ data, user, navigate }) {
  const { summary, byRep, role } = data;

  // Pages on its own, like the artist calendar, so changing month is one small request rather
  // than rebuilding every figure on the dashboard.
  const [month, setMonth] = useState(data.calendarMonth);
  const [calendar, setCalendar] = useState(data.calendar || []);
  const [calLoading, setCalLoading] = useState(false);

  async function loadMonth(ym) {
    setCalLoading(true);
    try {
      const { data: d } = await api.get('/dashboard/sales-calendar', { params: { month: ym } });
      setMonth(d.month);
      setCalendar(d.calendar || []);
    } catch {
      // Leave the month showing what it had rather than blanking the calendar on a hiccup.
    } finally {
      setCalLoading(false);
    }
  }
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
          <h3>Scheduled JO / NSTDJO</h3>
          {/* Jobs sit on their delivery date -- what the rep promised the customer -- not on
              the artist's layout schedule. Clicking a chip opens the document itself rather
              than the artist's run screen, which sales has no business driving. */}
          <ScheduleCalendar
            month={month}
            jobs={calendar}
            loading={calLoading}
            onMonth={loadMonth}
            navigate={navigate}
            pathFor={(j) => (j.kind === 'NSTDJO' ? `/non-standard-job-orders/${j.id}` : `/job-orders/${j.id}`)}
            tooltipFor={(j) => [
              j.jobOrderNo,
              j.customerName || '—',
              j.anchor === 'delivery' ? `Delivery ${String(j.day)}` : `No delivery date — planned start ${String(j.day)}`,
              j.subStatus || j.status,
              j.artistName ? `Artist: ${j.artistName}` : 'No artist assigned',
            ].join(' · ')}
          />
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

// Mirrors ProductionJobOrderView's STAGE_LABELS -- the planner's calendar has to name a
// stage the same way the production screen it links to does.
const PROD_STAGE_LABELS = {
  pending_for_scheduling: 'Pending for Sched.',
  for_revision: 'For Revision',
  in_process_with_revision: 'In-Process w/ Rev.',
  in_process: 'In-Process',
  for_qi: 'For QI',
  partially_completed: 'Part. Completed',
  completed: 'Completed',
  invoiced: 'Invoiced',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// A month grid of the artist's scheduled work, replacing the old performance orb -- an artist
// needs to know what is coming and when, which a single averaged percentage cannot say.
// Carries both Job Orders and Non-Standard Job Orders; each chip's tooltip gives the planned
// start -> end window, and clicking it opens that document's own run screen.
//
// Days are keyed by the plain YYYY-MM-DD the server sends, never by parsing it into a Date and
// reading it back: at UTC+8 `new Date('2026-08-01')` is 8am local, and formatting it in another
// timezone slides the job onto the previous day.
// Every job order whose forecast window covers a day, laid out as a month. Kept separate from
// ScheduleCalendar rather than bent to fit: that one's day popup is built around an artist's
// incentive and actual-end times, which say nothing to someone scheduling the floor. The grid
// classes are shared so the two read as the same calendar.
const JO_COLOURS = 8;

// Which of the eight .jo-c* colours each job order wears, for one month's worth of jobs.
//
// The starting point is a hash of the job order number, not the job's position in the list, so a
// job keeps the same colour on every day of its window and from one load to the next -- a band
// whose colour changed partway across would read as two different jobs.
//
// Eight colours and a hash will sometimes hand two jobs the same one. That does not matter for
// jobs at opposite ends of the month, but two OVERLAPPING jobs in one colour merge into what
// looks like a single longer band, which is exactly the misreading this feature exists to
// prevent. So a job whose hashed colour is already taken by a job it overlaps moves to the next
// free one. Deterministic for a given set of jobs, and only jobs that actually clash are moved.
function assignJoColours(jobs) {
  const day = (v) => String(v || '').slice(0, 10);
  const ordered = [...jobs].sort((a, b) => day(a.plannedStart).localeCompare(day(b.plannedStart))
    || String(a.jobOrderNo).localeCompare(String(b.jobOrderNo)));
  const byId = new Map();
  const placed = [];
  for (const j of ordered) {
    const s = String(j.jobOrderNo || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 100003;
    const start = day(j.plannedStart);
    const end = day(j.plannedEnd);
    const clashes = (idx) => placed.some((p) => p.idx === idx && p.start <= end && p.end >= start);
    let idx = h % JO_COLOURS;
    for (let n = 0; n < JO_COLOURS && clashes(idx); n += 1) idx = (idx + 1) % JO_COLOURS;
    placed.push({ idx, start, end });
    byId.set(j.id, `jo-c${idx}`);
  }
  return byId;
}

function ForecastCalendarCard({ navigate }) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/dashboard/production-calendar', { params: { month } })
      .then(({ data: d }) => { if (!cancelled) setJobs(d.jobs || []); })
      .catch(() => { if (!cancelled) setJobs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month]);

  const [year, monthNo] = month.split('-').map(Number);
  const first = new Date(year, monthNo - 1, 1);
  const daysInMonth = new Date(year, monthNo, 0).getDate();
  const leading = first.getDay();

  // A job occupies every day of its forecast window, not just the start -- that span is the
  // whole point of the calendar, so the walk happens here rather than the server sending the
  // same job once per day it covers.
  const byDay = new Map();
  for (const j of jobs) {
    const start = String(j.plannedStart || '').slice(0, 10);
    const end = String(j.plannedEnd || '').slice(0, 10);
    if (!start || !end) continue;
    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = `${year}-${pad(monthNo)}-${pad(d)}`;
      if (key < start || key > end) continue;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(j);
    }
  }
  // Ordered the same way in every cell, so a job holds its row as its band crosses the week
  // instead of hopping up and down as other jobs start and finish around it.
  for (const list of byDay.values()) {
    list.sort((a, b) => String(a.plannedStart).localeCompare(String(b.plannedStart))
      || String(a.jobOrderNo).localeCompare(String(b.jobOrderNo)));
  }
  const colourById = assignJoColours(jobs);

  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(`${year}-${pad(monthNo)}-${pad(d)}`);

  const shift = (delta) => {
    const base = new Date(year, monthNo - 1 + delta, 1);
    setMonth(`${base.getFullYear()}-${pad(base.getMonth() + 1)}`);
  };

  // The span in words as well as in colour: the band shows how long a job runs, this says it
  // exactly, including the part that falls outside the month on screen.
  const spanLabel = (j) => {
    const start = String(j.plannedStart).slice(0, 10);
    const end = String(j.plannedEnd).slice(0, 10);
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
    return `${start} to ${end} (${days} day${days === 1 ? '' : 's'})`;
  };

  return (
    <div className="holo-card dash-chart-card">
      <h3>Production Schedule</h3>
      <div className="artist-calendar">
        <div className="artist-calendar-head">
          <button type="button" className="btn btn-sm" onClick={() => shift(-1)} disabled={loading}>&lsaquo;</button>
          <strong>{MONTH_NAMES[monthNo - 1]} {year}</strong>
          <button type="button" className="btn btn-sm" onClick={() => shift(1)} disabled={loading}>&rsaquo;</button>
          <span className="muted artist-calendar-count">
            {loading ? 'Loading...' : `${jobs.length} scheduled`}
          </span>
        </div>

        <div className="artist-calendar-grid">
          {WEEKDAYS.map((w) => <div key={w} className="artist-calendar-weekday">{w}</div>)}
          {cells.map((key, i) => {
            if (!key) return <div key={`pad-${i}`} className="artist-calendar-day is-empty" />;
            const dayJobs = byDay.get(key) || [];
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                className={`artist-calendar-day is-clickable${key === todayKey ? ' is-today' : ''}${dayJobs.length ? ' has-jobs' : ''}`}
                title={dayJobs.length ? `${dayJobs.length} in the window -- click to see them` : 'Nothing scheduled -- click to confirm'}
                onClick={() => setOpenDay(key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenDay(key); } }}
              >
                <span className="artist-calendar-daynum">{Number(key.slice(8, 10))}</span>
                {dayJobs.slice(0, 3).map((j) => {
                  // Square the edge the window carries on through, so consecutive days join into
                  // one band. Compared as plain YYYY-MM-DD strings, which sort correctly and keep
                  // this free of the timezone slide the day keys are built to avoid.
                  const start = String(j.plannedStart || '').slice(0, 10);
                  const end = String(j.plannedEnd || '').slice(0, 10);
                  return (
                    <span
                      key={j.id}
                      className={`artist-calendar-chip jo-span ${colourById.get(j.id) || 'jo-c0'}${key > start ? ' is-cont-left' : ''}${key < end ? ' is-cont-right' : ''}`}
                      title={`${j.jobOrderNo} - ${j.customerName || ''} - ${spanLabel(j)}`}
                    >
                      {j.jobOrderNo}
                    </span>
                  );
                })}
                {dayJobs.length > 3 && <span className="artist-calendar-more">+{dayJobs.length - 3} more</span>}
              </div>
            );
          })}
        </div>

        {openDay && (
          <Modal title={`Scheduled on ${formatDayHeading(openDay)}`} onClose={() => setOpenDay(null)} large>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>JO #</th><th>Job Type</th><th>Qty</th><th>Forecast</th>
                    <th>Delivery</th><th>Stage</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {!(byDay.get(openDay) || []).length && (
                    <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                      Nothing scheduled on this day.
                    </td></tr>
                  )}
                  {(byDay.get(openDay) || []).map((j) => (
                    <tr key={j.id}>
                      <td>
                        <strong>{j.jobOrderNo}</strong>
                        {j.customerName && <div className="muted" style={{ fontSize: '0.85em' }}>{j.customerName}</div>}
                      </td>
                      <td>
                        {j.jobTypeName}
                        {j.jobLocationName && <div className="muted" style={{ fontSize: '0.85em' }}>{j.jobLocationName}</div>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{Number(j.quantity || 0)} {j.units || ''}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{spanLabel(j)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {j.deliveryDate ? String(j.deliveryDate).slice(0, 10) : <span className="muted">-</span>}
                      </td>
                      <td>
                        {PROD_STAGE_LABELS[j.stage] || j.stage || '-'}
                        {!!j.onHold && <div className="muted" style={{ fontSize: '0.85em' }}>On Hold</div>}
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/production/${j.id}`)}>Open</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}

// Where a process has actually got to. The badge classes carry the colour; nothing here sets
// one, so these follow the design tokens like every other badge.
const PROCESS_STATUS = {
  done: { label: 'Done', className: 'badge badge-success' },
  in_progress: { label: 'In progress', className: 'badge badge-info' },
  on_hold: { label: 'On hold', className: 'badge badge-warning' },
  not_started: { label: 'Not started', className: 'badge badge-muted' },
};

// The processes under one scheduled job order, fetched only when a row is actually opened.
// A month of job orders is a lot of process lines to load for the two or three anyone expands.
function ProcessBreakdown({ kind, id }) {
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: '', data: null });
    api.get(`/dashboard/scheduled-processes/${kind || 'JO'}/${id}`)
      .then(({ data }) => { if (live) setState({ loading: false, error: '', data }); })
      .catch((err) => {
        if (live) setState({ loading: false, error: err.response?.data?.error || 'Could not load the processes for this job order.', data: null });
      });
    return () => { live = false; };
  }, [kind, id]);

  if (state.loading) return <div className="muted" style={{ padding: 'var(--space-3)' }}>Loading processes…</div>;
  if (state.error) return <div className="muted" style={{ padding: 'var(--space-3)' }}>{state.error}</div>;

  const { processes = [], hasProcesses, note } = state.data || {};
  if (!processes.length) {
    return <div className="muted" style={{ padding: 'var(--space-3)' }}>This job order has no processes on it.</div>;
  }

  return (
    <div style={{ padding: 'var(--space-3)' }}>
      {/* Said plainly rather than shown as a one-row table that looks like a bug. */}
      {hasProcesses === false && note && (
        <div className="muted" style={{ marginBottom: 'var(--space-2)' }}>{note}</div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>Process</th><th>Material</th><th>Assigned To</th><th>Status</th><th>Completed</th></tr>
          </thead>
          <tbody>
            {processes.map((p, i) => {
              const st = PROCESS_STATUS[p.status] || PROCESS_STATUS.not_started;
              return (
                <tr key={p.id}>
                  <td>{p.lineNo || i + 1}</td>
                  <td>{p.processName || <span className="muted">—</span>}</td>
                  <td>{p.itemName || <span className="muted">—</span>}</td>
                  <td>{p.assignedTo || <span className="muted">Unassigned</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className={st.className}>{st.label}</span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {Number(p.total || 0) > 0
                      ? `${Number(p.totalCompleted || 0)} / ${Number(p.total)} ${p.unit || ''}`
                      : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScheduleCalendar({ month, jobs, loading, onMonth, navigate, pathFor, tooltipFor }) {
  // Which row's processes are open. One at a time: the popup is not tall enough for two
  // breakdowns, and the question is always about one job order.
  const [openRow, setOpenRow] = useState(null);
  const [year, monthNo] = String(month || '').split('-').map(Number);
  const valid = Number.isFinite(year) && Number.isFinite(monthNo);
  const first = valid ? new Date(year, monthNo - 1, 1) : new Date();
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const leading = first.getDay();

  // The day whose jobs are being shown in the popup, or null. Held here rather than in the
  // parent so paging months closes it -- the day it refers to is no longer on screen.
  const [openDay, setOpenDay] = useState(null);

  const byDay = new Map();
  for (const j of jobs || []) {
    if (!j.day) continue;
    if (!byDay.has(j.day)) byDay.set(j.day, []);
    byDay.get(j.day).push(j);
  }

  const pad = (n) => String(n).padStart(2, '0');
  const todayKey = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  })();

  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(`${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(d)}`);
  }

  const shift = (delta) => {
    const base = new Date(first.getFullYear(), first.getMonth() + delta, 1);
    onMonth(`${base.getFullYear()}-${pad(base.getMonth() + 1)}`);
  };

  return (
    <div className="artist-calendar">
      <div className="artist-calendar-head">
        <button type="button" className="btn btn-sm" onClick={() => shift(-1)} disabled={loading}>‹</button>
        <strong>{valid ? `${MONTH_NAMES[monthNo - 1]} ${year}` : ''}</strong>
        <button type="button" className="btn btn-sm" onClick={() => shift(1)} disabled={loading}>›</button>
        <span className="muted artist-calendar-count">
          {loading ? 'Loading...' : `${(jobs || []).length} scheduled`}
        </span>
      </div>

      <div className="artist-calendar-grid">
        {WEEKDAYS.map((w) => <div key={w} className="artist-calendar-weekday">{w}</div>)}
        {cells.map((key, i) => {
          if (!key) return <div key={`pad-${i}`} className="artist-calendar-day is-empty" />;
          const dayJobs = byDay.get(key) || [];
          const dayNo = Number(key.slice(8, 10));
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              // EVERY day opens, including empty ones. Making only busy days clickable meant a
              // click on a quiet day did nothing at all, which is indistinguishable from the
              // feature being broken -- an empty day answers "nothing scheduled", which is
              // itself worth knowing.
              className={`artist-calendar-day is-clickable${key === todayKey ? ' is-today' : ''}${dayJobs.length ? ' has-jobs' : ''}`}
              title={dayJobs.length ? `${dayJobs.length} scheduled — click to see them` : 'Nothing scheduled — click to confirm'}
              onClick={() => setOpenDay(key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenDay(key); }
              }}
            >
              <span className="artist-calendar-daynum">{dayNo}</span>
              {dayJobs.slice(0, 3).map((j) => {
                const state = j.done ? 'Completed' : j.running ? 'Running' : 'Not Started';
                // A Job Order and a Non-Standard Job Order can share an id, so the key has to
                // carry the kind -- and each has its own run screen to open.
                const runPath = pathFor
                  ? pathFor(j)
                  : (j.kind === 'NSTDJO' ? `/assigned-jo/nstdjo/${j.id}` : `/assigned-jo/${j.id}`);
                // A label, not a button: the whole day is the click target now, and a button
                // inside a clickable cell is both invalid markup and two competing targets in
                // the same few pixels. Opening a job happens from the day's popup.
                return (
                  <span
                    key={`${j.kind || 'JO'}-${j.id}`}
                    className="artist-calendar-chip"
                    style={TIMER_STATUS_STYLE[state]}
                    data-run-path={runPath}
                    title={tooltipFor
                      ? tooltipFor(j)
                      : `${j.jobOrderNo} · ${j.customerName || '—'} · ${state} · Planned ${formatDateTime(j.plannedStartAt)} → ${formatDateTime(j.plannedEndAt)}`}
                  >
                    {j.jobOrderNo}
                  </span>
                );
              })}
              {dayJobs.length > 3 && (
                <span className="artist-calendar-more">+{dayJobs.length - 3} more</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Wide: a row now opens a nested process table, and at the default width every column
          of it wraps onto three lines. */}
      {openDay && (
        <Modal title={`Scheduled on ${formatDayHeading(openDay)}`} onClose={() => setOpenDay(null)} large>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>JO / NSTDJO #</th>
                  <th>Status</th>
                  <th>Planned End</th>
                  <th>Actual End</th>
                  <th>Incentive</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {!(byDay.get(openDay) || []).length && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing scheduled on this day.
                  </td></tr>
                )}
                {(byDay.get(openDay) || []).map((j) => {
                  const state = j.done ? 'Completed' : j.running ? 'Running' : 'Not Started';
                  const runPath = pathFor
                    ? pathFor(j)
                    : (j.kind === 'NSTDJO' ? `/assigned-jo/nstdjo/${j.id}` : `/assigned-jo/${j.id}`);
                  const rowKey = `${j.kind || 'JO'}-${j.id}`;
                  const isOpen = openRow === rowKey;
                  return (
                    <Fragment key={rowKey}>
                    <tr>
                      <td>
                        {/* The whole-job status above answers "has anyone touched it". This
                            opens the only answer a rep chasing a customer can use: which
                            process is done and which has not started. */}
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          aria-expanded={isOpen}
                          title={isOpen ? 'Hide processes' : 'Show processes'}
                          onClick={() => setOpenRow(isOpen ? null : rowKey)}
                          style={{ marginRight: 'var(--space-2)' }}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                        <strong>{j.jobOrderNo}</strong>
                        {j.customerName && <div className="muted" style={{ fontSize: '0.85em' }}>{j.customerName}</div>}
                      </td>
                      <td>
                        {/* Both statuses, because they answer different questions: sub status
                            is whose hands the job is in, the timer state is how far this
                            artist got with it. */}
                        <span className="badge" style={TIMER_STATUS_STYLE[state]}>{state}</span>
                        {j.subStatus && <div className="muted" style={{ fontSize: '0.85em' }}>{j.subStatus}</div>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(j.plannedEndAt)}</td>
                      {/* Regularly a different day from the plan, and the one that decides
                          which month the incentive is credited to. Flagged when the two
                          differ so an artist can see why a job counts where it does. */}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {j.actualEndAt ? formatDateTime(j.actualEndAt) : <span className="muted">—</span>}
                        {j.actualEndAt && String(j.actualEndAt).slice(0, 10) !== String(j.plannedEndAt).slice(0, 10) && (
                          <div className="muted" style={{ fontSize: '0.85em' }}>different day</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {Number(j.incentiveAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        {j.incentiveBasis && <div className="muted" style={{ fontSize: '0.85em' }}>{j.incentiveBasis}</div>}
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(runPath)}>Open</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--color-neutral-bg)' }}>
                          <ProcessBreakdown kind={j.kind} id={j.id} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ArtistDashboard({ data, user, navigate }) {
  const activity = data.schedule.slice(0, 4).map((r) => ({
    title: `${r.jobOrderNo} · ${r.customerName || '—'}`,
    sub: `${timerStatus(r)} · Planned End ${formatDateTime(r.plannedEndAt)}`,
    onClick: () => navigate(`/assigned-jo/${r.id}`),
  }));

  // The calendar pages independently of the rest of the dashboard, so moving to another month
  // is one small request rather than rebuilding every figure on the screen.
  const [month, setMonth] = useState(data.calendarMonth);
  const [calendar, setCalendar] = useState(data.calendar || []);
  const [incentive, setIncentive] = useState({ amount: data.incentiveThisMonth, jobs: data.incentiveJobs });
  const [calLoading, setCalLoading] = useState(false);

  async function loadMonth(ym) {
    setCalLoading(true);
    try {
      const { data: d } = await api.get('/dashboard/artist-calendar', { params: { month: ym } });
      setMonth(d.month);
      setCalendar(d.calendar || []);
      setIncentive({ amount: d.incentive, jobs: d.incentiveJobs });
    } catch {
      // Leave the month showing what it had rather than blanking the calendar on a hiccup.
    } finally {
      setCalLoading(false);
    }
  }

  const isCurrentMonth = month === data.calendarMonth;

  return (
    <>
      <StatRow cards={[
        {
          // Both document types are the artist's active work, so the card totals them and
          // shows the split underneath -- an artist carrying five NSTDJOs and no JOs was
          // previously shown a bare "0".
          label: 'Active Job Orders',
          value: data.active,
          detail: `JO ${data.activeJo ?? 0} · NSTDJO ${data.activeNstdjo ?? 0}`,
          icon: '🎨',
        },
        {
          // Incentive earned from the job orders actually finished in the month being viewed --
          // the same 7.50-per-layout / NSTDJO-per-line rules as Reports > Artist Incentive.
          label: isCurrentMonth ? 'Incentive This Month' : `Incentive · ${month}`,
          value: `₱${money2(incentive.amount ?? 0)}`,
          icon: '💰',
        },
        { label: 'Completed This Month', value: data.completedThisMonth, icon: '✅' },
        { label: 'Avg. Performance', value: data.avgPerformance === null ? '—' : `${data.avgPerformance}%`, icon: '⚡' },
      ]} />

      <div className="dash-main-grid">
        <ProfileCard user={user} roleLabel={ROLE_LABELS.artist} rings={data.rings} activity={activity} />
        <div className="holo-card dash-chart-card">
          <h3>Scheduled JO / NSTDJO</h3>
          <ScheduleCalendar
            month={month}
            jobs={calendar}
            loading={calLoading}
            onMonth={loadMonth}
            navigate={navigate}
          />
        </div>
      </div>

      <div className="holo-card">
        <h3>My Schedule</h3>
        <ScheduleTable rows={data.schedule} navigate={(url) => navigate(url.replace('/job-orders/', '/assigned-jo/'))} showArtist={false} />
      </div>
    </>
  );
}
