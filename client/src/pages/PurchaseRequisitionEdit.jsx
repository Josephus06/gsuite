import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function departmentLabel(d) { return d ? d.name : ''; }
function employeeLabel(e) { return e ? `${e.first_name} ${e.last_name}` : ''; }

// Mirrors the real "Purchase Requisition" create/edit form -- a single form + one Save,
// unlike Transfer Order's inline-persist-per-line pattern. "Add Material" just adds a
// row to local state; nothing hits the server until Save.
export default function PurchaseRequisitionEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;

  const [form, setForm] = useState({
    date_created: new Date().toISOString().slice(0, 10), date_needed: '',
    department_id: '', requestor_id: '', memo: '',
  });
  const [lines, setLines] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/lookups/departments'),
      api.get('/employees'),
      api.get('/inventory'),
      isNew ? Promise.resolve(null) : api.get(`/purchase-requisitions/${id}`),
    ]).then(([deptRes, empRes, invRes, prRes]) => {
      setDepartments(deptRes.data);
      setEmployees(empRes.data);
      setInventoryItems(invRes.data);

      if (prRes) {
        const pr = prRes.data;
        setForm({
          date_created: pr.date_created ? String(pr.date_created).slice(0, 10) : '',
          date_needed: pr.date_needed ? String(pr.date_needed).slice(0, 10) : '',
          department_id: pr.department_id || '',
          requestor_id: pr.requestor_id || '',
          memo: pr.memo || '',
        });
        setLines((pr.lines || []).map((l) => ({ ...l, _key: l.id })));
      }
      setLoading(false);
    });
  }, [id, isNew]);

  function addLine(item) {
    setLines((prev) => [...prev, {
      _key: `new-${Date.now()}`,
      item_id: item.id, item_code: item.item_code, item_name: item.display_name,
      purchase_description: item.display_name, job_order_id: null, job_order_no: '',
      qty_on_hand: 0, qty: 1, purchase_unit: item.base_unit_title || '', unit_title: item.base_unit_title || '',
    }]);
  }

  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key) {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }

  async function handleSave() {
    setError('');
    if (!lines.length) { setError('Add at least one material.'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        lines: lines.map((l) => ({
          item_id: l.item_id, purchase_description: l.purchase_description, job_order_id: l.job_order_id || null,
          qty: l.qty, purchase_unit: l.purchase_unit, unit_title: l.unit_title,
        })),
      };
      if (isNew) {
        const { data } = await api.post('/purchase-requisitions', payload);
        navigate(`/purchase-requisitions/${data.id}`);
      } else {
        await api.put(`/purchase-requisitions/${id}`, payload);
        navigate(`/purchase-requisitions/${id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Purchase Requisition</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate(isNew ? '/purchase-requisitions' : `/purchase-requisitions/${id}`)}>Back to Lists</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={form.date_created} onChange={(e) => setForm({ ...form, date_created: e.target.value })} />
          </div>
          <div className="field">
            <label>Date Needed</label>
            <input type="date" value={form.date_needed} onChange={(e) => setForm({ ...form, date_needed: e.target.value })} />
          </div>
          <div className="field">
            <label>Requested From</label>
            <EntityPicker
              label="Department" items={departments} value={form.department_id} getLabel={departmentLabel}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
              onSelect={(d) => setForm({ ...form, department_id: d.id })}
            />
          </div>
          <div className="field">
            <label>Memo</label>
            <textarea rows={2} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </div>
          <div className="field">
            <label>Requestor</label>
            <EntityPicker
              label="Requestor" items={employees} value={form.requestor_id} getLabel={employeeLabel}
              columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
              searchKeys={['first_name', 'last_name']}
              onSelect={(e) => setForm({ ...form, requestor_id: e.id })}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
        <DataTable
          columns={[
            { key: 'item', label: 'Item', render: (l) => `${l.item_code || ''} — ${l.item_name || ''}` },
            {
              key: 'purchase_description', label: 'Purchase Description',
              render: (l) => <input style={{ width: 180 }} defaultValue={l.purchase_description} onBlur={(e) => updateLine(l._key, { purchase_description: e.target.value })} />,
            },
            { key: 'job_order_no', label: 'JO #' },
            { key: 'qty_on_hand', label: 'Qty on Hand', render: (l) => Number(l.qty_on_hand || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
            {
              key: 'qty', label: 'Qty',
              render: (l) => <input type="number" step="0.0001" style={{ width: 90 }} defaultValue={l.qty} onBlur={(e) => updateLine(l._key, { qty: e.target.value })} />,
            },
            {
              key: 'purchase_unit', label: 'Purchase Unit',
              render: (l) => <input style={{ width: 90 }} defaultValue={l.purchase_unit} onBlur={(e) => updateLine(l._key, { purchase_unit: e.target.value })} />,
            },
            { key: 'unit_title', label: 'Unit Title' },
          ]}
          rows={lines}
          actions={(l) => <button className="btn btn-sm btn-danger" onClick={() => removeLine(l._key)}>Delete</button>}
          emptyLabel="No materials yet."
        />

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
      </div>
    </div>
  );
}
