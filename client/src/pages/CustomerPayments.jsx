import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';
import CustomerPaymentModal from '../components/CustomerPaymentModal';
import { useAuth } from '../context/useAuth';

const PAGE_SIZE = 10;
// A saved payment sits NOT DEPOSITED until a bank deposit sweeps it into the bank.
const STATUS_LABELS = { not_deposited: 'Not Deposited', deposited: 'Deposited', voided: 'Void' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function CustomerPayments() {
  const { can } = useAuth();
  // Raising a payment starts with the CUSTOMER, because that is the only thing known when someone
  // walks in and hands money over. Which invoices it settles is decided in the form afterwards.
  const [customers, setCustomers] = useState([]);
  const [newFor, setNewFor] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    const { data } = await api.get('/customer-payments', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only for the Add picker, and only when the button is there to use it.
  useEffect(() => {
    if (!can('/customer-payments', 'can_add')) return;
    api.get('/customers').then(({ data }) => setCustomers(Array.isArray(data) ? data : (data?.rows || []))).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Customer Payments</h1>
        {can('/customer-payments', 'can_add') && (
          <EntityPicker
            label="Customer" items={customers} value="" getLabel={(c) => c?.name}
            columns={[{ key: 'customer_code', label: 'Code' }, { key: 'name', label: 'Name' }]}
            searchKeys={['customer_code', 'name']}
            onSelect={(c) => setNewFor(c)}
            triggerLabel="Add Customer Payment"
            triggerClassName="btn btn-primary"
          />
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="CPAY #, OR # or Customer..."
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="not_deposited">Not Deposited</option>
              <option value="deposited">Deposited</option>
              <option value="voided">Void</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Payment #</th>
                  <th>Date Created</th>
                  <th>Customer</th>
                  <th>OR #</th>
                  <th>Payment Method</th>
                  <th>Payment Amount</th>
                  <th>Applied Amount</th>
                  <th>Unapplied Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No customer payments found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Payment #">{row.customer_payment_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Customer">{row.customer_name}</td>
                    <td data-label="OR #">{row.or_no}</td>
                    <td data-label="Payment Method">{row.payment_method_name}</td>
                    <td data-label="Payment Amount">{money(row.payment_amount)}</td>
                    <td data-label="Applied Amount">{money(row.applied_amount)}</td>
                    <td data-label="Unapplied Amount">{money(row.unapplied_amount)}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/customer-payments/${row.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {/* The same form an invoice's Accept Payment button opens, entered from the customer end. */}
      {newFor && (
        <CustomerPaymentModal
          customerId={newFor.id}
          onClose={() => setNewFor(null)}
          onSaved={() => { setNewFor(null); load(); }}
        />
      )}
    </div>
  );
}
