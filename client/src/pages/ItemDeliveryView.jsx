import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's "Item Delivery" detail screen: banner + Details grid +
// Items/GL Impact/Related Records/System Info tabs -- same structure as
// AssemblyBuildView.jsx, since this is the same class of record (a production/
// fulfillment transaction hung off a Job Order) just for the delivery leg instead of
// the build leg.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

export default function ItemDeliveryView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);

  function load() {
    return api.get(`/item-deliveries/${id}`).then(({ data }) => { setD(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/item-deliveries/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleCancel() {
    if (!confirm('Cancel this Item Delivery? This will reduce the Job Order\'s Qty Delivered.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/item-deliveries/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !d) return <LoadingSpinner />;

  const canEdit = can('/sales-orders', 'can_edit');
  const isCancelled = d.status === 'cancelled';
  const lines = d.lines || [];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/sales-orders/${d.sales_order_id}`)}>Back to Lists</button>
          <button className="btn btn-sm" disabled title="Editing a saved Item Delivery isn't implemented in this build">Edit</button>
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canEdit && !isCancelled && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Item Delivery</h1>
          <span className="estimate-no">{d.delivery_no}</span>
        </div>
        <div className="estimate-status">
          {isCancelled ? 'Cancelled' : 'Saved'}
          <button type="button" className="estimate-so-link" onClick={() => navigate(`/sales-orders/${d.sales_order_id}`)}>
            {d.sales_order_no}
          </button>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer</h4>
            <div className="hi">{d.customer_name}</div>
            <div>Contact Person : <span className="hi">{d.contact_name}</span></div>
            <div>Contact Email : <span className="hi">{d.contact_email}</span></div>
            <div>Contact Title : <span className="hi">{d.contact_title}</span></div>
            <div>Contact Phone : <span className="hi">{d.contact_phone}</span></div>
          </div>
          <div>
            <div>ID # : <span className="hi">{d.delivery_no}</span></div>
            <div>Date Created : <span className="hi">{formatDate(d.date_created)}</span></div>
            <div>Created From : <span className="hi">{d.sales_order_no}</span></div>
            <div>Created By : <span className="hi">{d.created_by_name}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{d.memo}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
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
                  <th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Location</th>
                  <th>Qty</th><th>Unit</th><th>Size</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No lines on this delivery.</td></tr>
                )}
                {lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>{idx + 1}</td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => navigate(`/production/${l.job_order_id}`)}>
                        {l.job_order_no}
                      </button>
                    </td>
                    <td>{l.item_name}</td>
                    <td>{l.description}</td>
                    <td>{l.job_location_name}</td>
                    <td>{qty(l.qty_delivered)}</td>
                    <td>{l.units}</td>
                    <td>{l.length ?? 0} x {l.width ?? 0} x {l.height ?? 0}</td>
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
                {(!d.gl_impact || d.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(d.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {d.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(d.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(d.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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
              <thead><tr><th>Date</th><th>Transaction #</th><th>Status</th></tr></thead>
              <tbody>
                <tr>
                  <td>{formatDate(d.date_created)}</td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${d.sales_order_id}`)}>
                      {d.sales_order_no}
                    </button>
                  </td>
                  <td>{isCancelled ? 'Cancelled' : 'Saved'}</td>
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
