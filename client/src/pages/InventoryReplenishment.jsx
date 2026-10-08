import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';

// Purchasing > Inventory Replenishment: the INVENTORY-type items (the ones kept on the shelf --
// JIT items are bought per job and never stocked) whose stock will not cover the job orders in
// production. Every figure is worked out on the server (routes/replenishment.js), in the item's
// base unit; To Order is also given in the unit it is bought in. A row opens on the job orders
// behind its Required figure.
const STAGE_LABEL = { pending_for_scheduling: 'Pending for Sched.', in_process: 'In Process', partially_completed: 'Partially Completed' };

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
}

export default function InventoryReplenishment() {
  const [data, setData] = useState({ rows: [], days: 120, placeholders_excluded: 0 });
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState('120');
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [open, setOpen] = useState(null); // { itemId, rows }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/replenishment', { params: { days, all: showAll ? 1 : undefined } })
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, showAll]);

  useAutoSearch(search, () => setApplied(search));

  async function toggle(itemId) {
    if (open?.itemId === itemId) { setOpen(null); return; }
    setOpen({ itemId, rows: null });
    const { data: rows } = await api.get(`/replenishment/${itemId}/job-orders`, { params: { days } });
    setOpen((o) => (o?.itemId === itemId ? { itemId, rows } : o));
  }

  const q = applied.trim().toLowerCase();
  const rows = data.rows.filter((r) => !q
    || String(r.item_code).toLowerCase().includes(q)
    || String(r.display_name || '').toLowerCase().includes(q)
    || String(r.category_name || '').toLowerCase().includes(q));

  return (
    <div>
      <div className="page-header">
        <h1>Inventory Replenishment</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 360px' }}>
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setApplied(search)} placeholder="Item code, name or category..." />
          </div>
          <div className="field" style={{ width: 230 }}>
            <label>Job Orders counted</label>
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="30">Sales order in the last 30 days</option>
              <option value="60">Sales order in the last 60 days</option>
              <option value="120">Sales order in the last 120 days</option>
              <option value="365">Sales order in the last year</option>
              <option value="0">All in production</option>
            </select>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="rep-all" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            <label htmlFor="rep-all">Also show items that are covered</label>
          </div>
        </div>
        <p className="muted" style={{ margin: '10px 0 0' }}>
          INVENTORY items only. <strong>Required</strong> is what job orders Pending for Scheduling, In
          Process or Partially Completed still need; <strong>On Order</strong> is what approved
          purchase orders have yet to deliver. <strong>To Order</strong> = Required + Reorder Point −
          On Hand − On Order. Quantities are in the item&apos;s base unit; the last column is in the
          unit it is bought in.
          {data.placeholders_excluded > 0 && ` ${data.placeholders_excluded} job order line(s) carrying a placeholder quantity are left out.`}
        </p>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item Code</th><th>Item</th><th>Category</th><th>Unit</th>
                  <th className="text-right">Required</th><th className="text-right">JOs</th>
                  <th className="text-right">Reorder Pt.</th><th className="text-right">On Hand</th>
                  <th className="text-right">On Order</th><th className="text-right">Pending PO Approval</th>
                  <th className="text-right">To Order</th><th className="text-right">To Order (Purchase Unit)</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    {showAll ? 'No INVENTORY items are needed by job orders in production.' : 'Nothing to replenish -- every INVENTORY item in use is covered.'}
                  </td></tr>
                )}
                {rows.map((r) => (
                  <Fragment key={r.item_id}>
                    <tr className="is-clickable" onClick={() => toggle(r.item_id)} title="Show the job orders behind Required">
                      <td><Link to={`/inventory/${r.item_id}`} onClick={(e) => e.stopPropagation()}>{r.item_code}</Link></td>
                      <td>{r.display_name}</td>
                      <td>{r.category_name}</td>
                      <td>{r.base_unit}</td>
                      <td className="text-right">{qty(r.required)}</td>
                      <td className="text-right">{r.jo_count || '—'}</td>
                      <td className="text-right">{qty(r.reorder_point)}</td>
                      <td className="text-right" style={r.on_hand < 0 ? { color: 'var(--danger, #b91c1c)' } : undefined}>{qty(r.on_hand)}</td>
                      <td className="text-right">{qty(r.on_order)}</td>
                      <td className="text-right muted">{qty(r.pending_approval)}</td>
                      <td className="text-right"><strong>{qty(r.to_order)}</strong></td>
                      <td className="text-right"><strong>{r.to_order_purchase_unit ? `${r.to_order_purchase_unit.toLocaleString('en-US')} ${r.purchase_unit || ''}` : '—'}</strong></td>
                    </tr>
                    {open?.itemId === r.item_id && (
                      <tr>
                        <td />
                        <td colSpan={11} style={{ padding: 0 }}>
                          {!open.rows ? <LoadingSpinner /> : (
                            <table style={{ width: '100%' }}>
                              <thead><tr><th>Job Order</th><th>Stage</th><th>Location</th><th>SO Date</th><th>Delivery</th><th className="text-right">Still Needed ({r.base_unit})</th></tr></thead>
                              <tbody>
                                {open.rows.map((j) => (
                                  <tr key={j.id}>
                                    <td><Link to={`/job-orders/${j.id}`}>{j.job_order_no}</Link></td>
                                    <td>{STAGE_LABEL[j.production_stage] || j.production_stage}</td>
                                    <td>{j.location_name}</td>
                                    <td>{j.so_date ? String(j.so_date).slice(0, 10) : '—'}</td>
                                    <td>{j.delivery_date ? String(j.delivery_date).slice(0, 10) : '—'}</td>
                                    <td className="text-right">{qty(j.required)}</td>
                                  </tr>
                                ))}
                                {open.rows.length === 0 && <tr><td colSpan={6} className="muted">Not needed by any job order in this window.</td></tr>}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
