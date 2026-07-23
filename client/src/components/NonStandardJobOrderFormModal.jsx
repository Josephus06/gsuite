import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import Modal from './Modal';
import { computeProcessCosting, selectBracket } from '../utils/costing';

// The one Non-Standard Job Order form, shared by "Add New" on the list and the rework a
// Sales user does after an approver bounces the order back (Sub Status "Sales Revision").
// Shared rather than duplicated so the two can't drift apart -- the pricing cascade, the
// SITE INSPECTION relabelling and the materials grid all have to behave identically
// whether the order is being raised or revised.
const ROUTE = '/non-standard-job-orders';

// Job types are master data (job_types.jo_type = 'Non Standard JO') served by /meta --
// they are not a hardcoded list. Only SITE INSPECTION alters the form, so it is the one
// value the UI needs to name: it relabels the PMS Job Type and address fields below.
const SITE_INSPECTION = 'SITE INSPECTION';
// The artist earns 5% of a line's Process Price. Kept in sync with ARTIST_INCENTIVE_RATE
// in server/src/routes/nonStandardJobOrders.js, which recomputes it on save.
const ARTIST_INCENTIVE_RATE = 0.05;

const today = () => new Date().toISOString().slice(0, 10);
// Mirrors the Materials grid column order on the form. process_qty/process_price belong
// to the process; qty/uom/total/unit belong to the item it consumes.
const emptyMaterial = () => ({
  process_id: '', process_qty: '', item_id: '', length: '', width: '', qty: '',
  uom: '', total: '', unit: '', process_price: '', artist_incentive: '',
  artist_remarks: '', sales_remarks: '',
});

const emptyForm = (defaults = {}) => ({
  customer_id: '', contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '',
  memo: '', date_created: today(),
  job_location_id: defaults.location_id || '',
  job_type_id: '', pms_job_type_id: '', description: '', quantity: '',
  shipping_address: '', delivery_date: today(), delivery_time: '',
  sales_rep_id: defaults.employee_id || '',
  sales_division_id: defaults.sales_division_id || '',
  materials: [],
});

// Seeds the form from a saved order so a revision starts from what is on the record.
const formFromOrder = (order) => ({
  customer_id: order.customer_id || '',
  contact_person_id: order.contact_person_id || '',
  contact_email: order.contact_email || '',
  contact_title: order.contact_title || '',
  contact_phone: order.contact_phone || '',
  memo: order.memo || '',
  date_created: order.date_created ? String(order.date_created).slice(0, 10) : today(),
  job_location_id: order.job_location_id || '',
  job_type_id: order.job_type_id || '',
  pms_job_type_id: order.pms_job_type_id || '',
  description: order.description || '',
  quantity: order.quantity ?? '',
  shipping_address: order.shipping_address || '',
  delivery_date: order.delivery_date ? String(order.delivery_date).slice(0, 10) : today(),
  delivery_time: order.delivery_time || '',
  sales_rep_id: order.sales_rep_id || '',
  sales_division_id: order.sales_division_id || '',
  materials: (order.materials || []).map((m) => ({
    process_id: m.process_id || '', process_qty: m.process_qty ?? '', item_id: m.item_id || '',
    length: m.length ?? '', width: m.width ?? '', qty: m.qty ?? '', uom: m.uom || '',
    total: m.total ?? '', unit: m.unit || '', process_price: m.process_price ?? '',
    artist_incentive: m.artist_incentive ?? '', artist_remarks: m.artist_remarks || '',
    sales_remarks: m.sales_remarks || '',
  })),
});

function fieldError(errors, name) {
  return errors[name] && <div className="error" style={{ marginTop: 4 }}>{errors[name]}</div>;
}

// Process Price is the Process Costing rate for the bracket the quantity falls into,
// extended by that quantity -- the same basis an Estimate line uses (see
// utils/costing.js), so both modules price a process identically. Falls back to the
// material Qty when Process Qty is blank, matching computeAutoPricing.
function processPriceFor(brackets, material) {
  const quantity = Number(material.process_qty) || Number(material.qty) || 0;
  if (!brackets?.length || !quantity) return '';
  const costing = computeProcessCosting(selectBracket(brackets, quantity));
  return costing ? Number((costing.pricePerUnit * quantity).toFixed(2)) : '';
}

export default function NonStandardJobOrderFormModal({ mode = 'create', order, onClose, onSaved }) {
  const isEdit = mode === 'edit';
  const [meta, setMeta] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [form, setForm] = useState(() => (isEdit && order ? formFromOrder(order) : emptyForm()));
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [bracketsByProcess, setBracketsByProcess] = useState({});

  useEffect(() => { api.get(`${ROUTE}/meta`).then(({ data }) => setMeta(data)); }, []);

  // A new order inherits the raiser's own branch defaults; a revision keeps whatever the
  // order was saved with.
  useEffect(() => {
    if (isEdit || !meta?.defaults) return;
    setForm((current) => ({
      ...current,
      job_location_id: current.job_location_id || meta.defaults.location_id || '',
      sales_rep_id: current.sales_rep_id || meta.defaults.employee_id || '',
      sales_division_id: current.sales_division_id || meta.defaults.sales_division_id || '',
    }));
  }, [meta, isEdit]);

  // Contact Person is scoped to the chosen customer, so its list is fetched per customer
  // rather than shipped whole in /meta.
  useEffect(() => {
    if (!form.customer_id) { setContacts([]); return; }
    let stale = false;
    api.get(`${ROUTE}/contacts`, { params: { customer_id: form.customer_id } })
      .then(({ data }) => { if (!stale) setContacts(data.contacts); });
    return () => { stale = true; };
  }, [form.customer_id]);

  // Re-derives Process Price whenever a line's process or either quantity changes. Keyed
  // on just those inputs so writing the computed price back cannot retrigger the effect.
  const pricingKey = form.materials.map((m) => `${m.process_id}:${m.process_qty}:${m.qty}`).join('|');
  useEffect(() => {
    let stale = false;
    (async () => {
      const processIds = [...new Set(form.materials.map((m) => m.process_id).filter(Boolean))];
      const fetched = {};
      for (const processId of processIds) {
        if (bracketsByProcess[processId]) continue;
        const { data } = await api.get(`${ROUTE}/cost-brackets/${processId}`);
        fetched[processId] = data;
      }
      if (stale) return;
      const brackets = { ...bracketsByProcess, ...fetched };
      if (Object.keys(fetched).length) setBracketsByProcess(brackets);
      setForm((current) => ({
        ...current,
        materials: current.materials.map((material) => {
          const price = processPriceFor(brackets[material.process_id], material);
          const incentive = price === '' ? '' : Number((price * ARTIST_INCENTIVE_RATE).toFixed(2));
          if (String(material.process_price) === String(price)
            && String(material.artist_incentive) === String(incentive)) return material;
          return { ...material, process_price: price, artist_incentive: incentive };
        }),
      }));
    })();
    return () => { stale = true; };
  }, [pricingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function setField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: '' }));
  }

  function selectCustomer(customer) {
    // Changing customer invalidates the contact person and everything derived from it.
    setForm((current) => ({
      ...current, customer_id: customer.id, contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '',
    }));
    setErrors((current) => ({ ...current, customer_id: '', contact_person_id: '' }));
  }

  function selectContact(contact) {
    setForm((current) => ({
      ...current,
      contact_person_id: contact.id,
      contact_email: contact.email || '',
      contact_title: contact.title || '',
      contact_phone: contact.phone || '',
    }));
    setErrors((current) => ({ ...current, contact_person_id: '' }));
  }

  function selectJobType(jobType) {
    // The PMS Job Type list is filtered by job type, so a previous pick can no longer apply.
    setForm((current) => ({ ...current, job_type_id: jobType.id, pms_job_type_id: '' }));
    setErrors((current) => ({ ...current, job_type_id: '' }));
  }

  function setMaterial(index, name, value) {
    setForm((current) => ({
      ...current,
      materials: current.materials.map((material, i) => (i === index ? { ...material, [name]: value } : material)),
    }));
  }

  const addMaterial = () => setForm((c) => ({ ...c, materials: [...c.materials, emptyMaterial()] }));
  const removeMaterial = (index) => setForm((c) => ({ ...c, materials: c.materials.filter((_, i) => i !== index) }));

  function validate() {
    const next = {};
    if (!form.customer_id) next.customer_id = 'Customer is required.';
    if (!form.contact_person_id) next.contact_person_id = 'Contact person is required.';
    if (!form.job_location_id) next.job_location_id = 'Job location is required.';
    if (!form.job_type_id) next.job_type_id = 'Job type is required.';
    if (!form.description.trim()) next.description = 'Job description is required.';
    if (!form.quantity || Number(form.quantity) <= 0) next.quantity = 'Enter a quantity greater than zero.';
    if (!form.delivery_date) next.delivery_date = 'Delivery date is required.';
    if (!form.sales_rep_id) next.sales_rep_id = 'Your user account must be linked to an employee.';
    if (!form.sales_division_id) next.sales_division_id = 'Your default User Branch must have a department.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(event, forward) {
    event.preventDefault();
    setSaveError('');
    if (!validate()) return;
    setSaving(true);
    try {
      if (isEdit) {
        // Saving a revision sends the order back round to SBU Approval -- the server
        // clears the previous approval so the changes get signed off, not the old version.
        await api.put(`${ROUTE}/${order.id}`, form);
      } else {
        const { data } = await api.post(ROUTE, form);
        if (forward) await api.post(`${ROUTE}/${data.id}/forward`);
      }
      await onSaved?.();
      onClose();
    } catch (error) {
      setSaveError(error.response?.data?.error || 'Could not save this non-standard job order.');
    } finally {
      setSaving(false);
    }
  }

  const divisions = meta?.divisions || [];
  const jobTypes = meta?.jobTypes || [];
  const currentDivision = divisions.find((division) => String(division.id) === String(form.sales_division_id));
  const currentLocation = (meta?.locations || []).find((location) => String(location.id) === String(form.job_location_id));
  const currentSalesRep = (meta?.employees || []).find((employee) => String(employee.id) === String(form.sales_rep_id));
  const currentJobType = jobTypes.find((jobType) => String(jobType.id) === String(form.job_type_id));
  const isSiteInspection = currentJobType?.display_name === SITE_INSPECTION;

  // Cascade: only the PMS job types belonging to the selected job type are offered,
  // and the field stays disabled until a job type is chosen.
  const pmsJobTypes = useMemo(
    () => (meta?.pmsJobTypes || []).filter((jobType) => String(jobType.job_type_id) === String(form.job_type_id)),
    [meta, form.job_type_id],
  );

  return (
    <Modal title={isEdit ? `Revise ${order.nstdjo_no}` : 'Non-Standard Job Order'} onClose={() => !saving && onClose()} xl>
      <form onSubmit={(event) => submit(event, false)}>
        {saveError && <div className="error-banner">{saveError}</div>}
        {isEdit && <div className="muted" style={{ marginBottom: 12 }}>Saving these changes sends this job order back to SBU Approval.</div>}
        <div className="filter-grid">
          <div className="field"><label>Customer *</label><EntityPicker label="Select Customer" items={meta?.customers || []} value={form.customer_id} getLabel={(customer) => customer.name} columns={[{ key: 'name', label: 'Customer' }]} searchKeys={['name']} onSelect={selectCustomer} placeholder="Select customer" />{fieldError(errors, 'customer_id')}</div>
          <div className="field"><label>Contact Person *</label><EntityPicker label="Select Contact Person" items={contacts} value={form.contact_person_id} getLabel={(contact) => contact.contact_name} columns={[{ key: 'contact_name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Contact Nos' }, { key: 'title', label: 'Title' }]} searchKeys={['contact_name', 'email', 'title']} onSelect={selectContact} disabled={!form.customer_id} placeholder={form.customer_id ? 'Select contact person' : 'Select a customer first'} />{fieldError(errors, 'contact_person_id')}</div>
          <div className="field"><label>Contact Email</label><input type="email" value={form.contact_email} onChange={(event) => setField('contact_email', event.target.value)} /></div>
          <div className="field"><label>Contact Title</label><input value={form.contact_title} onChange={(event) => setField('contact_title', event.target.value)} /></div>
          <div className="field"><label>Contact Phone</label><input value={form.contact_phone} onChange={(event) => setField('contact_phone', event.target.value)} /></div>
          <div className="field"><label>Job Location *</label><input readOnly value={currentLocation?.location_name || ''} placeholder="Set a default location on your User Branch" />{fieldError(errors, 'job_location_id')}</div>
          <div className="field"><label>Job Type *</label><EntityPicker label="Search Jobs" items={jobTypes} value={form.job_type_id} getLabel={(jobType) => jobType.display_name} columns={[{ key: 'display_name', label: 'Display Name' }, { key: 'base_unit', label: 'Base Unit' }]} searchKeys={['display_name']} onSelect={selectJobType} placeholder="Select job type" />{fieldError(errors, 'job_type_id')}</div>
          <div className="field"><label>{isSiteInspection ? 'Site Inspection - Job Type' : 'PMS Job Type'}</label><EntityPicker label="Search Job Types" items={pmsJobTypes} value={form.pms_job_type_id} getLabel={(jobType) => `${jobType.code ? `${jobType.code} — ` : ''}${jobType.display_name}`} columns={[{ key: 'code', label: 'Code' }, { key: 'display_name', label: 'Display Name' }, { key: 'minutes_consume', label: 'Hours Consume' }]} searchKeys={['code', 'display_name']} onSelect={(jobType) => setField('pms_job_type_id', jobType.id)} disabled={!form.job_type_id} placeholder={form.job_type_id ? 'Select job type detail' : 'Select a job type first'} /></div>
          <div className="field"><label>Sales Rep</label><input readOnly value={currentSalesRep ? `${currentSalesRep.first_name} ${currentSalesRep.last_name}` : ''} placeholder="Link your user account to an employee" />{fieldError(errors, 'sales_rep_id')}</div>
          <div className="field"><label>Sales Division</label><input readOnly value={currentDivision?.name || ''} placeholder="Set a department on your default User Branch" />{fieldError(errors, 'sales_division_id')}</div>
          <div className="field"><label>Date Created</label><input type="date" value={form.date_created} onChange={(event) => setField('date_created', event.target.value)} /></div>
          <div className="field"><label>Delivery Date *</label><input type="date" value={form.delivery_date} onChange={(event) => setField('delivery_date', event.target.value)} />{fieldError(errors, 'delivery_date')}</div>
          <div className="field"><label>Delivery Time</label><input type="time" value={form.delivery_time} onChange={(event) => setField('delivery_time', event.target.value)} /></div>
          <div className="field"><label>Quantity *</label><input type="number" min="0.0001" step="0.0001" value={form.quantity} onChange={(event) => setField('quantity', event.target.value)} />{fieldError(errors, 'quantity')}</div>
          <div className="field"><label>Job Description *</label><input value={form.description} onChange={(event) => setField('description', event.target.value)} />{fieldError(errors, 'description')}</div>
        </div>
        <div className="field"><label>{isSiteInspection ? 'Site Address' : 'Optional Address'}</label><input value={form.shipping_address} onChange={(event) => setField('shipping_address', event.target.value)} /></div>
        <div className="field"><label>Memo</label><textarea value={form.memo} onChange={(event) => setField('memo', event.target.value)} /></div>

        <div className="field">
          <label>Materials</label>
          <div className="table-wrap">
            <table className="spreadsheet-table nstdjo-materials">
              <thead><tr><th>Process</th><th>Qty</th><th>Item</th><th>Length</th><th>Width</th><th>Qty</th><th>UOM</th><th>Total</th><th>Unit</th><th>Process Price</th><th>Artist Incentive</th><th>Artist Remarks</th><th>Sales Remarks</th><th /></tr></thead>
              <tbody>
                {form.materials.length === 0 && <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 12 }}>No materials added.</td></tr>}
                {form.materials.map((material, index) => <tr key={index}>
                  <td><EntityPicker label="Select Process" items={meta?.processes || []} value={material.process_id} getLabel={(process) => process.process_name} columns={[{ key: 'process_code', label: 'Code' }, { key: 'process_name', label: 'Process' }]} searchKeys={['process_code', 'process_name']} onSelect={(process) => setMaterial(index, 'process_id', process.id)} placeholder="Select process" /></td>
                  <td><input type="number" step="0.0001" value={material.process_qty} onChange={(event) => setMaterial(index, 'process_qty', event.target.value)} /></td>
                  <td><EntityPicker label="Select Item" items={meta?.items || []} value={material.item_id} getLabel={(item) => item.display_name} columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Item' }]} searchKeys={['item_code', 'display_name']} onSelect={(item) => setMaterial(index, 'item_id', item.id)} placeholder="Select item" /></td>
                  <td><input type="number" step="0.01" value={material.length} onChange={(event) => setMaterial(index, 'length', event.target.value)} /></td>
                  <td><input type="number" step="0.01" value={material.width} onChange={(event) => setMaterial(index, 'width', event.target.value)} /></td>
                  <td><input type="number" step="0.0001" value={material.qty} onChange={(event) => setMaterial(index, 'qty', event.target.value)} /></td>
                  <td><select value={material.uom} onChange={(event) => setMaterial(index, 'uom', event.target.value)}><option value="">--</option>{(meta?.uoms || []).map((uom) => <option key={uom.id} value={uom.code}>{uom.code}</option>)}</select></td>
                  <td><input type="number" step="0.0001" value={material.total} onChange={(event) => setMaterial(index, 'total', event.target.value)} /></td>
                  <td><input value={material.unit} onChange={(event) => setMaterial(index, 'unit', event.target.value)} /></td>
                  <td><input readOnly value={material.process_price} title="Auto-calculated: Process Costing rate for this quantity bracket x Qty" placeholder="—" /></td>
                  <td><input readOnly value={material.artist_incentive} title="Auto-calculated: 5% of Process Price" placeholder="—" /></td>
                  <td><input value={material.artist_remarks} onChange={(event) => setMaterial(index, 'artist_remarks', event.target.value)} /></td>
                  <td><input value={material.sales_remarks} onChange={(event) => setMaterial(index, 'sales_remarks', event.target.value)} /></td>
                  <td><button type="button" className="btn btn-sm" onClick={() => removeMaterial(index)}>Remove</button></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={addMaterial}>Add Material</button>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
          {!isEdit && <button type="button" className="btn" disabled={saving} onClick={(event) => submit(event, true)}>Forward To Design Supervisor</button>}
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save & Resubmit' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
