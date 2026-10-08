import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import RmaDetailsTab, { isRmaJobOrder } from '../components/RmaDetailsTab';
import { useAuth } from '../context/useAuth';

import { displayDateTime } from '../utils/dates';
import { convertAreaToBaseUnit, convertLengthToBaseUnit } from '../utils/costing';

// Mirrors the real system's full-page Job Order Edit form (not a modal): a 3-column
// header form + a Materials tab with an inline-editable process/material table + a
// Logs tab. Customer/Job Type/Sales Division/Office Location stay locked to the
// originating Sales Order (matching the real form's read-only treatment of those),
// while contact/shipping/delivery/sales-rep/artist/memo/job-location/job-desc are
// independently editable here, same as the real one. Quantity/Length/Width/Height are
// shown read-only too -- the real form displays them as plain labels, not inputs.
// Process/Item/Job Location/Sales Rep/Artist use the same searchable EntityPicker modal
// as the rest of the app (Estimates, Sales Orders) rather than plain <select> dropdowns,
// since their option lists are too long to scan without search.
const CATEGORY_OPTIONS = ['Electrical', 'In-House', 'Assembly', 'Installation', 'Structural'];

const PROCESS_COLUMNS = [
  { key: 'process_id', label: 'Process', type: 'picker-process' },
  { key: 'process_qty', label: 'Process Qty', type: 'number' },
  { key: 'process_uom', label: 'Process UOM', type: 'text', readOnly: true },
  { key: 'category', label: 'Category', type: 'select', options: CATEGORY_OPTIONS },
  { key: 'parts', label: 'Parts', type: 'text' },
  { key: 'item_id', label: 'Item', type: 'picker-item' },
  { key: 'length', label: 'Length', type: 'number' },
  { key: 'width', label: 'Width', type: 'number' },
  // A dropdown of the item's own Unit of Measures, as on the Estimate -- Length/Width are read
  // in it and converted into the item's unit for Total.
  { key: 'uom', label: 'UOM', type: 'select-uom' },
  { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'total', label: 'Total', type: 'number', readOnly: true },
  { key: 'unit', label: 'Unit', type: 'text', readOnly: true },
  { key: 'location_id', label: 'Location', type: 'picker-location' },
  { key: 'artist_remarks', label: 'Artist Remarks', type: 'text' },
];

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }

// Forecast is a derived summary, not its own input: total calendar days spanned by
// Planned Start..Planned End (inclusive, so same-day = 1 day), matching how a delivery
// window would actually be counted.
function forecastDays(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  const days = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
  return days > 0 ? days : null;
}

export default function JobOrderEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { can, user } = useAuth();
  // Design Supervisors only -- the server's rule (lib/artistAssignment.js mayAssignArtist).
  const canAssignArtist = !!user?.is_design_supervisor;
  // Edit is reachable from both Sales > Job Orders and Production > Production --
  // Cancel/Save should return wherever the user actually came from instead of always
  // landing on the Sales-side view, which used to strand Production users on a
  // different module after every edit.
  const backTo = location.state?.from === 'production' ? `/production/${id}` : `/job-orders/${id}`;

  const [jo, setJo] = useState(null);
  // A rework JO (RWIP / RFQC) sizes each material in the MOTHER's UOM for that item (asked
  // 2026-10-08; the server refuses anything else): item_id -> UOM, read off the mother's lines.
  const [motherUoms, setMotherUoms] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('materials');
  const [auditLogs, setAuditLogs] = useState([]);

  const [form, setForm] = useState(null);
  const [processes, setProcesses] = useState([]);

  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [artists, setArtists] = useState([]);
  const [processesList, setProcessesList] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [units, setUnits] = useState([]);
  const [uomsByItem, setUomsByItem] = useState({});

  useEffect(() => {
    Promise.all([
      api.get(`/job-orders/${id}`),
      api.get('/lookups/locations'),
      api.get('/employees'),
      api.get('/employees', { params: { account_type: 'Artist' } }),
      api.get('/lookups/processes'),
      // Same as the Estimate wizard: a process line here can carry a JO-flagged Service item
      // (SERVICE LABOR, Layout Fee) as well as a material.
      api.get('/inventory', { params: { include_jo_services: 1 } }),
      api.get('/lookups/units-of-measure'),
    ]).then(([joRes, locRes, empRes, artistRes, procRes, invRes, unitRes]) => {
      setJo(joRes.data);
      setProcesses(joRes.data.processes || []);
      if (joRes.data.parent_job_order_id) {
        api.get(`/job-orders/${joRes.data.parent_job_order_id}`).then(({ data }) => {
          const m = new Map();
          for (const p of data.processes || []) if (p.item_id && p.uom && !m.has(p.item_id)) m.set(p.item_id, p.uom);
          setMotherUoms(m);
        }).catch(() => {});
      }
      setForm({
        job_location_id: joRes.data.job_location_id || '', description: joRes.data.description || '',
        artist_id: joRes.data.artist_id || '', memo: joRes.data.memo || '',
        contact_email: joRes.data.contact_email || '', contact_title: joRes.data.contact_title || '',
        contact_phone: joRes.data.contact_phone || '', shipping_address: joRes.data.shipping_address || '',
        delivery_date: joRes.data.delivery_date ? String(joRes.data.delivery_date).slice(0, 10) : '',
        delivery_time: joRes.data.delivery_time || '',
        planned_start_date: joRes.data.planned_start_date ? String(joRes.data.planned_start_date).slice(0, 10) : '',
        planned_end_date: joRes.data.planned_end_date ? String(joRes.data.planned_end_date).slice(0, 10) : '',
        sales_rep_id: joRes.data.sales_rep_id || '',
      });
      setLocations(locRes.data);
      setEmployees(empRes.data);
      setArtists(artistRes.data);
      setProcessesList(procRes.data);
      setInventoryItems(invRes.data);
      setUnits(unitRes.data);
      setLoading(false);
      // Each line's UOM options, for the items already on the JO.
      [...new Set((joRes.data.processes || []).map((r) => r.item_id).filter(Boolean))].forEach(ensureUomsLoaded);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // An item's Unit of Measures (its Inventory "Unit of Measures" tab), fetched once per item --
  // the same list the Estimate wizard's UOM dropdown offers.
  async function ensureUomsLoaded(itemId) {
    if (!itemId) return;
    try {
      const { data } = await api.get(`/inventory/${itemId}/unit-of-measures`);
      setUomsByItem((prev) => ({ ...prev, [itemId]: data }));
    } catch { /* no list: the dropdown still shows the line's current UOM */ }
  }

  function unitLabel(unitId) {
    return units.find((u) => u.id === unitId)?.title || '';
  }

  function employeeLabel(e) {
    return `${e.first_name} ${e.last_name}`;
  }

  useEffect(() => {
    if (tab === 'logs') {
      api.get(`/job-orders/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleSave() {
    if (form.planned_start_date && form.planned_end_date && form.planned_end_date < form.planned_start_date) {
      setError('Planned End cannot be before Planned Start.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.put(`/job-orders/${id}`, form);
      navigate(backTo);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function addMaterial() {
    const { data } = await api.post(`/job-orders/${id}/processes`, {});
    setProcesses((prev) => [...prev, data]);
  }

  async function updateMaterial(procId, field, value) {
    setProcesses((prev) => prev.map((p) => (p.id === procId ? { ...p, [field]: value } : p)));
  }

  async function commitMaterial(procId, overrides = {}) {
    const row = { ...processes.find((p) => p.id === procId), ...overrides };
    const { data } = await api.put(`/job-orders/${id}/processes/${procId}`, row);
    setProcesses((prev) => prev.map((p) => (p.id === procId ? { ...p, ...data } : p)));
  }

  // Recomputes Total and, when the Item changes, the UOM/Unit auto-fill -- the Estimate wizard's
  // rule (shared/costing.js): Total = Qty x size, where size is Length x Width converted from the
  // chosen UOM into the item's own area unit for an area item (48 x 96 IN of a Square-Foot sheet
  // = 32), Length converted into its linear unit for a length item, else 1.
  async function recalcAndCommitMaterial(procId, overrides = {}) {
    const current = { ...processes.find((p) => p.id === procId), ...overrides };
    const item = current.item_id ? inventoryItems.find((i) => i.id === Number(current.item_id)) : null;
    let size = 1;
    if (item?.is_length_based && item?.is_width_based && num(current.length) > 0 && num(current.width) > 0) {
      size = convertAreaToBaseUnit(current.length, current.width, current.uom, item.base_unit_code);
    } else if (item?.is_length_based && !item?.is_width_based && num(current.length) > 0) {
      size = convertLengthToBaseUnit(current.length, current.uom, item.base_unit_code);
    }
    const total = Number((size * num(current.qty)).toFixed(4));
    await commitMaterial(procId, { ...overrides, total });
  }

  async function deleteMaterial(procId) {
    if (!confirm('Delete this material line?')) return;
    await api.delete(`/job-orders/${id}/processes/${procId}`);
    setProcesses((prev) => prev.filter((p) => p.id !== procId));
  }

  function materialCell(col, row) {
    const val = row[col.key] ?? '';
    if (col.type === 'picker-process') {
      return (
        <EntityPicker
          label="Process" items={processesList} value={val} getLabel={(p) => p.process_name}
          isSelectable={(p) => !!p.is_active}
          columns={[{ key: 'process_name', label: 'Process Name' }, { key: 'process_code', label: 'Code' }, { key: 'base_unit', label: 'Base Unit', render: (p) => unitLabel(p.base_unit_id) }]}
          searchKeys={['process_name', 'process_code']}
          onSelect={(p) => commitMaterial(row.id, { process_id: p.id, process_uom: unitLabel(p.base_unit_id) })}
        />
      );
    }
    if (col.type === 'picker-item') {
      return (
        <EntityPicker
          label="Item" items={inventoryItems} value={val} getLabel={(i) => i.display_name}
          columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }, { key: 'category_name', label: 'Category' }]}
          searchKeys={['item_code', 'display_name']}
          // UOM starts at the item's base unit CODE, as on the Estimate, and is then changeable.
          onSelect={(i) => { ensureUomsLoaded(i.id); recalcAndCommitMaterial(row.id, { item_id: i.id, uom: motherUoms.get(i.id) || i.base_unit_code || '', unit: unitLabel(i.base_unit_id) }); }}
        />
      );
    }
    if (col.type === 'picker-location') {
      return (
        <EntityPicker
          label="Location" items={locations} value={val} getLabel={(l) => l.location_name}
          columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
          searchKeys={['location_name', 'location_code']}
          onSelect={(l) => commitMaterial(row.id, { location_id: l.id })}
        />
      );
    }
    if (col.type === 'select') {
      return (
        <select value={val} onChange={(e) => { updateMaterial(row.id, col.key, e.target.value); commitMaterial(row.id, { [col.key]: e.target.value || null }); }}>
          <option value="">—</option>
          {col.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (col.type === 'select-uom') {
      // Fixed to the mother's UOM on a rework JO, for an item the mother uses.
      if (motherUoms.has(row.item_id)) {
        return <input value={motherUoms.get(row.item_id)} readOnly tabIndex={-1} title="A rework job order uses the mother JO's UOM" />;
      }
      const options = row.item_id ? (uomsByItem[row.item_id] || []) : [];
      return (
        <select value={val} disabled={!row.item_id}
          onChange={(e) => { updateMaterial(row.id, 'uom', e.target.value); recalcAndCommitMaterial(row.id, { uom: e.target.value }); }}>
          {val && !options.some((u) => u.code === val) && <option value={val}>{val}</option>}
          <option value="">—</option>
          {options.map((u) => <option key={u.id} value={u.code}>{u.code}</option>)}
        </select>
      );
    }
    if (col.readOnly) {
      return <input value={val} readOnly tabIndex={-1} />;
    }
    const isPricingInput = col.key === 'qty' || col.key === 'length' || col.key === 'width';
    return (
      <input
        type={col.type === 'number' ? 'number' : 'text'}
        value={val}
        onChange={(e) => updateMaterial(row.id, col.key, e.target.value)}
        onBlur={() => (isPricingInput ? recalcAndCommitMaterial(row.id) : commitMaterial(row.id))}
      />
    );
  }

  if (loading || !jo || !form) return <LoadingSpinner />;

  const days = forecastDays(form.planned_start_date, form.planned_end_date);
  const forecastLabel = days ? `${days} day${days === 1 ? '' : 's'}` : '';

  return (
    <div>
      <div className="page-header">
        <h1>Job Order — {jo.job_order_no}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={backTo}>Cancel</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Customer</label><input readOnly value={jo.customer_name || ''} /></div>
          <div className="field"><label>Job Location</label>
            <EntityPicker
              label="Job Location" items={locations} value={form.job_location_id} getLabel={(l) => l.location_name}
              columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
              searchKeys={['location_name', 'location_code']}
              onSelect={(l) => setForm({ ...form, job_location_id: l.id })}
            />
          </div>
          <div className="field"><label>Shipping Address</label><input value={form.shipping_address} onChange={(e) => setForm({ ...form, shipping_address: e.target.value })} /></div>

          <div className="field"><label>Contact Person</label><input readOnly value={jo.contact_name || ''} /></div>
          <div className="field"><label>Job Type</label><input readOnly value={jo.job_type_name || ''} /></div>
          <div className="field"><label>Delivery Date</label><input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} /></div>

          <div className="field"><label>Contact Email</label><input value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} /></div>
          <div className="field"><label>Job Desc.</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="field"><label>Delivery Time</label><input type="time" value={form.delivery_time} onChange={(e) => setForm({ ...form, delivery_time: e.target.value })} /></div>

          <div className="field"><label>Contact Title</label><input value={form.contact_title} onChange={(e) => setForm({ ...form, contact_title: e.target.value })} /></div>
          <div className="field">
            <label>Quantity / Length / Width / Height</label>
            <input readOnly value={`${jo.quantity ?? 0} ${jo.units || ''}  L:${jo.length ?? 0} W:${jo.width ?? 0} H:${jo.height ?? ''}`} />
          </div>
          <div className="field"><label>Sales Rep.</label>
            <EntityPicker
              label="Sales Rep" items={employees} value={form.sales_rep_id} getLabel={employeeLabel}
              columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
              searchKeys={['first_name', 'last_name']}
              onSelect={(e) => setForm({ ...form, sales_rep_id: e.id })}
            />
          </div>

          <div className="field"><label>Contact Phone</label><input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} /></div>
          <div className="field"><label>Artist</label>
            <EntityPicker
              label="Artist" items={artists} value={form.artist_id} getLabel={employeeLabel}
              columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
              searchKeys={['first_name', 'last_name']}
              onSelect={(e) => setForm({ ...form, artist_id: e.id })}
              disabled={!canAssignArtist}
            />
            {!canAssignArtist && <small className="muted">You do not have permission to assign an artist.</small>}
          </div>
          <div className="field"><label>Sales Division</label><input readOnly value={jo.sales_division_name || ''} /></div>

          <div />
          <div className="field"><label>Memo</label><input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} /></div>
          <div className="field"><label>Office Location</label><input readOnly value={jo.office_location_name || ''} /></div>

          <div className="field"><label>Planned Start</label><input type="date" value={form.planned_start_date} onChange={(e) => setForm({ ...form, planned_start_date: e.target.value })} /></div>
          <div className="field"><label>Planned End</label><input type="date" value={form.planned_end_date} onChange={(e) => setForm({ ...form, planned_end_date: e.target.value })} /></div>
          <div className="field"><label>Forecast</label><input readOnly tabIndex={-1} value={forecastLabel} /></div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'materials' ? 'active' : ''}`} onClick={() => setTab('materials')}>Materials</button>
        {/* RWIP / RFQC / NSSO RMA: the Cause of Error (Reason Code / Reason) and Action/s to be taken,
            saved by the tab's own Save -- a System Admin's, as on the view screens. */}
        {isRmaJobOrder(jo) && <button className={`status-tab ${tab === 'rma' ? 'active' : ''}`} onClick={() => setTab('rma')}>RMA Additional Details</button>}
        <button className={`status-tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>Logs</button>
      </div>

      {tab === 'rma' && isRmaJobOrder(jo) && <RmaDetailsTab jobOrderId={jo.id} />}

      {tab === 'materials' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th>{PROCESS_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}<th></th></tr></thead>
              <tbody>
                {processes.length === 0 && (
                  <tr><td colSpan={PROCESS_COLUMNS.length + 2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials.</td></tr>
                )}
                {processes.map((p, idx) => (
                  <tr key={p.id}>
                    <td>{idx + 1}</td>
                    {PROCESS_COLUMNS.map((c) => <td key={c.key}>{materialCell(c, p)}</td>)}
                    <td><button className="btn btn-sm btn-danger" onClick={() => deleteMaterial(p.id)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={addMaterial}>Add Material</button>
        </div>
      )}

      {tab === 'logs' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => displayDateTime(r.set_at) },
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
