import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real GraphicStar "Setup Job" (Add/Update Job) screen (#/jobs). Unit Type/
// Stock Unit/Purchase Unit/Sales Unit/Base Unit are plain text fields there (confirmed
// against the live API -- free text like "Each"/"EACH", not FK unit codes), not pickers.
// Processes and Customers (a per-customer GP Rate override) are only manageable once the
// job has been saved once, matching the real screen's own behavior for a brand-new job.
const JO_TYPES = ['JO', 'Non Standard JO', 'ECommerce'];

const EMPTY = {
  item_code: '', display_name: '', sales_description: '', purchase_description: '',
  jo_type: 'JO', parent_job_type_id: '', department_id: '',
  unit_type: '', stock_unit: '', purchase_unit: '', sales_unit: '', base_unit: '',
  is_area: false, is_piece: false, is_for_sample: false, is_direct_to_prod: false, is_ecommerce: false,
  income_account_id: '', cogs_account_id: '', asset_account_id: '',
  gp_rate_head: 0, gp_rate_branch: 0, is_active: true,
};

function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function jobTypeLabel(j) { return j ? j.display_name : ''; }
function departmentLabel(d) { return d ? d.name : ''; }
function processLabel(p) { return p ? `${p.process_code} — ${p.process_name}` : ''; }
function customerLabel(c) { return c ? `${c.customer_code} — ${c.name}` : ''; }

export default function JobTypeEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('processes');

  const [departments, setDepartments] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [processesList, setProcessesList] = useState([]);
  const [customersList, setCustomersList] = useState([]);
  const [processes, setProcesses] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [newCustomerGpRate, setNewCustomerGpRate] = useState(0);

  function load() {
    return Promise.all([
      api.get('/lookups/departments'),
      api.get('/lookups/chart-of-accounts'),
      api.get('/job-types'),
      api.get('/lookups/processes'),
      api.get('/customers'),
      isNew ? Promise.resolve(null) : api.get(`/job-types/${id}`),
    ]).then(([deptRes, acctRes, jtRes, procRes, custRes, detailRes]) => {
      setDepartments(deptRes.data);
      setAccounts(acctRes.data);
      setJobTypes(jtRes.data.filter((j) => !id || j.id !== Number(id)));
      setProcessesList(procRes.data);
      setCustomersList(custRes.data);
      if (detailRes) {
        const data = detailRes.data;
        setForm({
          item_code: data.item_code || '', display_name: data.display_name, sales_description: data.sales_description || '',
          purchase_description: data.purchase_description || '', jo_type: data.jo_type || 'JO',
          parent_job_type_id: data.parent_job_type_id || '', department_id: data.department_id || '',
          unit_type: data.unit_type || '', stock_unit: data.stock_unit || '', purchase_unit: data.purchase_unit || '',
          sales_unit: data.sales_unit || '', base_unit: data.base_unit || '',
          is_area: !!data.is_area, is_piece: !!data.is_piece, is_for_sample: !!data.is_for_sample,
          is_direct_to_prod: !!data.is_direct_to_prod, is_ecommerce: !!data.is_ecommerce,
          income_account_id: data.income_account_id || '', cogs_account_id: data.cogs_account_id || '',
          asset_account_id: data.asset_account_id || '', gp_rate_head: data.gp_rate_head ?? 0,
          gp_rate_branch: data.gp_rate_branch ?? 0, is_active: !!data.is_active,
        });
        setProcesses(data.processes || []);
        setCustomers(data.customers || []);
      }
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    setError('');
    const payload = { ...form };
    ['parent_job_type_id', 'department_id', 'income_account_id', 'cogs_account_id', 'asset_account_id']
      .forEach((k) => { payload[k] = payload[k] || null; });
    try {
      if (isNew) {
        const { data } = await api.post('/job-types', payload);
        navigate(`/job-types/${data.id}/edit`);
      } else {
        await api.put(`/job-types/${id}`, payload);
        await load();
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete job type "${form.display_name}"?`)) return;
    try {
      await api.delete(`/job-types/${id}`);
      navigate('/job-types');
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function addProcess(p) {
    if (processes.some((row) => row.process_id === p.id)) return;
    const { data } = await api.post(`/job-types/${id}/processes`, { process_id: p.id });
    setProcesses((prev) => [...prev, data]);
  }

  async function removeProcess(linkId) {
    await api.delete(`/job-types/${id}/processes/${linkId}`);
    setProcesses((prev) => prev.filter((p) => p.id !== linkId));
  }

  async function addCustomer(c) {
    if (customers.some((row) => row.customer_id === c.id)) return;
    const { data } = await api.post(`/job-types/${id}/customers`, { customer_id: c.id, gp_rate: newCustomerGpRate || 0 });
    setCustomers((prev) => [...prev, data]);
    setNewCustomerGpRate(0);
  }

  async function removeCustomer(linkId) {
    await api.delete(`/job-types/${id}/customers/${linkId}`);
    setCustomers((prev) => prev.filter((c) => c.id !== linkId));
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Add / Update Job' : `Job — ${form.display_name}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate('/job-types')}>Back</button>
          {!isNew && <button className="btn btn-danger" onClick={handleDelete}>Delete Job</button>}
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h3 className="subsection" style={{ marginTop: 0 }}>Setup Job</h3>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Display Name</label><input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></div>
          <div className="field"><label>Sales Description</label><input value={form.sales_description} onChange={(e) => setForm({ ...form, sales_description: e.target.value })} /></div>
          <div className="field"><label>Purchase Description</label><input value={form.purchase_description} onChange={(e) => setForm({ ...form, purchase_description: e.target.value })} /></div>

          <div className="field">
            <label>JO Type</label>
            <select value={form.jo_type} onChange={(e) => setForm({ ...form, jo_type: e.target.value })}>
              {JO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Group</label>
            <EntityPicker
              label="Group" items={jobTypes} value={form.parent_job_type_id} getLabel={jobTypeLabel}
              columns={[{ key: 'display_name', label: 'Display Name' }]} searchKeys={['display_name']}
              onSelect={(j) => setForm({ ...form, parent_job_type_id: j.id })}
            />
          </div>
          <div className="field">
            <label>Department</label>
            <EntityPicker
              label="Department" items={departments} value={form.department_id} getLabel={departmentLabel}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
              onSelect={(d) => setForm({ ...form, department_id: d.id })}
            />
          </div>

          <div className="field"><label>Unit Type</label><input value={form.unit_type} onChange={(e) => setForm({ ...form, unit_type: e.target.value })} /></div>
          <div className="field"><label>Stock Unit</label><input value={form.stock_unit} onChange={(e) => setForm({ ...form, stock_unit: e.target.value })} /></div>
          <div className="field"><label>Purchase Unit</label><input value={form.purchase_unit} onChange={(e) => setForm({ ...form, purchase_unit: e.target.value })} /></div>
          <div className="field"><label>Sales Unit</label><input value={form.sales_unit} onChange={(e) => setForm({ ...form, sales_unit: e.target.value })} /></div>
          <div className="field"><label>Base Unit</label><input value={form.base_unit} onChange={(e) => setForm({ ...form, base_unit: e.target.value })} /></div>
          <div />

          <div className="field"><label>Head Office (GP Rate)</label><input type="number" step="0.01" value={form.gp_rate_head} onChange={(e) => setForm({ ...form, gp_rate_head: e.target.value })} /></div>
          <div className="field"><label>Branch Office (GP Rate)</label><input type="number" step="0.01" value={form.gp_rate_branch} onChange={(e) => setForm({ ...form, gp_rate_branch: e.target.value })} /></div>
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-piece" checked={form.is_piece} onChange={(e) => setForm({ ...form, is_piece: e.target.checked })} />
            <label htmlFor="is-piece">Piece</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-area" checked={form.is_area} onChange={(e) => setForm({ ...form, is_area: e.target.checked })} />
            <label htmlFor="is-area">Area</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-sample" checked={form.is_for_sample} onChange={(e) => setForm({ ...form, is_for_sample: e.target.checked })} />
            <label htmlFor="is-sample">Sample</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-direct-prod" checked={form.is_direct_to_prod} onChange={(e) => setForm({ ...form, is_direct_to_prod: e.target.checked })} />
            <label htmlFor="is-direct-prod">Direct to Production</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            <label htmlFor="is-active">Active</label>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>Processes {processes.length}</button>
        <button className={`status-tab ${tab === 'accounting' ? 'active' : ''}`} onClick={() => setTab('accounting')}>Accounting</button>
        <button className={`status-tab ${tab === 'customers' ? 'active' : ''}`} onClick={() => setTab('customers')}>Customers</button>
      </div>

      {tab === 'processes' && (
        <div className="card">
          {isNew ? <p className="muted" style={{ marginTop: 0 }}>Save this job first to manage its processes.</p> : (
            <>
              <DataTable
                columns={[
                  { key: 'process_code', label: 'Process Code' },
                  { key: 'process_name', label: 'Process Name' },
                ]}
                rows={processes}
                actions={(r) => <button className="btn btn-sm btn-danger" onClick={() => removeProcess(r.id)}>Remove</button>}
                emptyLabel="No processes assigned yet."
              />
              <div className="inline-form" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>Process</label>
                  <EntityPicker
                    label="Process" items={processesList} value="" getLabel={processLabel}
                    columns={[{ key: 'process_code', label: 'Code' }, { key: 'process_name', label: 'Name' }]}
                    searchKeys={['process_code', 'process_name']}
                    onSelect={addProcess}
                    placeholder="Add Process..."
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'accounting' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="field">
              <label>COGS</label>
              <EntityPicker
                label="COGS Account" items={accounts} value={form.cogs_account_id} getLabel={accountLabel}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                searchKeys={['account_code', 'account_name']}
                onSelect={(a) => setForm({ ...form, cogs_account_id: a.id })}
              />
            </div>
            <div className="field">
              <label>Asset</label>
              <EntityPicker
                label="Asset Account" items={accounts} value={form.asset_account_id} getLabel={accountLabel}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                searchKeys={['account_code', 'account_name']}
                onSelect={(a) => setForm({ ...form, asset_account_id: a.id })}
              />
            </div>
            <div className="field">
              <label>Income</label>
              <EntityPicker
                label="Income Account" items={accounts} value={form.income_account_id} getLabel={accountLabel}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                searchKeys={['account_code', 'account_name']}
                onSelect={(a) => setForm({ ...form, income_account_id: a.id })}
              />
            </div>
          </div>
        </div>
      )}

      {tab === 'customers' && (
        <div className="card">
          {isNew ? <p className="muted" style={{ marginTop: 0 }}>Save this job first to manage customer GP Rate overrides.</p> : (
            <>
              <DataTable
                columns={[
                  { key: 'customer_code', label: 'Customer Code' },
                  { key: 'customer_name', label: 'Customer Name' },
                  { key: 'gp_rate', label: 'GP Rate' },
                ]}
                rows={customers}
                actions={(r) => <button className="btn btn-sm btn-danger" onClick={() => removeCustomer(r.id)}>Remove</button>}
                emptyLabel="No customer GP Rate overrides yet."
              />
              <div className="inline-form" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>GP Rate</label>
                  <input type="number" step="0.01" style={{ width: 100 }} value={newCustomerGpRate} onChange={(e) => setNewCustomerGpRate(e.target.value)} />
                </div>
                <div className="field">
                  <label>Customer</label>
                  <EntityPicker
                    label="Customer" items={customersList} value="" getLabel={customerLabel}
                    columns={[{ key: 'customer_code', label: 'Code' }, { key: 'name', label: 'Name' }]}
                    searchKeys={['customer_code', 'name']}
                    onSelect={addCustomer}
                    placeholder="Add Customer..."
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
