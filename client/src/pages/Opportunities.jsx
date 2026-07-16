import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import EntityPicker from '../components/EntityPicker';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const STAGES = [
  { key: 'prospecting', label: 'Prospecting' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'proposal', label: 'Proposal' },
  { key: 'negotiation', label: 'Negotiation' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];
const OPEN_STAGES = ['prospecting', 'qualified', 'proposal', 'negotiation'];
const EMPTY = { name: '', customer_id: '', lead_id: '', estimated_value: 0, expected_close_date: '', sales_rep_id: '', memo: '' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) : ''; }

// Column-per-stage board -- deliberately not a real drag-and-drop Kanban (a stage
// <select> on each card moves it instead): same organized-by-column read as a Kanban,
// far less implementation risk than wiring up a DnD library. Won/Lost sit at the end as
// the pipeline's two closed states, matching opportunities.stage's own enum order
// (server/src/routes/opportunities.js's STAGES).
export default function Opportunities() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [leads, setLeads] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  async function load() {
    setLoading(true);
    const [o, c, l, e] = await Promise.all([
      api.get('/opportunities'),
      api.get('/customers'),
      api.get('/leads', { params: { status: '' } }),
      api.get('/employees'),
    ]);
    setRows(o.data);
    setCustomers(c.data);
    setLeads(l.data.rows.filter((r) => r.status !== 'converted'));
    setEmployees(e.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const payload = {
      ...form,
      customer_id: form.customer_id || null,
      lead_id: form.lead_id || null,
      sales_rep_id: form.sales_rep_id || null,
      estimated_value: Number(form.estimated_value) || 0,
      expected_close_date: form.expected_close_date || null,
    };
    try {
      await api.post('/opportunities', payload);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function moveStage(opp, stage) {
    let lostReason = null;
    if (stage === 'lost') {
      lostReason = prompt('Reason this Opportunity was lost:');
      if (!lostReason) return;
    }
    try {
      await api.put(`/opportunities/${opp.id}/stage`, { stage, lost_reason: lostReason });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to move stage');
    }
  }

  const visibleStages = showClosed ? STAGES : STAGES.filter((s) => OPEN_STAGES.includes(s.key));
  const totalOpenValue = rows.filter((r) => OPEN_STAGES.includes(r.stage)).reduce((s, r) => s + Number(r.estimated_value || 0), 0);

  return (
    <div>
      <div className="page-header">
        <h1>Opportunities</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide Won/Lost' : 'Show Won/Lost'}</button>
          {can('/opportunities', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>New Opportunity</button>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <span className="muted">Open Pipeline Value</span>
        <div className="hi-lg">{money(totalOpenValue)}</div>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${visibleStages.length}, minmax(220px, 1fr))`, gap: 12, overflowX: 'auto' }}>
          {visibleStages.map((stage) => {
            const stageRows = rows.filter((r) => r.stage === stage.key);
            const stageValue = stageRows.reduce((s, r) => s + Number(r.estimated_value || 0), 0);
            return (
              <div key={stage.key} className="card" style={{ minHeight: 200 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <strong>{stage.label}</strong>
                  <span className="muted">{stageRows.length}</span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{money(stageValue)}</div>
                {stageRows.map((o) => (
                  <div key={o.id} className="card" style={{ marginBottom: 8, padding: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{o.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {o.customer_name || o.lead_company_name || '—'}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>{money(o.estimated_value)}</div>
                    {o.expected_close_date && <div className="muted" style={{ fontSize: 11 }}>Close: {formatDate(o.expected_close_date)}</div>}
                    {o.sales_rep_name && <div className="muted" style={{ fontSize: 11 }}>{o.sales_rep_name}</div>}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button type="button" className="btn btn-sm" onClick={() => navigate(`/opportunities/${o.id}`)}>Open</button>
                      {can('/opportunities', 'can_edit') && stage.key !== 'won' && stage.key !== 'lost' && (
                        <select value="" onChange={(e) => e.target.value && moveStage(o, e.target.value)} style={{ fontSize: 12 }}>
                          <option value="">Move to...</option>
                          {STAGES.filter((s) => s.key !== stage.key).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <Modal title="New Opportunity" onClose={() => setEditing(null)}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Customer</label>
                <EntityPicker
                  label="Customer" items={customers} value={form.customer_id} getLabel={(c) => c?.name}
                  columns={[{ key: 'name', label: 'Name' }, { key: 'company_name', label: 'Company' }]} searchKeys={['name', 'company_name']}
                  onSelect={(c) => setForm({ ...form, customer_id: c.id, lead_id: '' })}
                  placeholder="Existing customer..."
                />
              </div>
              <div className="field">
                <label>or Lead</label>
                <EntityPicker
                  label="Lead" items={leads} value={form.lead_id} getLabel={(l) => l?.company_name}
                  columns={[{ key: 'lead_no', label: 'Lead #' }, { key: 'company_name', label: 'Company' }]} searchKeys={['company_name']}
                  onSelect={(l) => setForm({ ...form, lead_id: l.id, customer_id: '' })}
                  placeholder="Not-yet-converted lead..."
                  disabled={!!form.customer_id}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Estimated Value</label>
                <input type="number" step="0.01" value={form.estimated_value} onChange={(e) => setForm({ ...form, estimated_value: e.target.value })} />
              </div>
              <div className="field">
                <label>Expected Close Date</label>
                <input type="date" value={form.expected_close_date} onChange={(e) => setForm({ ...form, expected_close_date: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Sales Rep</label>
              <EntityPicker
                label="Sales Rep" items={employees} value={form.sales_rep_id}
                getLabel={(e) => e && `${e.first_name} ${e.last_name}`}
                columns={[{ key: 'first_name', label: 'First Name' }, { key: 'last_name', label: 'Last Name' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={(e) => setForm({ ...form, sales_rep_id: e.id })}
              />
            </div>
            <div className="field">
              <label>Memo</label>
              <textarea rows={2} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Close</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
