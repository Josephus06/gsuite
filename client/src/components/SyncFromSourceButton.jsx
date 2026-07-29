import { useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from './LoadingSpinner';

// "Refresh from Source" button for a list page: re-pulls the current live status + totals for the
// already-migrated records of one module (or all, when `module` is omitted) and updates them in
// place. System Admin only -- the backend enforces it; here we just hide the button otherwise so
// non-admins don't see a control that would 403. Calls onDone() after a successful sync so the
// list can reload and show the refreshed statuses.
export default function SyncFromSourceButton({ module, label = 'Sync from Source', onDone }) {
  const { user } = useAuth();
  const [syncing, setSyncing] = useState(false);
  if (user?.account_type !== 'System Admin') return null;

  async function handleSync() {
    setSyncing(true);
    try {
      const { data } = await api.post('/admin/sync-status', module ? { modules: [module] } : {});
      const lines = data.results.map((r) => `${r.label}: ${r.statusChanged} status change(s), ${r.updated} record(s) updated (${r.checked} checked).`);
      alert(`Sync from source complete.\n\n${lines.join('\n')}`);
      if (onDone) onDone();
    } catch (err) {
      alert(err.response?.data?.error || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button type="button" className="btn btn-sm" disabled={syncing} onClick={handleSync}>
      {syncing ? <LoadingSpinner inline size="sm" label="Syncing..." /> : label}
    </button>
  );
}
