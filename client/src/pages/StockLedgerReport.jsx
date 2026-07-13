import { Fragment, useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Mirrors the real system's "Inventory > Inventory Reports > Stock Ledger" screen: per
// Item + Location, Beginning balance / Input / Output / Ending balance. The real report
// derives Beginning/Input/Output from actual stock transactions (Item Receipts,
// Transfer Orders, Item Fulfillments, ...) over the selected period -- none of those
// transactional modules exist in this build, so there's no movement history to sum.
// Those columns are always blank here; Ending Qty On-hand/Ave Cost/Value are the real
// live snapshot from Inventory, grouped the same way the real report groups rows (an
// Item header row followed by one row per Location).
function qtyFmt(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function moneyFmt(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function StockLedgerReport() {
  const [showFilters, setShowFilters] = useState(true);
  const [item, setItem] = useState(null);
  const [location, setLocation] = useState(null);
  const [period, setPeriod] = useState('as_of');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dateFrom, setDateFrom] = useState(new Date().toISOString().slice(0, 10));

  const [inventoryItems, setInventoryItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    api.get('/inventory').then(({ data }) => setInventoryItems(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
  }, []);

  async function generate() {
    setLoading(true);
    const params = {};
    if (item) params.item_id = item.id;
    if (location) params.location_id = location.id;
    const { data } = await api.get('/stock-ledger-reports', { params });
    setRows(data);
    setPage(1);
    setLoading(false);
  }

  // Group flat rows by item for the header-row + location-sub-rows layout.
  const grouped = [];
  if (rows) {
    const byItem = new Map();
    for (const r of rows) {
      if (!byItem.has(r.inventory_id)) byItem.set(r.inventory_id, { item_code: r.item_code, unit_title: r.unit_title, locations: [] });
      // Items with no inventory_locations row yet (never had a stock count entered)
      // come back with a null location_id from the LEFT JOIN -- skip those instead of
      // rendering a confusing blank sub-row; the item header row alone is enough.
      if (r.location_id) byItem.get(r.inventory_id).locations.push(r);
    }
    grouped.push(...byItem.values());
  }

  const totalPages = Math.max(1, Math.ceil(grouped.length / PAGE_SIZE));
  const pageGroups = grouped.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Stock Ledger</h1>
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
              <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="as_of">As of</option>
                <option value="period_from">Period from</option>
              </select>
            </div>
            {period === 'as_of' ? (
              <div className="field">
                <label>Date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            ) : (
              <>
                <div className="field">
                  <label>From</label>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </div>
                <div className="field">
                  <label>To</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
              </>
            )}
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate}>
            Generate
          </button>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item Code</th>
                  <th>Location</th>
                  <th>Unit Title</th>
                  <th>Beg. Inv. Qty On-hand</th>
                  <th>Beg. Ave. Cost</th>
                  <th>Beg. Inv. On-hand Value</th>
                  <th>Input</th>
                  <th>Value of Inputs</th>
                  <th>Output</th>
                  <th>Value of Outputs</th>
                  <th>Ending Inv. Qty On-hand</th>
                  <th>Ending Ave. Cost</th>
                  <th>Ending Inv On-hand Value</th>
                </tr>
              </thead>
              <tbody>
                {rows === null && (
                  <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>Set your filters and click Generate.</td></tr>
                )}
                {rows !== null && grouped.length === 0 && (
                  <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>No stock ledger data found.</td></tr>
                )}
                {pageGroups.map((g) => (
                  <Fragment key={g.item_code}>
                    <tr>
                      <td><strong>{g.item_code}</strong></td>
                      <td></td>
                      <td>{g.unit_title}</td>
                      <td colSpan={10}></td>
                    </tr>
                    {g.locations.map((r) => (
                      <tr key={`${g.item_code}-${r.location_id}`}>
                        <td></td>
                        <td>{r.location_name}</td>
                        <td></td>
                        <td>{qtyFmt(r.beg_qty)}</td>
                        <td>{moneyFmt(r.beg_cost)}</td>
                        <td>{moneyFmt(r.beg_value)}</td>
                        <td>{r.input || ''}</td>
                        <td>{r.value_of_inputs ? moneyFmt(r.value_of_inputs) : ''}</td>
                        <td>{r.output || ''}</td>
                        <td>{r.value_of_outputs ? moneyFmt(r.value_of_outputs) : ''}</td>
                        <td>{qtyFmt(r.ending_qty)}</td>
                        <td>{moneyFmt(r.ending_cost)}</td>
                        <td>{moneyFmt(r.ending_value)}</td>
                      </tr>
                    ))}
                  </Fragment>
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
