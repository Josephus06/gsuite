import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate, displayAuditTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';
import ButtonMenu from '../components/ButtonMenu';

// Certificate of Completion (2026-10-28): the header, its Approvers and Certifiers, and the
// approve / print / void actions -- as the Warranty Certificate view.
const STATUS_LABELS = { pending_approval: 'Pending', approved: 'Approved', voided: 'Voided' };
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export default function CompletionCertificateView() {
  const { id } = useParams();
  const { can } = useAuth();
  const [cc, setCc] = useState(null);
  const [tab, setTab] = useState('approvers');
  const [auditLogs, setAuditLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/completion-certificates/${id}`).then(({ data }) => setCc(data)); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/completion-certificates/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function act(fn) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError(e.response?.data?.error || 'Action failed'); } finally { setBusy(false); } }
  const handleApprove = () => { if (confirm('Approve this Certificate of Completion?')) act(() => api.put(`/completion-certificates/${id}/approve`)); };
  const handleVoid = () => { if (confirm('Void this Certificate of Completion?')) act(() => api.put(`/completion-certificates/${id}/void`)); };

  if (!cc) return <LoadingSpinner />;
  const isApproved = cc.status === 'approved';
  const isVoided = cc.status === 'voided';
  const signers = tab === 'certifiers' ? cc.certifiers : cc.approvers;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>CERTIFICATE OF COMPLETION <span className="muted">{STATUS_LABELS[cc.status] || cc.status}</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/completion-certificates'}>Back to Lists</Link>
          {can('/completion-certificates', 'can_edit') && !isVoided && !isApproved && <Link className="btn btn-sm btn-primary" to={`/completion-certificates/${id}/edit`}>Edit</Link>}
          {can('/completion-certificates', 'can_approve') && cc.status === 'pending_approval' && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {/* Printed once approved, as the Warranty Certificate -- either of the source's two certificates. */}
          {isApproved && (
            <ButtonMenu
              label="Print"
              options={[
                { label: 'Certificate of Completion', onClick: () => window.open(`/completion-certificates/${id}/print`, '_blank') },
                { label: 'Certificate of Acceptance', onClick: () => window.open(`/completion-certificates/${id}/print?type=acceptance`, '_blank') },
              ]}
            />
          )}
          {can('/completion-certificates', 'can_void') && !isVoided && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 16px' }}>COC # : <span style={{ marginLeft: 30 }}>{cc.coc_no}</span></h1>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, lineHeight: 2 }}>
          <div>
            <div>Date Created : <span className="hi">{formatDate(cc.date_created)}</span></div>
            <div>SO # : <span className="hi">{cc.sales_order_no}</span></div>
            <div>PO # : <span className="hi">{cc.po_no}</span></div>
            <div>Customer : <span className="hi"><CustomerLink id={cc.customer_id} name={cc.customer_name} /></span></div>
            <div>Submitted By : <span className="hi">{cc.submitted_by_name}</span></div>
          </div>
          <div>
            <div>Project Name : <span className="hi">{cc.project_name}</span></div>
            <div>Location : <span className="hi">{cc.location}</span></div>
            <div>Contract Package : <span className="hi">{cc.contract_package}</span></div>
            {isApproved && <div>Approved : <span className="hi">{formatDate(cc.approved_at)}{cc.approved_by_name ? ` by ${cc.approved_by_name}` : ''}</span></div>}
          </div>
        </div>
      </div>

      <div className="status-tabs">
        <button className={`status-tab ${tab === 'approvers' ? 'active' : ''}`} onClick={() => setTab('approvers')}>Approvers</button>
        <button className={`status-tab ${tab === 'certifiers' ? 'active' : ''}`} onClick={() => setTab('certifiers')}>Certifiers</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      <div className="card">
        {tab === 'system' ? (
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 50 }}>#</th><th>Name</th><th>Job Title</th></tr></thead>
              <tbody>
                {(signers || []).length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 16 }}>None.</td></tr>}
                {(signers || []).map((s) => <tr key={s.id}><td>{s.line_no}</td><td>{s.name}</td><td>{s.job_title}</td></tr>)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
