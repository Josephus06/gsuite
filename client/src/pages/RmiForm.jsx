import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { useItemBalances } from '../utils/itemBalances';

// The live "RETURN MATERIAL INVENTORY" add form: Date Created, Return From / Return To and
// Returned By above, then the Materials grid (Item | JO # | Qty | Received | Qty on Hand | UOM |
// Unit). It is raised Pending Receipt, so Received stays empty here, and nothing moves stock --
// see routes/rmis.js. Return From starts at the user's own warehouse when there is one, Return To
// at Warehouse - Central, and Returned By at the user, as live does.
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
}
const locationLabel = (l) => (l ? l.location_name : '');
const employeeLabel = (e) => (e ? `${e.first_name} ${e.last_name}` : '');
const LOCATION_COLUMNS = [{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }];

export default function RmiForm() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [form, setForm] = useState({
    date_created: new Date().toISOString().slice(0, 10),
    return_from_location_id: '', return_to_location_id: '', returned_by_employee_id: '', memo: '',
  });
  const [lines, setLines] = useState([]);
  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Qty on Hand: the Bin Card balance at Return From, in the base unit -- nothing until a
  // warehouse is picked, since a company-wide total would read as stock that warehouse may lack.
  const { balances, load: loadBalances } = useItemBalances(form.return_from_location_id || null);
  const itemKey = lines.map((l) => l.item_id).join(',');
  useEffect(() => {
    if (form.return_from_location_id && itemKey) loadBalances(itemKey.split(',').map((id) => ({ id: Number(id) })));
  }, [form.return_from_location_id, itemKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    Promise.all([api.get('/lookups/locations'), api.get('/rmis/form-meta')]).then(([locRes, metaRes]) => {
      setLocations(locRes.data);
      setEmployees(metaRes.data.employees);
      setItems(metaRes.data.items);
      const central = locRes.data.find((l) => /warehouse\s*-\s*central/i.test(l.location_name));
      setForm((f) => ({
        ...f,
        return_to_location_id: f.return_to_location_id || central?.id || '',
        returned_by_employee_id: f.returned_by_employee_id || user?.employee_id || '',
      }));
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error || 'Could not load the form.');
      setLoading(false);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onHand(l) {
    const b = form.return_from_location_id ? balances[l.item_id] : null;
    return b ? qty(b.balance_base) : '';
  }

  async function handleSave() {
    setError('');
    setSaving(true);
    try {
      const { data } = await api.post('/rmis', {
        ...form,
        lines: lines.map((l) => ({ item_id: l.item_id, job_order_no: l.job_order_no, qty: Number(l.qty) })),
      });
      navigate(`/rmis/${data.id}`);
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
        <h1>Return Material Inventory</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={'/rmis'}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <div>
            <div className="field">
              <label>Date Created</label>
              <input type="date" value={form.date_created} onChange={(e) => setForm({ ...form, date_created: e.target.value })} />
            </div>
            <div className="field">
              <label>Return From:</label>
              <EntityPicker
                label="Return From" items={locations} value={form.return_from_location_id} getLabel={locationLabel}
                columns={LOCATION_COLUMNS} searchKeys={['location_name', 'location_code']}
                onSelect={(l) => setForm({ ...form, return_from_location_id: l.id })}
              />
            </div>
            <div className="field">
              <label>Return To:</label>
              <EntityPicker
                label="Return To" items={locations} value={form.return_to_location_id} getLabel={locationLabel}
                columns={LOCATION_COLUMNS} searchKeys={['location_name', 'location_code']}
                onSelect={(l) => setForm({ ...form, return_to_location_id: l.id })}
              />
            </div>
          </div>
          <div>
            <div className="field">
              <label>Returned By:</label>
              <EntityPicker
                label="Returned By" items={employees} value={form.returned_by_employee_id} getLabel={employeeLabel}
                columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={(e) => setForm({ ...form, returned_by_employee_id: e.id })}
              />
            </div>
            <div className="field">
              <label>Memo</label>
              <textarea rows={4} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
            </div>
          </div>
        </div>

        <h3 className="subsection">Materials</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Item</th><th>JO #</th><th>Qty</th><th>Received</th><th>Qty on Hand</th><th>UOM</th><th>Unit</th><th></th></tr>
            </thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials yet.</td></tr>}
              {lines.map((l, i) => {
                const set = (patch) => setLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
                return (
                  <tr key={l.key}>
                    <td>{i + 1}</td>
                    <td>{l.item_name}</td>
                    <td><input style={{ width: 140 }} placeholder="JO-#####-#-#" value={l.job_order_no} onChange={(e) => set({ job_order_no: e.target.value })} /></td>
                    <td><input type="number" step="0.0001" min="0" style={{ width: 100 }} value={l.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                    <td><input disabled style={{ width: 90 }} value="" title="Filled in when the RMI is received" /></td>
                    <td>{onHand(l)}</td>
                    <td>{l.uom}</td>
                    <td>{l.unit}</td>
                    <td><button type="button" className="btn btn-sm btn-danger" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>Delete</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10 }}>
          <EntityPicker
            label="Item" items={items} value="" getLabel={(it) => it.display_name}
            columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
            searchKeys={['item_code', 'display_name']}
            onSelect={(it) => setLines((ls) => [...ls, {
              key: `${it.id}-${Date.now()}`, item_id: it.id, item_name: it.display_name, job_order_no: '', qty: 1,
              uom: it.base_unit_code, unit: it.base_unit_title,
            }])}
            triggerLabel="Add Material"
            triggerClassName="btn btn-primary"
          />
        </div>
      </div>
    </div>
  );
}
