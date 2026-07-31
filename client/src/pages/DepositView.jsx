import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }

export default function DepositView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('payments');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/deposits/${id}`).then(({ data }) => { setD(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/deposits/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Deposit? The payments will return to Not Deposited.')) return;
    setBusy(true); setError('');
    try { await api.put(`/deposits/${id}/void`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }

  if (loading || !d) return <LoadingSpinner />;
  const payments = d.payments || [];
  const gl = d.gl || [];
  const totalDebit = gl.reduce((s, l) => s + num(l.debit), 0);
  const totalCredit = gl.reduce((s, l) => s + num(l.credit), 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/deposits')}>Back to Lists</button>
          {can('/deposits', 'can_edit') && d.status !== 'void' && <button className="btn btn-sm" disabled title="Editing a posted Deposit isn't implemented in this build -- void and re-enter instead">Edit</button>}
          {can('/deposits', 'can_edit') && d.status !== 'void' && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Deposit</h1>
          <span className="estimate-no">{d.bd_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{d.status === 'void' ? 'VOID' : 'OPEN'}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 20, marginTop: 12, alignItems: 'start' }}>
          <div>
            <div>Date : <span className="hi">{formatDate(d.date_created)}</span></div>
            <div>Account : <span className="hi">{d.account_name || ''}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{d.memo || ''}</span></div>
          </div>
          <div style={{ background: '#fff', color: '#0f172a', borderRadius: 8, padding: '14px 20px', minWidth: 260 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Total Deposit</span><span style={{ color: '#2563eb', fontWeight: 700 }}>{money(d.total_amount)}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>Payments</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'payments' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Trans. #</th><th>Customer</th><th>Date Created</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {payments.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No payments.</td></tr>}
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/customer-payments/${p.id}`)}>{p.customer_payment_no}</button></td>
                    <td>{p.customer_name}</td>
                    <td>{formatDate(p.date_created)}</td>
                    <td style={{ textAlign: 'right' }}>{money(p.payment_amount)}</td>
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
              <thead><tr><th>Account Code</th><th>Account Title</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {gl.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact.</td></tr>}
                {gl.map((l, i) => (
                  <tr key={i}><td>{l.account_code}</td><td>{l.account_name}</td><td style={{ textAlign: 'right' }}>{money(l.debit)}</td><td style={{ textAlign: 'right' }}>{money(l.credit)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={2} style={{ textAlign: 'right' }}>Total</td><td style={{ textAlign: 'right' }}>{money(totalDebit)}</td><td style={{ textAlign: 'right' }}>{money(totalCredit)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => new Date(r.set_at).toLocaleString() },
              { key: 'set_by_name', label: 'Set By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}
    </div>
  );
}
