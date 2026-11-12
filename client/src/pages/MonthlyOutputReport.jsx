import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { downloadFile } from '../utils/downloadFile';

// Inventory > Reports > Monthly Output (2026-11-12), the source's /monthly-output-reports: the
// material each item put into production over a period -- Assembly Build lines summed per item,
// location and unit. Item and Location narrow it; Period is As of a day or a From .. To range.
const qty = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('en-CA');
const monthStart = () => `${today().slice(0, 8)}01`;
const R = { textAlign: 'right' };

export default function MonthlyOutputReport() {
  const [showFilters, setShowFilters] = useState(true);
  const [item, setItem] = useState(null);
  const [location, setLocation] = useState(null);
  const [mode, setMode] = useState('period');
  const [dateFrom, setDateFrom] = useState(monthStart());
  const [dateTo, setDateTo] = useState(today());
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/inventory', { params: { include_inactive: 1 } }).then(({ data }) => setItems(data)).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
  }, []);

  // The filters, shared by Generate and Extract so the file holds what is on screen.
  function params() {
    const p = { date_mode: mode, date_to: dateTo };
    if (mode === 'period') p.date_from = dateFrom;
    if (item) p.item_id = item.id;
    if (location) p.location_id = location.id;
    return p;
  }

  async function generate() {
    setError('');
    if (mode === 'period' && dateFrom && dateTo && dateFrom > dateTo) { setError('Date From is after Date To.'); return; }
    setLoading(true);
    try {
      const { data } = await api.get('/monthly-output-reports', { params: params() });
      setRows(data.rows);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not generate the report.');
    }
    setLoading(false);
  }

  async function extract() {
    setExtracting(true);
    try { await downloadFile('/monthly-output-reports/export', params(), 'monthly-output.xlsx'); }
    catch { setError('Could not extract the report.'); }
    setExtracting(false);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Monthly Output</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
          <button className="btn btn-sm" onClick={extract} disabled={extracting} title="Download the report under the filters as Excel">
            {extracting ? 'Extracting...' : 'Extract'}
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>Item:</label>
              <EntityPicker
                label="Item" items={items} value={item?.id || ''} getLabel={(i) => i.display_name}
                columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
                searchKeys={['item_code', 'display_name']}
                placeholder="--ALL--"
                onSelect={(i) => setItem(i)}
              />
            </div>
            <div className="field">
              <label>Location:</label>
              <EntityPicker
                label="Location" items={locations} value={location?.id || ''} getLabel={(l) => l.location_name}
                columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
                searchKeys={['location_name', 'location_code']}
                placeholder="--ALL--"
                onSelect={(l) => setLocation(l)}
              />
            </div>
            <div className="field">
              <label>Period:</label>
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="period">Period from</option>
                <option value="as_of">As of</option>
              </select>
            </div>
            {mode === 'period' && (
              <div className="field">
                <label>Date From</label>
                <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
              </div>
            )}
            <div className="field">
              <label>{mode === 'period' ? 'Date To' : 'Date'}</label>
              <input type="date" value={dateTo} min={mode === 'period' ? dateFrom || undefined : undefined} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={generate} disabled={loading}>Generate</button>
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item Code</th><th>Display Name</th><th>Type</th><th style={R}>Sum of Qty</th><th>Sales Unit</th><th>Location</th>
                </tr>
              </thead>
              <tbody>
                {rows === null && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>Set the filters and click Generate.</td></tr>}
                {rows && rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No output in this period.</td></tr>}
                {(rows || []).map((r) => (
                  <tr key={`${r.item_id}|${r.location_id}|${r.unit}`}>
                    <td>{r.item_code}</td>
                    <td>{r.display_name}</td>
                    <td>{r.item_type || ''}</td>
                    <td style={R}>{qty(r.qty)}</td>
                    <td>{r.unit || ''}</td>
                    <td>{r.location_name || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && rows.length > 0 && <div className="muted" style={{ marginTop: 8 }}>{rows.length} item lines</div>}
      </div>
    </div>
  );
}
