import { useState } from 'react';
import api from '../api/client';
import Modal from './Modal';

// Renaming a knowledge base card, and rewording what it is for.
//
// Shared by the front page grid and the card detail page rather than written twice: the same card
// is editable from both, and two copies of this form is how the placeholder text on one of them
// drifts away from the other.
export default function KnowledgeCardEditModal({ card, onClose, onSaved }) {
  const [form, setForm] = useState({ name: card.name, description: card.description || '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!form.name.trim()) { setError('A name is required.'); return; }
    setError(''); setSaving(true);
    try { await api.put(`/archiver/knowledge-base/topics/${card.id}`, form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); setSaving(false); }
  }

  return (
    <Modal title={`Edit ${card.name}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Name *</label>
        <input
          value={form.name} autoFocus
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea
          rows={3} value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What this card is for, so the next person knows whether to open it."
        />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}
