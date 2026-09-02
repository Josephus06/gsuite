import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';

const ROUTE = '/hrd';

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// HRD rooms as cards. A room is just a named container for files -- the 201 file, memos,
// scanned contracts -- so the card shows what is inside rather than a description nobody
// fills in.
export default function Hrd() {
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  // The room being renamed, or null. Holds its own copy of the fields so a half-typed name is
  // not written onto the card behind the dialog.
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get(ROUTE);
      setRooms(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function save() {
    if (!form.name.trim()) { setError('Room name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      if (editing) await api.put(`${ROUTE}/${editing.id}`, form);
      else await api.post(ROUTE, form);
      setAdding(false);
      setEditing(null);
      setForm({ name: '', description: '' });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save this room.');
    } finally {
      setSaving(false);
    }
  }

  // Whoever made the room may rename it, and so may anyone with edit rights on HRD -- the same
  // pair the server accepts, so the pencil is never shown on a room the save would refuse.
  const mayRename = (room) => can(ROUTE, 'can_edit')
    || (!!user?.id && String(room.created_by_user_id) === String(user.id));

  function openRename(room) {
    setError('');
    setEditing(room);
    setForm({ name: room.name || '', description: room.description || '' });
  }

  return (
    <div>
      <div className="page-header">
        <h1>HRD</h1>
        {can(ROUTE, 'can_add') && (
          <button className="btn btn-primary" onClick={() => { setError(''); setAdding(true); }}>Add Room</button>
        )}
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="hrd-room-grid">
          {rooms.length === 0 && (
            <div className="card muted" style={{ padding: 20 }}>
              No rooms yet. Add one to start keeping files in it.
            </div>
          )}
          {rooms.map((room) => (
            // The card and its rename control are siblings, not nested. The card used to be one
            // big <button>, and a second button inside it would be invalid HTML -- the click
            // target of the inner one is not reliably its own.
            <div key={room.id} className="hrd-room-slot">
              <button
                type="button"
                className="card hrd-room-card"
                onClick={() => navigate(`${ROUTE}/${room.id}`)}
              >
                <div className="hrd-room-name">{room.name}</div>
                {room.description && <div className="muted hrd-room-desc">{room.description}</div>}
                <div className="hrd-room-meta">
                  {room.file_count} file{Number(room.file_count) === 1 ? '' : 's'}
                  {Number(room.total_bytes) > 0 && ` · ${formatBytes(room.total_bytes)}`}
                </div>
              </button>
              {mayRename(room) && (
                <button
                  type="button"
                  className="btn btn-sm hrd-room-rename"
                  title={`Rename ${room.name}`}
                  aria-label={`Rename ${room.name}`}
                  onClick={() => openRename(room)}
                >
                  ✎
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {(adding || editing) && (
        <Modal
          title={editing ? `Rename ${editing.name}` : 'Add Room'}
          onClose={() => { if (!saving) { setAdding(false); setEditing(null); } }}
        >
          {error && <div className="error-banner">{error}</div>}
          <div className="field">
            <label>Room Name *</label>
            <input
              value={form.name}
              autoFocus
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
              placeholder="e.g. 201 File, Memos, Contracts"
            />
          </div>
          <div className="field">
            <label>Description</label>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="wizard-actions">
            <button type="button" className="btn" disabled={saving} onClick={() => { setAdding(false); setEditing(null); }}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
