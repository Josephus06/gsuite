import { useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import { computeInk } from '../utils/processInk';

// The Materials and Ink tabs of a process (2026-11-04), as the source's process set-up shows them:
// Materials lists the items the process uses; Ink lists its inks with their Ink Price and Volume (one
// container's ml) and works out the Ink Calculation underneath -- utils/processInk.js, Costing's INK
// COST workbook. Read-only on the view page; on the
// edit page `onChange(patch)` receives { materials } / { inks } / an ink field.

const fmt = (v, d = 2) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function ItemPicker({ label, onSelect }) {
  const [items, setItems] = useState([]);
  const search = (q) => api.get('/processes/inventory-search', { params: { q } }).then(({ data }) => setItems(data)).catch(() => {});
  return (
    <EntityPicker
      label={label} items={items} value="" getLabel={(i) => i?.item_code}
      columns={[{ key: 'item_code', label: 'Item Code' }, { key: 'display_name', label: 'Name' },
        { key: 'last_purchase_price', label: 'Last Purchase Price' }, { key: 'average_cost', label: 'Average Cost' }]}
      searchKeys={['item_code', 'display_name']}
      onSearch={search} onSelect={onSelect}
      triggerLabel={label} triggerClassName="btn btn-sm btn-primary"
    />
  );
}

const asRow = (i) => ({ inventory_id: i.id, item_code: i.item_code, display_name: i.display_name, last_purchase_price: i.last_purchase_price, average_cost: i.average_cost });

export function MaterialsTab({ materials, editable, onChange }) {
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Material</th><th className="text-right">Last Purchase Price</th><th className="text-right">Average Cost</th>{editable && <th />}</tr>
          </thead>
          <tbody>
            {materials.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 16 }}>No materials.</td></tr>}
            {materials.map((m, idx) => (
              <tr key={`${m.inventory_id}-${idx}`}>
                <td>{m.item_code}{m.display_name && m.display_name !== m.item_code ? <span className="muted"> — {m.display_name}</span> : null}</td>
                <td className="text-right">{fmt(m.last_purchase_price)}</td>
                <td className="text-right">{fmt(m.average_cost)}</td>
                {editable && (
                  <td style={{ width: 80 }}>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => onChange({ materials: materials.filter((_, i) => i !== idx) })}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div style={{ marginTop: 12 }}>
          <ItemPicker label="Add Material" onSelect={(i) => onChange({ materials: [...materials, asRow(i)] })} />
        </div>
      )}
    </div>
  );
}

// Media usage is measured in the process's UOM (SQFT, LI INCH ...), so the per-unit labels follow it.
const unitOf = (p) => String(p.base_unit_code || 'SQFT').toUpperCase();

export function InkTab({ process, inks, editable, onChange }) {
  const c = computeInk(process, inks);
  const U = unitOf(process);
  const box = (value, onEdit, placeholder) => (
    <input type="number" step="any" value={value ?? ''} placeholder={placeholder} onChange={(e) => onEdit(e.target.value)}
      style={{ width: 120, textAlign: 'right' }} />
  );
  const input = (f, label, unit) => (
    <tr key={f}>
      <td>{label}</td>
      <td className="text-right">{editable ? box(process[f], (v) => onChange({ [f]: v })) : fmt(process[f])}</td>
      <td>{unit}</td><td /><td />
    </tr>
  );
  const calc = (label, value, unit) => (
    <tr key={label}><td>{label}</td><td className="text-right">{fmt(value)}</td><td>{unit}</td><td /><td /></tr>
  );
  // COSTING PRICE: the workbook's MANUAL column. Blank = the computed figure rounded to 2 decimals.
  const manual = (label, value, unit, f, costing) => (
    <tr key={label}>
      <td>{label}</td><td className="text-right">{fmt(value)}</td><td>{unit}</td>
      <td className="text-right">
        {editable ? box(process[f], (v) => onChange({ [f]: v }), fmt(costing)) : fmt(costing)}
      </td>
      <td>{unit}</td>
    </tr>
  );
  const gap = (k) => <tr key={k}><td colSpan={5} style={{ padding: 6 }} /></tr>;

  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Material</th><th className="text-right">Last Purchase Price</th><th className="text-right">Average Cost</th>
              <th className="text-right">Ink Price</th><th className="text-right">Volume (ML)</th>{editable && <th />}
            </tr>
          </thead>
          <tbody>
            {inks.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>No inks.</td></tr>}
            {inks.map((m, idx) => {
              const patch = (k, v) => onChange({ inks: inks.map((x, i) => (i === idx ? { ...x, [k]: v } : x)) });
              return (
                <tr key={`${m.inventory_id}-${idx}`}>
                  <td>{m.item_code}</td>
                  <td className="text-right">{fmt(m.last_purchase_price)}</td>
                  <td className="text-right">{fmt(m.average_cost)}</td>
                  <td className="text-right">{editable ? box(m.ink_price, (v) => patch('ink_price', v)) : fmt(m.ink_price)}</td>
                  <td className="text-right">
                    {editable ? box(m.volume_ml, (v) => patch('volume_ml', v), fmt(process.ink_volume)) : fmt(c.volumeOf(m))}
                  </td>
                  {editable && (
                    <td style={{ width: 80 }}>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => onChange({ inks: inks.filter((_, i) => i !== idx) })}>Delete</button>
                    </td>
                  )}
                </tr>
              );
            })}
            {inks.length > 0 && (
              <>
                <tr style={{ fontWeight: 600 }}><td colSpan={3} /><td className="text-right">{fmt(c.totalPrice)}</td><td className="text-right">{fmt(c.totalVolume)}</td>{editable && <td />}</tr>
                <tr style={{ fontWeight: 600 }}><td colSpan={3} /><td className="text-right">PER ML</td><td className="text-right">{fmt(c.perMl)}</td>{editable && <td />}</tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      {editable && (
        <div style={{ marginTop: 12 }}>
          <ItemPicker label="Add Ink" onSelect={(i) => onChange({ inks: [...inks, { ...asRow(i), ink_price: i.last_purchase_price ?? '', volume_ml: process.ink_volume ?? '' }] })} />
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr><th colSpan={3}>INK CALCULATION</th><th className="text-right" colSpan={2}>COSTING PRICE (manual)</th></tr>
          </thead>
          <tbody>
            {input('ink_media_usage', 'MEDIA USAGE', U)}
            {input('ink_media_weight_wo_print', 'MEDIA WEIGHT W/O PRINT', 'GMS')}
            {input('ink_media_weight_w_print', 'MEDIA WEIGHT W/ PRINT', 'GMS')}
            {calc('INK WEIGHT = (Media w/ Print - Media w/o Print)', c.inkWeight, 'GMS')}
            {gap('g1')}
            {calc(`INK PER ${U} = (Ink Weight / Media Usage)`, c.inkPerUnit, `GMS/${U}`)}
            {gap('g2')}
            {input('ink_weight_full', 'WEIGHT OF INK - (Full Container)', 'GMS')}
            {input('ink_weight_empty', 'WEIGHT OF INK - (Empty Container)', 'GMS')}
            {calc('NET INK WEIGHT = (Full - Empty)', c.netInkWeight, 'GMS')}
            {gap('g3')}
            {input('ink_volume', 'INK VOLUME', 'ML')}
            {calc('INK DENSITY = (Net Ink Weight / Ink Volume)', c.density, 'GMS/ML')}
            {gap('g4')}
            {manual(`INK USAGE = (Ink per ${U} / Ink Density)`, c.inkUsage, `ML/${U}`, 'ink_usage_costing', c.usageCosting)}
            {manual('INK PRICE PER ML = (Total Ink Price / Total Volume)', c.perMl, 'PER ML', 'ink_price_per_ml_costing', c.perMlCosting)}
            <tr style={{ fontWeight: 700 }}>
              <td>{`INK COST PER ${U} = (Ink Usage x Ink Price per ML)`}</td><td className="text-right">{fmt(c.costPerUnit)}</td><td>{`PER ${U}`}</td>
              <td className="text-right">{fmt(c.costPerUnitCosting)}</td><td>{`PER ${U}`}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Costing Price: type a manual Ink Usage or Ink Price per ML to override; left blank, it takes the computed figure rounded to 2 decimals.
        </div>
      )}
    </div>
  );
}
