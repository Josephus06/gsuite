import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

const STATUS_LABELS = {
  pending_fulfillment: 'Pending Fulfillment',
  partially_fulfilled: 'Partially Fulfilled',
  pending_receipt: 'Pending Receipt',
  pending_receipt_partially_fulfilled: 'Pending Receipt / Partially Fulfilled',
  received: 'Received',
  cancelled: 'Cancelled',
};

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function locationLabel(l) { return l ? l.location_name : ''; }
function employeeLabel(e) { return e ? `${e.first_name} ${e.last_name}` : ''; }

// Mirrors the real "Transfer Order" Add/Update form. Reached two ways: "Add New" from
// the Transfer Orders list (blank), or the "Create TO" button on a Job Order's
// Production view -- which arrives here with router state (`prefill`) already carrying
// the header defaults (Withdraw From = Warehouse - Central, Transfer To = the JO's own
// material location, Requestor = the current user) and one line per material that's
// actually short, so this whole record gets created in a single request on mount
// instead of the user re-entering what the Production screen already knew.
export default function TransferOrderEdit() {
  const { id } = useParams();
  const location = useLocation();
  const isNew = !id;
  const navigate = useNavigate();
  const { can } = useAuth();

  const [form, setForm] = useState({
    date_created: new Date().toISOString().slice(0, 10), date_needed: '',
    withdraw_from_location_id: '', transfer_to_location_id: '', requestor_id: '', memo: '',
  });
  const [to, setTo] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const autoCreated = useRef(false);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/locations'),
      api.get('/employees'),
      api.get('/inventory'),
      isNew ? Promise.resolve(null) : api.get(`/transfer-orders/${id}`),
    ]).then(async ([locRes, empRes, invRes, toRes]) => {
      setLocations(locRes.data);
      setEmployees(empRes.data);
      setInventoryItems(invRes.data);

      const prefill = location.state?.prefill;
      if (isNew && prefill && !autoCreated.current) {
        autoCreated.current = true;
        setSaving(true);
        try {
          const { data } = await api.post('/transfer-orders', {
            date_created: new Date().toISOString().slice(0, 10),
            withdraw_from_location_id: prefill.withdraw_from_location_id,
            transfer_to_location_id: prefill.transfer_to_location_id,
            requestor_id: prefill.requestor_id || null,
            job_order_id: prefill.job_order_id || null,
            lines: prefill.lines || [],
          });
          navigate(`/transfer-orders/${data.id}`, { replace: true });
        } catch (err) {
          setError(err.response?.data?.error || 'Could not create the transfer order.');
          setLoading(false);
        } finally {
          setSaving(false);
        }
        return;
      }

      if (toRes) {
        setTo(toRes.data);
        setLines(toRes.data.lines || []);
        setForm({
          date_created: toRes.data.date_created ? String(toRes.data.date_created).slice(0, 10) : '',
          date_needed: toRes.data.date_needed ? String(toRes.data.date_needed).slice(0, 10) : '',
          withdraw_from_location_id: toRes.data.withdraw_from_location_id || '',
          transfer_to_location_id: toRes.data.transfer_to_location_id || '',
          requestor_id: toRes.data.requestor_id || '',
          memo: toRes.data.memo || '',
        });
      }
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        if (!form.withdraw_from_location_id || !form.transfer_to_location_id) {
          setError('Withdraw From and Transfer To are required.');
          return;
        }
        const { data } = await api.post('/transfer-orders', form);
        navigate(`/transfer-orders/${data.id}/edit`);
      } else {
        await api.put(`/transfer-orders/${id}`, form);
        navigate(`/transfer-orders/${id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function addLine(item) {
    const { data } = await api.post(`/transfer-orders/${id}/lines`, {
      item_id: item.id, qty: 1, uom: item.base_unit_title, unit: item.base_unit_title,
    });
    setLines((prev) => [...prev, data]);
  }

  async function commitLine(lineId, overrides = {}) {
    const row = { ...lines.find((l) => l.id === lineId), ...overrides };
    const { data } = await api.put(`/transfer-orders/${id}/lines/${lineId}`, row);
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, ...data } : l)));
  }

  async function removeLine(lineId) {
    if (!confirm('Remove this material?')) return;
    await api.delete(`/transfer-orders/${id}/lines/${lineId}`);
    setLines((prev) => prev.filter((l) => l.id !== lineId));
  }

  if (loading) return <LoadingSpinner />;

  const isPending = !to || to.status === 'pending_fulfillment';
  const canEdit = can('/transfer-orders', 'can_edit') && isPending;

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Add Transfer Order' : `Transfer Order — ${to?.to_no}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate(isNew ? '/transfer-orders' : `/transfer-orders/${id}`)}>Back</button>
          {canEdit && <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>}
        </div>
      </div>

      {!isNew && to && <p className="muted" style={{ marginTop: -8 }}>{STATUS_LABELS[to.status] || to.status}{to.job_order_no ? ` · ${to.job_order_no}` : ''}</p>}
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" disabled={!canEdit && !isNew} value={form.date_created} onChange={(e) => setForm({ ...form, date_created: e.target.value })} />
          </div>
          <div className="field">
            <label>Date Needed</label>
            <input type="date" disabled={!canEdit && !isNew} value={form.date_needed} onChange={(e) => setForm({ ...form, date_needed: e.target.value })} />
          </div>
          <div className="field">
            <label>Withdraw From</label>
            <EntityPicker
              label="Withdraw From" items={locations} value={form.withdraw_from_location_id} getLabel={locationLabel}
              columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
              searchKeys={['location_name', 'location_code']}
              disabled={!canEdit && !isNew}
              onSelect={(l) => setForm({ ...form, withdraw_from_location_id: l.id })}
            />
          </div>
          <div className="field">
            <label>Requestor</label>
            <EntityPicker
              label="Requestor" items={employees} value={form.requestor_id} getLabel={employeeLabel}
              columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
              searchKeys={['first_name', 'last_name']}
              disabled={!canEdit && !isNew}
              onSelect={(e) => setForm({ ...form, requestor_id: e.id })}
            />
          </div>
          <div className="field">
            <label>Transfer To</label>
            <EntityPicker
              label="Transfer To" items={locations} value={form.transfer_to_location_id} getLabel={locationLabel}
              columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
              searchKeys={['location_name', 'location_code']}
              disabled={!canEdit && !isNew}
              onSelect={(l) => setForm({ ...form, transfer_to_location_id: l.id })}
            />
          </div>
          <div className="field">
            <label>Memo</label>
            <input disabled={!canEdit && !isNew} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </div>
        </div>
      </div>

      {!isNew && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
          <DataTable
            columns={[
              { key: 'item_code', label: 'Item', render: (l) => `${l.item_code || ''} — ${l.item_name || ''}` },
              { key: 'job_order_no', label: 'JO #' },
              { key: 'to_count', label: 'TO Count' },
              {
                key: 'qty', label: 'Qty',
                render: (l) => canEdit ? (
                  <input type="number" step="0.0001" style={{ width: 80 }} defaultValue={l.qty} onBlur={(e) => commitLine(l.id, { qty: e.target.value })} />
                ) : qty(l.qty),
              },
              { key: 'uom', label: 'UOM' },
              { key: 'unit', label: 'Unit' },
              {
                key: 'adjusted_qty', label: 'Adjusted Qty',
                render: (l) => canEdit ? (
                  <input type="number" step="0.0001" style={{ width: 90 }} defaultValue={l.adjusted_qty ?? ''} onBlur={(e) => commitLine(l.id, { adjusted_qty: e.target.value })} />
                ) : (l.adjusted_qty != null ? qty(l.adjusted_qty) : ''),
              },
              { key: 'new_qty', label: 'New Qty', render: (l) => qty(l.new_qty) },
              { key: 'committed', label: 'Committed', render: (l) => qty(l.committed) },
              { key: 'fulfilled', label: 'Fulfilled', render: (l) => qty(l.fulfilled) },
              { key: 'received', label: 'Received', render: (l) => qty(l.received) },
              { key: 'back_ordered', label: 'Back Ordered', render: (l) => qty(l.back_ordered) },
              { key: 'qty_on_hand', label: 'Qty on Hand', render: (l) => qty(l.qty_on_hand) },
              {
                key: 'memo', label: 'Memo',
                render: (l) => canEdit ? (
                  <input style={{ width: 120 }} defaultValue={l.memo || ''} onBlur={(e) => commitLine(l.id, { memo: e.target.value })} />
                ) : l.memo,
              },
            ]}
            rows={lines}
            actions={canEdit ? (l) => <button className="btn btn-sm btn-danger" onClick={() => removeLine(l.id)}>Delete</button> : undefined}
            emptyLabel="No materials yet."
          />

          {canEdit && (
            <div style={{ marginTop: 10 }}>
              <EntityPicker
                label="Item" items={inventoryItems} value="" getLabel={(i) => i.display_name}
                columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
                searchKeys={['item_code', 'display_name']}
                onSelect={addLine}
                triggerLabel="Add Material"
                triggerClassName="btn btn-primary"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
