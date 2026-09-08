import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

const EMPTY = {
  name: '', cost_account_id: '', accumulated_depreciation_account_id: '',
  depreciation_expense_account_id: '', is_depreciable: true, default_useful_life_months: 60, is_active: true,
};

const accountLabel = (a) => `${a.account_code} — ${a.account_name}`;

// An asset class is where a physical thing meets the ledger: it names the three accounts every
// posting for that class uses. Assets themselves never carry account ids, so re-pointing a class
// moves all of its assets at once.
function ClassModal({ item, meta, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...EMPTY, ...(item || {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const depreciable = form.is_depreciable !== false;

  async function save() {
    setError(''); setSaving(true);
    try {
      if (item?.id) await api.put(`/asset-classes/${item.id}`, form);
      else await api.post('/asset-classes', form);
      onSaved();
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  return (
    <Modal title={item?.id ? `Edit ${item.name}` : 'New Asset Class'} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Class Name *</label>
        <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Office Equipment" />
      </div>
      <div className="field">
        <label>Cost Account *</label>
        <EntityPicker
          label="Cost Account" items={meta.asset_accounts} value={form.cost_account_id} getLabel={accountLabel}
          columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }]}
          searchKeys={['account_code', 'account_name']} placeholder="--Select--"
          onSelect={(a) => set({ cost_account_id: a?.id || '' })}
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Where the asset&apos;s cost sits on the balance sheet.</div>
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={depreciable} onChange={(e) => set({ is_depreciable: e.target.checked })} />
          Depreciable
        </label>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Land is not depreciated; almost everything else is.</div>
      </div>
      {depreciable && (
        <>
          <div className="field">
            <label>Accumulated Depreciation Account *</label>
            <EntityPicker
              label="Accumulated Depreciation" items={meta.asset_accounts} value={form.accumulated_depreciation_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }]}
              searchKeys={['account_code', 'account_name']} placeholder="--Select--"
              onSelect={(a) => set({ accumulated_depreciation_account_id: a?.id || '' })}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>The contra account credited each month.</div>
          </div>
          <div className="field">
            <label>Depreciation Expense Account *</label>
            <EntityPicker
              label="Depreciation Expense" items={meta.expense_accounts} value={form.depreciation_expense_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }]}
              searchKeys={['account_code', 'account_name']} placeholder="--Select--"
              onSelect={(a) => set({ depreciation_expense_account_id: a?.id || '' })}
            />
          </div>
          <div className="field">
            <label>Default Useful Life (months) *</label>
            <input type="number" value={form.default_useful_life_months ?? ''} onChange={(e) => set({ default_useful_life_months: e.target.value })} />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Suggested when an asset in this class is capitalised. 60 months = 5 years.</div>
          </div>
        </>
      )}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={form.is_active !== false} onChange={(e) => set({ is_active: e.target.checked })} />
          Active
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

// The capitalisation policy: the amount at or above which an asset goes on the balance sheet
// instead of straight to expense.
function SettingsModal({ settings, meta, onClose, onSaved }) {
  const [form, setForm] = useState({
    capitalization_threshold: settings.capitalization_threshold ?? 10000,
    default_useful_life_months: settings.default_useful_life_months ?? 60,
    gain_loss_account_id: settings.gain_loss_account_id || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setError(''); setSaving(true);
    try { await api.put('/asset-classes/settings', form); onSaved(); }
    catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  return (
    <Modal title="Capitalisation Policy" onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Capitalisation Threshold</label>
        <input type="number" step="0.01" value={form.capitalization_threshold}
          onChange={(e) => setForm({ ...form, capitalization_threshold: e.target.value })} />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          An asset costing this much or more is capitalised and depreciated. Below it, it is expensed on
          purchase — the register still tracks where it is and who has it.
        </div>
      </div>
      <div className="field">
        <label>Default Useful Life (months)</label>
        <input type="number" value={form.default_useful_life_months}
          onChange={(e) => setForm({ ...form, default_useful_life_months: e.target.value })} />
      </div>
      <div className="field">
        <label>Gain / Loss on Disposal Account</label>
        <EntityPicker
          label="Gain/Loss Account" items={meta.all_accounts} value={form.gain_loss_account_id} getLabel={accountLabel}
          columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
          searchKeys={['account_code', 'account_name']} placeholder="--Select--"
          onSelect={(a) => setForm({ ...form, gain_loss_account_id: a?.id || '' })}
        />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

export default function AssetClasses() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: list }, { data: s }] = await Promise.all([
      api.get('/asset-classes'),
      api.get('/asset-classes/settings'),
    ]);
    setRows(list); setSettings(s); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/asset-classes/meta').then(({ data }) => setMeta(data)).catch(() => {}); }, []);

  async function remove(row) {
    if (!confirm(`Delete asset class "${row.name}"?`)) return;
    setError('');
    try { await api.delete(`/asset-classes/${row.id}`); load(); }
    catch (e) { setError(e.response?.data?.error || 'Delete failed.'); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Asset Classes</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/assets">Assets</Link>
          {can('/asset-classes', 'can_edit') && settings && meta && <button className="btn btn-sm" onClick={() => setShowSettings(true)}>Capitalisation Policy</button>}
          {can('/asset-classes', 'can_add') && meta && <button className="btn btn-primary" onClick={() => setEditing({})}>Add New</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {settings && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>Capitalisation threshold : <span className="hi">{Number(settings.capitalization_threshold).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></div>
            <div>Default useful life : <span className="hi">{settings.default_useful_life_months} months</span></div>
            <div>Gain / loss account : <span className="hi">{settings.gain_loss_account_code ? `${settings.gain_loss_account_code} — ${settings.gain_loss_account_name}` : '—'}</span></div>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Class</th><th>Cost Account</th><th>Accumulated Depreciation</th><th>Depreciation Expense</th>
                  <th style={{ textAlign: 'right' }}>Life</th><th style={{ textAlign: 'right' }}>Assets</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No asset classes yet.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Class">{r.name}</td>
                    <td data-label="Cost Account">{r.cost_account_code ? `${r.cost_account_code} — ${r.cost_account_name}` : <span className="muted">not set</span>}</td>
                    <td data-label="Accumulated Depreciation">
                      {r.is_depreciable
                        ? (r.accumulated_account_code ? `${r.accumulated_account_code} — ${r.accumulated_account_name}` : <span className="muted">not set</span>)
                        : <span className="muted">not depreciated</span>}
                    </td>
                    <td data-label="Depreciation Expense">{r.expense_account_code ? `${r.expense_account_code} — ${r.expense_account_name}` : '—'}</td>
                    <td data-label="Life" style={{ textAlign: 'right' }}>{r.is_depreciable ? `${r.default_useful_life_months} mo` : '—'}</td>
                    <td data-label="Assets" style={{ textAlign: 'right' }}>{r.capitalized_count} / {r.asset_count}</td>
                    <td data-label="Status">{r.is_active ? 'Active' : 'Inactive'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {can('/asset-classes', 'can_edit') && meta && <button className="btn btn-sm btn-primary" onClick={() => setEditing(r)}>Edit</button>}
                      {can('/asset-classes', 'can_delete') && Number(r.asset_count) === 0 && <button className="btn btn-sm btn-warning" onClick={() => remove(r)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          The Assets column reads capitalised / total — assets below the threshold are tracked but not on the balance sheet.
        </p>
      </div>

      {editing && meta && <ClassModal item={editing.id ? editing : null} meta={meta} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {showSettings && meta && settings && <SettingsModal settings={settings} meta={meta} onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); load(); }} />}
    </div>
  );
}
