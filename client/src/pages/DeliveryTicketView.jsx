import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import SalesInvoiceModal from '../components/SalesInvoiceModal';
import LoadingSpinner from '../components/LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

const STATUS_LABELS = { open: 'OPEN', converted: 'CONVERTED', void: 'VOID' };

// Mirrors the real "Delivery Ticket" detail screen (DT-####). A Delivery Ticket is its
// own transaction type, not a Sales Invoice variant -- its GL Impact debits Accounts
// Receivable Trade - *Unbilled* (12101), because the goods have gone and the sale is
// recognised while the receivable itself hasn't been billed yet. Its Bill button is what
// would raise the actual invoice; that step isn't modelled in this build.
export default function DeliveryTicketView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [dt, setDt] = useState(null);
  const [tab, setTab] = useState('items');
  const [auditLogs, setAuditLogs] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [showBillMenu, setShowBillMenu] = useState(false);
  const [showSIModal, setShowSIModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return Promise.all([
      api.get(`/delivery-tickets/${id}`),
      api.get(`/sales-invoices/by-delivery-ticket/${id}`),
    ]).then(([dtRes, siRes]) => {
      setDt(dtRes.data);
      setInvoices(siRes.data);
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/delivery-tickets/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Delivery Ticket? It will stop posting to the GL.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/delivery-tickets/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !dt) return <LoadingSpinner />;

  const canEdit = can('/delivery-tickets', 'can_edit');
  const isOpen = dt.status === 'open';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/sales-orders/${dt.sales_order_id}`)}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Delivery Ticket isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          <button className="btn btn-sm" disabled title="Credit Memos aren't implemented in this build">Credit Memo</button>
          {/* Bill on a Delivery Ticket raises the official Sales Invoice from it and
              converts the ticket -- so it's offered only while the ticket is still open. */}
          {canEdit && isOpen && (
            <div style={{ position: 'relative' }}>
              <button className="btn btn-sm btn-primary" onClick={() => setShowBillMenu((s) => !s)}>Bill ▾</button>
              {showBillMenu && (
                <div className="card" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, padding: 6, minWidth: 80 }}>
                  <button type="button" className="btn btn-sm" style={{ width: '100%' }} onClick={() => { setShowBillMenu(false); setShowSIModal(true); }}>SI</button>
                </div>
              )}
            </div>
          )}
          {canEdit && isOpen && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Delivery Ticket</h1>
          <span className="estimate-no">{dt.dt_no}</span>
        </div>
        <div className="estimate-status">
          {STATUS_LABELS[dt.status] || dt.status}
          <button type="button" className="estimate-so-link" onClick={() => navigate(`/sales-orders/${dt.sales_order_id}`)}>
            {dt.sales_order_no}
          </button>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer</h4>
            <div><span className="hi">{dt.customer_name}</span></div>
            <div>TIN : <span className="hi">{dt.customer_tin || '—'}</span></div>
            <div>Contact Person : <span className="hi">{dt.contact_name || '—'}</span></div>
            <div>Contact Email : <span className="hi">{dt.contact_email || '—'}</span></div>
            <div>Contact Title : <span className="hi">{dt.contact_title || '—'}</span></div>
            <div>Contact Phone : <span className="hi">{dt.contact_phone || '—'}</span></div>
          </div>
          <div>
            <div>Date : <span className="hi">{formatDate(dt.date_created)}</span></div>
            <div>Created From : <button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${dt.sales_order_id}`)}>{dt.sales_order_no}</button></div>
            <div>Memo : <span className="hi">{dt.memo || ''}</span></div>
            <div>Sales Rep : <span className="hi">{dt.sales_rep_name || '—'}</span></div>
            <div>Office Location : <span className="hi">{dt.office_location_name || '—'}</span></div>
            <div>Department : <span className="hi">{dt.department_name || '—'}</span></div>
          </div>
          <div>
            <div>Term : <span className="hi">{dt.term || '—'}</span></div>
            <div>Date Due : <span className="hi">{formatDate(dt.date_due)}</span></div>
            <div>PO # : <span className="hi">{dt.po_no || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Sub Total</span><div className="hi-lg">{money(dt.subtotal)}</div></div>
        <div><span className="muted">Discount Amount</span><div className="hi-lg">{money(dt.discount_amount)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(dt.net_of_tax)}</div></div>
        <div><span className="muted">Tax Amount</span><div className="hi-lg">{money(dt.tax_amount)}</div></div>
        <div><span className="muted">Gross Amount</span><div className="hi-lg">{money(dt.gross_amount)}</div></div>
        <div><span className="muted">Amount Due</span><div className="hi-lg">{money(dt.amount_due)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Location</th><th>Qty</th>
                  <th>Unit</th><th>Unit Title</th><th>Price/Unit</th><th>Subtotal</th><th>Disc.%</th>
                  <th>Disc. / Unit</th><th>Disc. Amt</th><th>Disc. Price/Unit</th><th>Net of Tax</th>
                  <th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th>
                </tr>
              </thead>
              <tbody>
                {dt.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.line_no}</td>
                    <td>{l.job_order_id ? (
                      <button type="button" className="link-btn" onClick={() => navigate(`/production/${l.job_order_id}`)}>{l.job_order_no}</button>
                    ) : '—'}</td>
                    <td>{l.item_name}</td>
                    <td>{l.description}</td>
                    <td>{l.location_name || '—'}</td>
                    <td>{qty(l.quantity)}</td>
                    <td>{l.units}</td>
                    <td>{l.unit_title}</td>
                    <td>{money(l.price_per_unit)}</td>
                    <td>{money(l.subtotal)}</td>
                    <td>{money(l.disc_percent)}</td>
                    <td>{money(l.disc_per_unit)}</td>
                    <td>{money(l.disc_amount)}</td>
                    <td>{money(l.disc_price_per_unit)}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.gross_amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={9} />
                  <td><strong>{money(dt.subtotal)}</strong></td>
                  <td colSpan={2} />
                  <td><strong>{money(dt.discount_amount)}</strong></td>
                  <td />
                  <td><strong>{money(dt.net_of_tax)}</strong></td>
                  <td />
                  <td><strong>{money(dt.tax_amount)}</strong></td>
                  <td><strong>{money(dt.gross_amount)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Account Code</th><th>Account Title</th><th>Debit</th><th>Credit</th></tr>
              </thead>
              <tbody>
                {(!dt.gl_impact || dt.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(dt.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : '0.00'}</td>
                    <td>{row.credit ? money(row.credit) : '0.00'}</td>
                  </tr>
                ))}
                {dt.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(dt.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(dt.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th></tr></thead>
              <tbody>
                <tr>
                  <td>Sales Order</td>
                  <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${dt.sales_order_id}`)}>{dt.sales_order_no}</button></td>
                  <td>—</td>
                </tr>
                {invoices.map((si) => (
                  <tr key={si.id}>
                    <td>Sales Invoice</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-invoices/${si.id}`)}>{si.invoice_no}</button></td>
                    <td>{formatDate(si.date_created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'Date Time', render: (r) => new Date(r.set_at).toLocaleString() },
              { key: 'set_by_name', label: 'Set By' },
              { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' },
              { key: 'old_value', label: 'Old Value' },
              { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}

      {showSIModal && (
        <SalesInvoiceModal
          deliveryTicketId={Number(id)}
          onClose={() => setShowSIModal(false)}
          onSaved={async (si) => { setShowSIModal(false); await load(); navigate(`/sales-invoices/${si.id}`); }}
        />
      )}
    </div>
  );
}
