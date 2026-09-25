import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function today() { return new Date().toISOString().slice(0, 10); }
function longDate(v) { return v ? new Date(`${v}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }

// Mirrors live's "Reversal Journal" popup, shown when a Sales Invoice is voided. Nothing is voided
// until Save: the table is the reversing entry the void will post (the invoice's own GL Impact,
// debits and credits swapped), read from GET /sales-invoices/:id/reversal-preview, which is built by
// the same code the void posts with. The user picks the reversal date, location, memo and a
// department per line; PUT /sales-invoices/:id/cancel does the rest.
export default function ReversalJournalModal({ invoiceId, onClose, onSaved }) {
  const [preview, setPreview] = useState(null);
  const [date, setDate] = useState(today());
  const [location, setLocation] = useState(null);
  const [memo, setMemo] = useState('');
  const [depts, setDepts] = useState([]); // department id per GL line, same order as preview.rows
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const pick = (d) => (Array.isArray(d) ? d : (d?.rows || []));
    Promise.all([
      api.get(`/sales-invoices/${invoiceId}/reversal-preview`),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
    ]).then(([p, l, d]) => {
      setPreview(p.data);
      setLocation(p.data.location);
      setDepts(p.data.rows.map((r) => r.department_id || ''));
      setLocations(pick(l.data));
      setDepartments(pick(d.data));
    }).catch((e) => setError(e.response?.data?.error || 'Could not load the reversal.'));
  }, [invoiceId]);

  async function save() {
    setError('');
    if (!date) { setError('Date is required.'); return; }
    if (!location) { setError('Location is required.'); return; }
    setSaving(true);
    try {
      const { data } = await api.put(`/sales-invoices/${invoiceId}/cancel`, {
        reversal_date: date, location_id: location.id, memo, line_departments: depts.map((x) => x || null),
      });
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Void failed.');
      setSaving(false);
    }
  }

  const rows = preview?.rows || [];
  const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
  const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Reversal Journal</h2>
          <button type="button" onClick={onClose} disabled={saving} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}
          {!preview ? (!error && <LoadingSpinner />) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div>
                  <div className="field">
                    <label>Date <span className="req">*</span></label>
                    <input type="date" value={date} min={String(preview.invoice_date || '').slice(0, 10) || undefined} onChange={(e) => setDate(e.target.value)} />
                  </div>
                  <div>Reversal # : <span className="hi">{preview.invoice_no}</span></div>
                  <div>Reversal Date : <span className="hi">{longDate(date)}</span></div>
                </div>
                <div>
                  <div className="field">
                    <label>Location <span className="req">*</span></label>
                    <EntityPicker
                      label="Location" items={locations} value={location?.id || ''} getLabel={(l) => l.location_name || l.name}
                      columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                      onSelect={(l) => setLocation(l ? { id: l.id, location_name: l.location_name || l.name } : null)}
                    />
                  </div>
                  <div className="field"><label>Memo</label><textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
                </div>
              </div>

              <div className="status-tabs" style={{ marginTop: 16 }}><button type="button" className="status-tab active">GL Impact</button></div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Account Code</th><th>Account Title</th><th>Department</th><th>Memo</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>This invoice posted nothing, so there is nothing to reverse.</td></tr>}
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.account_code}</td>
                        <td>{r.account_name}</td>
                        <td>
                          <select value={depts[i] || ''} onChange={(e) => setDepts((ds) => ds.map((x, j) => (j === i ? e.target.value : x)))}>
                            <option value="">--None--</option>
                            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                        </td>
                        <td>Voided from {preview.invoice_no}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.debit)}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.credit)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {rows.length > 0 && (
                    <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={4} style={{ textAlign: 'right' }}>Total</td>
                      <td style={{ textAlign: 'right' }}>{money(totalDebit)}</td><td style={{ textAlign: 'right' }}>{money(totalCredit)}</td></tr></tfoot>
                  )}
                </table>
              </div>

              <div className="modal-actions">
                <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
                  {saving ? <LoadingSpinner inline size="sm" label="Voiding..." /> : 'Save'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
