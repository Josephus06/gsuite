import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import BillPaymentModal from '../components/BillPaymentModal';
import BillCreditModal from '../components/BillCreditModal';
import LoadingSpinner from '../components/LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

const STATUS_LABELS = { open: 'Open', paid_in_full: 'Paid in Full', cancelled: 'Cancelled' };

// Mirrors the real "Vendor Bill" detail view -- reached from a Purchase Order's Related
// Records tab after billing it. Each line is a frozen snapshot of what was actually billed
// (Rate = the PO line's rate at that moment, Unit Price = what was actually charged), not a
// live re-query of the PO.
export default function VendorBillView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [vb, setVb] = useState(null);
  const [tab, setTab] = useState('items');
  const [auditLogs, setAuditLogs] = useState([]);
  const [related, setRelated] = useState({ bill_payments: [], bill_credits: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showBillPaymentModal, setShowBillPaymentModal] = useState(false);
  const [showBillCreditModal, setShowBillCreditModal] = useState(false);

  function load() {
    return api.get(`/vendor-bills/${id}`).then(({ data }) => { setVb(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/vendor-bills/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
    if (tab === 'related') {
      api.get(`/vendor-bills/${id}/related`).then(({ data }) => setRelated(data));
    }
  }, [tab, id]);

  async function handleCancel() {
    if (!confirm('Cancel this Vendor Bill? Its billed qty will be reversed.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/vendor-bills/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !vb) return <LoadingSpinner />;

  const canEdit = can('/vendor-bills', 'can_edit');
  const isOpen = vb.status === 'open';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/purchase-orders/${vb.purchase_order_id}`)}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Vendor Bill isn't implemented in this build">Edit</button>
          {isOpen && <button className="btn btn-sm btn-primary" onClick={() => setShowBillPaymentModal(true)}>Bill Payment</button>}
          {isOpen && <button className="btn btn-sm btn-primary" onClick={() => setShowBillCreditModal(true)}>Bill Credit</button>}
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && isOpen && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Vendor Bill</h1>
          <span className="estimate-no">{vb.bill_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[vb.status] || vb.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Vendor : <span className="hi">{vb.supplier_name}</span></div>
            <div>Office Location : <span className="hi">{vb.office_location_name || '—'}</span></div>
            <div>Account : <span className="hi">{vb.account_code ? `${vb.account_code} — ${vb.account_name}` : '—'}</span></div>
          </div>
          <div>
            <div>Date : <span className="hi">{formatDate(vb.date_created)}</span></div>
            <div>Term : <span className="hi">{vb.term}</span></div>
            <div>Date Due : <span className="hi">{formatDate(vb.date_due)}</span></div>
          </div>
          <div>
            <div>Created From : <button type="button" className="link-btn" onClick={() => navigate(`/purchase-orders/${vb.purchase_order_id}`)}>{vb.po_no}</button></div>
            <div>Reference # : <span className="hi">{vb.reference_no || ''}</span></div>
            <div>Memo : <span className="hi">{vb.memo || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Sub Total</span><div className="hi-lg">{money(vb.subtotal)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(vb.discount_amount)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(vb.net_of_tax)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(vb.tax_amount)}</div></div>
        <div><span className="muted">Gross Amount</span><div className="hi-lg">{money(vb.gross_amount)}</div></div>
        <div><span className="muted">Withholding Tax</span><div className="hi-lg">{money(vb.wtax_amount)}</div></div>
        <div><span className="muted">Amount Due</span><div className="hi-lg">{money(vb.amount_due)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax</button>
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
                  <th>Item Code</th><th>Purchase Desc.</th><th>Location</th><th>Department</th>
                  <th>Billed Qty</th><th>Unit</th><th>Rate</th><th>Unit Price</th><th>Discount %</th>
                  <th>Total Disc. Amt.</th><th>Total Amt. (Net of Tax)</th><th>Tax Code</th><th>Tax Amt.</th>
                  <th>Ext. Price</th><th>Withhold?</th><th>Withholding Tax Amt.</th><th>Amount Due</th>
                </tr>
              </thead>
              <tbody>
                {vb.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.item_code} {l.item_name ? `— ${l.item_name}` : ''}</td>
                    <td>{l.purchase_description}</td>
                    <td>{l.location_name}</td>
                    <td>{l.department_name}</td>
                    <td>{qty(l.qty)}</td>
                    <td>{l.unit_title}</td>
                    <td>{money(l.rate)}</td>
                    <td>{money(l.unit_price)}</td>
                    <td>{l.disc_percent}</td>
                    <td>{money(l.disc_amount)}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.ext_price)}</td>
                    <td>{l.is_withhold ? 'Yes' : 'No'}</td>
                    <td>{money(l.wtax_amount)}</td>
                    <td>{money(l.amount_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'wtax' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="field"><label>Withholding Tax</label><input readOnly value={vb.wtax_code || ''} /></div>
            <div className="field"><label>Withholding Tax Description</label><input readOnly value={vb.wtax_description || ''} /></div>
            <div className="field"><label>Withholding Tax Amount</label><input readOnly value={money(vb.wtax_amount)} /></div>
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
                {(!vb.gl_impact || vb.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(vb.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {vb.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(vb.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(vb.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {related.bill_payments.map((bp) => (
                  <tr key={`bp-${bp.id}`}>
                    <td>Bill Payment</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/bill-payments/${bp.id}`)}>{bp.bill_payment_no}</button></td>
                    <td>{formatDate(bp.date_created)}</td>
                    <td>{money(bp.total_amount)}</td>
                    <td>{bp.status === 'voided' ? 'Voided' : 'Open'}</td>
                  </tr>
                ))}
                {related.bill_credits.map((bc) => (
                  <tr key={`bc-${bc.id}`}>
                    <td>Bill Credit</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/bill-credits/${bc.id}`)}>{bc.bill_credit_no}</button></td>
                    <td>{formatDate(bc.date_created)}</td>
                    <td>{money(bc.total_amount)}</td>
                    <td>{bc.status === 'voided' ? 'Voided' : 'Open'}</td>
                  </tr>
                ))}
                {related.bill_payments.length === 0 && related.bill_credits.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records yet.</td></tr>
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

      {showBillPaymentModal && (
        <BillPaymentModal
          vendorBillId={id}
          onClose={() => setShowBillPaymentModal(false)}
          onSaved={(bp) => { setShowBillPaymentModal(false); navigate(`/bill-payments/${bp.id}`); }}
        />
      )}
      {showBillCreditModal && (
        <BillCreditModal
          vendorBillId={id}
          onClose={() => setShowBillCreditModal(false)}
          onSaved={(bc) => { setShowBillCreditModal(false); navigate(`/bill-credits/${bc.id}`); }}
        />
      )}
    </div>
  );
}
