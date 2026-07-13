import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const CONFIG = [
  { key: 'chart-of-accounts', label: 'Chart of Accounts', fields: [
    { name: 'account_code', label: 'Account Code', type: 'text', required: true },
    { name: 'account_name', label: 'Account Name', type: 'text', required: true },
    { name: 'account_type', label: 'Account Type', type: 'select', options: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 'Cost of Sales'], required: true },
    { name: 'parent_account_id', label: 'Parent Account', type: 'ref', ref: 'chart-of-accounts', refLabel: 'account_name' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'locations', label: 'Locations', fields: [
    { name: 'location_code', label: 'Code', type: 'text', required: true },
    { name: 'location_name', label: 'Name', type: 'text', required: true },
    { name: 'location_type', label: 'Type', type: 'select', options: ['Branch', 'Warehouse', 'Design', 'Damaged', 'Delivery Charge', 'Technical', 'Subcon', 'Other'] },
    { name: 'address', label: 'Address', type: 'textarea' },
    { name: 'telephone', label: 'Telephone', type: 'text' },
    { name: 'contact_person', label: 'Contact Person', type: 'text' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'business-styles', label: 'Business Styles', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'departments', label: 'Departments', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'units-of-measure', label: 'Units of Measure', fields: [
    { name: 'code', label: 'Code', type: 'text', required: true },
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'unit-conversions', label: 'Unit Conversions', fields: [
    { name: 'from_unit_id', label: 'From Unit', type: 'ref', ref: 'units-of-measure', refLabel: 'title', required: true },
    { name: 'to_unit_id', label: 'To Unit', type: 'ref', ref: 'units-of-measure', refLabel: 'title', required: true },
    { name: 'multiplier', label: 'Multiplier', type: 'number', step: '0.000001', required: true },
  ] },
  { key: 'inventory-categories', label: 'Inventory Categories', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'parent_category_id', label: 'Parent Category', type: 'ref', ref: 'inventory-categories', refLabel: 'name' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'taxes', label: 'Taxes', fields: [
    { name: 'code', label: 'Code', type: 'text', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'rate', label: 'Rate (%)', type: 'number', step: '0.01', required: true },
    { name: 'tax_account_id', label: 'Tax Account', type: 'ref', ref: 'chart-of-accounts', refLabel: 'account_name' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'withholding-taxes', label: 'Withholding Taxes', fields: [
    { name: 'code', label: 'Code', type: 'text', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'rate', label: 'Rate (%)', type: 'number', step: '0.01', required: true },
    { name: 'atc_code', label: 'ATC Code', type: 'text' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'payment-terms', label: 'Payment Terms', fields: [
    { name: 'term_name', label: 'Term Name', type: 'text', required: true },
    { name: 'no_of_days', label: 'No. of Days', type: 'number' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'payment-methods', label: 'Payment Methods', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'requires_reference', label: 'Requires Reference', type: 'checkbox' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'warranties', label: 'Warranties', fields: [
    { name: 'warranty_type', label: 'Type', type: 'select', options: ['Print', 'Structure', 'Electrical'], required: true },
    { name: 'duration_label', label: 'Duration Label', type: 'text', required: true },
    { name: 'duration_months', label: 'Duration (Months)', type: 'number', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'reasons', label: 'Reasons', fields: [
    { name: 'reason_type', label: 'Type', type: 'select', options: ['Cancellation', 'Disapproval', 'Return', 'Adjustment', 'Other'], required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'sales-divisions', label: 'Sales Divisions', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'discount-items', label: 'Discount Items', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'discount_type', label: 'Type', type: 'select', options: ['Percent', 'Fixed'] },
    { name: 'value', label: 'Value', type: 'number', step: '0.0001' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'landed-costs', label: 'Landed Costs', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'allocation_method', label: 'Allocation Method', type: 'select', options: ['By Value', 'By Quantity', 'By Weight'] },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'non-inventories', label: 'Non-Inventory Items', fields: [
    { name: 'item_code', label: 'Item Code', type: 'text', required: true },
    { name: 'display_name', label: 'Display Name', type: 'text', required: true },
    { name: 'unit_price', label: 'Unit Price', type: 'number', step: '0.0001' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'service-items', label: 'Service Items', fields: [
    { name: 'item_code', label: 'Item Code', type: 'text', required: true },
    { name: 'display_name', label: 'Display Name', type: 'text', required: true },
    { name: 'unit_price', label: 'Unit Price', type: 'number', step: '0.0001' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'items', label: 'Costing Items', fields: [
    { name: 'item_name', label: 'Item Name', type: 'text', required: true },
    { name: 'item_type', label: 'Type', type: 'select', options: ['Material', 'Labor', 'Service'], required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'processes', label: 'Processes', fields: [
    { name: 'process_code', label: 'Process Code', type: 'text', required: true },
    { name: 'process_name', label: 'Process Name', type: 'text', required: true },
    { name: 'base_unit_id', label: 'Base Unit', type: 'ref', ref: 'units-of-measure', refLabel: 'title', required: true },
    { name: 'minutes_per_unit', label: 'Minutes per Unit', type: 'number' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'user-groups', label: 'User Groups', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
];

function emptyForm(fields) {
  const form = {};
  for (const f of fields) form[f.name] = f.type === 'checkbox' ? f.name === 'is_active' : '';
  return form;
}

export default function Lookups() {
  const { can } = useAuth();
  const [activeKey, setActiveKey] = useState(CONFIG[0].key);
  const [rows, setRows] = useState([]);
  const [refOptions, setRefOptions] = useState({});
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const active = useMemo(() => CONFIG.find((c) => c.key === activeKey), [activeKey]);
  const refKeys = useMemo(() => [...new Set(active.fields.filter((f) => f.type === 'ref').map((f) => f.ref))], [active]);

  async function load() {
    setLoading(true);
    const { data } = await api.get(`/lookups/${activeKey}`);
    setRows(data);
    const refs = {};
    for (const refKey of refKeys) {
      const res = await api.get(`/lookups/${refKey}`);
      refs[refKey] = res.data;
    }
    setRefOptions(refs);
    setLoading(false);
  }

  useEffect(() => { load(); }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setForm(emptyForm(active.fields));
    setEditing('new');
    setError('');
  }

  function openEdit(row) {
    const f = {};
    for (const field of active.fields) f[field.name] = field.type === 'checkbox' ? !!row[field.name] : (row[field.name] ?? '');
    setForm(f);
    setEditing(row.id);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = {};
    for (const f of active.fields) {
      payload[f.name] = form[f.name] === '' && f.type === 'ref' ? null : form[f.name];
    }
    try {
      if (editing === 'new') {
        await api.post(`/lookups/${activeKey}`, payload);
      } else {
        await api.put(`/lookups/${activeKey}/${editing}`, payload);
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm('Delete this record?')) return;
    try {
      await api.delete(`/lookups/${activeKey}/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  const columns = active.fields
    .filter((f) => f.type !== 'textarea')
    .map((f) => ({
      key: f.name,
      label: f.label,
      render: f.type === 'checkbox'
        ? (r) => (r[f.name] ? <span className="badge badge-success">Yes</span> : <span className="badge badge-muted">No</span>)
        : f.type === 'ref'
          ? (r) => {
            const list = refOptions[f.ref] || [];
            const match = list.find((o) => o.id === r[f.name]);
            return match ? match[f.refLabel] : '—';
          }
          : undefined,
    }));

  return (
    <div>
      <div className="page-header">
        <h1>Lookups</h1>
        {can('/lookups', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add Record</button>}
      </div>
      <div className="tabs">
        {CONFIG.map((c) => (
          <button key={c.key} className={c.key === activeKey ? 'active' : ''} onClick={() => setActiveKey(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            actions={(row) => (
              <>
                {can('/lookups', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/lookups', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={`${editing === 'new' ? 'Add' : 'Edit'} — ${active.label}`} onClose={() => setEditing(null)}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            {active.fields.map((f) => (
              <div className="field" key={f.name}>
                {f.type === 'checkbox' ? (
                  <div className="field-checkbox">
                    <input
                      type="checkbox" id={f.name}
                      checked={!!form[f.name]}
                      onChange={(e) => setForm({ ...form, [f.name]: e.target.checked })}
                    />
                    <label htmlFor={f.name}>{f.label}</label>
                  </div>
                ) : f.type === 'select' ? (
                  <>
                    <label>{f.label}</label>
                    <select required={f.required} value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                      <option value="">—</option>
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </>
                ) : f.type === 'ref' ? (
                  <>
                    <label>{f.label}</label>
                    <select required={f.required} value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                      <option value="">—</option>
                      {(refOptions[f.ref] || []).map((o) => <option key={o.id} value={o.id}>{o[f.refLabel]}</option>)}
                    </select>
                  </>
                ) : f.type === 'textarea' ? (
                  <>
                    <label>{f.label}</label>
                    <textarea rows={3} value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
                  </>
                ) : (
                  <>
                    <label>{f.label}</label>
                    <input
                      type={f.type === 'number' ? 'number' : 'text'}
                      step={f.step}
                      required={f.required}
                      value={form[f.name] ?? ''}
                      onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                    />
                  </>
                )}
              </div>
            ))}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
