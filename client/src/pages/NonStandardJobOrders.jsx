import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';

const JOB_TYPES = [
  'CUTTING LIST',
  'DPOD-FILE PREPARATION LAYOUT',
  'LED PRODUCT DEMO',
  'SITE INSPECTION',
];

// These are intentionally local to NSTDJO. They are not ERP Job Types and should not
// be looked up from the generic Job Types master list.
const SITE_INSPECTION_SUBTYPES = [
  'INITIAL SITE INSPECTION',
  'FINAL SITE INSPECTION',
];
const JOB_TYPE_OPTIONS = JOB_TYPES.map((name) => ({ id: name, name }));

const today = () => new Date().toISOString().slice(0, 10);
const emptyForm = (defaults = {}) => ({
  customer_id: '',
  contact_email: '',
  contact_title: '',
  contact_phone: '',
  memo: '',
  date_created: today(),
  job_location_id: defaults.location_id || '',
  job_type: '',
  site_inspection_subtype: '',
  pms_job_type_id: '',
  description: '',
  quantity: '',
  shipping_address: '',
  delivery_date: today(),
  delivery_time: '',
  sales_rep_id: defaults.employee_id || '',
  sales_division_id: defaults.sales_division_id || '',
});

function fieldError(errors, name) {
  return errors[name] && <div className="error" style={{ marginTop: 4 }}>{errors[name]}</div>;
}

export default function NonStandardJobOrders() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    const { data } = await api.get('/non-standard-job-orders', { params: { page, limit: 10, search } });
    setRows(data.rows);
    setTotal(data.total);
  }

  useEffect(() => { load(); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get('/non-standard-job-orders/meta').then(({ data }) => setMeta(data)); }, []);
  useEffect(() => {
    if (!open || !meta?.defaults) return;
    setForm((current) => ({
      ...current,
      job_location_id: current.job_location_id || meta.defaults.location_id || '',
      sales_rep_id: current.sales_rep_id || meta.defaults.employee_id || '',
      sales_division_id: current.sales_division_id || meta.defaults.sales_division_id || '',
    }));
  }, [open, meta]);

  function setField(name, value) {
    setForm((current) => ({
      ...current,
      [name]: value,
      ...(name === 'job_type' && value !== 'SITE INSPECTION' ? { site_inspection_subtype: '' } : {}),
    }));
    setErrors((current) => ({ ...current, [name]: '' }));
  }

  function validate() {
    const next = {};
    if (!form.customer_id) next.customer_id = 'Customer is required.';
    if (!form.job_location_id) next.job_location_id = 'Job location is required.';
    if (!form.job_type) next.job_type = 'Job type is required.';
    if (form.job_type === 'SITE INSPECTION' && !form.site_inspection_subtype) next.site_inspection_subtype = 'Choose a site inspection subtype.';
    if (!form.description.trim()) next.description = 'Job description is required.';
    if (!form.quantity || Number(form.quantity) <= 0) next.quantity = 'Enter a quantity greater than zero.';
    if (!form.delivery_date) next.delivery_date = 'Delivery date is required.';
    if (!form.sales_rep_id) next.sales_rep_id = 'Your user account must be linked to an employee.';
    if (!form.sales_division_id) next.sales_division_id = 'Your default User Branch must have a department.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function openNew() {
    setForm(emptyForm(meta?.defaults));
    setErrors({});
    setSaveError('');
    setOpen(true);
  }

  async function save(event) {
    event.preventDefault();
    setSaveError('');
    if (!validate()) return;
    setSaving(true);
    try {
      await api.post('/non-standard-job-orders', form);
      setOpen(false);
      await load();
    } catch (error) {
      setSaveError(error.response?.data?.error || 'Could not save this non-standard job order.');
    } finally {
      setSaving(false);
    }
  }

  const divisions = meta?.divisions || [];
  const currentDivision = divisions.find((division) => String(division.id) === String(form.sales_division_id));
  const currentLocation = (meta?.locations || []).find((location) => String(location.id) === String(form.job_location_id));
  const currentSalesRep = (meta?.employees || []).find((employee) => String(employee.id) === String(form.sales_rep_id));

  return (
    <div>
      <div className="page-header">
        <h1>Saved Non-Standard Job Orders</h1>
        <div>
          <button className="btn btn-sm" onClick={() => { setPage(1); load(); }}>Search</button>{' '}
          <button className="btn btn-primary" onClick={openNew}>Add New</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field">
          <label>General Searching</label>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="JO #, customer, or job description" />
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>JO #</th><th>Date Created</th><th>Sales Division</th><th>Job Type</th><th>PMS Job Type</th><th>Job Desc</th><th>Qty</th><th>Customer</th><th>Sales Rep</th><th>Delivery Date</th><th>Status</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No non-standard job orders found.</td></tr>}
              {rows.map((row) => <tr key={row.id}>
                <td>{row.nstdjo_no}</td><td>{String(row.date_created).slice(0, 10)}</td><td>{row.sales_division_name}</td>
                <td>{row.job_type}{row.site_inspection_subtype ? ` — ${row.site_inspection_subtype}` : ''}</td>
                <td>{row.pms_job_type_name || ''}</td><td>{row.description}</td><td>{row.quantity}</td><td>{row.customer_name}</td>
                <td>{row.sales_rep_name}</td><td>{String(row.delivery_date).slice(0, 10)}</td><td>{row.status}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / 10))} onChange={setPage} />
      </div>

      {open && <Modal title="Non-Standard Job Order" onClose={() => !saving && setOpen(false)} large>
        <form onSubmit={save}>
          {saveError && <div className="error-banner">{saveError}</div>}
          <div className="filter-grid">
            <div className="field"><label>Customer *</label><EntityPicker label="Select Customer" items={meta?.customers || []} value={form.customer_id} getLabel={(customer) => customer.name} columns={[{ key: 'name', label: 'Customer' }]} searchKeys={['name']} onSelect={(customer) => setField('customer_id', customer.id)} placeholder="Select customer" />{fieldError(errors, 'customer_id')}</div>
            <div className="field"><label>Job Location *</label><input readOnly value={currentLocation?.location_name || ''} placeholder="Set a default location on your User Branch" />{fieldError(errors, 'job_location_id')}</div>
            <div className="field"><label>Job Type *</label><EntityPicker label="Select Job Type" items={JOB_TYPE_OPTIONS} value={form.job_type} getLabel={(jobType) => jobType.name} columns={[{ key: 'name', label: 'Job Type' }]} searchKeys={['name']} onSelect={(jobType) => setField('job_type', jobType.id)} placeholder="Select job type" />{fieldError(errors, 'job_type')}</div>
            {form.job_type === 'SITE INSPECTION' && <div className="field"><label>Site Inspection Subtype *</label><select value={form.site_inspection_subtype} onChange={(event) => setField('site_inspection_subtype', event.target.value)}><option value="">Select subtype</option>{SITE_INSPECTION_SUBTYPES.map((subtype) => <option key={subtype} value={subtype}>{subtype}</option>)}</select>{fieldError(errors, 'site_inspection_subtype')}</div>}
            <div className="field"><label>PMS Job Type</label><EntityPicker label="PMS Job Type" items={meta?.pmsJobTypes || []} value={form.pms_job_type_id} getLabel={(jobType) => `${jobType.code ? `${jobType.code} — ` : ''}${jobType.display_name}`} columns={[{ key: 'code', label: 'Code' }, { key: 'display_name', label: 'Display Name' }]} searchKeys={['code', 'display_name']} onSelect={(jobType) => setField('pms_job_type_id', jobType.id)} placeholder="Select from PMS Job Types" /></div>
            <div className="field"><label>Sales Rep</label><input readOnly value={currentSalesRep ? `${currentSalesRep.first_name} ${currentSalesRep.last_name}` : ''} placeholder="Link your user account to an employee" />{fieldError(errors, 'sales_rep_id')}</div>
            <div className="field"><label>Sales Division</label><input readOnly value={currentDivision?.name || ''} placeholder="Set a department on your default User Branch" />{fieldError(errors, 'sales_division_id')}</div>
            <div className="field"><label>Date Created</label><input type="date" value={form.date_created} onChange={(event) => setField('date_created', event.target.value)} /></div>
            <div className="field"><label>Delivery Date *</label><input type="date" value={form.delivery_date} onChange={(event) => setField('delivery_date', event.target.value)} />{fieldError(errors, 'delivery_date')}</div>
            <div className="field"><label>Delivery Time</label><input type="time" value={form.delivery_time} onChange={(event) => setField('delivery_time', event.target.value)} /></div>
            <div className="field"><label>Quantity *</label><input type="number" min="0.0001" step="0.0001" value={form.quantity} onChange={(event) => setField('quantity', event.target.value)} />{fieldError(errors, 'quantity')}</div>
            <div className="field"><label>Job Description *</label><input value={form.description} onChange={(event) => setField('description', event.target.value)} />{fieldError(errors, 'description')}</div>
            <div className="field"><label>Contact Email</label><input type="email" value={form.contact_email} onChange={(event) => setField('contact_email', event.target.value)} /></div>
            <div className="field"><label>Contact Title</label><input value={form.contact_title} onChange={(event) => setField('contact_title', event.target.value)} /></div>
            <div className="field"><label>Contact Phone</label><input value={form.contact_phone} onChange={(event) => setField('contact_phone', event.target.value)} /></div>
          </div>
          <div className="field"><label>Optional Address</label><input value={form.shipping_address} onChange={(event) => setField('shipping_address', event.target.value)} /></div>
          <div className="field"><label>Memo</label><textarea value={form.memo} onChange={(event) => setField('memo', event.target.value)} /></div>
          <div className="modal-actions"><button type="button" className="btn" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
        </form>
      </Modal>}
    </div>
  );
}
