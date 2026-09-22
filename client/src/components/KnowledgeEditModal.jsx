import { useState } from 'react';
import api from '../api/client';
import Modal from './Modal';

// Renaming something in the Knowledge Base -- a card, or one of the three sections -- and
// rewording the line that explains it.
//
// One component for both rather than one per level: the form is the same two fields, and two
// copies is how the placeholder text on one of them drifts away from the other. Only the endpoint
// and the wording differ, so only those are parameterised.
//
// A SECTION RENAME CHANGES ITS LABEL, NOT ITS IDENTITY. The server leaves the slug alone, because
// the front page keys a section's empty-state copy on it and storage keys are built from it.
const KINDS = {
  card: {
    path: (id) => `/archiver/knowledge-base/topics/${id}`,
    hint: 'What this card is for, so the next person knows whether to open it.',
  },
  section: {
    path: (id) => `/archiver/knowledge-base/sections/${id}`,
    hint: 'The line under the heading, saying what belongs in this section.',
  },
};

export default function KnowledgeEditModal({ item, kind = 'card', onClose, onSaved }) {
  const [form, setForm] = useState({ name: item.name, description: item.description || '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const spec = KINDS[kind] || KINDS.card;

  async function save() {
    if (!form.name.trim()) { setError('A name is required.'); return; }
    setError(''); setSaving(true);
    try { await api.put(spec.path(item.id), form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save.'); setSaving(false); }
  }

  return (
    <Modal title={`Edit ${item.name}`} onClose={onClose}>
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
          placeholder={spec.hint}
        />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}
