import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { useAuth } from '../context/useAuth';
import { PURPOSE_LABELS, STATUS_BADGE, TYPE_LABELS, fmtDate, money, pretty } from '../utils/requestForms';

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

  const load = useCallback(() => api.get(`/forms/${id}`).then(({ data }) => {
    setDoc(data);
    setLoading(false);
  }), [id]);

  useEffect(() => {
    load().catch((e) => { setError(e.response?.data?.error || 'Could not load this form.'); setLoading(false); });
  }, [load]);

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
  const hasItems = doc.type !== 'business_trip';
  const itemsTotal = (doc.items || []).reduce((s, r) => s + Number(r.amount || 0), 0);

  // A business trip prints once noted; everything else needs approval. The server enforces this --
  // repeated here only so the button is not offered when it would be refused.
  const printable = doc.type === 'business_trip'
    ? ['noted', 'approved'].includes(doc.status)
    : doc.status === 'approved';

  const mayEdit = doc.is_owner && ['draft', 'rejected'].includes(doc.status) && can('/forms', 'can_edit');
  const maySubmit = doc.is_owner && doc.status === 'draft' && can('/forms', 'can_add');
  const mayDiscard = doc.is_owner && doc.status === 'draft' && can('/forms', 'can_delete');
  const mayNote = doc.can_note && doc.status === 'submitted';
  const mayDecide = doc.can_approve && ['submitted', 'noted'].includes(doc.status);

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
          <button className="btn btn-sm" onClick={() => navigate('/forms')}>Back</button>
          {printable && can('/forms', 'can_print') && (
            <button className="btn btn-sm" onClick={() => window.open(`/forms/${id}/print`, '_blank')}>Print</button>
          )}
          {mayEdit && <button className="btn btn-sm" onClick={() => navigate(`/forms/${id}/edit`)}>Edit</button>}
          {maySubmit && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={() => act('submit', null, 'Submitted for approval.')}>Submit</button>
          )}
          {mayNote && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={() => act('note', null, 'Noted.')}>Note</button>
          )}
          {mayDecide && (
            <>
              <button className="btn btn-sm btn-success" disabled={busy}
                onClick={() => act('approve', null, 'Approved.')}>Approve</button>
              <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
            </>
          )}
          {mayDiscard && <button className="btn btn-sm btn-danger" disabled={busy} onClick={discard}>Discard</button>}
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
        <Line label="Approved">{doc.approved_at ? `${fmtDate(doc.approved_at)} by ${doc.approved_by_name || '—'}` : null}</Line>
      </div>

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

      {doc.type === 'payment' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Request for Payment</h3>
          <Line label="Payable To">{d.payable_to}</Line>
          <Line label="Address">{d.address}</Line>
          <Line label="Date">{fmtDate(d.doc_date)}</Line>
          <Line label="Total Amount">{d.total_amount != null ? money(d.total_amount) : null}</Line>
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
          <h3>{doc.type === 'payment' ? 'Particulars' : 'Expenses'}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {isFund && <th>Date</th>}
                  <th>Particulars</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {(doc.items || []).length === 0 && (
                  <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 16 }}>No lines.</td></tr>
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
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={isFund ? 2 : 1} style={{ fontWeight: 700 }}>Total</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(itemsTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
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
