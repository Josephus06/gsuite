import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';

// Reports > Fuel Issuance (2026-11-23): Audit's control over fuel slips -- every Fuel Request in a
// range with its vehicle, litres, approver and every print / reprint of its slip, and the exceptions
// flagged (server: routes/fuelIssuanceReport.js says what each flag means).

const money = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (v, d = 2) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
const FLAG_TONE = {
  reprinted: '#b91c1c', over_limit: '#b91c1c', odometer: '#b45309', same_day: '#b91c1c',
  self_approved: '#b91c1c', typed_vehicle: '#475569', not_printed: '#2563eb',
};
const FLAG_HELP = {
  not_printed: 'Approved but the slip was never printed (not issued yet, or printed before 23 Nov 2026 when printing started being counted).',
  reprinted: 'The slip was printed more than once -- each copy is another voucher at the gas station.',
  over_limit: "The requester's month (submitted, noted and approved requests) is past their fuel limit.",
  odometer: 'A Fleet vehicle with no odometer, or one not higher than its previous approved fill.',
  same_day: 'The same vehicle got more than one approved fill on the same day.',
  typed_vehicle: 'Not a Fleet vehicle -- typed by hand, so nothing ties it to a registered plate.',
  self_approved: 'The requester approved their own request.',
};

function monthToDate() {
  const t = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return { from: `${t.slice(0, 7)}-01`, to: t, status: 'approved', department_id: '', user_id: '', vehicle: '', flagged: false };
}
const params = (f) => ({
  from: f.from, to: f.to, status: f.status,
  ...(f.department_id ? { department_id: f.department_id } : {}),
  ...(f.user_id ? { user_id: f.user_id } : {}),
  ...(f.vehicle.trim() ? { vehicle: f.vehicle.trim() } : {}),
  ...(f.flagged ? { flagged: '1' } : {}),
});

function Chip({ flag, label }) {
  return (
    <span title={FLAG_HELP[flag]} style={{ display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '1px 7px', margin: '0 4px 3px 0',
      borderRadius: 10, color: FLAG_TONE[flag], border: `1px solid ${FLAG_TONE[flag]}55`, background: `${FLAG_TONE[flag]}12`, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

export default function FuelIssuanceReport() {
  const [f, setF] = useState(monthToDate);
  const [applied, setApplied] = useState(monthToDate);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [opts, setOpts] = useState({ departments: [], requesters: [] });
  const [onlyFlag, setOnlyFlag] = useState('');
  const [tab, setTab] = useState('issuances');
  const [open, setOpen] = useState(null);

  useEffect(() => { api.get('/reports/fuel-issuance/filters').then(({ data: d }) => setOpts(d)).catch(() => {}); }, []);
  const load = useCallback(async (q) => {
    setLoading(true); setError('');
    try { const { data: d } = await api.get('/reports/fuel-issuance', { params: params(q) }); setData(d); }
    catch (e) { setError(e.response?.data?.error || 'Could not load the report.'); }
    setLoading(false);
  }, []);
  useEffect(() => { load(applied); }, [load, applied]);

  async function exportXlsx() {
    const res = await api.get('/reports/fuel-issuance/export', { params: params(applied), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = `fuel-issuance-${applied.from}-to-${applied.to}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const labels = data?.flag_labels || {};
  const rows = useMemo(() => (data?.rows || []).filter((r) => !onlyFlag || r.flags.includes(onlyFlag)), [data, onlyFlag]);
  const s = data?.summary;

  return (
    <div>
      <div className="page-header">
        <h1>Fuel Issuance Report</h1>
        <button className="btn btn-primary" disabled={loading || !data?.rows?.length} onClick={exportXlsx}>Export to Excel</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>Fuel date from</label><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
          <div className="field"><label>To</label><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
          <div className="field">
            <label>Status</label>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="approved">Approved (issued)</option>
              <option value="all">All requests</option>
            </select>
          </div>
          <div className="field">
            <label>Charge to (department)</label>
            <select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
              <option value="">All</option>
              {opts.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Requester / driver</label>
            <select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })}>
              <option value="">All</option>
              {opts.requesters.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Vehicle / plate</label><input value={f.vehicle} placeholder="e.g. 325GRT" onChange={(e) => setF({ ...f, vehicle: e.target.value })} /></div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={f.flagged} onChange={(e) => setF({ ...f, flagged: e.target.checked })} /> Exceptions only
            </label>
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={() => { setOnlyFlag(''); setApplied({ ...f }); }}>Generate</button>
          </div>
        </div>
      </div>

      {loading ? <LoadingSpinner /> : s && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 12 }}>
          {[
            ['Requests', num(s.total.requests, 0)],
            ['Liters', num(s.total.liters, 3)],
            ['Amount', `₱${money(s.total.amount)}`],
            ['Slips printed', num(s.total.prints, 0)],
            ['Reprints', num(s.total.reprints, 0)],
            ['With exceptions', num(s.total.with_flags, 0)],
          ].map(([k, v]) => (
            <div className="card" key={k} style={{ padding: '10px 14px' }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>{k}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: k === 'Reprints' && s.total.reprints ? '#b91c1c' : undefined }}>{v}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
          <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>Exceptions (click to show only those):</span>
          {Object.entries(s.flags).map(([k, n]) => (
            <button key={k} type="button" onClick={() => { setTab('issuances'); setOnlyFlag(onlyFlag === k ? '' : k); }}
              title={FLAG_HELP[k]} className="btn btn-sm"
              style={{ marginRight: 6, marginBottom: 4, opacity: n ? 1 : 0.45, borderColor: onlyFlag === k ? FLAG_TONE[k] : undefined, color: n ? FLAG_TONE[k] : undefined }}>
              {labels[k]} · {n}
            </button>
          ))}
          {onlyFlag && <button type="button" className="btn btn-sm" onClick={() => setOnlyFlag('')}>Show all</button>}
        </div>

        <div className="status-tabs" style={{ marginBottom: 8 }}>
          {[['issuances', `Issuances (${rows.length})`], ['vehicle', 'By Vehicle'], ['department', 'By Department'], ['requester', 'By Requester']].map(([k, l]) => (
            <button key={k} className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {tab === 'issuances' ? (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Control No.</th><th>Fuel Date</th><th>Requester / Driver</th><th>Charge to</th><th>Vehicle</th>
                    <th style={{ textAlign: 'right' }}>Liters</th><th style={{ textAlign: 'right' }}>Amount</th>
                    <th style={{ textAlign: 'right' }}>Odometer</th><th style={{ textAlign: 'right' }}>Km / L</th>
                    <th>Gas Station</th><th>Approved by</th><th style={{ textAlign: 'center' }}>Printed</th><th>Exceptions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>No fuel requests match.</td></tr>}
                  {rows.map((r) => (
                    <tr key={r.id} style={{ verticalAlign: 'top' }}>
                      <td><Link to={`/forms/${r.id}`}>{r.request_no}</Link>{r.status !== 'approved' && <div className="muted" style={{ fontSize: 11 }}>{r.status}</div>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.fuel_date}</td>
                      <td>{r.requester}</td>
                      <td>{r.department}</td>
                      <td>{r.vehicle}</td>
                      <td style={{ textAlign: 'right' }}>
                        {num(r.liters, 3)}
                        {r.month_limit != null && <div className="muted" style={{ fontSize: 11 }} title="This requester's month: used / limit">{num(r.month_used, 3)} / {num(r.month_limit, 3)} L</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {num(r.odometer_km, 0)}
                        {r.km_since_last != null && <div className="muted" style={{ fontSize: 11 }}>+{num(r.km_since_last, 0)} km</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{num(r.km_per_liter)}</td>
                      <td>{r.station}</td>
                      <td>{r.approved_by_name}{r.approved_at && <div className="muted" style={{ fontSize: 11 }}>{String(r.approved_at).slice(0, 16).replace('T', ' ')}</div>}</td>
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <button type="button" className="link-btn" disabled={!r.prints.length} onClick={() => setOpen(open === r.id ? null : r.id)}
                          style={{ fontWeight: 700, color: r.print_count > 1 ? '#b91c1c' : undefined }}>
                          {r.print_count}×
                        </button>
                        {open === r.id && (
                          <div style={{ textAlign: 'left', fontSize: 11, marginTop: 4 }}>
                            {r.prints.map((p, i) => <div key={i}>{p.event} {p.at} · {p.by}</div>)}
                          </div>
                        )}
                      </td>
                      <td>{r.flags.map((k) => <Chip key={k} flag={k} label={labels[k]} />)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{tab === 'vehicle' ? 'Vehicle' : tab === 'department' ? 'Department' : 'Requester'}</th>
                    <th style={{ textAlign: 'right' }}>Requests</th><th style={{ textAlign: 'right' }}>Liters</th>
                    <th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Km travelled</th>
                    <th style={{ textAlign: 'right' }}>Km / L</th><th style={{ textAlign: 'right' }}>With exceptions</th>
                  </tr>
                </thead>
                <tbody>
                  {(s[`by_${tab}`] || []).map((g) => (
                    <tr key={g.label}>
                      <td>{g.label}</td><td style={{ textAlign: 'right' }}>{g.requests}</td>
                      <td style={{ textAlign: 'right' }}>{num(g.liters, 3)}</td><td style={{ textAlign: 'right' }}>{money(g.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{g.km ? num(g.km, 0) : ''}</td><td style={{ textAlign: 'right' }}>{num(g.km_per_liter)}</td>
                      <td style={{ textAlign: 'right', color: g.flagged ? '#b91c1c' : undefined, fontWeight: g.flagged ? 700 : 400 }}>{g.flagged || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}
