import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

// The real modal's Receipt and Payment Type are plain selects with a fixed set of
// options, not master-list lookups -- stored as their label on the payment.
const RECEIPT_TYPES = ['Official Receipt', 'Collection Receipt', 'Acknowledgement Receipt'];
const PAYMENT_TYPES = ['Full Payment', 'Partial Payment', 'Advance Payment'];

// Mirrors the real "Customer Payment" popup, reached from an Open Invoice's "Accept
// Payment" button. Every one of this customer's still-open invoices is listed in APPLY,
// not just the one the button was pressed from -- a single payment routinely settles
// several at once -- with the source invoice ticked by default. CREDITS offsets the
// payment with the customer's own open Credit Memos, which move no cash.
export default function CustomerPaymentModal({ invoiceId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [department, setDepartment] = useState(null);
  const [receiptType, setReceiptType] = useState('');
  const [orNo, setOrNo] = useState('');
  const [paymentType, setPaymentType] = useState('');
  const [issuedBy, setIssuedBy] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState(null);
  const [depositAccount, setDepositAccount] = useState(null);
  const [memo, setMemo] = useState('');
  const [tab, setTab] = useState('apply');
  const [applyAmounts, setApplyAmounts] = useState({});   // sales_invoice_id -> string
  const [creditAmounts, setCreditAmounts] = useState({}); // credit_memo_id -> string
  const [departments, setDepartments] = useState([]);
  const [users, setUsers] = useState([]);
  const [methods, setMethods] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/customer-payments/for-invoice/${invoiceId}`),
      api.get('/lookups/departments'),
      api.get('/users'),
      api.get('/lookups/payment-methods'),
      api.get('/lookups/chart-of-accounts'),
    ]).then(([srcRes, deptRes, userRes, methodRes, acctRes]) => {
      const d = srcRes.data;
      setData(d);
      setDepartments(deptRes.data);
      setUsers(Array.isArray(userRes.data) ? userRes.data : (userRes.data?.rows || []));
      setMethods(methodRes.data);
      setAccounts(Array.isArray(acctRes.data) ? acctRes.data : (acctRes.data?.rows || []));
      setMemo(d.memo || '');
      if (d.department_id) setDepartment({ id: d.department_id, name: d.department_name });
      // The invoice the button was pressed from starts ticked for its full remaining
      // balance -- the overwhelmingly common case is settling exactly that.
      setApplyAmounts({ [d.sales_invoice_id]: String(Number(d.amount_due).toFixed(2)) });
      setPaymentAmount(String(Number(d.amount_due).toFixed(2)));
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error || 'Could not load this Invoice.');
      setLoading(false);
    });
  }, [invoiceId]);

  if (loading) {
    return <div className="modal-overlay"><div className="modal modal-xl"><LoadingSpinner /></div></div>;
  }
  if (!data) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-xl">
          <div className="error-banner">{error}</div>
          <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const appliedToInvoices = Object.values(applyAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const appliedToCredits = Object.values(creditAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const appliedAmount = appliedToInvoices + appliedToCredits;
  const received = Number(paymentAmount) || 0;
  // Credits offset the bill without cash changing hands, so only the invoice-applied
  // portion consumes the payment -- the same split the server enforces. Whatever cash is
  // left over sits unapplied, on account.
  const unappliedAmount = received - appliedToInvoices;

  async function handleSave() {
    setError('');
    const apply = Object.entries(applyAmounts)
      .filter(([, v]) => Number(v) > 0)
      .map(([id, v]) => ({ sales_invoice_id: Number(id), applied_amount: Number(v) }));
    const credits = Object.entries(creditAmounts)
      .filter(([, v]) => Number(v) > 0)
      .map(([id, v]) => ({ credit_memo_id: Number(id), applied_amount: Number(v) }));
    if (!apply.length && !credits.length) { setError('Apply at least one amount to an invoice or credit.'); return; }

    setSaving(true);
    try {
      const { data: cp } = await api.post('/customer-payments', {
        customer_id: data.customer_id,
        date_created: dateCreated,
        department_id: department?.id || null,
        office_location_id: data.office_location_id || null,
        deposit_account_id: depositAccount?.id || null,
        receipt_type: receiptType,
        or_no: orNo,
        payment_type: paymentType,
        issued_by_user_id: issuedBy?.id || null,
        payment_method_id: paymentMethod?.id || null,
        payment_amount: received,
        memo,
        apply_lines: apply,
        credit_lines: credits,
      });
      onSaved(cp);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Customer Payment</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div>Customer : <span className="hi">{data.customer_name}</span></div>
              <div className="field">
                <label>Department</label>
                <EntityPicker
                  label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d.name}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDepartment}
                />
              </div>
              <div>Office Location : <span className="hi">{data.office_location_name || '—'}</span></div>
              <div className="field"><label>Memo</label><textarea rows={5} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div>
              <div className="field">
                <label>Receipt</label>
                <select value={receiptType} onChange={(e) => setReceiptType(e.target.value)}>
                  <option value="">--Select--</option>
                  {RECEIPT_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="field"><label>OR #</label><input value={orNo} onChange={(e) => setOrNo(e.target.value)} /></div>
              <div className="field">
                <label>Payment Type</label>
                <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                  <option value="">--Select--</option>
                  {PAYMENT_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Issued By</label>
                <EntityPicker
                  label="Issued By" items={users} value={issuedBy?.id || ''} getLabel={(u) => u.display_name}
                  columns={[{ key: 'display_name', label: 'Name' }, { key: 'email', label: 'Email' }]}
                  searchKeys={['display_name', 'email']} onSelect={setIssuedBy}
                />
              </div>
              <div className="field"><label>Payment Amount</label><input type="number" step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} /></div>
              <div className="field">
                <label>Payment Method</label>
                <EntityPicker
                  label="Payment Method" items={methods} value={paymentMethod?.id || ''} getLabel={(m) => m.name}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setPaymentMethod}
                />
              </div>
              <div className="field">
                <label>Deposit To</label>
                <EntityPicker
                  label="Deposit To" items={accounts} value={depositAccount?.id || ''}
                  getLabel={(a) => `${a.account_code} ${a.account_name}`}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }]}
                  searchKeys={['account_code', 'account_name']} onSelect={setDepositAccount}
                />
              </div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Applied Amount</span><span className="hi">{money(appliedAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Unapplied Amount</span><span className="hi">{money(unappliedAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Total Payments</span><span>{money(received)}</span></div>
            </div>
          </div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>APPLY {money(appliedToInvoices)}</button>
            <button className={`status-tab ${tab === 'credits' ? 'active' : ''}`} onClick={() => setTab('credits')}>CREDITS {money(appliedToCredits)}</button>
          </div>

          {tab === 'apply' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr><th></th><th>Invoice #</th><th>Customer</th><th>Date Created</th><th>Original Amount</th><th>Amount Due</th><th>Applied Amount</th></tr>
                </thead>
                <tbody>
                  {data.apply_lines.length === 0 && (
                    <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>This customer has no open invoices.</td></tr>
                  )}
                  {data.apply_lines.map((l) => {
                    const checked = applyAmounts[l.sales_invoice_id] !== undefined;
                    return (
                      <tr key={l.sales_invoice_id}>
                        <td>
                          <input
                            type="checkbox" checked={checked}
                            onChange={() => setApplyAmounts((prev) => {
                              const next = { ...prev };
                              if (checked) delete next[l.sales_invoice_id];
                              else next[l.sales_invoice_id] = String(Number(l.amount_due).toFixed(2));
                              return next;
                            })}
                          />
                        </td>
                        <td>{l.invoice_no}</td>
                        <td>{l.customer_name}</td>
                        <td>{formatDate(l.date_created)}</td>
                        <td>{money(l.gross_amount)}</td>
                        <td>{money(l.amount_due)}</td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 120 }} disabled={!checked}
                            value={applyAmounts[l.sales_invoice_id] ?? ''}
                            onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [l.sales_invoice_id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'credits' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr><th></th><th>Credit Memo #</th><th>Date Created</th><th>Original Amount</th><th>Remaining</th><th>Applied Amount</th></tr>
                </thead>
                <tbody>
                  {data.credit_lines.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>This customer has no open credit memos.</td></tr>
                  )}
                  {data.credit_lines.map((l) => {
                    const checked = creditAmounts[l.credit_memo_id] !== undefined;
                    return (
                      <tr key={l.credit_memo_id}>
                        <td>
                          <input
                            type="checkbox" checked={checked}
                            onChange={() => setCreditAmounts((prev) => {
                              const next = { ...prev };
                              if (checked) delete next[l.credit_memo_id];
                              else next[l.credit_memo_id] = String(Number(l.remaining).toFixed(2));
                              return next;
                            })}
                          />
                        </td>
                        <td>{l.credit_memo_no}</td>
                        <td>{formatDate(l.date_created)}</td>
                        <td>{money(l.gross_amount)}</td>
                        <td>{money(l.remaining)}</td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 120 }} disabled={!checked}
                            value={creditAmounts[l.credit_memo_id] ?? ''}
                            onChange={(e) => setCreditAmounts((prev) => ({ ...prev, [l.credit_memo_id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
