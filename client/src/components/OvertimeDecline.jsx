import { useState } from 'react';
import Modal from './Modal';

// Declining an Overtime Request filed for you (2026-10-13): a reason is required, so the person who
// asked knows why.
export default function OvertimeDecline({ busy, onDecline }) {
  const [open, setOpen] = useState(false);
  const [remark, setRemark] = useState('');
  return (
    <>
      <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setOpen(true)}>Decline</button>
      {open && (
        <Modal title="Decline the overtime" onClose={() => setOpen(false)}>
          <div className="field">
            <label>Reason *</label>
            <textarea rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Why you cannot take this overtime" />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-warning" disabled={busy || !remark.trim()}
              onClick={async () => { await onDecline(remark.trim()); setOpen(false); }}>Decline</button>
          </div>
        </Modal>
      )}
    </>
  );
}
