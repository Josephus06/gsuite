import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { ENTRY_TYPE_LABELS, ARCHIVE_STATUS_LABELS, BILLING_CYCLE_LABELS } from '../utils/archiverLabels';

const EMPTY = {
  title: '', entry_type: 'subscription', category_id: '', vendor: '', url: '', username: '',
  secret: '', notes: '', account_reference: '', renews_on: '', expires_on: '', cost: '',
  billing_cycle: '', owner_user_id: '', department_id: '', status: 'active',
};

// Generates a strong password so nobody has to invent one, and so "changing the password" is not
// quietly discouraged by the effort of thinking of a new one.
function generatePassword(length = 20) {
  // Ambiguous characters removed: O/0, l/1/I. Someone WILL read one of these off a screen and
  // type it into a device that has no clipboard.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export default function ArchiverEntryForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [hadSecret, setHadSecret] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data: m } = await api.get('/archiver/credentials/meta');
      setMeta(m);
      if (id) {
        // Note what comes back has NO secret in it -- the API never returns one outside a verified
        // reveal, so an edit form starts with the password field blank by design.
        const { data: e } = await api.get(`/archiver/credentials/${id}`);
        if (!e.my_access?.can_edit) { navigate(`/archiver/credentials/${id}`, { replace: true }); return; }
        setHadSecret(!!e.has_secret);
        setForm({
          title: e.title || '', entry_type: e.entry_type || 'subscription', category_id: e.category_id || '',
          vendor: e.vendor || '', url: e.url || '', username: e.username || '', secret: '',
          notes: e.notes || '', account_reference: e.account_reference || '',
          renews_on: e.renews_on ? String(e.renews_on).slice(0, 10) : '',
          expires_on: e.expires_on ? String(e.expires_on).slice(0, 10) : '',
          cost: e.cost ?? '', billing_cycle: e.billing_cycle || '',
          owner_user_id: e.owner_user_id || '', department_id: e.department_id || '', status: e.status || 'active',
        });
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setError('');
    if (!form.title.trim()) { setError('A title is required.'); return; }
    if (form.secret && !meta?.vault_configured) {
      setError('The vault is not configured on this server, so a password cannot be stored.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        ...form,
        category_id: form.category_id || null,
        owner_user_id: form.owner_user_id || null,
        department_id: form.department_id || null,
        cost: form.cost === '' ? null : Number(form.cost),
        renews_on: form.renews_on || null,
        expires_on: form.expires_on || null,
        billing_cycle: form.billing_cycle || null,
      };
      // An empty password field means "leave it as it is", never "erase it".
      if (!form.secret) delete body.secret;
      if (id) { await api.put(`/archiver/credentials/${id}`, body); navigate(`/archiver/credentials/${id}`); }
      else { const { data } = await api.post('/archiver/credentials', body); navigate(`/archiver/credentials/${data.id}`); }
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Archiver</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(id ? `/archiver/credentials/${id}` : '/archiver/credentials')}>Back</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!meta.vault_configured && (
        <div className="error-banner">
          The vault is not configured (ARCHIVER_KEY is unset), so passwords cannot be stored. You can still
          record the entry and add the password later.
        </div>
      )}

      <div className="card">
        <h2 style={{ margin: '0 0 2px', color: '#334155' }}>{id ? form.title : 'New Entry'}</h2>
        <div className="muted" style={{ marginBottom: 16 }}>
          Passwords are encrypted before they are stored and never appear in any list.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Title *</label>
            <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Adobe Creative Cloud — Design team" />
          </div>
          <div className="field">
            <label>Vendor</label>
            <input value={form.vendor} onChange={(e) => set({ vendor: e.target.value })} placeholder="Adobe" />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={form.entry_type} onChange={(e) => set({ entry_type: e.target.value })}>
              {Object.entries(ENTRY_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Category</label>
            <select value={form.category_id} onChange={(e) => set({ category_id: e.target.value })}>
              <option value="">--None--</option>
              {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Sign-in URL</label>
            <input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://account.adobe.com" />
          </div>
        </div>

        <h3 style={{ margin: '22px 0 8px', fontSize: 14, color: '#334155' }}>Credentials</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          <div className="field">
            <label>Username / Login</label>
            <input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
          </div>
          <div className="field">
            <label>Password / Secret</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type={showSecret ? 'text' : 'password'}
                value={form.secret}
                onChange={(e) => set({ secret: e.target.value })}
                placeholder={hadSecret ? 'Unchanged — type to replace' : ''}
                autoComplete="new-password"
                style={{ flex: 1, fontFamily: showSecret ? 'monospace' : undefined }}
              />
              <button type="button" className="btn btn-sm" onClick={() => setShowSecret((v) => !v)}>
                {showSecret ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { set({ secret: generatePassword() }); setShowSecret(true); }}>
                Generate
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {hadSecret
                ? 'A password is already stored. Leave this blank to keep it; type here only to replace it.'
                : 'Encrypted before it is saved. It will never be shown again without an emailed code.'}
            </div>
          </div>
          <div className="field">
            <label>Account Reference</label>
            <input value={form.account_reference} onChange={(e) => set({ account_reference: e.target.value })} placeholder="Customer or account number" />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
              {Object.entries(ARCHIVE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>

        <h3 style={{ margin: '22px 0 8px', fontSize: 14, color: '#334155' }}>Renewal &amp; ownership</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div className="field">
            <label>Renews On</label>
            <input type="date" value={form.renews_on} onChange={(e) => set({ renews_on: e.target.value })} />
          </div>
          <div className="field">
            <label>Expires On</label>
            <input type="date" value={form.expires_on} onChange={(e) => set({ expires_on: e.target.value })} />
          </div>
          <div className="field">
            <label>Billing Cycle</label>
            <select value={form.billing_cycle} onChange={(e) => set({ billing_cycle: e.target.value })}>
              <option value="">--None--</option>
              {Object.entries(BILLING_CYCLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Cost</label>
            <input type="number" step="0.01" value={form.cost} onChange={(e) => set({ cost: e.target.value })} />
          </div>
          <div className="field">
            <label>Owner</label>
            <select value={form.owner_user_id} onChange={(e) => set({ owner_user_id: e.target.value })}>
              <option value="">--Me--</option>
              {meta.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>The owner always has full access.</div>
          </div>
          <div className="field">
            <label>Department</label>
            <select value={form.department_id} onChange={(e) => set({ department_id: e.target.value })}>
              <option value="">--None--</option>
              {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Notes</label>
            <textarea rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })}
              placeholder="Recovery details, licence seats, who to contact..." />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Notes are stored in plain text and are visible to anyone the entry is shared with — keep second
              passwords and recovery codes out of here.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
