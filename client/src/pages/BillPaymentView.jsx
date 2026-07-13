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

const STATUS_LABELS = { open: 'Open', voided: 'Voided' };

// Mirrors the real "Bill Payment" detail view -- reached from a Vendor Bill's Related
// Records tab after paying it, or from the Bill Payments list.
export default function BillPaymentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [bp, setBp] = useState(null);
  const [tab, setTab] = useState('apply');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/bill-payments/${id}`).then(({ data }) => { setBp(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/bill-payments/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Bill Payment? Its applied bills/credits will be reversed.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/bill-payments/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !bp) return <LoadingSpinner />;

  const canEdit = can('/bill-payments', 'can_edit');
  const isOpen = bp.status === 'open';
  const applyLines = bp.lines.filter((l) => l.vendor_bill_id);
  const debitLines = bp.lines.filter((l) => l.bill_credit_id);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/bill-payments')}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Bill Payment isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && isOpen && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Bill Payment</h1>
          <span className="estimate-no">{bp.bill_payment_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[bp.status] || bp.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Vendor : <span className="hi">{bp.supplier_name}</span></div>
            <div>Payee Name : <span className="hi">{bp.payee_name}</span></div>
            <div>TIN : <span className="hi">{bp.tin || ''}</span></div>
            <div>A/P : <span className="hi">{bp.ap_account_code ? `${bp.ap_account_code} — ${bp.ap_account_name}` : '—'}</span></div>
            <div>Account : <span className="hi">{bp.bank_account_code ? `${bp.bank_account_code} — ${bp.bank_account_name}` : '—'}</span></div>
          </div>
          <div>
            <div>Date Created : <span className="hi">{formatDate(bp.date_created)}</span></div>
            <div>Reference # : <span className="hi">{bp.reference_no || ''}</span></div>
            <div>Memo : <span className="hi">{bp.memo || ''}</span></div>
            <div>Office Location : <span className="hi">{bp.office_location_name || '—'}</span></div>
          </div>
          <div>
            <div>Payment Method : <span className="hi">{bp.payment_method_name}</span></div>
            {bp.check_date && <div>Check Date : <span className="hi">{formatDate(bp.check_date)}</span></div>}
            {bp.check_no && <div>Check No : <span className="hi">{bp.check_no}</span></div>}
            <div>Payment Type : <span className="hi">{bp.payment_type}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Total Payments</span><div className="hi-lg">{money(bp.total_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply</button>
        <button className={`status-tab ${tab === 'debits' ? 'active' : ''}`} onClick={() => setTab('debits')}>Debits</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'apply' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Vendor Bill #</th><th>Date</th><th>Date Due</th><th>Original Amount</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {applyLines.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No bills settled.</td></tr>
                )}
                {applyLines.map((l) => (
                  <tr key={l.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/vendor-bills/${l.vendor_bill_id}`)}>{l.bill_no}</button></td>
                    <td>{formatDate(l.vb_date_created)}</td>
                    <td>{formatDate(l.vb_date_due)}</td>
                    <td>{money(l.vb_gross_amount)}</td>
                    <td>{money(l.applied_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'debits' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bill Credit #</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {debitLines.length === 0 && (
                  <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No credits used.</td></tr>
                )}
                {debitLines.map((l) => (
                  <tr key={l.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/bill-credits/${l.bill_credit_id}`)}>{l.bill_credit_no}</button></td>
                    <td>{money(l.applied_amount)}</td>
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
    </div>
  );
}
