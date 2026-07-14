import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { computeMaterialCosting } from '../utils/costing';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Mirrors the real GraphicStar "Material Cost" screen (#/material-costs) -- a
// spreadsheet-style list of inventory items where Sales/Pricing costing fields are
// edited inline, with Wastage Allowance Amount/SubTotal/Mark-Up Amount recomputed live
// as you type (matching the real MaterialCostController's Compute()). Selling Price is
// also editable here (the real system only exposes that on its separate CRUD form, but
// the user asked for this screen to be "where we update the inventory sales/pricing"),
// while approval itself still goes through the existing approve-costing endpoint, which
// keeps requiring Selling Price > 0 -- that gate is untouched by this page.
//
// Material Cost (Base Cost) is what actually drives the Wastage/SubTotal/Mark-Up chain
// -- it's a distinct, separately-maintained field from Average Cost (the real weighted-
// average purchase cost, used for stock valuation elsewhere). Real Average Cost and Last
// Purchase Price are each tracked per stock/purchase unit, then shown a second time
// normalized to the item's base unit ("(Base Cost)") when a conversion factor applies.
const STATUS_TABS = [
  { key: 'for_approval_costing', label: 'For Approval Costing' },
  { key: 'for_approval_accounting', label: 'For Approval Accounting' },
  { key: 'approved', label: 'Approved' },
  { key: 'inactive', label: 'Inactive' },
];

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
// "(Base Cost)" columns mirror the real screen's own pair-up: Last Purchase Price and
// Average Cost are tracked in the item's stock/purchase unit, then shown a second time
// normalized into the base unit by dividing out the conversion factor (e.g. a cost
// tracked per ROLL, where 1 ROLL = 5 LMTR base units, shown per-LMTR here too).
function baseCost(raw, conversionFactor) {
  const cf = num(conversionFactor) || 1;
  return num(raw) / cf;
}

export default function MaterialCosting() {
  const { can } = useAuth();

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('for_approval_costing');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [approvingId, setApprovingId] = useState(null);
  const [rowErrors, setRowErrors] = useState({});

  async function load() {
    setLoading(true);
    const params = { status, with_counts: 1 };
    if (search) params.search = search;
    const { data } = await api.get('/inventory', { params });
    setRows(data.rows);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]);

  function runSearch() {
    setPage(1);
    load();
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const canEdit = can('/inventory', 'can_edit');
  const canApprove = can('/inventory', 'can_approve');

  function updateField(id, field, value) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  async function commitField(row, field) {
    try {
      const payload = { ...row, [field]: row[field] === '' ? null : row[field] };
      await api.put(`/inventory/${row.id}`, payload);
    } catch (err) {
      alert(err.response?.data?.error || 'Save failed');
      load();
    }
  }

  async function handleApproveCosting(row) {
    setApprovingId(row.id);
    setRowErrors((prev) => ({ ...prev, [row.id]: '' }));
    try {
      await api.put(`/inventory/${row.id}/approve-costing`);
      load();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.id]: err.response?.data?.error || 'Approve Costing failed' }));
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Material Costing</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Item code, name, description..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${status === t.key ? 'active' : ''}`}
            onClick={() => setStatus(t.key)}
          >
            {t.label} <span className="badge badge-muted">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="spreadsheet-wrap">
            <table className="spreadsheet-table">
              <thead>
                <tr>
                  <th>Item Code</th>
                  <th>Display Name</th>
                  <th>Unit</th>
                  <th>Last Purchase Price</th>
                  <th>Last Purchase Price (Base Cost)</th>
                  <th>Average Cost</th>
                  <th>Average Cost (Base Cost)</th>
                  <th>Material Cost (Base Cost)</th>
                  <th>Wastage Allow. %</th>
                  <th>Wastage Allow. Amt</th>
                  <th>SubTotal</th>
                  <th>Mark-Up %</th>
                  <th>Mark-Up Amt</th>
                  <th>Selling Price</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={15} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items found.</td></tr>
                )}
                {pageRows.map((row) => {
                  const computed = computeMaterialCosting(row);
                  const canApproveCosting = canApprove && status === 'for_approval_costing' && !row.is_costing_approved;
                  return (
                    <tr key={row.id}>
                      <td>{row.item_code}</td>
                      <td>{row.display_name}</td>
                      <td>{row.base_unit_title}</td>
                      <td>{money(row.last_purchase_price)}</td>
                      <td>{money(baseCost(row.last_purchase_price, row.conversion_factor))}</td>
                      <td>{money(row.average_cost)}</td>
                      <td>{money(baseCost(row.average_cost, row.conversion_factor))}</td>
                      <td>
                        <input
                          type="number" step="0.0001" disabled={!canEdit}
                          value={row.material_cost ?? ''}
                          onChange={(e) => updateField(row.id, 'material_cost', e.target.value)}
                          onBlur={() => commitField(row, 'material_cost')}
                        />
                      </td>
                      <td>
                        <input
                          type="number" step="0.01" disabled={!canEdit}
                          value={row.wastage_allowance_pct ?? ''}
                          onChange={(e) => updateField(row.id, 'wastage_allowance_pct', e.target.value)}
                          onBlur={() => commitField(row, 'wastage_allowance_pct')}
                        />
                      </td>
                      <td>{money(computed.wastage)}</td>
                      <td>{money(computed.costPerUnit)}</td>
                      <td>
                        <input
                          type="number" step="0.01" disabled={!canEdit}
                          value={row.markup_pct ?? ''}
                          onChange={(e) => updateField(row.id, 'markup_pct', e.target.value)}
                          onBlur={() => commitField(row, 'markup_pct')}
                        />
                      </td>
                      <td>{money(computed.priceUnrounded - computed.costPerUnit)}</td>
                      <td>
                        <input
                          type="number" step="0.0001" disabled={!canEdit}
                          style={{ fontWeight: 600 }}
                          value={row.selling_price ?? ''}
                          placeholder={money(computed.pricePerUnit)}
                          onChange={(e) => updateField(row.id, 'selling_price', e.target.value)}
                          onBlur={() => commitField(row, 'selling_price')}
                        />
                      </td>
                      <td style={{ display: 'flex', gap: 6, flexDirection: 'column', alignItems: 'flex-start' }}>
                        <Link className="btn btn-sm" to={`/inventory/${row.id}`}>View</Link>
                        {canApproveCosting && (
                          <button type="button" className="btn btn-sm btn-primary" disabled={approvingId === row.id} onClick={() => handleApproveCosting(row)}>
                            Approve Costing
                          </button>
                        )}
                        {rowErrors[row.id] && <span className="muted" style={{ color: 'var(--danger)', fontSize: 12 }}>{rowErrors[row.id]}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
