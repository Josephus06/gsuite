import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Full-page Add/Edit form for Inventory items -- mirrors JobOrderEdit.jsx's pattern:
// EntityPicker (searchable modal) for Category/Unit/Chart-of-Accounts fields instead of
// plain <select> dropdowns, since those lists are too long to scan without search.
const ITEM_TYPES = ['Inventory', 'Non-Inventory', 'Service'];

const EMPTY = {
  item_code: '', display_name: '', sales_description: '', purchase_description: '',
  category_id: '', base_unit_id: '', purchase_unit_id: '', stock_unit_id: '', sales_unit_id: '',
  conversion_factor: 1, item_type: 'Inventory', reorder_point: 0, is_active: true,
  to_type: '', is_office_supply: false, is_to_item: true,
  is_with_jo: false, is_po: false, is_jo: false,
  is_length_based: false, is_width_based: false, last_purchase_price: '', last_purchase_date: '',
  average_cost: '', material_cost: '', price_indicator: 0, tolerance_pct: 0, wastage_allowance_pct: 0, markup_pct: 0,
  selling_price: '', beg_selling_price: '', disc_ceiling_pct: 0, disc_supervisor_pct: 0,
  disc_manager_pct: 0, disc_gm_pct: 0,
  expense_account_id: '', asset_account_id: '', income_account_id: '', cogs_account_id: '',
};

function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function unitLabel(u) { return u ? `${u.title} (${u.code})` : ''; }

export default function InventoryEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [categories, setCategories] = useState([]);
  const [units, setUnits] = useState([]);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/inventory-categories'),
      api.get('/lookups/units-of-measure'),
      api.get('/lookups/chart-of-accounts'),
      isNew ? Promise.resolve(null) : api.get(`/inventory/${id}`),
    ]).then(([catRes, unitRes, acctRes, itemRes]) => {
      setCategories(catRes.data);
      setUnits(unitRes.data);
      setAccounts(acctRes.data);
      if (itemRes) {
        const data = itemRes.data;
        setForm({
          item_code: data.item_code, display_name: data.display_name,
          sales_description: data.sales_description || '', purchase_description: data.purchase_description || '',
          category_id: data.category_id || '', base_unit_id: data.base_unit_id || '',
          purchase_unit_id: data.purchase_unit_id || '', stock_unit_id: data.stock_unit_id || '', sales_unit_id: data.sales_unit_id || '',
          conversion_factor: data.conversion_factor ?? 1, item_type: data.item_type || 'Inventory',
          reorder_point: data.reorder_point || 0, is_active: !!data.is_active,
          to_type: data.to_type || '', is_office_supply: !!data.is_office_supply, is_to_item: !!data.is_to_item,
          is_with_jo: !!data.is_with_jo, is_po: !!data.is_po, is_jo: !!data.is_jo,
          is_length_based: !!data.is_length_based, is_width_based: !!data.is_width_based,
          last_purchase_price: data.last_purchase_price ?? '', last_purchase_date: data.last_purchase_date ? String(data.last_purchase_date).slice(0, 10) : '',
          average_cost: data.average_cost ?? '', material_cost: data.material_cost ?? '', price_indicator: data.price_indicator ?? 0, tolerance_pct: data.tolerance_pct ?? 0,
          wastage_allowance_pct: data.wastage_allowance_pct ?? 0, markup_pct: data.markup_pct ?? 0,
          selling_price: data.selling_price ?? '', beg_selling_price: data.beg_selling_price ?? '',
          disc_ceiling_pct: data.disc_ceiling_pct ?? 0, disc_supervisor_pct: data.disc_supervisor_pct ?? 0,
          disc_manager_pct: data.disc_manager_pct ?? 0, disc_gm_pct: data.disc_gm_pct ?? 0,
          expense_account_id: data.expense_account_id || '', asset_account_id: data.asset_account_id || '',
          income_account_id: data.income_account_id || '', cogs_account_id: data.cogs_account_id || '',
        });
      }
      setLoading(false);
    });
  }, [id, isNew]);

  async function handleSave() {
    setSaving(true);
    setError('');
    const payload = { ...form };
    ['category_id', 'base_unit_id', 'purchase_unit_id', 'stock_unit_id', 'sales_unit_id', 'expense_account_id', 'asset_account_id', 'income_account_id', 'cogs_account_id']
      .forEach((k) => { payload[k] = payload[k] || null; });
    ['last_purchase_price', 'last_purchase_date', 'average_cost', 'material_cost', 'selling_price', 'beg_selling_price']
      .forEach((k) => { payload[k] = payload[k] === '' ? null : payload[k]; });
    try {
      if (isNew) {
        const { data } = await api.post('/inventory', payload);
        navigate(`/inventory/${data.id}`);
      } else {
        await api.put(`/inventory/${id}`, payload);
        navigate(`/inventory/${id}`);
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
        <h1>{isNew ? 'Add Inventory Item' : `Inventory Item — ${form.item_code}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate(isNew ? '/inventory' : `/inventory/${id}`)}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h3 className="subsection" style={{ marginTop: 0 }}>Basic Info</h3>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Item Code</label><input required value={form.item_code} onChange={(e) => setForm({ ...form, item_code: e.target.value })} /></div>
          <div className="field"><label>Display Name</label><input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></div>
          <div className="field">
            <label>Category</label>
            <EntityPicker
              label="Category" items={categories} value={form.category_id} getLabel={(c) => c.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
              onSelect={(c) => setForm({ ...form, category_id: c.id })}
            />
          </div>

          <div className="field"><label>Sales Description</label><input value={form.sales_description} onChange={(e) => setForm({ ...form, sales_description: e.target.value })} /></div>
          <div className="field"><label>Purchase Description</label><input value={form.purchase_description} onChange={(e) => setForm({ ...form, purchase_description: e.target.value })} /></div>
          <div className="field">
            <label>Type</label>
            <select value={form.item_type} onChange={(e) => setForm({ ...form, item_type: e.target.value })}>
              {ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>

          <div className="field"><label>Reorder Point</label><input type="number" step="0.0001" value={form.reorder_point} onChange={(e) => setForm({ ...form, reorder_point: e.target.value })} /></div>
          <div className="field"><label>TO Type</label><input value={form.to_type} onChange={(e) => setForm({ ...form, to_type: e.target.value })} /></div>
        </div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            <label htmlFor="is-active">Active</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-office-supply" checked={form.is_office_supply} onChange={(e) => setForm({ ...form, is_office_supply: e.target.checked })} />
            <label htmlFor="is-office-supply">Office Supply Requisition</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-to-item" checked={form.is_to_item} onChange={(e) => setForm({ ...form, is_to_item: e.target.checked })} />
            <label htmlFor="is-to-item">TO Item</label>
          </div>
          {form.item_type === 'Service' && (
            <>
              <div className="field field-checkbox">
                <input type="checkbox" id="is-with-jo" checked={form.is_with_jo} onChange={(e) => setForm({ ...form, is_with_jo: e.target.checked })} />
                <label htmlFor="is-with-jo">With JO</label>
              </div>
              <div className="field field-checkbox">
                <input type="checkbox" id="is-po" checked={form.is_po} onChange={(e) => setForm({ ...form, is_po: e.target.checked })} />
                <label htmlFor="is-po">PO</label>
              </div>
              <div className="field field-checkbox">
                <input type="checkbox" id="is-jo" checked={form.is_jo} onChange={(e) => setForm({ ...form, is_jo: e.target.checked })} />
                <label htmlFor="is-jo">JO</label>
              </div>
            </>
          )}
        </div>
        {isNew && (
          <p className="muted" style={{ marginTop: 12 }}>
            New items start pending both Costing and Accounting approval. Fill in Sales/Pricing and Accounting below (or after saving) to make those approvals available on the item's view page.
          </p>
        )}

        <h3 className="subsection">Units</h3>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field">
            <label>Base Unit</label>
            <EntityPicker
              label="Base Unit" items={units} value={form.base_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, base_unit_id: u.id })}
            />
          </div>
          <div className="field">
            <label>Purchase Unit</label>
            <EntityPicker
              label="Purchase Unit" items={units} value={form.purchase_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, purchase_unit_id: u.id })}
            />
          </div>
          <div className="field">
            <label>Stock Unit</label>
            <EntityPicker
              label="Stock Unit" items={units} value={form.stock_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, stock_unit_id: u.id })}
            />
          </div>
          <div className="field">
            <label>Sales Unit</label>
            <EntityPicker
              label="Sales Unit" items={units} value={form.sales_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, sales_unit_id: u.id })}
            />
          </div>
          <div className="field"><label>Conversion Factor</label><input type="number" step="0.000001" value={form.conversion_factor} onChange={(e) => setForm({ ...form, conversion_factor: e.target.value })} /></div>
        </div>

        <h3 className="subsection">Inventory Detail</h3>
        <div className="field-row">
          <div className="field field-checkbox">
            <input type="checkbox" id="is-length" checked={form.is_length_based} onChange={(e) => setForm({ ...form, is_length_based: e.target.checked })} />
            <label htmlFor="is-length">Priced by Length</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-width" checked={form.is_width_based} onChange={(e) => setForm({ ...form, is_width_based: e.target.checked })} />
            <label htmlFor="is-width">Priced by Width</label>
          </div>
          <div className="field"><label>Price Indicator</label><input type="number" step="0.01" value={form.price_indicator} onChange={(e) => setForm({ ...form, price_indicator: e.target.value })} /></div>
          <div className="field"><label>Tolerance %</label><input type="number" step="0.01" value={form.tolerance_pct} onChange={(e) => setForm({ ...form, tolerance_pct: e.target.value })} /></div>
        </div>

        <h3 className="subsection">Purchasing / Costing</h3>
        <div className="field-row">
          <div className="field"><label>Average Cost</label><input type="number" step="0.0001" value={form.average_cost} onChange={(e) => setForm({ ...form, average_cost: e.target.value })} /></div>
          <div className="field"><label>Last Purchase Price</label><input type="number" step="0.0001" value={form.last_purchase_price} onChange={(e) => setForm({ ...form, last_purchase_price: e.target.value })} /></div>
          <div className="field"><label>Last Purchase Date</label><input type="date" value={form.last_purchase_date} onChange={(e) => setForm({ ...form, last_purchase_date: e.target.value })} /></div>
        </div>

        <h3 className="subsection">Sales / Pricing</h3>
        <div className="field-row">
          <div className="field"><label>Material Cost <span className="muted">(base unit, costing basis)</span></label><input type="number" step="0.0001" value={form.material_cost} onChange={(e) => setForm({ ...form, material_cost: e.target.value })} /></div>
          <div className="field"><label>Wastage Allowance %</label><input type="number" step="0.01" value={form.wastage_allowance_pct} onChange={(e) => setForm({ ...form, wastage_allowance_pct: e.target.value })} /></div>
          <div className="field"><label>Mark-Up %</label><input type="number" step="0.01" value={form.markup_pct} onChange={(e) => setForm({ ...form, markup_pct: e.target.value })} /></div>
          <div className="field"><label>Selling Price <span className="muted">(blank = auto)</span></label><input type="number" step="0.0001" value={form.selling_price} onChange={(e) => setForm({ ...form, selling_price: e.target.value })} /></div>
          <div className="field"><label>Beg. Selling Price</label><input type="number" step="0.0001" value={form.beg_selling_price} onChange={(e) => setForm({ ...form, beg_selling_price: e.target.value })} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Disc. Ceiling %</label><input type="number" step="0.01" value={form.disc_ceiling_pct} onChange={(e) => setForm({ ...form, disc_ceiling_pct: e.target.value })} /></div>
          <div className="field"><label>Disc. Supervisor %</label><input type="number" step="0.01" value={form.disc_supervisor_pct} onChange={(e) => setForm({ ...form, disc_supervisor_pct: e.target.value })} /></div>
          <div className="field"><label>Disc. Manager %</label><input type="number" step="0.01" value={form.disc_manager_pct} onChange={(e) => setForm({ ...form, disc_manager_pct: e.target.value })} /></div>
          <div className="field"><label>Disc. GM %</label><input type="number" step="0.01" value={form.disc_gm_pct} onChange={(e) => setForm({ ...form, disc_gm_pct: e.target.value })} /></div>
        </div>

        <h3 className="subsection">Accounting</h3>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="field">
            <label>Expense Account</label>
            <EntityPicker
              label="Expense Account" items={accounts} value={form.expense_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, expense_account_id: a.id })}
            />
          </div>
          <div className="field">
            <label>COGS Account</label>
            <EntityPicker
              label="COGS Account" items={accounts} value={form.cogs_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, cogs_account_id: a.id })}
            />
          </div>
          <div className="field">
            <label>Asset Account</label>
            <EntityPicker
              label="Asset Account" items={accounts} value={form.asset_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, asset_account_id: a.id })}
            />
          </div>
          <div className="field">
            <label>Income Account</label>
            <EntityPicker
              label="Income Account" items={accounts} value={form.income_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, income_account_id: a.id })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
