import FormAttachments from '../components/FormAttachments';
import FormSystemInfo from '../components/FormSystemInfo';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import StandaloneVendorBillModal from '../components/StandaloneVendorBillModal';
import { useAuth } from '../context/useAuth';
import { ADJ_REASON_LABELS, ADJ_TIMES, NO_ITEM_TYPES, PAYMENT_TYPES, PURPOSE_LABELS, STATUS_BADGE, TYPE_LABELS, bankLabel, clock, fmtDate, money, pretty } from '../utils/requestForms';

// One form, and whatever the viewer is allowed to do to it.
//
// The buttons follow the chain: the owner submits a draft, an approver notes it, an approver
// approves or rejects it, and a rejected form goes back to its owner to revise. Every one of those
// is checked again server-side -- what is drawn here only decides what is worth offering.

function Line({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
      <span className="muted" style={{ minWidth: 170 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}


export default function FormView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [lineRemarks, setLineRemarks] = useState({});
  // Accounts Payable assigns each liquidation item its COGS account before noting it.
  const [cogsAccounts, setCogsAccounts] = useState([]);
  const [creditAccounts, setCreditAccounts] = useState([]);
  const [billing, setBilling] = useState(false);

  const load = useCallback(() => api.get(`/forms/${id}`).then(({ data }) => {
    setDoc(data);
    setLoading(false);
  }), [id]);

  useEffect(() => {
    load().catch((e) => { setError(e.response?.data?.error || 'Could not load this form.'); setLoading(false); });
  }, [load]);

  const canSetCogs = !!doc?.can_set_cogs;
  useEffect(() => {
    if (!canSetCogs) return;
    // Said out loud when it fails -- an empty picker with no reason reads as "there are no accounts".
    const failed = (e) => setError(e.response?.data?.error || 'Could not load the Chart of Accounts.');
    api.get('/forms/meta/cogs-accounts').then(({ data }) => setCogsAccounts(data)).catch(failed);
    api.get('/forms/meta/credit-accounts').then(({ data }) => setCreditAccounts(data)).catch(failed);
  }, [canSetCogs]);

  // One COGS account onto every item that has none yet -- a liquidation of 41 courier fees takes the
  // same account on every line. Items AP has already set are left as they are.
  async function applyCogsToAll(account) {
    const todo = (doc?.items || []).filter((i) => !i.cogs_account_id);
    if (!todo.length) return;
    setBusy(true); setError(''); setSaved('');
    try {
      for (const it of todo) await api.put(`/forms/${id}/items/${it.id}/cogs`, { cogs_account_id: account.id });
      await load();
      setSaved(`${account.account_code} — ${account.account_name} set on ${todo.length} item(s).`);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not set the accounts.');
      await load();
    } finally { setBusy(false); }
  }

  async function setCreditAccount(accountId) {
    setError(''); setSaved('');
    try {
      await api.put(`/forms/${id}/credit-account`, { credit_account_id: accountId || null });
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not set the credit account.');
    }
  }

  async function setItemCogs(itemId, accountId) {
    setError(''); setSaved('');
    try {
      await api.put(`/forms/${id}/items/${itemId}/cogs`, { cogs_account_id: accountId || null });
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not set the account.');
    }
  }

  async function act(path, body, note) {
    setBusy(true); setError(''); setSaved('');
    try {
      await api.post(`/forms/${id}/${path}`, body || {});
      await load();
      setSaved(note);
      setRejecting(false);
    } catch (e) {
      setError(e.response?.data?.error || 'That did not go through.');
    } finally { setBusy(false); }
  }

  if (loading) return <LoadingSpinner />;
  if (!doc) return <div className="error-banner">{error || 'Form not found.'}</div>;

  const d = doc.detail || {};
  const isFund = doc.type === 'liquidation' || doc.type === 'revolving_fund';
  const hasItems = !NO_ITEM_TYPES.includes(doc.type);
  const itemsTotal = (doc.items || []).reduce((s, r) => s + Number(r.amount || 0), 0);

  // A business trip prints once noted; everything else needs approval. The server enforces this --
  // repeated here only so the button is not offered when it would be refused.
  const printable = ['business_trip', 'attendance_adjustment'].includes(doc.type)
    ? ['noted', 'approved'].includes(doc.status)
    : doc.status === 'approved';

  // Until somebody acts on it: draft, submitted (not yet noted) or rejected. Same list as the server.
  // Decided by the server: the owner while the form is still open, a System Admin always.
  const mayEdit = !!doc.can_edit;
  const maySubmit = doc.is_owner && doc.status === 'draft' && can('/forms', 'can_add');
  const mayDiscard = doc.is_owner && doc.status === 'draft' && can('/forms', 'can_delete');
  // Noting a liquidation or a payment belongs to the head of the department it came from, not to a
  // permission, so the server decides and this only draws the answer. When it says no, it says WHY
  // -- most departments have no head recorded yet, and a missing button with no explanation reads
  // as the module being broken rather than as the form waiting on somebody.
  const mayNote = doc.can_note && doc.status === 'submitted';
  // A liquidation is noted by Accounts Payable only once every item has a COGS account.
  const cogsBlocksNote = mayNote && doc.needs_cogs && doc.cogs_missing > 0;
  const noteBlocked = doc.status === 'submitted' && !doc.can_note && doc.note_blocked_reason;
  // Approving reads only from NOTED -- the head's sign-off is a gate, not a step to skip. Rejecting
  // still works from SUBMITTED: sending something back does not need the head to have seen it first.
  const mayApprove = doc.can_approve && doc.status === 'noted';
  // Decided by the server: an approver at submitted or noted, and the noter (department head, or
  // Accounts Payable for a liquidation) while the form is waiting on them.
  const mayReject = !!doc.can_reject;
  // Said plainly to the approver looking at a form they cannot yet act on, so a missing Approve
  // button reads as "waiting on the head" rather than as something broken.
  const awaitingNote = doc.can_approve && doc.status === 'submitted';
  // An approved liquidation goes to the books through a Vendor Bill raised from it, once.
  const mayBill = doc.type === 'liquidation' && doc.status === 'approved' && !doc.vendor_bill && can('/vendor-bills', 'can_add');

  async function discard() {
    if (!confirm(`Discard ${doc.request_no}? This cannot be undone.`)) return;
    setBusy(true); setError('');
    try { await api.delete(`/forms/${id}`); navigate('/forms'); }
    catch (e) { setError(e.response?.data?.error || 'Could not discard this form.'); setBusy(false); }
  }

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to={'/forms'}>Back</Link>
          {printable && can('/forms', 'can_print') && (
            <button className="btn btn-sm" onClick={() => window.open(`/forms/${id}/print`, '_blank')}>Print</button>
          )}
          {mayEdit && <Link className="btn btn-sm" to={`/forms/${id}/edit`}>Edit</Link>}
          {maySubmit && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={() => act('submit', null, 'Submitted for approval.')}>Submit</button>
          )}
          {mayNote && (
            <button className="btn btn-sm btn-primary" disabled={busy || cogsBlocksNote}
              title={cogsBlocksNote ? `Select an account for every item first (${doc.cogs_missing} missing)` : undefined}
              onClick={() => act('note', null, 'Noted.')}>Note</button>
          )}
          {mayApprove && (
            <button className="btn btn-sm btn-success" disabled={busy}
              onClick={() => act('approve', null, 'Approved.')}>Approve</button>
          )}
          {mayReject && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
          )}
          {mayDiscard && <button className="btn btn-sm btn-danger" disabled={busy} onClick={discard}>Discard</button>}
          {mayBill && (
            <button className="btn btn-sm btn-primary" onClick={() => setBilling(true)}>Create Vendor Bill</button>
          )}
          {doc.vendor_bill && (
            <Link className="btn btn-sm" to={`/vendor-bills/${doc.vendor_bill.id}`}>{doc.vendor_bill.bill_no}</Link>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="muted" style={{ marginBottom: 8 }}>{saved}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{TYPE_LABELS[doc.type] || pretty(doc.type)}</h1>
          <span className="estimate-no">{doc.request_no}</span>
        </div>
        <div className="estimate-status">
          <span className={`badge ${STATUS_BADGE[doc.status] || 'badge-muted'}`}>{pretty(doc.status)}</span>
        </div>
      </div>

      {noteBlocked && (
        <div className="muted" style={{ marginBottom: 8 }}>{doc.note_blocked_reason}</div>
      )}

      {awaitingNote && (
        <div className="muted" style={{ marginBottom: 8 }}>
          {(doc.noters || []).length
            ? `This has to be noted by ${doc.noters.join(' or ')} before it can be approved.`
            : 'This has to be noted before it can be approved.'}
        </div>
      )}

      {doc.status === 'rejected' && (
        <div className="error-banner">
          <strong>Returned by {doc.rejected_by_name || 'an approver'}</strong>
          {doc.rejection_reason ? ` — ${doc.rejection_reason}` : ''}
          {doc.is_owner && ' Edit the form and save; it goes back for a decision automatically.'}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <Line label="Filed By">{doc.owner_name}</Line>
        <Line label="Department">{doc.department}</Line>
        <Line label="Name">{doc.name}</Line>
        <Line label="Date Created">{fmtDate(doc.created_at)}</Line>
        <Line label="Submitted">{fmtDate(doc.submitted_at)}</Line>
        <Line label="Noted">{doc.noted_at ? `${fmtDate(doc.noted_at)} by ${doc.noted_by_name || '—'}` : null}</Line>
        {/* Named whoever is looking, so the person who filed it knows who to chase rather than
            having to ask who heads their own department. */}
        <Line label="To Be Noted By">
          {!doc.noted_at && (doc.noters || []).length ? doc.noters.join(' or ') : null}
        </Line>
        <Line label="Approved">{doc.approved_at ? `${fmtDate(doc.approved_at)} by ${doc.approved_by_name || '—'}` : null}</Line>
      </div>

      {doc.remarks && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Remarks</h3>
          <div style={{ whiteSpace: 'pre-wrap' }}>{doc.remarks}</div>
        </div>
      )}

      {isFund && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{doc.type === 'liquidation' ? 'Liquidation' : 'Revolving Fund'}</h3>
          <Line label="Week No.">{d.week_no}</Line>
          <Line label="Form No.">{d.form_no}</Line>
          <Line label="Period">{d.date_from || d.date_to ? `${fmtDate(d.date_from)} — ${fmtDate(d.date_to)}` : null}</Line>
          <Line label="Cash Advance">{d.cash_advance_amount != null ? `${money(d.cash_advance_amount)} on ${fmtDate(d.cash_advance_date) || '—'}` : null}</Line>
          <Line label="Previous Balance">{d.previous_balance != null ? money(d.previous_balance) : null}</Line>
          <Line label="Starting Balance">{d.starting_balance != null ? money(d.starting_balance) : null}</Line>
          <Line label="Reimbursement Amount">{d.reimbursement_amount != null ? money(d.reimbursement_amount) : null}</Line>
          <Line label="Ending Balance">{d.ending_balance != null ? money(d.ending_balance) : null}</Line>
          {doc.type === 'liquidation' && (doc.purposes || []).length > 0 && (
            <Line label="Purpose">
              {doc.purposes.map((p) => (p.purpose === 'others' && p.other_text
                ? `Others: ${p.other_text}` : PURPOSE_LABELS[p.purpose] || p.purpose)).join(', ')}
            </Line>
          )}
        </div>
      )}

      {PAYMENT_TYPES.includes(doc.type) && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{TYPE_LABELS[doc.type]}</h3>
          {doc.type === 'fund_transfer' && <>
            <Line label="From">{bankLabel(d.from_account_code, d.from_account_name)}</Line>
            <Line label="To">{bankLabel(d.to_account_code, d.to_account_name)}</Line>
          </>}
          <Line label="Payable To">{d.payable_to}</Line>
          <Line label="Address">{d.address}</Line>
          <Line label="Date">{fmtDate(d.doc_date)}</Line>
          <Line label="Total Amount">{d.total_amount != null ? money(d.total_amount) : null}</Line>
        </div>
      )}

      {doc.type === 'attendance_adjustment' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Attendance Adjustment</h3>
          <Line label="Date">{fmtDate(d.adjustment_date)}</Line>
          {ADJ_TIMES.map(([k, label]) => <Line key={k} label={label}>{d[k] ? clock(d[k]) : null}</Line>)}
          <Line label="Reason">{d.reason ? `${ADJ_REASON_LABELS[d.reason] || d.reason}${d.reason === 'others' && d.reason_other ? `: ${d.reason_other}` : ''}` : null}</Line>
        </div>
      )}

      {doc.type === 'business_trip' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Business Trip</h3>
          <Line label="Driver">{d.driver_name}</Line>
          <Line label="Vehicle Plate No.">{d.vehicle_plate_no}</Line>
          <Line label="Trip Date">{fmtDate(d.trip_date)}</Line>
          <Line label="Time Out / In">{d.time_out || d.time_in ? `${d.time_out || '—'} — ${d.time_in || '—'}` : null}</Line>
          <Line label="Speedometer">{d.speedometer_begin || d.speedometer_end ? `${d.speedometer_begin || '—'} → ${d.speedometer_end || '—'}` : null}</Line>
          <Line label="Total Mileage">{d.total_mileage_km != null ? `${d.total_mileage_km} km` : null}</Line>
          <Line label="Purpose">{d.purpose}</Line>
          <Line label="Checked By">{d.checked_by}</Line>
          <Line label="Noted By">{d.noted_by_name}</Line>
        </div>
      )}

      {hasItems && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{PAYMENT_TYPES.includes(doc.type) ? 'Particulars' : 'Expenses'}</h3>
          {cogsBlocksNote && (
            <div className="muted" style={{ marginBottom: 8, color: 'var(--danger, #b91c1c)' }}>
              Select an account for every item before noting -- {doc.cogs_missing} still missing.
            </div>
          )}
          {canSetCogs && doc.cogs_missing > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <span className="muted">Apply to all items without an account :</span>
              <div style={{ minWidth: 300 }}>
                <EntityPicker
                  label="Select Account (all items)" items={cogsAccounts} value=""
                  getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
                  searchKeys={['account_code', 'account_name']}
                  placeholder="Select Account"
                  disabled={busy}
                  onSelect={applyCogsToAll}
                />
              </div>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {isFund && <th>Date</th>}
                  <th>Particulars</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  {doc.needs_cogs && <th>Account</th>}
                </tr>
              </thead>
              <tbody>
                {(doc.items || []).length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 16 }}>No lines.</td></tr>
                )}
                {(doc.items || []).map((r) => (
                  <tr key={r.id}>
                    {isFund && <td>{fmtDate(r.item_date)}</td>}
                    <td>
                      {r.particulars}
                      {r.rejection_remark && (
                        <div className="muted" style={{ color: 'var(--danger, #b91c1c)', fontSize: 12 }}>
                          Returned: {r.rejection_remark}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
                    {doc.needs_cogs && (
                      <td>
                        {canSetCogs ? (
                          <div style={{ minWidth: 260, ...(!r.cogs_account_id ? { outline: '1px solid var(--danger, #b91c1c)', borderRadius: 6 } : {}) }}>
                            <EntityPicker
                              label="Select Account" items={cogsAccounts} value={r.cogs_account_id || ''}
                              getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
                              searchKeys={['account_code', 'account_name']}
                              placeholder="Select Account"
                              onSelect={(a) => setItemCogs(r.id, a.id)}
                              onClear={() => setItemCogs(r.id, null)}
                            />
                          </div>
                        ) : (r.cogs_account_id ? `${r.cogs_account_code} — ${r.cogs_account_name}` : <span className="muted">—</span>)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={isFund ? 2 : 1} style={{ fontWeight: 700 }}>Total</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(itemsTotal)}</td>
                  {doc.needs_cogs && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Every form type takes attachments (2026-10-07). */}
      <FormAttachments formId={doc.id} />

      {doc.needs_cogs && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>GL Impact</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            {doc.gl_posts
              ? <>Posted to the books through {doc.vendor_bill.bill_no}. The liquidation itself posts nothing.</>
              : 'Not posted. This liquidation posts nothing on its own: once approved, Accounts Payable creates a Vendor Bill from it, and that bill debits each item\'s account and credits the credit account below.'}
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <span className="muted">Credit Account :</span>
            {canSetCogs ? (
              <div style={{ minWidth: 320 }}>
                <EntityPicker
                  label="Credit Account" items={creditAccounts} value={doc.credit_account_id || ''}
                  getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
                  searchKeys={['account_code', 'account_name']}
                  placeholder="13305 — Advances To Employees - For Liquidation (default)"
                  onSelect={(a) => setCreditAccount(a.id)}
                  onClear={() => setCreditAccount(null)}
                />
              </div>
            ) : (
              <strong>{doc.credit_account_id ? `${doc.credit_account_code} — ${doc.credit_account_name}` : '13305 — Advances To Employees - For Liquidation'}</strong>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account Code</th><th>Account Title</th><th>Memo</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {(doc.gl_impact || []).length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing to post until every item has an account.</td></tr>
                )}
                {(doc.gl_impact || []).map((g, i) => (
                  <tr key={i}>
                    <td>{g.account_code}</td>
                    <td>{g.account_name}</td>
                    <td>{g.memo}</td>
                    <td style={{ textAlign: 'right' }}>{g.debit ? money(g.debit) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{g.credit ? money(g.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
              {(doc.gl_impact || []).length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={3} style={{ fontWeight: 700 }}>Total</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(doc.gl_impact.reduce((t, g) => t + Number(g.debit || 0), 0))}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(doc.gl_impact.reduce((t, g) => t + Number(g.credit || 0), 0))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      <FormSystemInfo formId={doc.id} version={`${doc.updated_at}|${doc.status}`} />

      {billing && (
        <StandaloneVendorBillModal
          fromLiquidation={doc}
          onClose={() => setBilling(false)}
          onSaved={(vb) => navigate(`/vendor-bills/${vb.id}`)}
        />
      )}

      {rejecting && (
        <Modal title={`Reject ${doc.request_no}`} onClose={() => setRejecting(false)} large>
          <div className="field">
            <label>Reason</label>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="What has to change before this can be approved" />
          </div>
          {hasItems && (doc.items || []).length > 0 && (
            <>
              {/* Per line, because "rejected" on its own tells the owner nothing about WHICH
                  expense is the problem. Leave a line blank to say nothing about it. */}
              <p className="muted" style={{ marginTop: 12 }}>Add a remark against any line that has to change.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Particulars</th><th style={{ width: 120 }}>Amount</th><th>Remark</th></tr></thead>
                  <tbody>
                    {doc.items.map((r) => (
                      <tr key={r.id}>
                        <td>{r.particulars}</td>
                        <td>{money(r.amount)}</td>
                        <td>
                          <input value={lineRemarks[r.id] || ''}
                            onChange={(e) => setLineRemarks((p) => ({ ...p, [r.id]: e.target.value }))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={() => setRejecting(false)}>Cancel</button>
            <button className="btn btn-warning" disabled={busy}
              onClick={() => act('reject', { reason, line_remarks: lineRemarks }, 'Returned to the filer.')}>
              Reject
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
