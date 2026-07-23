import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

// A saved payment starts NOT DEPOSITED -- the cash is in hand and the invoice is settled,
// but it hasn't been swept into the bank yet. DEPOSITED is the other live value, reached
// once a bank deposit picks it up (not modelled in this build).
const STATUS_LABELS = { not_deposited: 'NOT DEPOSITED', deposited: 'DEPOSITED', voided: 'VOID' };

// Mirrors the real "Customer Payment" detail view (CPAY-#), reached from an Invoice's
// Related Records after accepting a payment. Each line is either an invoice this payment
// settled or a Credit Memo it drew on -- never both, same shape as Bill Payment.
export default function CustomerPaymentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [cp, setCp] = useState(null);
  const [tab, setTab] = useState('apply');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/customer-payments/${id}`).then(({ data }) => { setCp(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/customer-payments/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Customer Payment? The amounts it settled will be released back.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/customer-payments/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !cp) return <LoadingSpinner />;

  const canEdit = can('/customer-payments', 'can_edit');
  // Anything not already voided can be voided -- a deposited payment included, since
  // 'void' is the terminal state rather than an alternative to being deposited.
  const isOpen = cp.status !== 'voided';
  const invoiceLines = cp.lines.filter((l) => l.sales_invoice_id);
  const creditLines = cp.lines.filter((l) => l.credit_memo_id);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(-1)}>Back</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && isOpen && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Customer Payment</h1>
          <span className="estimate-no">{cp.customer_payment_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[cp.status] || cp.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Customer : <span className="hi">{cp.customer_name}</span></div>
            <div>Date : <span className="hi">{formatDate(cp.date_created)}</span></div>
            <div>Department : <span className="hi">{cp.department_name || '—'}</span></div>
            <div>Office Location : <span className="hi">{cp.office_location_name || '—'}</span></div>
            <div>Memo : <span className="hi">{cp.memo || ''}</span></div>
          </div>
          <div>
            <div>Receipt : <span className="hi">{cp.receipt_type || '—'}</span></div>
            <div>OR # : <span className="hi">{cp.or_no || '—'}</span></div>
            <div>Payment Type : <span className="hi">{cp.payment_type || '—'}</span></div>
            <div>Payment Method : <span className="hi">{cp.payment_method_name || '—'}</span></div>
            <div>Issued By : <span className="hi">{cp.issued_by_name || '—'}</span></div>
          </div>
          <div>
            <div>Deposit To : <span className="hi">{cp.deposit_account_code ? `${cp.deposit_account_code} ${cp.deposit_account_name}` : '—'}</span></div>
            <div>Created By : <span className="hi">{cp.created_by_name || '—'}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Applied Amount</span><div className="hi-lg">{money(cp.applied_amount)}</div></div>
        <div><span className="muted">Unapplied Amount</span><div className="hi-lg">{money(cp.unapplied_amount)}</div></div>
        <div><span className="muted">Total Payments</span><div className="hi-lg">{money(cp.payment_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply</button>
        <button className={`status-tab ${tab === 'credits' ? 'active' : ''}`} onClick={() => setTab('credits')}>Credits</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'apply' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Invoice #</th><th>Date Created</th><th>Original Amount</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {invoiceLines.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing applied to an invoice.</td></tr>
                )}
                {invoiceLines.map((l) => (
                  <tr key={l.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-invoices/${l.sales_invoice_id}`)}>{l.invoice_no}</button></td>
                    <td>{formatDate(l.invoice_date)}</td>
                    <td>{money(l.invoice_gross)}</td>
                    <td>{money(l.applied_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'credits' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Credit Memo #</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {creditLines.length === 0 && (
                  <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No credits drawn on.</td></tr>
                )}
                {creditLines.map((l) => (
                  <tr key={l.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/credit-memos/${l.credit_memo_id}`)}>{l.credit_memo_no}</button></td>
                    <td>{money(l.applied_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account Code</th><th>Account Title</th><th>Debit</th><th>Credit</th></tr></thead>
              <tbody>
                {(!cp.gl_impact || cp.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact -- set a Deposit To account on the payment.</td></tr>
                )}
                {(cp.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : '0.00'}</td>
                    <td>{row.credit ? money(row.credit) : '0.00'}</td>
                  </tr>
                ))}
                {cp.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(cp.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(cp.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
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
    </div>
  );
}
