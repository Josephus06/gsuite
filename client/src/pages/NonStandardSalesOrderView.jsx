import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import NsjoCreateModal from '../components/NsjoCreateModal';
import SalesInvoiceModal from '../components/SalesInvoiceModal';
import { displayDate, displayDateTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';

const TYPE_LABELS = { rma: 'RMA', rma_installation: 'RMA - Installation', sample: 'Sample', internal: 'Internal' };
// Two-part status: main headline + sub label, mirroring the live "Pending / Needs Approval" style.
const STATUS = {
  pending_approval: ['Pending', 'Needs Approval'], pending_for_jo: ['Pending for JO', 'Approved'],
  jo_in_process: ['JO In-Process', ''], billed: ['Billed', ''], cancelled: ['Cancelled', ''],
  // Delivery and billing move an NSSO through the same statuses a Sales Order goes through.
  pending_delivery: ['Pending Delivery', ''], partially_delivered: ['Partially Delivered', ''],
  pending_billing: ['Pending Billing', ''], pending_billing_partially_delivered: ['Pending Billing', 'Partially Delivered'],
};
const num = (v) => Number(v || 0);
function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function formatDate(v) { return v ? displayDate(v) : ''; }

export default function NonStandardSalesOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [n, setN] = useState(null);
  const [tab, setTab] = useState('items');
  const [auditLogs, setAuditLogs] = useState([]);
  const [joModalLine, setJoModalLine] = useState(null);
  const [showBillMenu, setShowBillMenu] = useState(false);
  const [billType, setBillType] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/non-standard-sales-orders/${id}`).then(({ data }) => { setN(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/non-standard-sales-orders/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function act(fn) { setBusy(true); setError(''); try { await fn(); await load(); } catch (err) { setError(err.response?.data?.error || 'Action failed'); } finally { setBusy(false); } }
  const handleApprove = () => { if (confirm('Approve this Non-Standard Sales Order?')) act(() => api.put(`/non-standard-sales-orders/${id}/approve`)); };
  const handleCancel = () => { if (confirm('Cancel this Non-Standard Sales Order?')) act(() => api.put(`/non-standard-sales-orders/${id}/cancel`)); };

  if (loading || !n) return <LoadingSpinner />;
  const canEdit = can('/non-standard-sales-orders', 'can_edit');
  // A Sample is approved by an SBU head (or a System Admin) only -- not on the NSSO Approve
  // permission a sales supervisor holds. The server decides the same way (mayApproveNsso).
  const canApprove = n.type === 'sample'
    ? (!!user?.is_sales_business_unit || user?.account_type === 'System Admin')
    : can('/non-standard-sales-orders', 'can_approve');
  const canAdd = can('/non-standard-sales-orders', 'can_add');
  const isOpen = n.status !== 'cancelled';
  const notApproved = n.status === 'pending_approval';
  const [statusMain, statusSub] = STATUS[n.status] || [n.status, ''];
  const b = n.billing || {};
  // Delivered and billed exactly like a Sales Order: Item Delivery once a line's Job Order has
  // something built and QI'd but not yet shipped, Bill once something shipped is not yet invoiced.
  // Same permissions the Sales Order buttons ask for.
  const hasDeliverableLine = isOpen && n.lines.some((l) => l.created_job_order_id
    && Math.min(num(l.quantity_built), num(l.quantity_inspected)) - num(l.quantity_delivered) > 0);
  const hasInvoiceableLine = isOpen && n.lines.some((l) => l.created_job_order_id && num(l.quantity_delivered) > num(l.quantity_invoiced));
  const canRaiseDelivery = can('/item-deliveries', 'can_add');
  const canBillSI = can('/sales-invoices', user?.is_head_office === false ? 'can_view' : 'can_edit');

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/non-standard-sales-orders'}>Back</Link>
          {canEdit && isOpen && <Link className="btn btn-sm" to={`/non-standard-sales-orders/${id}/edit`}>Edit</Link>}
          {canApprove && notApproved && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {hasDeliverableLine && canRaiseDelivery && <Link className="btn btn-sm btn-primary" to={`/non-standard-sales-orders/${id}/item-delivery/new`}>Item Delivery</Link>}
          {hasInvoiceableLine && canBillSI && (
            <div style={{ position: 'relative' }}>
              <button className="btn btn-sm btn-primary" onClick={() => setShowBillMenu((v) => !v)}>Bill ▾</button>
              {showBillMenu && (
                <div className="card" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, padding: 6, minWidth: 80 }}>
                  <button type="button" className="btn btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => { setShowBillMenu(false); setBillType('SI'); }}>SI</button>
                  <button type="button" className="btn btn-sm" style={{ width: '100%' }} onClick={() => { setShowBillMenu(false); setBillType('DR'); }}>DR</button>
                </div>
              )}
            </div>
          )}
          {canEdit && isOpen && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Non-Standard SO</h1>
          <span className="estimate-no">{n.nsso_no}</span>
        </div>
        <div className="estimate-status">{statusMain} {statusSub && <span style={{ fontWeight: 400, opacity: 0.85 }}>{statusSub}</span>}</div>

        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div>
            <h4>Customer Details</h4>
            <div style={{ fontWeight: 700 }}>{n.customer_name ? <CustomerLink id={n.customer_id} name={n.customer_name} /> : '—'}</div>
            <div>Contact Name : <span className="hi">{n.contact_person_name || ''}</span></div>
            <div>Contact Title : <span className="hi">{n.contact_title || ''}</span></div>
            <div>Contact Email : <span className="hi">{n.contact_email || ''}</span></div>
            <div>Contact Phone : <span className="hi">{n.contact_phone || ''}</span></div>
          </div>
          <div>
            <h4>Non-Standard Sales Order Details</h4>
            <div>Date Created : <span className="hi">{formatDate(n.date_created)}</span></div>
            <div>Sales Division : <span className="hi">{n.sales_division_name || ''}</span></div>
            <div>Office Location : <span className="hi">{n.office_location_name || ''}</span></div>
            <div>Contract Desc. : <span className="hi">{n.contract_description || ''}</span></div>
            <div>Memo : <span className="hi">{n.memo || ''}</span></div>
            <div>Shipping Address : <span className="hi">{n.shipping_address || ''}</span></div>
          </div>
          <div>
            <h4>Other Details</h4>
            <div>Sales Rep : <span className="hi">{n.sales_rep_name || ''}</span></div>
            <div>Prepared By : <span className="hi">{n.prepared_by_name || ''}</span></div>
            <div>Approved By : <span className="hi">{n.approved_by_name || ''}</span></div>
            <div>Type : <span className="hi">{TYPE_LABELS[n.type] || n.type}</span></div>
            {n.type === 'sample'
              ? <div>Estimate # : <span className="hi">{n.nested_estimate_no
                  ? <Link className="link-btn" to={`/estimates/${n.nested_estimate_id}`}>{n.nested_estimate_no}</Link>
                  : '—'}</span></div>
              : <div>Sales Order # : <span className="hi">{n.nested_sales_order_no
                  ? <Link className="link-btn" to={`/sales-orders/${n.nested_sales_order_id}`}>{n.nested_sales_order_no}</Link>
                  : '—'}</span></div>}
          </div>
          <div>
            <h4>Billing Details</h4>
            <div>Credit Term : <span className="hi">{b.credit_term || ''}</span></div>
            <div>Credit Limit : <span className="hi">{b.credit_limit != null ? money(b.credit_limit) : ''}</span></div>
            <div>Credit Balance : <span className="hi">{money(0)}</span></div>
            <div>Bill To : <span className="hi"></span></div>
            <div>Address : <span className="hi">{b.address || ''}</span></div>
            <div>Contact Number : <span className="hi">{b.contact_number || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>#</th><th>Job Type</th><th>JO Ref. #</th><th>JO #</th><th>Job Location</th><th>Description</th>
                <th style={{ textAlign: 'right' }}>Quantity</th><th style={{ textAlign: 'right' }}>Built</th><th style={{ textAlign: 'right' }}>QI</th>
                <th style={{ textAlign: 'right' }}>Delivered</th><th style={{ textAlign: 'right' }}>Invoiced</th><th>Units</th>
                <th style={{ textAlign: 'right' }}>Net of Tax</th><th style={{ textAlign: 'right' }}>Length</th><th style={{ textAlign: 'right' }}>Width</th><th>Delivery Date</th>
              </tr></thead>
              <tbody>
                {n.lines.length === 0 && <tr><td colSpan={16} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items.</td></tr>}
                {n.lines.map((l, i) => (
                  <tr key={l.id}>
                    <td>{i + 1}</td>
                    <td>{l.job_type_name}</td>
                    <td>{l.source_job_order_no
                      ? <Link className="link-btn" to={`/job-orders/${l.source_job_order_id}`}>{l.source_job_order_no}</Link>
                      : '—'}</td>
                    <td>{l.created_job_order_no
                      ? <Link className="link-btn" to={`/job-orders/${l.created_job_order_id}`}>{l.created_job_order_no}</Link>
                      : (canAdd
                        ? <button type="button" className="link-btn" disabled={notApproved || busy}
                            title={notApproved ? 'Approve the NSSO before creating the JO' : 'Create the job order'}
                            style={notApproved ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                            onClick={() => setJoModalLine(l.id)}>Create JO</button>
                        : '—')}</td>
                    <td>{l.job_location_name}</td>
                    <td>{l.description}</td>
                    {/* Read-only here (asked 2026-10-06): Qty and the sample amount are edited on the
                        Edit page only. */}
                    <td style={{ textAlign: 'right' }}>{Number(l.quantity)}</td>
                    <td style={{ textAlign: 'right' }}>{num(l.quantity_built)}</td><td style={{ textAlign: 'right' }}>{num(l.quantity_inspected)}</td>
                    <td style={{ textAlign: 'right' }}>{num(l.quantity_delivered)}</td><td style={{ textAlign: 'right' }}>{num(l.quantity_invoiced)}</td>
                    <td>{l.units}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.net_of_tax)}</td>
                    <td style={{ textAlign: 'right' }}>{l.length ?? '-'}</td><td style={{ textAlign: 'right' }}>{l.width ?? '-'}</td>
                    <td>{l.delivery_date ? String(l.delivery_date).slice(0, 10) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Status</th></tr></thead>
              <tbody>
                {n.nested_sales_order_no && (
                  <tr><td>Nested Sales Order</td>
                    <td><Link className="link-btn" to={`/sales-orders/${n.nested_sales_order_id}`}>{n.nested_sales_order_no}</Link></td>
                    <td></td></tr>
                )}
                {n.nested_estimate_no && (
                  <tr><td>Nested Estimate</td>
                    <td><Link className="link-btn" to={`/estimates/${n.nested_estimate_id}`}>{n.nested_estimate_no}</Link></td>
                    <td></td></tr>
                )}
                {n.lines.filter((l) => l.created_job_order_no).map((l) => (
                  <tr key={l.id}><td>Job Order</td>
                    <td><Link className="link-btn" to={`/job-orders/${l.created_job_order_id}`}>{l.created_job_order_no}</Link></td>
                    <td></td></tr>
                ))}
                {(n.deliveries || []).map((d) => (
                  <tr key={`del-${d.id}`}><td>Item Delivery</td>
                    <td><Link className="link-btn" to={`/item-deliveries/${d.id}`}>{d.delivery_no}</Link></td>
                    <td>{d.status}</td></tr>
                ))}
                {(n.invoices || []).map((si) => (
                  <tr key={`si-${si.id}`}><td>Invoice</td>
                    <td><Link className="link-btn" to={`/sales-invoices/${si.id}`}>{si.invoice_no}</Link></td>
                    <td>{si.status}</td></tr>
                ))}
                {!n.nested_sales_order_no && !n.nested_estimate_no && !n.lines.some((l) => l.created_job_order_no)
                  && !(n.deliveries || []).length && !(n.invoices || []).length && (
                  <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'Date Time', render: (r) => displayDateTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}

      {billType && (
        <SalesInvoiceModal
          nssoId={Number(id)}
          invoiceType={billType}
          onClose={() => setBillType(null)}
          onSaved={async (si) => { setBillType(null); await load(); navigate(`/sales-invoices/${si.id}`); }}
        />
      )}

      {joModalLine && (
        <NsjoCreateModal
          nssoId={id} lineId={joModalLine} nssoType={n.type}
          onClose={() => setJoModalLine(null)}
          onSaved={() => { setJoModalLine(null); load(); }}
        />
      )}
    </div>
  );
}
