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

      // Thirteen document types now sync, so listing every one makes the changes that matter hard
      // to find. What actually changed goes first and in full; the rest is one summary line.
      const changed = data.results.filter((r) => r.updated > 0);
      const clean = data.results.filter((r) => r.updated === 0);
      const lines = changed.map((r) => `${r.label}: ${r.statusChanged} status change(s), ${r.updated} record(s) updated (${r.checked} checked).`);
      if (clean.length) {
        const checked = clean.reduce((s, r) => s + r.checked, 0);
        lines.push(`${clean.length} other module(s) already up to date (${checked.toLocaleString()} records checked).`);
      }
      // A record present here but absent from live is worth surfacing -- it usually means the
      // document was raised in this system and has no counterpart to sync against.
      const orphans = data.results.reduce((s, r) => s + (r.notInLive || 0), 0);
      if (orphans) lines.push(`${orphans.toLocaleString()} record(s) had no match in the source system.`);
      if (!changed.length) lines.unshift('Nothing had changed in the source.');
      if (data.quantities) {
        const q = data.quantities;
        lines.push(`Job Order quantities rolled up: built ${q.built}, inspected ${q.inspected}, delivered ${q.delivered}.`);
      }
      if (data.processes) {
        const p = data.processes;
        if (p.missing === 0) lines.push('Processes: all Job Orders already have processes.');
        else if (p.backfill_started) lines.push(`Processes: backfill started in the background for ${p.missing} Job Order(s) — it runs a while; re-check later.`);
        else lines.push(`Processes: ${p.missing} Job Order(s) missing — a backfill is already running.`);
      }
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
