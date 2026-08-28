import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 20;

function qtyFmt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function moneyFmt(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

// Mirrors the real "Bin Card" report -- a chronological, per-Item (+ optional
// per-Location) transaction ledger with a running Balance, distinct from Stock Ledger's
// Beginning/Input/Output *summary*. Every action in this build that actually moves
// inventory_locations.qty_on_hand shows up here as its own Trans # row (Receiving
// Report, Vendor Return, Item Fulfillment, Item Receipt, Assembly Build, Inventory
// Adjustment), so the running Balance always reconciles with the live on-hand snapshot.
export default function BinCardReport() {
  const [showFilters, setShowFilters] = useState(true);
  const [item, setItem] = useState(null);
  const [location, setLocation] = useState(null);
  const [period, setPeriod] = useState('as_of');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const [inventoryItems, setInventoryItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [rows, setRows] = useState(null);
  const [unitLabels, setUnitLabels] = useState({ stock_unit_label: 'Stock Unit', base_unit_label: 'Base Unit' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  // Off by default: the anchored view is the one that answers "what is on the shelf". Full
  // history replays every movement this database holds from zero, which is what the migration
  // actually brought over and disagrees with the source system on 55% of item+location pairs.
  const [fullHistory, setFullHistory] = useState(false);
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    api.get('/inventory').then(({ data }) => setInventoryItems(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
  }, []);

  async function generate() {
    setError('');
    if (!item) { setError('Select an Item.'); return; }
    setLoading(true);
    const params = { item_id: item.id };
    if (location) params.location_id = location.id;
    if (period === 'as_of') params.as_of = date;
    if (fullHistory) params.full = 1;
    try {
      const { data } = await api.get('/bin-card-reports', { params });
      setRows(data.rows);
      setUnitLabels({ stock_unit_label: data.stock_unit_label, base_unit_label: data.base_unit_label });
      setMeta({
        reconciled: data.reconciled,
        window_from: data.window_from,
        opening_balance_base: data.opening_balance_base,
        opening_balance_stock: data.opening_balance_stock,
      });
      setPage(1);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil((rows?.length || 0) / PAGE_SIZE));
  const pageRows = rows ? rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  return (
    <div>
      <div className="page-header">
        <h1>Bin Card</h1>
        <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>Item:</label>
              <EntityPicker
                label="Item" items={inventoryItems} value={item?.id || ''} getLabel={(i) => i.display_name}
                columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
                searchKeys={['item_code', 'display_name']}
                onSelect={(i) => setItem(i)}
              />
            </div>
            <div className="field">
              <label>Unit Title:</label>
              <input value={item?.base_unit_title || ''} disabled />
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
              <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="as_of">As of</option>
                <option value="all">All dates</option>
              </select>
            </div>
            {period === 'as_of' && (
              <div className="field">
                <label>Date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            )}
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 16 }}>
            <button className="btn btn-primary" onClick={generate} disabled={loading}>
              Generate
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontWeight: 400 }}>
              <input type="checkbox" checked={fullHistory} onChange={(e) => setFullHistory(e.target.checked)} />
              Full history (every movement from zero, does not reconcile with stock on hand)
            </label>
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {/* Which of the two ledgers this is. Without saying so, the anchored view looks like
          history has gone missing, and the full view looks like the stock figure is wrong. */}
      {meta && (
        <div className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
          {meta.reconciled
            ? `Opened from the source system's Beginning Balance as at ${meta.window_from}; movements before that date are not replayed.`
            : 'Full history — every movement this database holds, run from zero. This does not reconcile with stock on hand.'}
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Trans. #</th>
                  <th>Ref. #</th>
                  <th>Withdraw From</th>
                  <th>Transfer To</th>
                  <th>Qty In</th>
                  <th>Qty Out</th>
                  <th>Rate</th>
                  <th>Balance(Stock Unit / {unitLabels.stock_unit_label})</th>
                  <th>Balance(Base Unit / {unitLabels.base_unit_label})</th>
                </tr>
              </thead>
              <tbody>
                {rows === null && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>Select an Item and click Generate.</td></tr>
                )}
                {rows !== null && rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transactions found.</td></tr>
                )}
                {pageRows.map((r, idx) => (
                  <tr key={idx} style={r.is_opening ? { fontWeight: 600 } : undefined}>
                    <td>{formatDate(r.trans_date)}</td>
                    <td>{r.is_opening ? <span className="muted">Beginning Balance</span> : r.trans_no}</td>
                    <td>{r.ref_no || '—'}</td>
                    <td>{r.from_location_name || ''}</td>
                    <td>{r.to_location_name || ''}</td>
                    <td>{Number(r.qty_in) ? qtyFmt(r.qty_in) : ''}</td>
                    <td>{Number(r.qty_out) ? qtyFmt(r.qty_out) : ''}</td>
                    <td>{moneyFmt(r.rate)}</td>
                    <td>{qtyFmt(r.balance_stock)}</td>
                    <td>{qtyFmt(r.balance_base)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
