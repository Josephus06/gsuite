import { useState } from 'react';
import Modal from './Modal';
import {
  REVISION_MATERIAL_PROCESS, REVISION_DELIVERY_DATE, REVISION_REASON_LABELS,
} from '../utils/salesRevision';

// Production says WHY it is handing a job order back, because the reason decides what Sales may
// then do about it -- re-specify the job, or answer a proposed delivery date. "For Revision" used
// to carry nothing, so the job reappeared in Sales's queue with no indication of what was wrong
// and the two departments still had to talk before anything could move.
export default function SalesRevisionModal({ jo, onClose, onSubmit }) {
  const [reason, setReason] = useState(REVISION_MATERIAL_PROCESS);
  const [suggested, setSuggested] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const currentDelivery = jo?.delivery_date ? String(jo.delivery_date).slice(0, 10) : '';
  const needsDate = reason === REVISION_DELIVERY_DATE;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (needsDate && !suggested) { setError('Choose the delivery date you are suggesting.'); return; }
    if (needsDate && currentDelivery && suggested === currentDelivery) {
      setError('That is already this job order’s delivery date — suggest a different one.');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        reason,
        note: note.trim() || null,
        suggested_delivery_date: needsDate ? suggested : null,
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send this Job Order for revision.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Send to Sales for Revision" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error && <div className="error-banner">{error}</div>}

        <div className="field">
          <label>Reason</label>
          {[REVISION_MATERIAL_PROCESS, REVISION_DELIVERY_DATE].map((value) => (
            <label key={value} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, fontWeight: 400 }}>
              <input
                type="radio" name="revision-reason" value={value}
                checked={reason === value} disabled={saving}
                onChange={() => { setReason(value); setError(''); }}
                style={{ marginTop: 3 }}
              />
              <span>
                {REVISION_REASON_LABELS[value]}
                <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                  {value === REVISION_MATERIAL_PROCESS
                    ? 'Sales can edit this Job Order’s materials and processes while it is with them.'
                    : 'Sales approves the date you suggest, or declines it and the current date stands.'}
                </span>
              </span>
            </label>
          ))}
        </div>

        {needsDate && (
          <div className="field">
            <label>Suggested Delivery Date</label>
            <input
              type="date" value={suggested} required disabled={saving}
              onChange={(e) => setSuggested(e.target.value)}
            />
            <span className="muted" style={{ fontSize: 12 }}>
              {currentDelivery
                ? `Currently promised for ${currentDelivery}.`
                : 'This job order has no delivery date set yet.'}
            </span>
          </div>
        )}

        <div className="field">
          <label>Remarks <span className="muted">(optional)</span></label>
          <textarea
            rows={3} value={note} disabled={saving} maxLength={500}
            placeholder={needsDate
              ? 'Why the promised date cannot be met'
              : 'What needs changing about the material or process'}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Sending...' : 'Send for Revision'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
