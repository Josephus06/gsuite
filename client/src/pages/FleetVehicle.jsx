import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { DUE_BADGE, vehicleName } from '../utils/fleet';

// One vehicle on Assets > Fleet (2026-10-19): its details (plate, registration, insurance, emission,
// PMS interval, driver, in-charge), the PMS / service log and the fuel log. routes/fleet.js.

const ROUTE = '/assets/fleet';
const money = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const km = (v) => (v == null || v === '' ? '' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })} km`);
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const DETAIL_GROUPS = [
  ['Vehicle', [['plate_no', 'Plate No'], ['conduction_sticker', 'Conduction Sticker'], ['make', 'Make'], ['model', 'Model'],
    ['year_model', 'Year Model', 'number'], ['color', 'Color'], ['fuel_type', 'Fuel Type', 'fuel'], ['engine_no', 'Engine No'], ['chassis_no', 'Chassis No']]],
  ['Registration & Insurance', [['or_no', 'OR No'], ['cr_no', 'CR No'], ['registration_date', 'Registration Date', 'date'],
    ['registration_expiry', 'Registration Expiry', 'date'], ['insurer', 'Insurer'], ['policy_no', 'Policy No'],
    ['insurance_expiry', 'Insurance Expiry', 'date'], ['emission_expiry', 'Emission Test Expiry', 'date']]],
  ['PMS & Odometer', [['pms_interval_km', 'PMS every (km)', 'number'], ['pms_interval_months', 'PMS every (months)', 'number'],
    ['odometer_km', 'Odometer (km)', 'number'], ['odometer_at', 'Odometer as of', 'date']]],
];
const ALL_FIELDS = [...DETAIL_GROUPS.flatMap(([, f]) => f.map(([k]) => k)), 'driver_employee_id', 'incharge_employee_id', 'remarks'];

function Badge({ d, label }) {
  const b = DUE_BADGE[d?.status || 'none'];
  return (
    <div className="item">
      <div className="label">{label}</div>
      <div className="value"><span className={`badge ${b.cls}`}>{d?.status === 'none' || !d ? 'Not set' : b.text}</span></div>
    </div>
  );
}

export default function FleetVehicle() {
  const { assetId } = useParams();
  const { can } = useAuth();
  const canEdit = can(ROUTE, 'can_edit');
  const canAdd = can(ROUTE, 'can_add');
  const canDelete = can(ROUTE, 'can_delete');
  const [v, setV] = useState(null);
  const [opts, setOpts] = useState({ employees: [], service_types: [] });
  const [tab, setTab] = useState('details');
  const [form, setForm] = useState({});
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const emptyService = () => ({ service_date: today(), service_type: 'PMS', odometer_km: '', work_done: '', shop: '', cost: '', reference_no: '', next_due_date: '', next_due_km: '' });
  const emptyFuel = () => ({ fuel_date: today(), odometer_km: '', liters: '', price_per_liter: '', amount: '', is_full_tank: true, station: '', driver_employee_id: '', receipt_no: '' });
  const [svc, setSvc] = useState(emptyService);
  const [fuel, setFuel] = useState(emptyFuel);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/fleet/${assetId}`);
      setV(data);
      setForm(Object.fromEntries(ALL_FIELDS.map((k) => [k, data[k] ?? ''])));
      if (data.is_new) setEditing(true);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the vehicle.'); }
  }, [assetId]);
  useEffect(() => { load(); api.get('/fleet/options').then(({ data }) => setOpts(data)).catch(() => {}); }, [load]);

  async function run(fn) {
    setBusy(true); setError('');
    try { await fn(); await load(); } catch (e) { setError(e.response?.data?.error || 'Could not save that.'); }
    setBusy(false);
  }
  const saveDetails = () => run(async () => { await api.put(`/fleet/${assetId}`, form); setEditing(false); });
  const addService = () => run(async () => { await api.post(`/fleet/${assetId}/service`, svc); setSvc(emptyService()); });
  const addFuel = () => run(async () => { await api.post(`/fleet/${assetId}/fuel`, fuel); setFuel(emptyFuel()); });
  const delService = (id) => confirm('Delete this service entry?') && run(() => api.delete(`/fleet/${assetId}/service/${id}`));
  const delFuel = (id) => confirm('Delete this fuel entry?') && run(() => api.delete(`/fleet/${assetId}/fuel/${id}`));

  if (!v) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const empName = (id) => opts.employees.find((e) => String(e.id) === String(id))?.name || '';
  const field = ([k, label, type]) => (
    <div className="field" key={k}>
      <label>{label}</label>
      {editing ? (
        type === 'fuel' ? (
          <select value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
            <option value="">—</option>{['Gasoline', 'Diesel', 'Electric', 'Hybrid'].map((f) => <option key={f}>{f}</option>)}
          </select>
        ) : <input type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'} step="any" value={form[k] ?? ''}
          onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
      ) : <div style={{ padding: '8px 0', fontWeight: 500 }}>{v[k] ?? '' ? String(v[k]) : <span className="muted">—</span>}</div>}
    </div>
  );
  const employeePicker = (k, label) => (
    <div className="field">
      <label>{label}</label>
      {editing ? (
        <select value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
          <option value="">—</option>
          {opts.employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.department ? ` (${e.department})` : ''}</option>)}
        </select>
      ) : <div style={{ padding: '8px 0', fontWeight: 500 }}>{empName(v[k]) || v[k === 'driver_employee_id' ? 'driver_name' : 'incharge_name'] || <span className="muted">—</span>}</div>}
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <h1>{v.plate_no || '(no plate)'} <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>{vehicleName(v)}</span></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/assets/fleet">Back to Fleet</Link>
          <Link className="btn btn-sm" to={`/assets/${assetId}`}>Asset {v.reference_no}</Link>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {v.due && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="review-grid">
            <div className="item"><div className="label">Odometer</div><div className="value">{km(v.current_odometer_km) || '—'}</div></div>
            <div className="item"><div className="label">Last PMS</div><div className="value">{v.last_pms_date || '—'}{v.last_pms_km != null ? ` · ${km(v.last_pms_km)}` : ''}</div></div>
            <div className="item"><div className="label">Next PMS</div><div className="value">{[v.next_pms_date, v.next_pms_km != null ? km(v.next_pms_km) : null].filter(Boolean).join(' or ') || '—'}</div></div>
            <Badge d={v.due.pms} label="PMS" />
            <Badge d={v.due.registration} label={`Registration${v.registration_expiry ? ` · ${v.registration_expiry}` : ''}`} />
            <Badge d={v.due.insurance} label={`Insurance${v.insurance_expiry ? ` · ${v.insurance_expiry}` : ''}`} />
            <Badge d={v.due.emission} label={`Emission${v.emission_expiry ? ` · ${v.emission_expiry}` : ''}`} />
          </div>
          <div className="muted">Custodian: {v.custodian_name || '—'} · In-charge: {v.incharge_name || '—'} · Reminders go to the General Manager, the custodian and the in-charge.</div>
        </div>
      )}

      <div className="status-tabs">
        {[['details', 'Details'], ['service', `PMS & Service (${v.service_logs.length})`], ['fuel', `Fuel (${v.fuel_logs.length})`]].map(([k, l]) => (
          <button key={k} className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)} disabled={v.is_new && k !== 'details'}>{l}</button>
        ))}
      </div>

      {tab === 'details' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
            {canEdit && !editing && <button className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>Edit</button>}
            {editing && (
              <>
                {!v.is_new && <button className="btn btn-sm" disabled={busy} onClick={() => { setEditing(false); load(); }}>Cancel</button>}
                <button className="btn btn-sm btn-primary" disabled={busy || !canEdit} onClick={saveDetails}>{busy ? 'Saving...' : 'Save'}</button>
              </>
            )}
          </div>
          {v.is_new && <div className="warning-banner">This asset is not set up as a vehicle yet -- fill in its details and save.</div>}
          {DETAIL_GROUPS.map(([title, fields]) => (
            <div key={title} style={{ marginBottom: 12 }}>
              <h4 style={{ margin: '8px 0' }}>{title}</h4>
              <div className="filter-grid">{fields.map(field)}</div>
            </div>
          ))}
          <h4 style={{ margin: '8px 0' }}>People</h4>
          <div className="filter-grid">
            {employeePicker('driver_employee_id', 'Assigned Driver')}
            {employeePicker('incharge_employee_id', 'In-charge (Technical Department)')}
          </div>
          <div className="field">
            <label>Remarks</label>
            {editing ? <textarea rows={2} value={form.remarks ?? ''} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
              : <div style={{ padding: '8px 0' }}>{v.remarks || <span className="muted">—</span>}</div>}
          </div>
        </div>
      )}

      {tab === 'service' && (
        <div className="card">
          {canAdd && (
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ marginTop: 0 }}>Add a service</h4>
              <div className="filter-grid">
                <div className="field"><label>Date</label><input type="date" value={svc.service_date} onChange={(e) => setSvc({ ...svc, service_date: e.target.value })} /></div>
                <div className="field"><label>Type</label>
                  <select value={svc.service_type} onChange={(e) => setSvc({ ...svc, service_type: e.target.value })}>
                    {opts.service_types.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="field"><label>Odometer (km)</label><input type="number" step="any" value={svc.odometer_km} onChange={(e) => setSvc({ ...svc, odometer_km: e.target.value })} /></div>
                <div className="field"><label>Shop</label><input value={svc.shop} onChange={(e) => setSvc({ ...svc, shop: e.target.value })} /></div>
                <div className="field"><label>Cost</label><input type="number" step="0.01" value={svc.cost} onChange={(e) => setSvc({ ...svc, cost: e.target.value })} /></div>
                <div className="field"><label>OR / Invoice No</label><input value={svc.reference_no} onChange={(e) => setSvc({ ...svc, reference_no: e.target.value })} /></div>
                {svc.service_type === 'PMS' && (
                  <>
                    <div className="field"><label>Next PMS date</label><input type="date" value={svc.next_due_date} onChange={(e) => setSvc({ ...svc, next_due_date: e.target.value })} title="Leave blank to use the vehicle's PMS interval" /></div>
                    <div className="field"><label>Next PMS at (km)</label><input type="number" step="any" value={svc.next_due_km} onChange={(e) => setSvc({ ...svc, next_due_km: e.target.value })} title="Leave blank to use the vehicle's PMS interval" /></div>
                  </>
                )}
              </div>
              <div className="field"><label>Work done</label><textarea rows={2} value={svc.work_done} onChange={(e) => setSvc({ ...svc, work_done: e.target.value })} /></div>
              <button className="btn btn-primary" disabled={busy} onClick={addService}>Add</button>
              {svc.service_type === 'PMS' && <span className="muted" style={{ marginLeft: 8 }}>Next PMS left blank: worked out from the vehicle&apos;s PMS interval.</span>}
            </div>
          )}
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Date</th><th>Type</th><th style={{ textAlign: 'right' }}>Odometer</th><th>Work Done</th><th>Shop</th><th style={{ textAlign: 'right' }}>Cost</th><th>Ref</th><th>Next Due</th><th>By</th><th /></tr></thead>
              <tbody>
                {v.service_logs.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 16 }}>No service recorded yet.</td></tr>}
                {v.service_logs.map((l) => (
                  <tr key={l.id}>
                    <td data-label="Date">{l.service_date}</td>
                    <td data-label="Type">{l.service_type}</td>
                    <td data-label="Odometer" style={{ textAlign: 'right' }}>{km(l.odometer_km)}</td>
                    <td data-label="Work Done">{l.work_done}</td>
                    <td data-label="Shop">{l.shop}</td>
                    <td data-label="Cost" style={{ textAlign: 'right' }}>{money(l.cost)}</td>
                    <td data-label="Ref">{l.reference_no}</td>
                    <td data-label="Next Due">{[l.next_due_date, l.next_due_km != null ? km(l.next_due_km) : null].filter(Boolean).join(' / ')}</td>
                    <td data-label="By">{l.created_by_name}</td>
                    <td>{canDelete && <button className="btn btn-sm btn-danger" onClick={() => delService(l.id)}>✕</button>}</td>
                  </tr>
                ))}
              </tbody>
              {v.service_logs.length > 0 && <tfoot><tr><td colSpan={5} style={{ fontWeight: 700 }}>Total recorded cost</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{money(v.service_total)}</td><td colSpan={4} /></tr></tfoot>}
            </table>
          </div>
        </div>
      )}

      {tab === 'fuel' && (
        <div className="card">
          {canAdd && (
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ marginTop: 0 }}>Add a fill-up</h4>
              <div className="filter-grid">
                <div className="field"><label>Date</label><input type="date" value={fuel.fuel_date} onChange={(e) => setFuel({ ...fuel, fuel_date: e.target.value })} /></div>
                <div className="field"><label>Odometer (km)</label><input type="number" step="any" value={fuel.odometer_km} onChange={(e) => setFuel({ ...fuel, odometer_km: e.target.value })} /></div>
                <div className="field"><label>Litres</label><input type="number" step="0.001" value={fuel.liters} onChange={(e) => setFuel({ ...fuel, liters: e.target.value })} /></div>
                <div className="field"><label>Price / litre</label><input type="number" step="0.01" value={fuel.price_per_liter} onChange={(e) => setFuel({ ...fuel, price_per_liter: e.target.value })} /></div>
                <div className="field"><label>Amount</label><input type="number" step="0.01" value={fuel.amount} placeholder={fuel.liters && fuel.price_per_liter ? money(Number(fuel.liters) * Number(fuel.price_per_liter)) : ''} onChange={(e) => setFuel({ ...fuel, amount: e.target.value })} /></div>
                <div className="field"><label>Station</label><input value={fuel.station} onChange={(e) => setFuel({ ...fuel, station: e.target.value })} /></div>
                <div className="field"><label>Driver</label>
                  <select value={fuel.driver_employee_id} onChange={(e) => setFuel({ ...fuel, driver_employee_id: e.target.value })}>
                    <option value="">—</option>{opts.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
                <div className="field"><label>Receipt No</label><input value={fuel.receipt_no} onChange={(e) => setFuel({ ...fuel, receipt_no: e.target.value })} /></div>
                <div className="field" style={{ alignSelf: 'end' }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                    <input type="checkbox" checked={fuel.is_full_tank} onChange={(e) => setFuel({ ...fuel, is_full_tank: e.target.checked })} /> Full tank
                  </label>
                </div>
              </div>
              <button className="btn btn-primary" disabled={busy} onClick={addFuel}>Add</button>
              <span className="muted" style={{ marginLeft: 8 }}>Km per litre is worked out between full-tank fill-ups that have odometer readings.</span>
            </div>
          )}
          <div className="review-grid">
            <div className="item"><div className="label">Total litres</div><div className="value">{Number(v.fuel_summary?.liters || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</div></div>
            <div className="item"><div className="label">Total spent</div><div className="value">{money(v.fuel_summary?.amount || 0)}</div></div>
            <div className="item"><div className="label">Average km / litre</div><div className="value">{v.fuel_summary?.avg_km_per_liter ?? '—'}</div></div>
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Date</th><th style={{ textAlign: 'right' }}>Odometer</th><th style={{ textAlign: 'right' }}>Litres</th><th style={{ textAlign: 'right' }}>Price/L</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Km/L</th><th>Station</th><th>Driver</th><th>Receipt</th><th /></tr></thead>
              <tbody>
                {v.fuel_logs.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 16 }}>No fill-ups recorded yet.</td></tr>}
                {v.fuel_logs.map((f) => (
                  <tr key={f.id}>
                    <td data-label="Date">{f.fuel_date}{!f.is_full_tank && <span className="muted"> (partial)</span>}</td>
                    <td data-label="Odometer" style={{ textAlign: 'right' }}>{km(f.odometer_km)}</td>
                    <td data-label="Litres" style={{ textAlign: 'right' }}>{Number(f.liters).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                    <td data-label="Price/L" style={{ textAlign: 'right' }}>{money(f.price_per_liter)}</td>
                    <td data-label="Amount" style={{ textAlign: 'right' }}>{money(f.amount)}</td>
                    <td data-label="Km/L" style={{ textAlign: 'right' }}>{f.km_per_liter ?? ''}</td>
                    <td data-label="Station">{f.station}</td>
                    <td data-label="Driver">{f.driver_name}</td>
                    <td data-label="Receipt">{f.receipt_no}</td>
                    <td>{canDelete && <button className="btn btn-sm btn-danger" onClick={() => delFuel(f.id)}>✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
