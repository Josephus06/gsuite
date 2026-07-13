import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's "Production > Item Delivery" ("Saved Item Delivery") list --
// a flat filterable table (no status tabs), same pattern as Assembly Build's list.
export default function ItemDeliveries() {
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [customers, setCustomers] = useState([]);

  async function load() {
    setLoading(true);
    const params = { page, limit };
    if (search) params.search = search;
    if (customerId) params.customer_id = customerId;
    if (asOf) params.as_of = asOf;
    const { data } = await api.get('/item-deliveries', { params });
    setRows(data.rows);
    setTotal(data.total);
    setLoading(false);
  }

  useEffect(() => {
    api.get('/customers').then(({ data }) => setCustomers(data));
  }, []);

  useEffect(() => { load(); }, [page]);

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <h1>Saved Item Delivery</h1>
        <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." />
            </div>
            <div className="field">
              <label>Customer</label>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">All</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Date Created (As of)</label>
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID #</th>
                    <th>SO #</th>
                    <th>Date Created</th>
                    <th>Customer</th>
                    <th>Total Qty Delivered</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No item deliveries found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.delivery_no}</td>
                      <td>{row.sales_order_no}</td>
                      <td>{row.date_created ? String(row.date_created).slice(0, 10) : ''}</td>
                      <td>{row.customer_name}</td>
                      <td>{row.total_qty_delivered}</td>
                      <td>{row.status === 'cancelled' ? <span className="badge badge-muted">Cancelled</span> : <span className="badge badge-success">Saved</span>}</td>
                      <td><button className="btn btn-sm btn-primary" onClick={() => navigate(`/item-deliveries/${row.id}`)}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
