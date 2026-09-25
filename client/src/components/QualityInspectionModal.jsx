import { useEffect, useState } from 'react';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { displayDate } from '../utils/dates';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// Mirrors the real "Quality Inspection" popup, reached from a Job Order's Production
// view once it has Assembly Build batches with something still uninspected. One QI can
// cover several Assembly Builds at once -- each row splits that batch's own remaining
// qty (quantity_built minus whatever's already Passed/RMA'd) into Pass Qty and RMA Qty,
// with a memo and action plan for anything that failed.
export default function QualityInspectionModal({ jobOrderId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [passQty, setPassQty] = useState({});
  const [rmaQty, setRmaQty] = useState({});
  const [reasonId, setReasonId] = useState({});
  const [rmaMemo, setRmaMemo] = useState({});
  const [action, setAction] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/quality-inspections/for-job-order/${jobOrderId}`).then(({ data: d }) => { setData(d); setLoading(false); });
  }, [jobOrderId]);

  if (loading || !data) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  async function handleSave() {
    setError('');
    const payload = data.assembly_builds
      .map((ab) => ({
        assembly_build_id: ab.id,
        pass_qty: passQty[ab.id] || 0,
        rma_qty: rmaQty[ab.id] || 0,
        reason_id: reasonId[ab.id] || null,
        rma_memo: rmaMemo[ab.id] || '',
        action_to_be_taken: action[ab.id] || '',
      }))
      .filter((l) => Number(l.pass_qty) > 0 || Number(l.rma_qty) > 0);
    if (!payload.length) { setError('Enter a Pass Qty or RMA Qty for at least one item.'); return; }
    // Once anything is RMA'd it has to say why and what happens next -- the same rule the server
    // enforces. These become the RFQC rework job order's own reason and action.
    for (const l of payload.filter((x) => Number(x.rma_qty) > 0)) {
      const missing = [
        !l.reason_id && 'Reason', !String(l.rma_memo).trim() && 'RMA Memo',
        !String(l.action_to_be_taken).trim() && 'Action/s to be taken',
      ].filter(Boolean);
      if (missing.length) {
        const ab = data.assembly_builds.find((b) => b.id === l.assembly_build_id);
        setError(`${ab?.ab_no}: ${missing.join(', ')} required when RMA Qty is above zero.`);
        return;
      }
    }

    setSaving(true);
    try {
      const { data: qi } = await api.post('/quality-inspections', { job_order_id: jobOrderId, date_created: dateCreated, lines: payload });
      onSaved(qi);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Quality Inspection</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div>
              <div className="field">
                <label>Date</label>
                <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
              </div>
              <div>Job Type : <span className="hi">{data.job_type_name || ''}</span></div>
              <div>Job Description : <span className="hi">{data.description}</span></div>
              <div>Job Location : <span className="hi">{data.job_location_name}</span></div>
              <div>Qty : <span className="hi">{qty(data.quantity)} {data.units}</span></div>
              <div>Built Qty : <span className="hi">{qty(data.quantity_built)} {data.units}</span></div>
              <div>&nbsp;&nbsp;Inspected Qty : <span className="hi">{qty(data.quantity_inspected)} {data.units}</span></div>
            </div>
            <div>
              <div>Customer : <span className="hi">{data.customer_name || '—'}</span></div>
              <div>Created From : <span className="hi">{data.job_order_no}</span></div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>AB #</th><th>AB Date</th><th>AB Qty</th><th>Passed</th><th>RMA</th>
                  <th>Pass Qty</th><th>RMA Qty</th><th>Reason</th><th>RMA Memo</th><th>Action/s to be taken</th>
                </tr>
              </thead>
              <tbody>
                {data.assembly_builds.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing left to inspect.</td></tr>
                )}
                {data.assembly_builds.map((ab) => (
                  <tr key={ab.id}>
                    <td>{ab.ab_no}</td>
                    <td>{formatDate(ab.date_created)}</td>
                    <td>{qty(ab.quantity_built)}</td>
                    <td>{qty(ab.passed_qty)}</td>
                    <td>{qty(ab.rma_qty)}</td>
                    <td>
                      <input
                        type="number" step="0.01" style={{ width: 80 }}
                        value={passQty[ab.id] ?? ''}
                        onChange={(e) => setPassQty((prev) => ({ ...prev, [ab.id]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        type="number" step="0.01" style={{ width: 80 }}
                        value={rmaQty[ab.id] ?? ''}
                        onChange={(e) => setRmaQty((prev) => ({ ...prev, [ab.id]: e.target.value }))}
                      />
                    </td>
                    <td>
                      {/* Reason, Memo and Action/s are required once RMA Qty is above zero; the
                          "Required" prompts appear then, so a line that only passes asks for none. */}
                      <select
                        style={{ width: 170 }}
                        value={reasonId[ab.id] ?? ''}
                        onChange={(e) => setReasonId((prev) => ({ ...prev, [ab.id]: e.target.value }))}
                      >
                        <option value="">{Number(rmaQty[ab.id]) > 0 ? '--Select-- (Required)' : '--Select--'}</option>
                        {(data.reasons || []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.reason_type})</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        style={{ width: 140 }}
                        placeholder={Number(rmaQty[ab.id]) > 0 ? 'Required' : ''}
                        value={rmaMemo[ab.id] ?? ''}
                        onChange={(e) => setRmaMemo((prev) => ({ ...prev, [ab.id]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        style={{ width: 160 }}
                        placeholder={Number(rmaQty[ab.id]) > 0 ? 'Required' : ''}
                        value={action[ab.id] ?? ''}
                        onChange={(e) => setAction((prev) => ({ ...prev, [ab.id]: e.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || data.assembly_builds.length === 0} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
