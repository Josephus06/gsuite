import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

// "Create RWIP" modal on a Production job order's RWIP JO tab. Mirrors the NSSO Create-JO modal --
// the mother JO's header, Reason Code / Reason / Action, editable process rows -- plus a Delivery
// Date/Time. Saving raises an RWIP-### job order that starts in "Pending RMA Approval".
export default function RwipCreateModal({ jobOrderId, onClose, onSaved }) {
  const [jo, setJo] = useState(null);
  const [meta, setMeta] = useState(null);
  const [reasonCode, setReasonCode] = useState(null);
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [deliveryTime, setDeliveryTime] = useState('');
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/production/${jobOrderId}/rwip-draft`),
      api.get('/non-standard-sales-orders/meta'),
    ]).then(([d, m]) => {
      setJo(d.data.jo);
      setMeta(m.data);
      setDeliveryDate(d.data.jo.delivery_date ? String(d.data.jo.delivery_date).slice(0, 10) : '');
      setDeliveryTime(d.data.jo.delivery_time || '');
      setRows((d.data.processes || []).map((p) => ({ ...p })));
    }).catch((e) => setError(e.response?.data?.error || 'Failed to load.'));
  }, [jobOrderId]);

  const setRow = (i, patch) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const addRow = () => setRows((r) => [...r, { process_id: null, process_name: '', process_qty: 0, process_uom: '', category: '', parts: '', item_id: null, item_name: '', length: '', width: '', uom: '', qty: 0, unit: '', remarks: '' }]);
  const delRow = (i) => setRows((r) => r.filter((_, idx) => idx !== i));

  async function save() {
    setError(''); setSaving(true);
    try {
      const processes = rows.map((r) => ({
        process_id: r.process_id || null, process_qty: r.process_qty, process_uom: r.process_uom, category: r.category,
        parts: r.parts, item_id: r.item_id || null, length: r.length, width: r.width, uom: r.uom, qty: r.qty, unit: r.unit, remarks: r.remarks,
      }));
      const { data } = await api.post(`/production/${jobOrderId}/rwip`, {
        reason_code_id: reasonCode?.id || null, reason: reason || null, action_to_be_taken: action || null,
        delivery_date: deliveryDate || null, delivery_time: deliveryTime || null, processes,
      });
      onSaved(data);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  return (
    <Modal title="RWIP Job Order" onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      {!jo ? <LoadingSpinner /> : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, lineHeight: 1.8, marginBottom: 12 }}>
            <div>
              <div>Customer : <span className="hi">{jo.customer_name || '—'}</span></div>
              <div>Contact Person : <span className="hi">{jo.contact_person_name || ''}</span></div>
              <div>Contact Phone : <span className="hi">{jo.contact_phone || ''}</span></div>
              <div>JO Ref. # : <span className="hi">{jo.job_order_no}</span></div>
            </div>
            <div>
              <div>Office Location : <span className="hi">{jo.office_location_name || ''}</span></div>
              <div>Sales Division : <span className="hi">{jo.sales_division_name || ''}</span></div>
              <div>Sales Rep : <span className="hi">{jo.sales_rep_name || ''}</span></div>
              <div className="field" style={{ marginTop: 6 }}><label>Delivery Date</label>
                <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} /></div>
              <div className="field"><label>Delivery Time</label>
                <input type="time" value={deliveryTime} onChange={(e) => setDeliveryTime(e.target.value)} /></div>
            </div>
            <div>
              <div>Job Type : <span className="hi">{jo.job_type_name || ''}</span></div>
              <div>Job Desc. : <span className="hi">{jo.description || ''}</span></div>
              <div>Job Location : <span className="hi">{jo.job_location_name || ''}</span></div>
              <div>Quantity : <span className="hi">{Number(jo.quantity)} {jo.units || ''}</span></div>
              <div>Length : <span className="hi">{jo.length ?? 0}</span> Width : <span className="hi">{jo.width ?? 0}</span> Height : <span className="hi">{jo.height ?? 0}</span></div>
            </div>
          </div>

          <div className="filter-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
            <div className="field">
              <label>Reason Code</label>
              <EntityPicker label="Reason Code" items={meta?.reasons || []} value={reasonCode?.id || ''} getLabel={(x) => x.name}
                columns={[{ key: 'name', label: 'Name' }, { key: 'reason_type', label: 'Type' }]} searchKeys={['name']} placeholder="--Select--" onSelect={setReasonCode} />
            </div>
            <div className="field">
              <label>Reason</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
            </div>
            <div className="field">
              <label>Action/s to be taken</label>
              <textarea value={action} onChange={(e) => setAction(e.target.value)} rows={2} />
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead><tr>
                <th></th><th>Process</th><th>Process Qty</th><th>Process UOM</th><th>Category</th><th>Parts</th>
                <th>Item</th><th>Length</th><th>Width</th><th>UOM</th><th>Qty</th><th>Unit</th><th>Remarks</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 12 }}>No processes. Click Add.</td></tr>}
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><button type="button" className="btn btn-sm btn-warning" onClick={() => delRow(i)}>✕</button></td>
                    <td style={{ minWidth: 200 }}>
                      <EntityPicker label="Process" items={meta?.processes || []} value={r.process_id || ''} getLabel={(p) => p.process_name}
                        columns={[{ key: 'process_code', label: 'Code' }, { key: 'process_name', label: 'Name' }]} searchKeys={['process_code', 'process_name']}
                        placeholder={r.process_name || '--Select--'} onSelect={(p) => setRow(i, { process_id: p?.id || null, process_name: p?.process_name || '' })} />
                    </td>
                    <td><input type="number" value={r.process_qty ?? 0} onChange={(e) => setRow(i, { process_qty: e.target.value })} style={{ width: 70 }} /></td>
                    <td><input value={r.process_uom || ''} onChange={(e) => setRow(i, { process_uom: e.target.value })} style={{ width: 70 }} /></td>
                    <td><input value={r.category || ''} onChange={(e) => setRow(i, { category: e.target.value })} style={{ width: 90 }} /></td>
                    <td><input value={r.parts || ''} onChange={(e) => setRow(i, { parts: e.target.value })} style={{ width: 90 }} /></td>
                    <td style={{ minWidth: 200 }}>
                      <EntityPicker label="Item" items={meta?.items || []} value={r.item_id || ''} getLabel={(x) => x.display_name}
                        columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]} searchKeys={['item_code', 'display_name']}
                        placeholder={r.item_name || '--Select--'} onSelect={(x) => setRow(i, { item_id: x?.id || null, item_name: x?.display_name || '' })} />
                    </td>
                    <td><input type="number" value={r.length ?? ''} onChange={(e) => setRow(i, { length: e.target.value })} style={{ width: 60 }} /></td>
                    <td><input type="number" value={r.width ?? ''} onChange={(e) => setRow(i, { width: e.target.value })} style={{ width: 60 }} /></td>
                    <td><input value={r.uom || ''} onChange={(e) => setRow(i, { uom: e.target.value })} style={{ width: 60 }} /></td>
                    <td><input type="number" value={r.qty ?? 0} onChange={(e) => setRow(i, { qty: e.target.value })} style={{ width: 60 }} /></td>
                    <td><input value={r.unit || ''} onChange={(e) => setRow(i, { unit: e.target.value })} style={{ width: 60 }} /></td>
                    <td><input value={r.remarks || ''} onChange={(e) => setRow(i, { remarks: e.target.value })} style={{ width: 120 }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
            <button className="btn btn-sm btn-primary" onClick={addRow}>Add</button>
            <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save JO'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
