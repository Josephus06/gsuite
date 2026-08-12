import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

// Purchasing > Receiving Report -- every RR raised against every Purchase Order.
//
// Read-only by design: a Receiving Report is created by receiving a PO, so there is no "Add"
// here. This answers "what did we receive, from whom, and when" without opening POs one at a
// time.
//
// Deliberately no status column: a Receiving Report has none of its own, and the parent PO's
// receipt_status is stale for everything that came in through the importer (19,100 of 19,103
// POs with receipts still read 'not_received'). Showing it would be showing a wrong answer,
// so the list reports the receipt's own line count and quantity instead.

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function ReceivingReports() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const [search, setSearch] = useState('');
  const [supplier, setSupplier] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [suppliers, setSuppliers] = useState([]);

  async function load() {
    setLoading(true);
    try {
      const params = { limit, offset: (page - 1) * limit };
      if (search) params.search = search;
      if (supplier) params.supplier_id = supplier.id;
      if (from) params.from = from;
      if (to) params.to = to;
      const { data } = await api.get('/receiving-reports', { params });
      setRows(data.rows);
      setTotal(data.total);
      setTotalAmount(data.total_amount);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { api.get('/suppliers').then(({ data }) => setSuppliers(data)).catch(() => setSuppliers([])); }, []);
  useEffect(() => { load(); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    // Reset to page 1 and load once: setPage(1) alone would not re-fire when already on 1.
    if (page === 1) load(); else setPage(1);
  }

  function clearFilters() {
    setSearch(''); setSupplier(null); setFrom(''); setTo('');
    if (page === 1) load(); else setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 16, textTransform: 'uppercase', margin: 0 }}>Receiving Reports</h1>
          <span className="muted">Lists</span>
          <button type="button" className="link-btn" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
        </div>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder="RR #, PO #, Supplier, Ref #"
              />
            </div>
            <div className="field">
              <label>Supplier</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <div style={{ flex: 1 }}>
                  <EntityPicker
                    label="Supplier" items={suppliers} value={supplier?.id || ''} getLabel={(s) => s?.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                    onSelect={setSupplier}
                  />
                </div>
                {supplier && <button type="button" className="btn" title="Clear Supplier" onClick={() => setSupplier(null)}>×</button>}
              </div>
            </div>
            <div className="field">
              <label>Date From</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field">
              <label>Date To</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={runSearch}>Search</button>
            <button className="btn" onClick={clearFilters}>Clear</button>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>RR #</th>
                    <th>Date</th>
                    <th>PO #</th>
                    <th>Supplier</th>
                    <th>Ref #</th>
                    <th style={{ textAlign: 'right' }}>Items</th>
                    <th style={{ textAlign: 'right' }}>Qty Received</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No receiving reports found.</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button type="button" className="link-btn" onClick={() => navigate(`/receiving-reports/${r.id}`)}>
                          {r.receipt_no}
                        </button>
                      </td>
                      <td>{formatDate(r.date_created)}</td>
                      <td>
                        <button type="button" className="link-btn" onClick={() => navigate(`/purchase-orders/${r.purchase_order_id}`)}>
                          {r.po_no}
                        </button>
                      </td>
                      <td>{r.supplier_name || '—'}</td>
                      <td>{r.ref_no || ''}</td>
                      <td style={{ textAlign: 'right' }}>{r.line_count}</td>
                      <td style={{ textAlign: 'right' }}>{qty(r.qty_received)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
              <span className="muted">
                {total.toLocaleString()} receiving report{total === 1 ? '' : 's'} · {money(totalAmount)} total
              </span>
            </div>

            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
