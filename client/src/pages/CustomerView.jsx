import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import ActivityTimeline from '../components/ActivityTimeline';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

// The "Customer 360" view -- didn't exist at all before this (Customers.jsx was
// list-+-edit-modal only). Ties together the existing sub-resources (contacts/
// addresses, already returned by GET /customers/:id) with the CRM layer (Pipeline,
// derived from real estimates/sales_orders -- see server/src/routes/crmPipeline.js --
// rather than a manually-tracked Opportunity; Activities) plus the customer's real
// transactional history (Estimates/Sales Orders/Invoices, via the customer_id filters
// added to those list endpoints for this feature).
export default function CustomerView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [pipeline, setPipeline] = useState([]);
  const [stages, setStages] = useState({ labels: {}, openStages: [] });
  const [estimates, setEstimates] = useState([]);
  const [salesOrders, setSalesOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get(`/customers/${id}`),
      api.get('/crm-pipeline', { params: { customer_id: id } }),
      api.get('/crm-pipeline/meta/stages'),
      api.get('/estimates', { params: { customer_id: id, limit: 100 } }),
      api.get('/sales-orders', { params: { customer_id: id, limit: 100 } }),
      api.get('/sales-invoices', { params: { customer_id: id } }),
    ]).then(([c, p, s, e, so, inv]) => {
      setCustomer(c.data);
      setPipeline(p.data);
      setStages(s.data);
      setEstimates(e.data.rows);
      setSalesOrders(so.data.rows);
      setInvoices(inv.data);
      setLoading(false);
    });
  }, [id]);

  if (loading || !customer) return <LoadingSpinner />;

  const openDeals = pipeline.filter((r) => stages.openStages.includes(r.stage));
  const openPipelineValue = openDeals.reduce((s, r) => s + r.value, 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <button className="btn btn-sm" onClick={() => navigate('/customers')}>Back</button>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{customer.name}</h1>
          <span className="estimate-no">{customer.customer_code}</span>
        </div>
        <div className="estimate-status">
          {customer.company_name || ''}
          {!customer.is_active && <span style={{ opacity: 0.7 }}> · Inactive</span>}
        </div>
        <div className="estimate-detail-grid">
          <div>
            <div>TIN : <span className="hi">{customer.tin || '—'}</span></div>
            <div>Credit Limit : <span className="hi">{money(customer.credit_limit)}</span></div>
          </div>
          <div>
            <div>Open Pipeline : <span className="hi">{money(openPipelineValue)}</span></div>
            <div>Open Deals : <span className="hi">{openDeals.length}</span></div>
          </div>
          <div>
            <div>Estimates : <span className="hi">{estimates.length}</span></div>
            <div>Sales Orders : <span className="hi">{salesOrders.length}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`status-tab ${tab === 'pipeline' ? 'active' : ''}`} onClick={() => setTab('pipeline')}>Pipeline ({pipeline.length})</button>
        <button className={`status-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>Activity</button>
        <button className={`status-tab ${tab === 'transactions' ? 'active' : ''}`} onClick={() => setTab('transactions')}>Transactions</button>
      </div>

      {tab === 'overview' && (
        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>Contacts</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th></tr></thead>
              <tbody>
                {(customer.contacts || []).length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No contacts yet.</td></tr>}
                {(customer.contacts || []).map((c) => (
                  <tr key={c.id}><td>{c.contact_name}{c.is_primary ? ' ★' : ''}</td><td>{c.title || '—'}</td><td>{c.email || '—'}</td><td>{c.phone || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="subsection">Addresses</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Address</th></tr></thead>
              <tbody>
                {(customer.addresses || []).length === 0 && <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No addresses yet.</td></tr>}
                {(customer.addresses || []).map((a) => (
                  <tr key={a.id}><td>{a.address_type}</td><td>{a.address_line}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'pipeline' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Document #</th><th>Stage</th><th>Value</th><th>Date</th><th>Sales Rep</th></tr></thead>
              <tbody>
                {pipeline.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No deals yet.</td></tr>}
                {pipeline.map((r) => (
                  <tr key={r.estimate_id}>
                    <td>
                      <button
                        type="button" className="link-btn"
                        onClick={() => navigate(r.sales_order_id ? `/sales-orders/${r.sales_order_id}` : `/estimates/${r.estimate_id}`)}
                      >
                        {r.current_doc_no}
                      </button>
                    </td>
                    <td>{stages.labels[r.stage]}</td>
                    <td>{money(r.value)}</td>
                    <td>{formatDate(r.date_created)}</td>
                    <td>{r.sales_rep_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="card">
          <ActivityTimeline relatedType="Customer" relatedId={customer.id} />
        </div>
      )}

      {tab === 'transactions' && (
        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>Estimates</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Estimate #</th><th>Date</th><th>Status</th><th>Total</th></tr></thead>
              <tbody>
                {estimates.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>None yet.</td></tr>}
                {estimates.map((e) => (
                  <tr key={e.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/estimates/${e.id}`)}>{e.estimate_no}</button></td>
                    <td>{formatDate(e.date_created)}</td><td>{e.status}</td><td>{money(e.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="subsection">Sales Orders</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Sales Order #</th><th>Date</th><th>Status</th></tr></thead>
              <tbody>
                {salesOrders.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>None yet.</td></tr>}
                {salesOrders.map((so) => (
                  <tr key={so.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${so.id}`)}>{so.sales_order_no}</button></td>
                    <td>{formatDate(so.date_created)}</td><td>{so.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="subsection">Invoices</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Invoice #</th><th>Date</th><th>Status</th><th>Gross</th><th>Amount Due</th></tr></thead>
              <tbody>
                {invoices.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>None yet.</td></tr>}
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-invoices/${inv.id}`)}>{inv.invoice_no}</button></td>
                    <td>{formatDate(inv.date_created)}</td><td>{inv.status}</td><td>{money(inv.gross_amount)}</td><td>{money(inv.amount_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
