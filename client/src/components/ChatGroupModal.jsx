import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import Avatar from './Avatar';

// Create a group chat, or -- for an existing one -- see its members and, as its creator, rename it,
// add or remove people, or delete it; anyone else can leave (2026-10-13; routes/chat.js).
//   groupId   omitted to create a new group
//   onDone(result)  { created: {id, name} } | { saved: true } | { deleted: true } | { left: true }
export default function ChatGroupModal({ groupId, onClose, onDone }) {
  const isNew = !groupId;
  const [people, setPeople] = useState([]);
  const [group, setGroup] = useState(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/chat/contacts').then(({ data }) => setPeople(Array.isArray(data) ? data : [])).catch(() => {});
    if (!isNew) {
      api.get(`/chat/groups/${groupId}`).then(({ data }) => {
        setGroup(data);
        setName(data.name);
        setPicked(new Set(data.members.map((m) => m.id).filter((id) => id !== data.created_by_user_id)));
      }).catch((e) => setError(e.response?.data?.error || 'Could not load the group.'));
    }
  }, [groupId, isNew]);

  const canEdit = isNew || group?.is_owner;
  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? people.filter((p) => String(p.display_name || '').toLowerCase().includes(q)) : people),
    [people, q],
  );
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function save() {
    setBusy(true); setError('');
    try {
      if (isNew) {
        const { data } = await api.post('/chat/groups', { name, member_ids: [...picked] });
        onDone({ created: data });
      } else {
        await api.put(`/chat/groups/${groupId}`, { name, member_ids: [...picked] });
        onDone({ saved: true });
      }
    } catch (e) { setError(e.response?.data?.error || 'Could not save the group.'); setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Delete "${group?.name}" and all its messages for everyone? This cannot be undone.`)) return;
    setBusy(true);
    try { await api.delete(`/chat/groups/${groupId}`); onDone({ deleted: true }); } catch (e) { setError(e.response?.data?.error || 'Could not delete.'); setBusy(false); }
  }
  async function leave() {
    if (!window.confirm(`Leave "${group?.name}"?`)) return;
    setBusy(true);
    try { await api.post(`/chat/groups/${groupId}/leave`); onDone({ left: true }); } catch (e) { setError(e.response?.data?.error || 'Could not leave.'); setBusy(false); }
  }

  return (
    <Modal title={isNew ? 'New group chat' : (group?.name || 'Group')} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      {canEdit ? (
        <>
          <div className="field">
            <label>Group name *</label>
            <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Signage Team" />
          </div>
          <div className="field">
            <label>Members ({picked.size} selected)</label>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search people" />
            <div className="chat-group-pick">
              {shown.map((p) => (
                <label key={p.id} className="chat-group-pick-row">
                  <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                  <Avatar user={p} size={24} />
                  <span>{p.display_name}</span>
                </label>
              ))}
              {!shown.length && <div className="muted" style={{ padding: 8 }}>No one found.</div>}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Only people who have Chat can be added. You are always in your own group.</div>
          </div>
          <div className="modal-actions">
            {!isNew && <button className="btn btn-danger" disabled={busy} onClick={remove} style={{ marginRight: 'auto' }}>Delete group</button>}
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !name.trim() || !picked.size} onClick={save}>{isNew ? 'Create' : 'Save'}</button>
          </div>
        </>
      ) : (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>{group ? `${group.members.length} members` : 'Loading…'}</div>
          <div className="chat-group-pick">
            {(group?.members || []).map((m) => (
              <div key={m.id} className="chat-group-pick-row">
                <Avatar user={m} size={24} />
                <span>{m.display_name}{m.id === group.created_by_user_id ? ' (creator)' : ''}</span>
              </div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Only the person who created the group can change its members.</div>
          <div className="modal-actions">
            <button className="btn btn-warning" disabled={busy || !group} onClick={leave} style={{ marginRight: 'auto' }}>Leave group</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </Modal>
  );
}
