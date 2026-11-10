import { useState } from 'react';
import api from '../api/client';
import MoneyInput from './MoneyInput';
import { BANK_LOAN_ROWS } from '../utils/requestForms';

// Request to Apply for a Bank Loan, once approved and until Confirmed (asked 2026-11-10): the details
// the bank sends when the loan is credited are filled in here, then Confirm makes the request final.
// The loan as approved (amount, need-by date, purpose, borrower, bank) is not reopened. The server
// (routes/forms.js /bank-loan-details, /bank-loan-confirm) checks who may and when.
const LATE = ['doc_stamp', 'advance_interest', 'net_proceeds', 'proceeds_instruction', 'term_of_payment', 'journal_entry_no', 'pn_no', 'bank_notice', 'remarks'];
const ROWS = BANK_LOAN_ROWS.filter((r) => LATE.includes(r.key));
const startValues = (d) => Object.fromEntries(ROWS.map((r) => [r.field, d?.[r.key] == null ? '' : r.type === 'money' ? String(Number(d[r.key])) : String(d[r.key])]));

export default function BankLoanFinish({ doc, onDone }) {
  const [form, setForm] = useState(() => startValues(doc.detail));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const set = (k, v) => { setSaved(''); setForm((f) => ({ ...f, [k]: v })); };

  async function save() {
    setBusy(true); setError(''); setSaved('');
    try { await api.put(`/forms/${doc.id}/bank-loan-details`, form); setSaved('Saved.'); await onDone(); } catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
    setBusy(false);
  }
  async function confirm() {
    if (!window.confirm('Confirm this bank loan request? After this its details can no longer be changed.')) return;
    setBusy(true); setError(''); setSaved('');
    try {
      await api.put(`/forms/${doc.id}/bank-loan-details`, form);
      await api.post(`/forms/${doc.id}/bank-loan-confirm`);
      await onDone();
    } catch (e) { setError(e.response?.data?.error || 'Could not confirm.'); setBusy(false); }
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h4 style={{ margin: '0 0 4px' }}>Details from the bank</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Fill these in as the bank credits the loan, then press Confirm. Until it is confirmed they can still be changed. The approved amount, purpose and bank stay as approved.
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        {ROWS.map((r) => (
          <div className="field" key={r.field} style={r.multiline ? { gridColumn: '1 / -1' } : undefined}>
            <label>{r.label}</label>
            {r.multiline ? <textarea rows={3} value={form[r.field]} maxLength={1000} onChange={(e) => set(r.field, e.target.value)} />
              : r.type === 'money' ? <MoneyInput value={form[r.field]} onChange={(v) => set(r.field, v)} />
                : <input type="text" value={form[r.field]} onChange={(e) => set(r.field, e.target.value)} />}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save details'}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={confirm}>Confirm</button>
        {saved && <span className="muted">{saved}</span>}
      </div>
    </div>
  );
}
