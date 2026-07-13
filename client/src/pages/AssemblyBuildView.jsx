import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's "Production > Assembly Build" detail screen: banner +
// Details grid + Processes/GL Impact/Related Records/System Info tabs. Each line is a
// snapshot taken at the moment the build was saved (see production.js's
// PUT /:id/assembly-build) -- it doesn't move if the source JO's processes change
// afterward, same as Inventory Adjustment lines snapshot Qty on Hand at add-time.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function AssemblyBuildView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [ab, setAb] = useState(null);
  const [tab, setTab] = useState('processes');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);

  function load() {
    return api.get(`/assembly-builds/${id}`).then(({ data }) => { setAb(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/assembly-builds/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleCancel() {
    if (!confirm('Cancel this Assembly Build? This will add the deducted materials back to on-hand and reduce the Job Order\'s Qty Built.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/assembly-builds/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !ab) return <LoadingSpinner />;

  const canEdit = can('/assembly-builds', 'can_edit');
  const isCancelled = ab.status === 'cancelled';
  const processes = ab.processes || [];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/assembly-builds')}>Back to Lists</button>
          <button className="btn btn-sm" disabled title="Editing a saved Assembly Build isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && !isCancelled && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Assembly Build</h1>
          <span className="estimate-no">{ab.ab_no}</span>
        </div>
        <div className="estimate-status">
          {isCancelled ? 'Cancelled' : 'Saved'}
          <button type="button" className="estimate-so-link" onClick={() => navigate(`/production/${ab.job_order_id}`)}>
            {ab.job_order_no}
          </button>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer</h4>
            <div className="hi">{ab.customer_name}</div>
            <div>Contact Person : <span className="hi">{ab.contact_name}</span></div>
            <div>Contact Email : <span className="hi">{ab.contact_email}</span></div>
            <div>Contact Title : <span className="hi">{ab.contact_title}</span></div>
            <div>Contact Phone : <span className="hi">{ab.contact_phone}</span></div>
          </div>
          <div>
            <div>AB # : <span className="hi">{ab.ab_no}</span></div>
            <div>Date Created : <span className="hi">{formatDate(ab.date_created)}</span></div>
            <div>Sales Rep : <span className="hi">{ab.sales_rep_name}</span></div>
            <div>Created By : <span className="hi">{ab.created_by_name}</span></div>
          </div>
          <div>
            <div>Job Location : <span className="hi">{ab.job_location_name}</span></div>
            <div>Job Type : <span className="hi">{ab.job_type_name}</span></div>
            <div>Job Desc. : <span className="hi">{ab.job_desc}</span></div>
            <div>Quantity : <span className="hi">{qty(ab.quantity)} {ab.units}</span></div>
            <div>QI : <span className="hi">{qty(ab.quantity_inspected)} {ab.units}</span> RMA : <span className="hi">0 {ab.units}</span></div>
            <div>Length : <span className="hi">{ab.length ?? 0}</span> Width : <span className="hi">{ab.width ?? 0}</span> Height : <span className="hi">{ab.height ?? 0}</span> unit : <span className="hi">{ab.units}</span></div>
            <div>Memo : <span className="hi">{ab.jo_memo}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>Processes</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'processes' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Process</th><th>Category</th><th>Parts</th><th>Item</th><th>Location</th>
                  <th>Process Qty</th><th>Qty</th><th>Qty RWIP</th><th>Total Qty to Build</th>
                  <th>Total Completed</th><th>Total Build</th><th>Unit</th>
                  <th>Process Cost</th><th>Material Cost</th><th>Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {processes.length === 0 && (
                  <tr><td colSpan={16} className="muted" style={{ textAlign: 'center', padding: 20 }}>No lines on this build.</td></tr>
                )}
                {processes.map((p, idx) => (
                  <tr key={p.id}>
                    <td>{idx + 1}</td>
                    <td>{p.process_name}</td>
                    <td>{p.category}</td>
                    <td>{p.parts}</td>
                    <td>{p.item_name}</td>
                    <td>{p.location_name}</td>
                    <td>{qty(p.process_qty)}</td>
                    <td>{qty(p.qty)}</td>
                    <td>{qty(p.qty_rwip)}</td>
                    <td>{qty(p.total_qty_to_build)}</td>
                    <td>{qty(p.total_completed)}</td>
                    <td>{qty(p.total_build)}</td>
                    <td>{p.unit}</td>
                    <td>{money(p.process_cost)}</td>
                    <td>{money(p.material_cost)}</td>
                    <td>{money(p.total_cost)}</td>
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
              <thead>
                <tr><th>Account Code</th><th>Account Title</th><th>Debit</th><th>Credit</th></tr>
              </thead>
              <tbody>
                {(!ab.gl_impact || ab.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(ab.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {ab.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(ab.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(ab.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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
              <thead><tr><th>Date</th><th>Transaction #</th><th>Qty</th><th>Status</th></tr></thead>
              <tbody>
                <tr>
                  <td>{formatDate(ab.date_created)}</td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => navigate(`/production/${ab.job_order_id}`)}>
                      {ab.job_order_no}
                    </button>
                  </td>
                  <td>{qty(ab.quantity)}</td>
                  <td>Released</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => new Date(r.set_at).toLocaleString() },
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
