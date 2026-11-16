import { useEffect, useState } from 'react';
import api from '../api/client';
import { displayAuditTime } from '../utils/dates';

// The JO punchlist (asked 2026-11-16): the Job Order's own lines -- every row of its Processes table
// -- ticked off one by one, plus any extra item added for this job. A required item still open stops
// QC from completing the JO. Regular Job Orders only; the server answers applicable: false for
// NSJO / RWIP / RFQC.
export function isChecklistJobOrder(jo) {
  if (!jo || jo.nsso_id) return false;
  const no = String(jo.job_order_no || '');
  return !no.startsWith('RWIP-') && !no.startsWith('RFQC-');
}

const qtyOf = (i) => [i.qty ?? i.process_qty, i.uom || i.process_uom].filter((v) => v !== null && v !== undefined && v !== '').join(' ');

export default function JoChecklist({ jobOrderId, onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newText, setNewText] = useState('');
  const [newRequired, setNewRequired] = useState(true);
  const [noteDraft, setNoteDraft] = useState({}); // itemId -> text while editing

  function load() {
    return api.get(`/job-orders/${jobOrderId}/checklist`)
      .then(({ data: d }) => { setData(d); onChange?.(d); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the checklist.'));
  }
  useEffect(() => { load(); }, [jobOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function call(fn) {
    setBusy(true);
    setError('');
    try { await fn(); await load(); return true; } catch (err) {
      setError(err.response?.data?.error || 'Could not save.');
      return false;
    } finally { setBusy(false); }
  }
  const put = (id, body) => call(() => api.put(`/job-orders/${jobOrderId}/checklist/${id}`, body));
  const dropDraft = (id) => setNoteDraft(({ [id]: _, ...rest }) => rest);

  if (!data) return <div className="card">{error ? <div className="error-banner">{error}</div> : <p className="muted">Loading checklist...</p>}</div>;
  if (!data.applicable) return <div className="card"><p className="muted" style={{ margin: 0 }}>Only regular Job Orders have a checklist.</p></div>;

  const items = data.items || [];
  const done = items.filter((i) => i.is_done).length;
  const openRequired = items.filter((i) => i.is_required && !i.is_done).length;
  const canWork = !!data.can_work;
  const cols = canWork ? 10 : 9;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <strong>{done} of {items.length} done</strong>
        <span className={openRequired ? '' : 'muted'} style={openRequired ? { color: 'var(--danger, #c0392b)' } : undefined}>
          {openRequired
            ? `${openRequired} required item${openRequired === 1 ? '' : 's'} open -- QC cannot complete this JO until they are ticked`
            : 'Every required item is done'}
        </span>
      </div>
      {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>Done</th><th>#</th><th>Process</th><th>Item</th><th>Location</th><th>Qty</th>
              <th>Required</th><th>Done By</th><th>Note</th>{canWork && <th></th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={cols} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                This Job Order has no process lines yet. They appear here as they are added; extra items can be added below.
              </td></tr>
            )}
            {items.map((i) => {
              const isLine = !!i.job_order_process_id;
              const editingNote = noteDraft[i.id] !== undefined;
              const struck = i.is_done ? { textDecoration: 'line-through', opacity: 0.7 } : undefined;
              return (
                <tr key={i.id}>
                  <td data-label="Done">
                    <input type="checkbox" checked={!!i.is_done} disabled={!canWork || busy} onChange={(e) => put(i.id, { is_done: e.target.checked })} />
                  </td>
                  <td data-label="#">{isLine ? i.line_no : ''}</td>
                  <td data-label="Process" style={struck}>{isLine ? i.process_name : <em>{i.item_text}</em>}</td>
                  <td data-label="Item" style={struck}>{isLine ? i.item_name : <span className="muted">Added for this JO</span>}</td>
                  <td data-label="Location">{i.location_name}</td>
                  <td data-label="Qty">{isLine ? qtyOf(i) : ''}</td>
                  <td data-label="Required">
                    {canWork
                      ? <input type="checkbox" checked={!!i.is_required} disabled={busy} onChange={(e) => put(i.id, { is_required: e.target.checked })} />
                      : (i.is_required ? 'Yes' : 'No')}
                  </td>
                  <td data-label="Done By">{i.is_done ? <>{i.done_by_name}<div className="muted" style={{ fontSize: 11 }}>{displayAuditTime(i.done_at)}</div></> : ''}</td>
                  <td data-label="Note">
                    {editingNote ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input value={noteDraft[i.id]} maxLength={500} onChange={(e) => setNoteDraft({ ...noteDraft, [i.id]: e.target.value })} />
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={async () => { if (await put(i.id, { note: noteDraft[i.id] })) dropDraft(i.id); }}>Save</button>
                        <button className="btn btn-sm" onClick={() => dropDraft(i.id)}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        {i.note}
                        {canWork && <button className="btn btn-sm" style={{ marginLeft: i.note ? 6 : 0 }} onClick={() => setNoteDraft({ ...noteDraft, [i.id]: i.note || '' })}>{i.note ? 'Edit' : 'Add note'}</button>}
                      </>
                    )}
                  </td>
                  {canWork && (
                    <td>
                      {/* A process line stays as long as it is on the JO -- untick Required instead. */}
                      {!isLine && (
                        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => {
                          if (window.confirm(`Remove "${i.item_text}" from this Job Order's checklist?`)) call(() => api.delete(`/job-orders/${jobOrderId}/checklist/${i.id}`));
                        }}>Remove</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canWork && (
        <form className="inline-form" style={{ marginTop: 10 }} onSubmit={async (e) => {
          e.preventDefault();
          if (!newText.trim()) return;
          if (await call(() => api.post(`/job-orders/${jobOrderId}/checklist`, { item_text: newText, is_required: newRequired }))) setNewText('');
        }}>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Add an extra item for this Job Order</label>
            <input value={newText} maxLength={255} onChange={(e) => setNewText(e.target.value)} placeholder="e.g. Client wants a second proof" />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={newRequired} onChange={(e) => setNewRequired(e.target.checked)} /> Required
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !newText.trim()}>Add</button>
        </form>
      )}
    </div>
  );
}
