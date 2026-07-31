import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }

export default function ChequeView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState('expenses');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/cheques/${id}`).then(({ data }) => { setC(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/cheques/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Cheque?')) return;
    setBusy(true); setError('');
    try { await api.put(`/cheques/${id}/void`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }

  if (loading || !c) return <LoadingSpinner />;
  const lines = c.lines || [];
  const gl = c.gl || [];
  const wtaxLines = lines.filter((l) => num(l.withholding_tax_amount) > 0 || l.apply_withholding_tax);
  const totalDebit = gl.reduce((s, l) => s + num(l.debit), 0);
  const totalCredit = gl.reduce((s, l) => s + num(l.credit), 0);
  const T = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}><span>{label}</span><span style={{ color: '#2563eb' }}>{money(value)}</span></div>
  );

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/cheques')}>Back to Lists</button>
          {can('/cheques', 'can_edit') && c.status !== 'void' && <button className="btn btn-sm" disabled title="Editing a posted Cheque isn't implemented in this build -- void and re-enter instead">Edit</button>}
          {can('/cheques', 'can_edit') && c.status !== 'void' && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Cheque</h1>
          <span className="estimate-no">{c.cheque_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{c.status === 'void' ? 'VOID' : 'OPEN'}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 320px', gap: 20, marginTop: 12, alignItems: 'start' }}>
          <div>
            <h4>Payee</h4>
            <div className="hi">{c.payee_name}</div>
            <div>Payee Name : <span className="hi">{c.payee_name}</span></div>
            <div>Office Location : <span className="hi">{c.location_name || ''}</span></div>
            <div>Account : <span className="hi">{c.account_name || ''}</span></div>
          </div>
          <div>
            <div>Date : <span className="hi">{formatDate(c.date_created)}</span></div>
            <div>Cheque Date : <span className="hi">{formatDate(c.cheque_date)}</span></div>
            <div>Cheque No : <span className="hi">{c.cheque_number || ''}</span></div>
            <div>Date Released : <span className="hi">{formatDate(c.date_released)}</span></div>
            <div>Currency : <span className="hi">{c.currency || ''}</span></div>
            <div>Conversion : <span className="hi">{Number(c.conversion_rate)}</span></div>
            <div>Memo : <span className="hi">{c.memo || ''}</span></div>
          </div>
          <div style={{ background: '#fff', color: '#0f172a', borderRadius: 8, padding: '14px 18px' }}>
            <T label="Sub Total" value={c.subtotal} />
            <T label="Discount Amount" value={c.discount_amount} />
            <T label="Net of Tax" value={c.net_of_tax} />
            <T label="Tax Amount" value={c.tax_amount} />
            <T label="Gross Amount" value={c.gross_amount} />
            <T label="Withholding Tax Amount" value={c.withholding_tax_amount} />
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 700 }}><span>Total Amount</span><span style={{ color: '#2563eb' }}>{money(c.total_amount)}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
        <button className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'expenses' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Account Code</th><th>Account Title</th><th>Description</th><th>Department</th><th style={{ textAlign: 'right' }}>Amount</th>
                <th>Tax Code</th><th style={{ textAlign: 'right' }}>Tax Amount</th><th style={{ textAlign: 'center' }}>Apply WTax</th>
                <th style={{ textAlign: 'right' }}>Gross Amount</th><th style={{ textAlign: 'right' }}>Withholding Tax</th><th style={{ textAlign: 'right' }}>Total Amount</th>
              </tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No expenses.</td></tr>}
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.account_code}</td><td>{l.account_name}</td><td>{l.description}</td><td>{l.department_name}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.amount)}</td>
                    <td>{l.tax_code}</td><td style={{ textAlign: 'right' }}>{money(l.tax_amount)}</td>
                    <td style={{ textAlign: 'center' }}>{l.apply_withholding_tax ? '✓' : ''}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.gross_amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.withholding_tax_amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700 }}>
                <td colSpan={4} style={{ textAlign: 'right' }}>Total</td>
                <td style={{ textAlign: 'right' }}>{money(c.net_of_tax)}</td><td />
                <td style={{ textAlign: 'right' }}>{money(c.tax_amount)}</td><td />
                <td style={{ textAlign: 'right' }}>{money(c.gross_amount)}</td>
                <td style={{ textAlign: 'right' }}>{money(c.withholding_tax_amount)}</td>
                <td style={{ textAlign: 'right' }}>{money(c.total_amount)}</td>
              </tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'wtax' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Withholding Tax</th></tr></thead>
              <tbody>
                {wtaxLines.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No withholding tax.</td></tr>}
                {wtaxLines.map((l) => (
                  <tr key={l.id}><td>{l.account_code} — {l.account_name}</td><td>{l.description}</td><td style={{ textAlign: 'right' }}>{money(l.amount)}</td><td style={{ textAlign: 'right' }}>{money(l.withholding_tax_amount)}</td></tr>
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
                {gl.map((l, i) => <tr key={i}><td>{l.account_code}</td><td>{l.account_name}</td><td style={{ textAlign: 'right' }}>{money(l.debit)}</td><td style={{ textAlign: 'right' }}>{money(l.credit)}</td></tr>)}
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
