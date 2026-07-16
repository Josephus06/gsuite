import { useEffect, useState } from 'react';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';

const TYPE_LABELS = { call: 'Call', email: 'Email', meeting: 'Meeting', note: 'Note', task: 'Task' };
const TYPE_ICONS = { call: '📞', email: '✉️', meeting: '👥', note: '📝', task: '☑️' };
const EMPTY = { activity_type: 'note', subject: '', description: '', due_date: '' };

function formatDateTime(v) { return v ? new Date(v).toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }

// Reusable activity/interaction log (calls/emails/meetings/notes/tasks) -- attached to
// any Lead/Customer/Opportunity via `relatedType`/`relatedId`, backed by
// server/src/routes/crmActivities.js's polymorphic crm_activities table. Used
// identically on Leads, Opportunities, and the Customer 360 page rather than building
// the same log-an-interaction UI three separate times.
export default function ActivityTimeline({ relatedType, relatedId }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    const { data } = await api.get('/crm-activities', { params: { related_type: relatedType, related_id: relatedId } });
    setActivities(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [relatedType, relatedId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.subject) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/crm-activities', {
        related_type: relatedType, related_id: relatedId,
        activity_type: form.activity_type, subject: form.subject,
        description: form.description || null, due_date: form.activity_type === 'task' ? (form.due_date || null) : null,
      });
      setForm(EMPTY);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to log activity');
    } finally {
      setSaving(false);
    }
  }

  async function toggleDone(activity) {
    await api.put(`/crm-activities/${activity.id}`, {
      subject: activity.subject, description: activity.description, due_date: activity.due_date,
      is_done: !activity.is_done, assigned_to_user_id: activity.assigned_to_user_id,
    });
    load();
  }

  async function handleDelete(activity) {
    if (!confirm(`Delete this ${TYPE_LABELS[activity.activity_type].toLowerCase()}?`)) return;
    await api.delete(`/crm-activities/${activity.id}`);
    load();
  }

  return (
    <div>
      <form onSubmit={handleAdd} className="card" style={{ marginBottom: 16 }}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field-row">
          <div className="field" style={{ maxWidth: 160 }}>
            <label>Type</label>
            <select value={form.activity_type} onChange={(e) => setForm({ ...form, activity_type: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>Subject</label>
            <input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="What happened?" />
          </div>
          {form.activity_type === 'task' && (
            <div className="field" style={{ maxWidth: 170 }}>
              <label>Due Date</label>
              <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </div>
          )}
        </div>
        <div className="field">
          <label>Notes</label>
          <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Logging...' : 'Log Activity'}</button>
      </form>

      {loading ? <LoadingSpinner /> : (
        <div className="activity-list">
          {activities.length === 0 && <div className="empty-state">No activity logged yet.</div>}
          {activities.map((a) => (
            <div key={a.id} className="card" style={{ marginBottom: 10, opacity: a.activity_type === 'task' && a.is_done ? 0.6 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span style={{ marginRight: 8 }}>{TYPE_ICONS[a.activity_type]}</span>
                  <strong>{a.subject}</strong>
                  {a.activity_type === 'task' && a.due_date && (
                    <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                      Due {formatDate(a.due_date)}{a.is_done ? ' — Done' : ''}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {a.activity_type === 'task' && (
                    <button type="button" className="btn btn-sm" onClick={() => toggleDone(a)}>{a.is_done ? 'Reopen' : 'Mark Done'}</button>
                  )}
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDelete(a)}>Delete</button>
                </div>
              </div>
              {a.description && <div style={{ marginTop: 6 }}>{a.description}</div>}
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {a.created_by_name || 'Someone'} · {formatDateTime(a.created_at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
