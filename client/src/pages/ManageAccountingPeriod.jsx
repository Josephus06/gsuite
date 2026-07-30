import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const QUARTERS = [
  { label: 'First Quarter', months: [1, 2, 3] },
  { label: 'Second Quarter', months: [4, 5, 6] },
  { label: 'Third Quarter', months: [7, 8, 9] },
  { label: 'Fourth Quarter', months: [10, 11, 12] },
];
const FLAGS = [
  { key: 'close_ar', label: 'Close A/R' },
  { key: 'close_ap', label: 'Close A/P' },
  { key: 'close_other_gl', label: 'Close Other GL' },
  { key: 'close_non_gl', label: 'Close Non-GL' },
  { key: 'close_all', label: 'Close All' },
];

// Close Accounting: lock accounting periods per fiscal-year month. Each month has five close flags.
// Checking "Close All" ticks the whole row; unchecking it clears the row.
export default function ManageAccountingPeriod() {
  const { can } = useAuth();
  const canEdit = can('/manage-accounting-period', 'can_edit');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState('');

  async function load() {
    const { data } = await api.get('/manage-accounting-period');
    setRows(data);
    setLoading(false);
    // Expand the most recent fiscal year by default.
    const years = [...new Set(data.map((r) => r.fiscal_year))].sort((a, b) => b - a);
    if (years.length) setExpanded((e) => (Object.keys(e).length ? e : { [years[0]]: true }));
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const byYear = useMemo(() => {
    const map = new Map();
    for (const r of rows) { if (!map.has(r.fiscal_year)) map.set(r.fiscal_year, {}); map.get(r.fiscal_year)[r.period_month] = r; }
    return [...map.entries()].sort((a, b) => a[0] - b[0]); // ascending like the live page
  }, [rows]);

  async function toggle(row, key, value) {
    setError('');
    // "Close All" is a master switch for the row; the others are independent.
    const patch = key === 'close_all'
      ? Object.fromEntries(FLAGS.map((f) => [f.key, value ? 1 : 0]))
      : { [key]: value ? 1 : 0 };
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
    try { await api.put(`/manage-accounting-period/${row.id}`, patch); }
    catch (e) { setError(e.response?.data?.error || 'Update failed'); load(); }
  }

  async function addFy() {
    const yr = prompt('Fiscal year to add (e.g. 2027):');
    const fy = Number(yr);
    if (!Number.isInteger(fy)) return;
    try { await api.post('/manage-accounting-period/add-fy', { fiscal_year: fy }); await load(); setExpanded((e) => ({ ...e, [fy]: true })); }
    catch (e) { setError(e.response?.data?.error || 'Add FY failed'); }
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Close Accounting</h1>
        {can('/manage-accounting-period', 'can_add') && <button className="btn btn-primary" onClick={addFy}>Add FY</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Fiscal Year / Period</th>
                {FLAGS.map((f) => <th key={f.key} style={{ textAlign: 'center' }}>{f.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {byYear.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No fiscal years. Click Add FY.</td></tr>}
              {byYear.map(([fy, months]) => {
                const open = !!expanded[fy];
                return (
                  <FragmentRows key={fy}>
                    <tr style={{ background: 'var(--surface-2, #f8fafc)', cursor: 'pointer' }} onClick={() => setExpanded((e) => ({ ...e, [fy]: !e[fy] }))}>
                      <td style={{ fontWeight: 700 }}><span style={{ display: 'inline-block', width: 16 }}>{open ? '▾' : '▸'}</span> FY : {fy}</td>
                      <td colSpan={5} />
                    </tr>
                    {open && QUARTERS.map((q) => (
                      <FragmentRows key={q.label}>
                        <tr><td colSpan={6} style={{ fontWeight: 600, color: 'var(--muted)', paddingLeft: 28 }}>{q.label}</td></tr>
                        {q.months.map((m) => {
                          const row = months[m];
                          if (!row) return null;
                          return (
                            <tr key={m}>
                              <td style={{ paddingLeft: 48 }}>{MONTHS[m - 1]} {fy}</td>
                              {FLAGS.map((f) => (
                                <td key={f.key} style={{ textAlign: 'center' }}>
                                  <input type="checkbox" checked={!!row[f.key]} disabled={!canEdit} onChange={(e) => toggle(row, f.key, e.target.checked)} />
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </FragmentRows>
                    ))}
                  </FragmentRows>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// eslint-disable-next-line react/jsx-no-useless-fragment
function FragmentRows({ children }) { return <>{children}</>; }
