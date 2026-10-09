import { useEffect, useState } from 'react';
import api from '../api/client';
import DataTable from './DataTable';
import { displayDateTime } from '../utils/dates';

// System Information on every form (asked 2026-10-09): who made it and when, who last changed it,
// and what happened to it since -- edits field by field, submit, note, approve, return, attachments.
// `version` is anything that changes when the form does, so the history follows a save.
export default function FormSystemInfo({ formId, version }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get(`/forms/${formId}/system-info`)
      .then(({ data }) => { if (!cancelled) { setInfo(data); setError(''); } })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.error || 'Could not load the system information.'); });
    return () => { cancelled = true; };
  }, [formId, version]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>System Information</h3>
      {error && <div className="muted">{error}</div>}
      {info && (
        <>
          <div className="field-row">
            <div className="field"><label>Created By</label><div>{info.created_by_name || '—'}</div></div>
            <div className="field"><label>Date Created</label><div>{displayDateTime(info.created_at) || '—'}</div></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Last Modified By</label><div>{info.updated_by_name || '—'}</div></div>
            <div className="field"><label>Last Modified</label><div>{displayDateTime(info.updated_at) || '—'}</div></div>
          </div>
          <div style={{ marginTop: 12 }}>
            <DataTable
              columns={[
                { key: 'set_at', label: 'Date Time', render: (r) => displayDateTime(r.set_at) },
                { key: 'set_by_name', label: 'Set By', render: (r) => r.set_by_name || '—' },
                { key: 'event_type', label: 'Type', render: (r) => (r.event_type === 'Disapproved' ? 'Rejected' : r.event_type) },
                { key: 'field_name', label: 'Field', render: (r) => r.field_name || '' },
                { key: 'old_value', label: 'Old Value', render: (r) => r.old_value || '' },
                { key: 'new_value', label: 'New Value', render: (r) => r.new_value || '' },
              ]}
              rows={info.history}
              emptyLabel="No history yet."
            />
          </div>
        </>
      )}
    </div>
  );
}
