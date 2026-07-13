import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Full-page read-only Inventory item view, mirroring the real system's Inventory View
// screen -- banner + info grid + tabs. "Related Records" (Item Receipts/Invoices/
// Transfer Orders/Receiving Reports/Vendor Bills/Purchase Requisitions/Purchase
// Orders) is deliberately skipped -- it needs seven transactional modules this build
// doesn't have.
const YES_NO = (v) => (v ? 'Yes' : 'No');

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

export default function InventoryView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('purchasing');
  const [auditLogs, setAuditLogs] = useState([]);

  const [suppliers, setSuppliers] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [newSupplierPrice, setNewSupplierPrice] = useState({ supplier_id: '', price: '', last_purchase_date: '', ref_no: '' });
  const [newSubItemQty, setNewSubItemQty] = useState(1);
  const [newUom, setNewUom] = useState('');
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState('');

  function load() {
    return api.get(`/inventory/${id}`).then(({ data }) => { setItem(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    api.get('/suppliers').then(({ data }) => setSuppliers(data));
    api.get('/inventory').then(({ data }) => setInventoryItems(data));
  }, []);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/inventory/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function addSupplierPrice() {
    if (!newSupplierPrice.supplier_id || !newSupplierPrice.price) return;
    await api.post(`/inventory/${id}/supplier-prices`, newSupplierPrice);
    setNewSupplierPrice({ supplier_id: '', price: '', last_purchase_date: '', ref_no: '' });
    load();
  }

  async function removeSupplierPrice(priceId) {
    await api.delete(`/inventory/${id}/supplier-prices/${priceId}`);
    load();
  }

  async function addSubItem(child) {
    await api.post(`/inventory/${id}/sub-items`, { child_inventory_id: child.id, qty: newSubItemQty || 1 });
    setNewSubItemQty(1);
    load();
  }

  async function removeSubItem(subItemId) {
    await api.delete(`/inventory/${id}/sub-items/${subItemId}`);
    load();
  }

  async function addUom() {
    if (!newUom.trim()) return;
    await api.post(`/inventory/${id}/unit-of-measures`, { code: newUom.trim() });
    setNewUom('');
    load();
  }

  async function removeUom(uomId) {
    await api.delete(`/inventory/${id}/unit-of-measures/${uomId}`);
    load();
  }

  async function handleApproveCosting() {
    setApproving(true);
    setApproveError('');
    try {
      await api.put(`/inventory/${id}/approve-costing`);
      await load();
    } catch (err) {
      setApproveError(err.response?.data?.error || 'Approve Costing failed');
    } finally {
      setApproving(false);
    }
  }

  async function handleApproveAccounting() {
    setApproving(true);
    setApproveError('');
    try {
      await api.put(`/inventory/${id}/approve-accounting`);
      await load();
    } catch (err) {
      setApproveError(err.response?.data?.error || 'Approve Accounting failed');
    } finally {
      setApproving(false);
    }
  }

  if (loading || !item) return <LoadingSpinner />;

  const canEdit = can('/inventory', 'can_edit');
  const canAdd = can('/inventory', 'can_add');
  const canApprove = can('/inventory', 'can_approve');
  const stock = item.stock || [];
  const totalQtyOnHand = stock.reduce((s, r) => s + num(r.qty_on_hand), 0);
  const totalValue = totalQtyOnHand * num(item.average_cost);
  const otherInventories = inventoryItems.filter((i) => i.id !== item.id);

  const costingReady = Number(item.selling_price) > 0;
  const accountingReady = !!(item.asset_account_id && item.cogs_account_id && item.income_account_id);
  const showApproveCosting = canApprove && item.is_active && !item.is_costing_approved && costingReady;
  const showApproveAccounting = canApprove && item.is_active && !item.is_accounting_approved && accountingReady;
  const fullyApproved = item.is_costing_approved && item.is_accounting_approved;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/inventory')}>Back to Lists</button>
          {canEdit && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/inventory/${id}/edit`)}>Edit</button>}
          {canAdd && <button className="btn btn-sm" onClick={() => navigate('/inventory/new')}>Add New</button>}
          {showApproveCosting && <button className="btn btn-sm btn-primary" disabled={approving} onClick={handleApproveCosting}>Approve Costing</button>}
          {showApproveAccounting && <button className="btn btn-sm btn-primary" disabled={approving} onClick={handleApproveAccounting}>Approve Accounting</button>}
        </div>
      </div>

      {approveError && <div className="error-banner">{approveError}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Inventory Item</h1>
          <span className="estimate-no">{item.item_code}</span>
        </div>
        <div className="estimate-status">
          {!item.is_active ? 'Inactive' : fullyApproved ? 'Approved' : (
            <>
              {!item.is_costing_approved && <span className="estimate-so-link" style={{ background: 'rgba(245, 159, 0, 0.35)' }}>For Approval Costing</span>}
              {!item.is_accounting_approved && <span className="estimate-so-link" style={{ background: 'rgba(245, 159, 0, 0.35)' }}>For Approval Accounting</span>}
            </>
          )}
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Basic Info</h4>
            <div>Item Code : <span className="hi">{item.item_code}</span></div>
            <div>Category : <span className="hi">{item.category_name}</span></div>
            <div>Type : <span className="hi">{item.item_type}</span></div>
            <div>Active : <span className="hi">{YES_NO(item.is_active)}</span></div>
          </div>
          <div>
            <h4>Description</h4>
            <div>Display Name : <span className="hi">{item.display_name}</span></div>
            <div>Purchase Description : <span className="hi">{item.purchase_description}</span></div>
            <div>Sales Description : <span className="hi">{item.sales_description}</span></div>
            <div>Sub-Item Of : {item.subItemOf ? (
              <button type="button" className="link-btn" onClick={() => navigate(`/inventory/${item.subItemOf.parent_inventory_id}`)}>
                {item.subItemOf.item_code} — {item.subItemOf.display_name}
              </button>
            ) : <span className="hi">—</span>}</div>
          </div>
          <div>
            <h4>Flags</h4>
            <div>TO Type : <span className="hi">{item.to_type || '—'}</span></div>
            <div>Office Supply Requisition : <span className="hi">{YES_NO(item.is_office_supply)}</span></div>
            <div>TO Item : <span className="hi">{YES_NO(item.is_to_item)}</span></div>
            <div>Reorder Point : <span className="hi">{item.reorder_point ?? 0}</span></div>
            {item.item_type === 'Service' && (
              <>
                <div>With JO : <span className="hi">{YES_NO(item.is_with_jo)}</span></div>
                <div>PO : <span className="hi">{YES_NO(item.is_po)}</span></div>
                <div>JO : <span className="hi">{YES_NO(item.is_jo)}</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'purchasing' ? 'active' : ''}`} onClick={() => setTab('purchasing')}>Purchasing / Inventory</button>
        <button className={`status-tab ${tab === 'detail' ? 'active' : ''}`} onClick={() => setTab('detail')}>Inventory Detail</button>
        <button className={`status-tab ${tab === 'pricing' ? 'active' : ''}`} onClick={() => setTab('pricing')}>Sales / Pricing</button>
        <button className={`status-tab ${tab === 'accounting' ? 'active' : ''}`} onClick={() => setTab('accounting')}>Accounting</button>
        <button className={`status-tab ${tab === 'stocks' ? 'active' : ''}`} onClick={() => setTab('stocks')}>Warehouse Stocks</button>
        <button className={`status-tab ${tab === 'suppliers' ? 'active' : ''}`} onClick={() => setTab('suppliers')}>Supplier Prices</button>
        <button className={`status-tab ${tab === 'subitems' ? 'active' : ''}`} onClick={() => setTab('subitems')}>Sub-Items</button>
        <button className={`status-tab ${tab === 'uom' ? 'active' : ''}`} onClick={() => setTab('uom')}>Unit of Measures</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'purchasing' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>Base Unit : <span className="hi">{item.base_unit_title} ({item.base_unit_code})</span></div>
            <div>Purchase Unit : <span className="hi">{item.purchase_unit_title || '—'}</span></div>
            <div>Stock Unit : <span className="hi">{item.stock_unit_title || '—'}</span></div>
            <div>Sales Unit : <span className="hi">{item.sales_unit_title || '—'}</span></div>
            <div>Conversion Factor : <span className="hi">{item.conversion_factor ?? 1}</span></div>
            <div />
            <div>Last Purchase Price : <span className="hi">{money(item.last_purchase_price)}</span></div>
            <div>Last Purchase Date : <span className="hi">{item.last_purchase_date ? String(item.last_purchase_date).slice(0, 10) : '—'}</span></div>
            <div>Average Cost : <span className="hi">{money(item.average_cost)}</span></div>
          </div>
        </div>
      )}

      {tab === 'detail' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>Priced by Length : <span className="hi">{YES_NO(item.is_length_based)}</span></div>
            <div>Priced by Width : <span className="hi">{YES_NO(item.is_width_based)}</span></div>
            <div>Price Indicator : <span className="hi">{item.price_indicator ?? 0}</span></div>
            <div>Tolerance % : <span className="hi">{item.tolerance_pct ?? 0}</span></div>
          </div>
        </div>
      )}

      {tab === 'pricing' && (
        <div className="card">
          {item.is_costing_approved ? (
            <p className="muted" style={{ marginTop: 0 }}>Costing approved by <strong>{item.costing_approved_by_name}</strong> on {item.costing_approved_at ? new Date(item.costing_approved_at).toLocaleString() : ''}.</p>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>Costing pending approval{!costingReady ? ' — Selling Price must be filled in before it can be approved.' : '.'}</p>
          )}
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div>Material Cost : <span className="hi">{money(item.material_cost)}</span></div>
            <div>Wastage Allowance % : <span className="hi">{item.wastage_allowance_pct ?? 0}</span></div>
            <div>Mark-Up % : <span className="hi">{item.markup_pct ?? 0}</span></div>
            <div>Selling Price : <span className="hi">{money(item.selling_price)}</span></div>
            <div>Beg. Selling Price : <span className="hi">{money(item.beg_selling_price)}</span></div>
            <div>Disc. Ceiling % : <span className="hi">{item.disc_ceiling_pct ?? 0}</span></div>
            <div>Disc. Supervisor % : <span className="hi">{item.disc_supervisor_pct ?? 0}</span></div>
            <div>Disc. Manager % : <span className="hi">{item.disc_manager_pct ?? 0}</span></div>
            <div>Disc. GM % : <span className="hi">{item.disc_gm_pct ?? 0}</span></div>
          </div>
          <h3 className="subsection">Price Tiers</h3>
          <DataTable
            columns={[
              { key: 'min_qty', label: 'Min Qty' },
              { key: 'max_qty', label: 'Max Qty', render: (r) => r.max_qty ?? '∞' },
              { key: 'unit_price', label: 'Unit Price', render: (r) => money(r.unit_price) },
            ]}
            rows={item.priceTiers || []}
            emptyLabel="No price tiers."
          />
        </div>
      )}

      {tab === 'accounting' && (
        <div className="card">
          {item.is_accounting_approved ? (
            <p className="muted" style={{ marginTop: 0 }}>Accounting approved by <strong>{item.accounting_approved_by_name}</strong> on {item.accounting_approved_at ? new Date(item.accounting_approved_at).toLocaleString() : ''}.</p>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>Accounting pending approval{!accountingReady ? ' — Asset, COGS, and Income accounts must all be set before it can be approved.' : '.'}</p>
          )}
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>Expense Account : <span className="hi">{item.expense_account_code ? `${item.expense_account_code} — ${item.expense_account_name}` : '—'}</span></div>
            <div>COGS Account : <span className="hi">{item.cogs_account_code ? `${item.cogs_account_code} — ${item.cogs_account_name}` : '—'}</span></div>
            <div>Asset Account : <span className="hi">{item.asset_account_code ? `${item.asset_account_code} — ${item.asset_account_name}` : '—'}</span></div>
            <div>Income Account : <span className="hi">{item.income_account_code ? `${item.income_account_code} — ${item.income_account_name}` : '—'}</span></div>
          </div>
        </div>
      )}

      {tab === 'stocks' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Location</th><th>Qty On Hand</th><th>Qty Committed</th><th>Qty In Transit</th><th>Average Cost</th><th>Total Value</th></tr></thead>
              <tbody>
                {stock.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No warehouse stock.</td></tr>
                )}
                {stock.map((s) => (
                  <tr key={s.id}>
                    <td>{s.location_name}</td>
                    <td>{s.qty_on_hand}</td>
                    <td>{s.qty_committed}</td>
                    <td>{s.qty_in_transit ?? 0}</td>
                    <td>{money(item.average_cost)}</td>
                    <td>{money(num(s.qty_on_hand) * num(item.average_cost))}</td>
                  </tr>
                ))}
              </tbody>
              {stock.length > 0 && (
                <tfoot>
                  <tr>
                    <td><strong>Total</strong></td>
                    <td><strong>{totalQtyOnHand}</strong></td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td><strong>{money(totalValue)}</strong></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {tab === 'suppliers' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'supplier_name', label: 'Supplier' },
              { key: 'price', label: 'Price', render: (r) => money(r.price) },
              { key: 'last_purchase_date', label: 'Last Purchase Date', render: (r) => (r.last_purchase_date ? String(r.last_purchase_date).slice(0, 10) : '') },
              { key: 'ref_no', label: 'Ref No.' },
            ]}
            rows={item.supplierPrices || []}
            actions={canEdit ? (r) => <button className="btn btn-sm btn-danger" onClick={() => removeSupplierPrice(r.id)}>Remove</button> : undefined}
            emptyLabel="No supplier prices yet."
          />
          {canEdit && (
            <div className="inline-form" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Supplier</label>
                <select value={newSupplierPrice.supplier_id} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, supplier_id: e.target.value })}>
                  <option value="">—</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Price</label>
                <input type="number" step="0.0001" value={newSupplierPrice.price} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, price: e.target.value })} />
              </div>
              <div className="field">
                <label>Last Purchase Date</label>
                <input type="date" value={newSupplierPrice.last_purchase_date} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, last_purchase_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Ref No.</label>
                <input value={newSupplierPrice.ref_no} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, ref_no: e.target.value })} />
              </div>
              <button type="button" className="btn" onClick={addSupplierPrice}>Add</button>
            </div>
          )}
        </div>
      )}

      {tab === 'subitems' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'item_code', label: 'Code' },
              { key: 'display_name', label: 'Name' },
              { key: 'sales_description', label: 'Description' },
              { key: 'qty', label: 'Qty' },
            ]}
            rows={item.subItems || []}
            actions={canEdit ? (r) => <button className="btn btn-sm btn-danger" onClick={() => removeSubItem(r.id)}>Remove</button> : undefined}
            emptyLabel="No sub-items yet."
          />
          {canEdit && (
            <div className="inline-form" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Qty</label>
                <input type="number" step="0.0001" style={{ width: 100 }} value={newSubItemQty} onChange={(e) => setNewSubItemQty(e.target.value)} />
              </div>
              <div className="field">
                <label>Item</label>
                <EntityPicker
                  label="Item" items={otherInventories} value="" getLabel={(i) => i.display_name}
                  columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }, { key: 'category_name', label: 'Category' }]}
                  searchKeys={['item_code', 'display_name']}
                  onSelect={addSubItem}
                  placeholder="Add Items..."
                />
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'uom' && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Unit codes usable for this item specifically -- these populate the Unit dropdown on Estimate process lines once this item is selected.
          </p>
          <DataTable
            columns={[{ key: 'code', label: 'Unit Of Measure' }]}
            rows={item.unitOfMeasures || []}
            actions={canEdit ? (r) => <button className="btn btn-sm btn-danger" onClick={() => removeUom(r.id)}>Delete</button> : undefined}
            emptyLabel="No unit of measures yet."
          />
          {canEdit && (
            <div className="inline-form" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Code</label>
                <input value={newUom} onChange={(e) => setNewUom(e.target.value)} placeholder="e.g. GAL" />
              </div>
              <button type="button" className="btn" onClick={addUom}>Add Unit of Measure</button>
            </div>
          )}
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => new Date(r.set_at).toLocaleString() },
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
