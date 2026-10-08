import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

// "RMA Additional Details" on an RWIP, RFQC or NSSO RMA job order (asked 2026-10-08, as live shows it):
// Reason Code, Reason and Action/s to be taken. They are entered when the job order is raised; here a
// System Admin may correct them (the server decides -- can_edit), everyone else reads them.
export function isRmaJobOrder(jo) {
  const no = String(jo?.job_order_no || '');
  return no.startsWith('RWIP-') || no.startsWith('RFQC-') || /^NSJO-(RMA|INST)-/.test(no);
}

export default function RmaDetailsTab({ jobOrderId, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ reason_code_id: '', reason: '', action_to_be_taken: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  function load() {
    return api.get(`/job-orders/${jobOrderId}/rma-details`).then(({ data: d }) => {
      setData(d);
      setForm({ reason_code_id: d.reason_code_id || '', reason: d.reason || '', action_to_be_taken: d.action_to_be_taken || '' });
    }).catch((e) => setError(e.response?.data?.error || 'Could not load the RMA details.'));
  }
  useEffect(() => { load(); }, [jobOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setError(''); setSaved(false);
    const missing = [!form.reason.trim() && 'Reason', !form.action_to_be_taken.trim() && 'Action/s to be taken'].filter(Boolean);
    if (missing.length) { setError(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required.`); return; }
    setSaving(true);
    try {
      await api.put(`/job-orders/${jobOrderId}/rma-details`, form);
      await load();
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the RMA details.');
    } finally {
      setSaving(false);
    }
  }

  if (!data) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const ro = !data.can_edit;
  const code = data.reasons.find((r) => String(r.id) === String(form.reason_code_id));

  return (
    <div className="card" style={{ maxWidth: 900 }}>
      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="muted" style={{ marginBottom: 8 }}>Saved.</div>}
      <div className="field">
        <label>Reason Code</label>
        {ro ? <input readOnly value={data.reason_code_name || ''} /> : (
          <EntityPicker
            label="Reason Code" items={data.reasons} value={form.reason_code_id}
            getLabel={(x) => x?.name || code?.name || data.reason_code_name || ''}
            columns={[{ key: 'name', label: 'Name' }, { key: 'reason_type', label: 'Type' }]} searchKeys={['name']}
            placeholder="--Select--"
            onSelect={(x) => setForm((f) => ({ ...f, reason_code_id: x?.id || '' }))}
            onClear={() => setForm((f) => ({ ...f, reason_code_id: '' }))}
          />
        )}
      </div>
      <div className="field">
        <label>Reason{ro ? '' : ' *'}</label>
        <textarea rows={2} readOnly={ro} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
      </div>
      <div className="field">
        <label>Action/s to be taken{ro ? '' : ' *'}</label>
        <textarea rows={2} readOnly={ro} value={form.action_to_be_taken} onChange={(e) => setForm((f) => ({ ...f, action_to_be_taken: e.target.value }))} />
      </div>
      {!ro && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      )}
    </div>
  );
}
