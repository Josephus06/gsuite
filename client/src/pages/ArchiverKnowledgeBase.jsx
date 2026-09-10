import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDateTime } from '../utils/archiverLabels';

// Adding a card. Technical Problem is the section that grows constantly -- a card per problem --
// but nothing stops a new product line or machine being added to the other two either.
function NewTopicModal({ sections, defaultSectionId, onClose, onSaved }) {
  const [form, setForm] = useState({ section_id: defaultSectionId || '', name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!form.section_id) { setError('Choose a section.'); return; }
    if (!form.name.trim()) { setError('Give the card a name.'); return; }
    setError(''); setSaving(true);
    try { const { data } = await api.post('/archiver/knowledge-base/topics', form); onSaved(data); }
    catch (e) { setError(e.response?.data?.error || 'Could not create the card.'); setSaving(false); }
  }

  return (
    <Modal title="New card" onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Section *</label>
        <select value={form.section_id} onChange={(e) => setForm({ ...form, section_id: e.target.value })}>
          <option value="">--Select--</option>
          {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Name *</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="Printhead clogging, Roland VG3, Vinyl 3M..." />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What this card is for, so the next person knows whether to open it." />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Creating...' : 'Create Card'}</button>
      </div>
    </Modal>
  );
}

// The front page: three sections, each holding its cards.
//
// Everything arrives in one call and is filtered in the browser. It is three sections and a few
// dozen cards -- paginating that would cost a round trip to save nothing, and the point of the
// page is to see the whole shape at a glance.
export default function ArchiverKnowledgeBase() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(null); // holds the section id to preselect
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/archiver/knowledge-base');
      setSections(data.sections || []);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the knowledge base.'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const q = search.trim().toLowerCase();
  const matches = (t) => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Knowledge Base</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/archiver/credentials">Credentials</Link>
          <Link className="btn btn-sm" to="/archiver/files">Files</Link>
          {can('/archiver/knowledge-base', 'can_add') && (
            <button className="btn btn-primary" onClick={() => setShowNew('')}>Add Card</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Search cards</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="LFP, printhead, Roland..." />
        </div>
      </div>

      {sections.map((section) => {
        const shown = section.topics.filter(matches);
        return (
          <div className="card" key={section.id} style={{ marginBottom: 16 }}>
            <div className="page-header" style={{ marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{section.name}</h2>
              {can('/archiver/knowledge-base', 'can_add') && (
                <button className="btn btn-sm" onClick={() => setShowNew(String(section.id))}>Add card here</button>
              )}
            </div>
            {section.description && <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{section.description}</p>}

            {shown.length === 0 ? (
              <p className="muted" style={{ padding: '12px 0', margin: 0 }}>
                {q
                  ? 'No cards here match that search.'
                  : section.slug === 'technical-problem'
                    ? 'No cards yet. Add one per problem, and put the fix inside it.'
                    : 'No cards yet.'}
              </p>
            ) : (
              // Auto-fill rather than a fixed column count, so four cards sit in a row on a desk
              // monitor and stack sensibly on a phone in the workshop.
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginTop: 8 }}>
                {shown.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => navigate(`/archiver/knowledge-base/${t.id}`)}
                    style={{
                      textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 10,
                      border: '1px solid var(--border, #e2e8f0)', background: 'transparent', color: 'inherit',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{t.name}</div>
                    {t.description && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t.description}</div>
                    )}
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      {Number(t.file_count) === 0
                        ? 'No files yet'
                        : `${t.file_count} file${Number(t.file_count) === 1 ? '' : 's'}`}
                      {t.last_upload_at ? ` · ${formatDateTime(t.last_upload_at).split(',')[0]}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {showNew !== null && (
        <NewTopicModal
          sections={sections}
          defaultSectionId={showNew}
          onClose={() => setShowNew(null)}
          onSaved={(d) => { setShowNew(null); navigate(`/archiver/knowledge-base/${d.id}`); }}
        />
      )}
    </div>
  );
}
