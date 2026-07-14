import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's Inventory Adjustment detail screen: banner + Details +
// Items/GL Impact/System Info tabs. GL Impact is derived on the fly from
// estimated_total_value against the single Adjustment Account rather than a real
// posted journal entry pair (Dr inventory asset / Cr adjustment account or vice versa)
// -- there's no Journal/GL module in this build to post real double-entry lines to, and
// the real screen itself only ever showed a single populated pair once Approved.
const STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function InventoryAdjustmentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [adj, setAdj] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);

  function load() {
    return api.get(`/inventory-adjustments/${id}`).then(({ data }) => { setAdj(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/inventory-adjustments/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleApprove() {
    if (!confirm('Approve this adjustment? This will update on-hand quantities at each location.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/inventory-adjustments/${id}/approve`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!confirm('Cancel this adjustment?')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/inventory-adjustments/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !adj) return <LoadingSpinner />;

  const canEdit = can('/inventory-adjustments', 'can_edit');
  const canApprove = can('/inventory-adjustments', 'can_approve');
  const isPending = adj.status === 'pending_approval';
  const lines = adj.lines || [];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/inventory-adjustments')}>Back to Lists</button>
          {canApprove && isPending && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {canEdit && isPending && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/inventory-adjustments/${id}/edit`)}>Edit</button>}
          {canEdit && isPending && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Inventory Adjustment</h1>
          <span className="estimate-no">{adj.adjustment_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[adj.status] || adj.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Details</h4>
            <div>Date Created : <span className="hi">{formatDate(adj.date_created)}</span></div>
            <div>Adjustment Account : <span className="hi">{adj.adjustment_account_code ? `${adj.adjustment_account_code} — ${adj.adjustment_account_name}` : '—'}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{adj.memo}</span></div>
          </div>
          <div>
            <div>Estimated Total Value : <span className="hi">{money(adj.estimated_total_value)}</span></div>
            {adj.status === 'approved' && <div>Approved By : <span className="hi">{adj.approved_by_name}</span></div>}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Item</th><th>Location</th><th>Department</th><th>Qty on Hand</th>
                  <th>Unit Used</th><th>UOM</th><th>Unit</th><th>Current Value</th><th>Adjust Qty. By</th><th>New Qty</th>
                  <th>Est. Unit Cost</th><th>Est. Unit Cost (Base)</th><th>Memo</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 20 }}>No adjustment lines.</td></tr>
                )}
                {lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>{idx + 1}</td>
                    <td>{l.item_code} {l.item_name ? `— ${l.item_name}` : ''}</td>
                    <td>{l.location_name}</td>
                    <td>{l.department_name}</td>
                    <td>{l.qty_on_hand}</td>
                    <td>{l.unit_used === 'base' ? 'Base Unit' : 'Stock Unit'}</td>
                    <td>{l.uom_title}</td>
                    <td>{l.unit}</td>
                    <td>{money(l.current_value)}</td>
                    <td>{l.adjust_qty_by}</td>
                    <td>{l.new_qty}</td>
                    <td>{money(l.est_unit_cost)}</td>
                    <td>{money(l.est_unit_cost_base)}</td>
                    <td>{l.memo}</td>
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
                {(!adj.gl_impact || adj.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(adj.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {adj.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(adj.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(adj.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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
