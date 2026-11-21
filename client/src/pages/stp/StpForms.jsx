import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import Modal from '../../components/Modal';
import EntityPicker from '../../components/EntityPicker';
import MoneyInput from '../../components/MoneyInput';
import { apiError } from './stpUtils';

// The STP create / edit forms (routes/stp.js validates everything again server-side). Each calls
// onSaved(id) once the save went through.

export function TerritoryModal({ territory, fy, meta, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    name: territory?.name || '',
    fiscal_year: territory?.fiscal_year || fy,
    rep_user_id: territory?.rep_user_id || '',
    coverage_area: territory?.coverage_area || '',
    target_amount: territory?.target_amount ?? '',
    status: territory?.status || 'Planned',
    notes: territory?.notes || '',
  }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  async function save(e) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Territory name is required.'); return; }
    if (form.status !== 'Unassigned' && !form.rep_user_id) { setError('Choose a rep, or set the status to Unassigned.'); return; }
    setSaving(true);
    setError('');
    try {
      const body = { ...form, target_amount: form.target_amount === '' ? 0 : Number(form.target_amount) };
      const { data } = territory
        ? await api.put(`/stp/territories/${territory.id}`, body)
        : await api.post('/stp/territories', body);
      onSaved(data.id);
    } catch (err) {
      setError(apiError(err, 'Could not save the territory.'));
      setSaving(false);
    }
  }

  return (
    <Modal title={territory ? `Edit territory — ${territory.name}` : 'New territory'} onClose={onClose} large>
      <form onSubmit={save}>
        {error && <div className="error-banner">{error}</div>}
        <div className="stp-form-grid">
          <div className="field">
            <label>Territory name <span className="req">*</span></label>
            <input value={form.name} onChange={set('name')} maxLength={150} required autoFocus />
          </div>
          <div className="field">
            <label>Period <span className="req">*</span></label>
            <select value={form.fiscal_year} onChange={set('fiscal_year')}>
              {(meta?.fiscal_years || [fy]).map((y) => <option key={y} value={y}>FY {y}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Rep {form.status !== 'Unassigned' && <span className="req">*</span>}</label>
            <select value={form.rep_user_id} onChange={set('rep_user_id')}>
              <option value="">— No rep (Unassigned) —</option>
              {(meta?.reps || []).map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={set('status')}>
              {(meta?.statuses || []).map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Target (₱)</label>
            <MoneyInput value={form.target_amount} onChange={set('target_amount')} />
          </div>
          <div className="field wide">
            <label>Coverage area</label>
            <input value={form.coverage_area} onChange={set('coverage_area')} placeholder="e.g. Banilad, Talamban, Lahug" />
          </div>
          <div className="field wide">
            <label>Notes</label>
            <textarea rows={3} value={form.notes} onChange={set('notes')} />
          </div>
        </div>
        <div className="stp-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save territory'}</button>
        </div>
      </form>
    </Modal>
  );
}

const KINDS = [
  { key: 'customer', label: 'Customer' },
  { key: 'lead', label: 'Lead (CRM)' },
  { key: 'prospect', label: 'New prospect' },
];

export function AccountModal({ account, fy, meta, territories, defaultTerritoryId, onClose, onSaved }) {
  const initialKind = account ? (account.customer_id ? 'customer' : account.lead_id ? 'lead' : 'prospect') : 'customer';
  const [kind, setKind] = useState(initialKind);
  const [form, setForm] = useState(() => ({
    customer_id: account?.customer_id || '',
    lead_id: account?.lead_id || '',
    prospect_name: account?.prospect_name || '',
    territory_id: account?.territory_id || defaultTerritoryId || '',
    segment: account?.segment || 'Corporate',
    annual_potential: account?.annual_potential ?? '',
    owner_user_id: account?.owner_user_id || '',
    visit_cadence: account?.visit_cadence || 'Monthly',
    last_visit_date: account?.last_visit_date ? String(account.last_visit_date).slice(0, 10) : '',
    notes: account?.notes || '',
  }));
  const [customers, setCustomers] = useState(account?.customer_id ? [{ id: account.customer_id, name: account.customer_name }] : []);
  const [leads, setLeads] = useState(account?.lead_id ? [{ id: account.lead_id, company_name: account.lead_name, lead_no: account.lead_no }] : []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const searchCustomers = (q) => api.get('/stp/lookup/customers', { params: { search: q } }).then(({ data }) => {
    setCustomers((cur) => [...new Map([...cur.filter((c) => String(c.id) === String(form.customer_id)), ...data].map((c) => [c.id, c])).values()]);
  });
  const searchLeads = (q) => api.get('/stp/lookup/leads', { params: { search: q } }).then(({ data }) => {
    setLeads((cur) => [...new Map([...cur.filter((l) => String(l.id) === String(form.lead_id)), ...data].map((l) => [l.id, l])).values()]);
  });
  useEffect(() => { searchCustomers(''); searchLeads(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const territoryRep = useMemo(() => {
    const t = territories.find((x) => String(x.id) === String(form.territory_id));
    return t?.rep_name || null;
  }, [territories, form.territory_id]);

  async function save(e) {
    e.preventDefault();
    const body = {
      ...form,
      customer_id: kind === 'customer' ? form.customer_id : null,
      lead_id: kind === 'lead' ? form.lead_id : null,
      prospect_name: kind === 'prospect' ? form.prospect_name : null,
      annual_potential: form.annual_potential === '' ? 0 : Number(form.annual_potential),
      last_visit_date: form.last_visit_date || null,
    };
    if (kind === 'customer' && !body.customer_id) { setError('Choose a customer.'); return; }
    if (kind === 'lead' && !body.lead_id) { setError('Choose a lead.'); return; }
    if (kind === 'prospect' && !String(body.prospect_name || '').trim()) { setError('Type the prospect\'s name.'); return; }
    if (!body.territory_id) { setError('Choose a territory.'); return; }
    setSaving(true);
    setError('');
    try {
      const { data } = account ? await api.put(`/stp/accounts/${account.id}`, body) : await api.post('/stp/accounts', body);
      onSaved(data.id);
    } catch (err) {
      setError(apiError(err, 'Could not save the account.'));
      setSaving(false);
    }
  }

  return (
    <Modal title={account ? `Edit account — ${account.account_name}` : 'Assign account'} onClose={onClose} large>
      <form onSubmit={save}>
        {error && <div className="error-banner">{error}</div>}
        <div className="stp-seg" role="radiogroup" aria-label="Account type">
          {KINDS.map((k) => (
            <button key={k.key} type="button" className={`btn btn-sm${kind === k.key ? ' btn-primary' : ''}`}
              aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>{k.label}</button>
          ))}
        </div>
        <div className="stp-form-grid">
          <div className="field wide">
            {kind === 'customer' && (
              <EntityPicker label="Customer" required items={customers} value={form.customer_id}
                getLabel={(c) => c?.name} onSelect={(c) => set('customer_id')(c.id)} onSearch={searchCustomers}
                columns={[{ key: 'customer_code', label: 'Code' }, { key: 'name', label: 'Customer' }]} searchKeys={['name', 'customer_code']}
                placeholder="Choose a customer…" />
            )}
            {kind === 'lead' && (
              <EntityPicker label="Lead" required items={leads} value={form.lead_id}
                getLabel={(l) => l?.company_name} onSelect={(l) => set('lead_id')(l.id)} onSearch={searchLeads}
                columns={[{ key: 'lead_no', label: 'Lead #' }, { key: 'company_name', label: 'Company' }, { key: 'status', label: 'Status' }]}
                searchKeys={['company_name', 'lead_no']} placeholder="Choose a lead…" />
            )}
            {kind === 'prospect' && (
              <>
                <label>Prospect name <span className="req">*</span></label>
                <input value={form.prospect_name} onChange={set('prospect_name')} maxLength={200} placeholder="Company not yet a customer or lead" />
              </>
            )}
          </div>
          <div className="field">
            <label>Territory (FY {fy}) <span className="req">*</span></label>
            <select value={form.territory_id} onChange={set('territory_id')} required>
              <option value="">— Choose —</option>
              {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Owner</label>
            <select value={form.owner_user_id} onChange={set('owner_user_id')}>
              <option value="">Territory's rep{territoryRep ? ` (${territoryRep})` : ''}</option>
              {(meta?.reps || []).map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Segment <span className="req">*</span></label>
            <select value={form.segment} onChange={set('segment')}>
              {(meta?.segments || []).map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Annual potential (₱)</label>
            <MoneyInput value={form.annual_potential} onChange={set('annual_potential')} />
          </div>
          <div className="field">
            <label>Visit cadence</label>
            <select value={form.visit_cadence} onChange={set('visit_cadence')}>
              {(meta?.cadences || []).map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Last visit</label>
            <input type="date" value={form.last_visit_date} onChange={set('last_visit_date')} max={meta?.today} />
          </div>
          <div className="field wide">
            <label>Notes</label>
            <textarea rows={3} value={form.notes} onChange={set('notes')} />
          </div>
        </div>
        <div className="stp-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : account ? 'Save account' : 'Assign account'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function VisitModal({ account, meta, onClose, onSaved }) {
  const [form, setForm] = useState({ visit_date: meta?.today || new Date().toISOString().slice(0, 10), notes: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/stp/accounts/${account.id}/visits`, form);
      onSaved();
    } catch (err) {
      setError(apiError(err, 'Could not log the visit.'));
      setSaving(false);
    }
  }
  return (
    <Modal title={`Log visit — ${account.account_name}`} onClose={onClose}>
      <form onSubmit={save}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Visit date <span className="req">*</span></label>
          <input type="date" required value={form.visit_date} max={meta?.today} onChange={(e) => setForm((f) => ({ ...f, visit_date: e.target.value }))} />
        </div>
        <div className="field">
          <label>Notes</label>
          <textarea rows={4} maxLength={2000} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Who you met, what was discussed, next steps" />
        </div>
        <div className="stp-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Log visit'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function OverrideModal({ account, requireReason, onClose, onSaved }) {
  const [tier, setTier] = useState(account.tier_override || '');
  const [reason, setReason] = useState(account.tier_override_reason || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(e) {
    e.preventDefault();
    if (tier && requireReason && !reason.trim()) { setError('A reason is required for a manual tier override.'); return; }
    setSaving(true);
    try {
      await api.put(`/stp/accounts/${account.id}/tier-override`, { tier: tier || null, reason });
      onSaved();
    } catch (err) {
      setError(apiError(err, 'Could not save the override.'));
      setSaving(false);
    }
  }
  return (
    <Modal title="Override tier" onClose={onClose}>
      <form onSubmit={save}>
        {error && <div className="error-banner">{error}</div>}
        <p className="stp-sub" style={{ marginTop: 0 }}>
          Computed tier: <strong>{account.computed_tier || (account.is_prospect ? 'Prospect' : 'not scored yet')}</strong>.
          The override is shown instead of it everywhere; the computed tier keeps being calculated beside it.
        </p>
        <div className="field">
          <label>Tier</label>
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">No override — use the computed tier</option>
            {['A', 'B', 'C'].map((t) => <option key={t} value={t}>Tier {t}</option>)}
          </select>
        </div>
        {tier && (
          <div className="field">
            <label>Reason {requireReason && <span className="req">*</span>}</label>
            <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this account belongs in a different tier" />
          </div>
        )}
        <div className="stp-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CapacityModal({ reps, fy, current, onClose, onSaved }) {
  const [repId, setRepId] = useState(current?.id || reps[0]?.id || '');
  const rep = reps.find((r) => String(r.id) === String(repId));
  const [cap, setCap] = useState(rep?.account_capacity || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put(`/stp/reps/${repId}/capacity`, { fiscal_year: fy, account_capacity: Number(cap) });
      onSaved();
    } catch (err) {
      setError(apiError(err, 'Could not save the capacity.'));
      setSaving(false);
    }
  }
  return (
    <Modal title={`Set capacity — FY ${fy}`} onClose={onClose}>
      <form onSubmit={save}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Rep</label>
          <select value={repId} onChange={(e) => { setRepId(e.target.value); setCap(reps.find((r) => String(r.id) === e.target.value)?.account_capacity || ''); }}>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Account capacity (max accounts) <span className="req">*</span></label>
          <input type="number" min={1} step={1} required value={cap} onChange={(e) => setCap(e.target.value)} />
        </div>
        <div className="stp-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !repId}>{saving ? 'Saving…' : 'Save capacity'}</button>
        </div>
      </form>
    </Modal>
  );
}
