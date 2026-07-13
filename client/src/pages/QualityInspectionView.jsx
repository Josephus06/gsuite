import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

// Mirrors the real "Quality Inspection" detail view -- reached from a Job Order's
// Production view. No Items tab (unlike most other transaction views this session) --
// the real screen doesn't gate the AB/Pass/RMA breakdown behind one, so it sits directly
// under the banner. "Quantity" is this QI's own total (Pass + RMA across every line);
// "Quantity Delivered" is the Pass-only portion -- what's actually cleared to move on to
// delivery, since RMA'd qty explicitly isn't.
export default function QualityInspectionView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [qi, setQi] = useState(null);
  const [tab, setTab] = useState('related');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/quality-inspections/${id}`).then(({ data }) => { setQi(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/quality-inspections/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleCancel() {
    if (!confirm('Cancel this Quality Inspection? Its Pass/RMA qty will be reversed.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/quality-inspections/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !qi) return <LoadingSpinner />;

  const canEdit = can('/production', 'can_edit');
  const isSaved = qi.status === 'saved';
  const totalQty = qi.lines.reduce((s, l) => s + Number(l.pass_qty || 0) + Number(l.rma_qty || 0), 0);
  const totalPassed = qi.lines.reduce((s, l) => s + Number(l.pass_qty || 0), 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/production/${qi.job_order_id}`)}>Back</button>
          <button className="btn btn-sm" disabled title="Editing a saved Quality Inspection isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && isSaved && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Quality Inspection</h1>
          <span className="estimate-no">{qi.qi_no}</span>
        </div>
        <div>
          {qi.lines.map((l) => (
            <button key={l.id} type="button" className="link-btn" style={{ color: '#fff', textDecoration: 'underline', marginRight: 12 }} onClick={() => navigate(`/assembly-builds/${l.assembly_build_id}`)}>
              {l.ab_no}
            </button>
          ))}
        </div>
        <div>
          <button type="button" className="link-btn" style={{ color: '#fff', textDecoration: 'underline' }} onClick={() => navigate(`/production/${qi.job_order_id}`)}>
            {qi.job_order_no}
          </button>
        </div>

        <div className="estimate-detail-grid" style={{ marginTop: 16 }}>
          <div>
            <div className="muted" style={{ color: '#cbd5e1', fontSize: 12, textTransform: 'uppercase' }}>Customer</div>
            <div className="hi">{qi.customer_name || '—'}</div>
            <div>Contact Person : <span className="hi">{qi.contact_name || ''}</span></div>
            <div>Contact Email : <span className="hi">{qi.contact_email || ''}</span></div>
            <div>Contact Title : <span className="hi">{qi.contact_title || ''}</span></div>
            <div>Contact Phone : <span className="hi">{qi.contact_phone || ''}</span></div>
          </div>
          <div>
            <div>QI # : <span className="hi">{qi.qi_no}</span></div>
            <div>Date Created : <span className="hi">{formatDate(qi.date_created)}</span></div>
            <div>Quantity : <span className="hi">{qty(totalQty)}</span></div>
            <div>Quantity Delivered : <span className="hi">{qty(totalPassed)}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{qi.memo || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Transaction #</th><th>Qty</th><th>Unit</th><th>Status</th></tr></thead>
              <tbody>
                {qi.lines.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records.</td></tr>
                )}
                {qi.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{formatDate(qi.date_created)}</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/assembly-builds/${l.assembly_build_id}`)}>{l.ab_no}</button></td>
                    <td>{qty(l.pass_qty)} passed / {qty(l.rma_qty)} RMA</td>
                    <td></td>
                    <td>{qi.status === 'cancelled' ? 'Cancelled' : 'Saved'}</td>
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
