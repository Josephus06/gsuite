import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }

// A manual journal's GL Impact is its lines verbatim -- so both tabs render the same rows; the
// LINES tab is the entered document, the GL IMPACT tab is what posts to the ledger.
function LinesTable({ lines }) {
  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Account Code</th><th>Account Title</th><th>Department</th><th>Name</th><th>Type</th>
            <th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th><th>Memo</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No lines.</td></tr>}
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{l.account_code}</td>
              <td>{l.account_name}</td>
              <td>{l.department_name}</td>
              <td>{l.party_name}</td>
              <td>{l.party_type}</td>
              <td style={{ textAlign: 'right' }}>{money(l.debit)}</td>
              <td style={{ textAlign: 'right' }}>{money(l.credit)}</td>
              <td>{l.memo}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: 700 }}>
            <td colSpan={5} style={{ textAlign: 'right' }}>Total</td>
            <td style={{ textAlign: 'right' }}>{money(totalDebit)}</td>
            <td style={{ textAlign: 'right' }}>{money(totalCredit)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function JournalView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [j, setJ] = useState(null);
  const [tab, setTab] = useState('lines');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/journals/${id}`).then(({ data }) => { setJ(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/journals/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Journal?')) return;
    setBusy(true); setError('');
    try { await api.put(`/journals/${id}/void`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }

  if (loading || !j) return <LoadingSpinner />;
  const lines = j.lines || [];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/journals')}>Back to Lists</button>
          {can('/journals', 'can_edit') && j.status !== 'void' && <button className="btn btn-sm" disabled title="Editing a posted Journal isn't implemented in this build -- void and re-enter instead">Edit</button>}
          {can('/journals', 'can_edit') && j.status !== 'void' && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Journal</h1>
          <span className="estimate-no">{j.journal_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{j.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Date : <span className="hi">{formatDate(j.date_created)}</span></div>
            <div>Location : <span className="hi">{j.location_name || ''}</span></div>
          </div>
          <div>
            <div>Currency : <span className="hi">{j.currency || ''}</span></div>
            <div>Conversion : <span className="hi">{Number(j.conversion)}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{j.memo || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'lines' ? 'active' : ''}`} onClick={() => setTab('lines')}>Lines</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'lines' && <div className="card"><LinesTable lines={lines} /></div>}
      {tab === 'gl' && <div className="card">{j.status === 'void'
        ? <p className="muted" style={{ padding: 16 }}>This journal is voided — it posts nothing to the GL.</p>
        : <LinesTable lines={lines} />}</div>}

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
