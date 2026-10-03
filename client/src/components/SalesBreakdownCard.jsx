import { useEffect, useState } from 'react';
import api from '../api/client';

function peso(v) {
  const n = Number(v);
  return `₱${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// One sales group: its total, each supervisor with their team's total and the reps under them,
// then anyone in the group who reports to no supervisor.
function GroupColumn({ g }) {
  return (
    <div style={{ minWidth: 220, flex: '1 1 220px', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: 8 }}>
        <span>{g.name}</span><span>{peso(g.total)}</span>
      </div>
      {g.supervisors.map((s) => (
        <div key={s.userId} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
            <span>{s.name} <span className="muted" style={{ fontWeight: 400 }}>(supervisor)</span></span><span>{peso(s.team)}</span>
          </div>
          {s.own > 0 && s.members.length > 0 && (
            <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 16, fontSize: 13 }}>
              <span>own sales</span><span>{peso(s.own)}</span>
            </div>
          )}
          {s.members.map((m) => (
            <div key={m.name} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 16, fontSize: 13 }}>
              <span>{m.name}</span><span>{peso(m.amount)}</span>
            </div>
          ))}
        </div>
      ))}
      {g.others.map((o) => (
        <div key={o.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span>{o.name}</span><span>{peso(o.amount)}</span>
        </div>
      ))}
    </div>
  );
}

// Dashboard: one month's Weighted Sales by SBU -> sales group -> supervisor (team) -> rep. The
// server decides what this viewer sees (an admin everything, an SBU head their group, a supervisor
// their team, an account officer themself), so the card has no role logic of its own.
export default function SalesBreakdownCard({ title = 'Sales Performance per Group' }) {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    api.get('/dashboard/sales-breakdown', { params: { month } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load sales.'); });
    return () => { live = false; };
  }, [month]);

  return (
    <div className="holo-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {data && <strong>{peso(data.total)}</strong>}
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </div>
      </div>
      <p className="muted" style={{ marginTop: -6, fontSize: 12 }}>Weighted sales: net of tax of the month&apos;s sales orders (cancelled excluded).</p>
      {error && <div className="error-banner">{error}</div>}
      {!data ? <p className="holo-empty">Loading…</p> : (data.sbus.length === 0 && data.otherGroups.length === 0) ? (
        <p className="holo-empty">No sales orders in this month.</p>
      ) : (
        <>
          {data.sbus.map((s) => (
            <div key={s.label} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
                <span>{s.label} — {s.owner}</span><span>Total {peso(s.total)}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {s.groups.map((g) => <GroupColumn key={g.id} g={g} />)}
              </div>
            </div>
          ))}
          {data.otherGroups.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Other sales groups</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {data.otherGroups.map((g) => <GroupColumn key={g.id} g={g} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
