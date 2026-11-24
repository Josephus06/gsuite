import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayDate, displayDateTime } from '../../utils/dates';
import { useAuth } from '../../context/useAuth';
import FilterPicker from '../../components/FilterPicker';
import SearchInput from '../../components/SearchInput';
import Modal from '../../components/Modal';

// Sales > Pending Billing: Job Orders production has completed but that are not yet (fully)
// invoiced -- the work that is done and waiting for its bill. Oldest first, because the longer a
// finished job sits unbilled the more it matters. See routes/pendingBillingReport.js for what
// "completed" and "invoiced" mean here.
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

export default function PendingBilling() {
  // location_id starts null: the first load waits for the locations so it is already Head Office's.
  const [f, setF] = useState({ search: '', sales_rep_id: '', location_id: null, from: '', to: '' });
  const [locations, setLocations] = useState([]);
  const [reps, setReps] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  // can_update here ticks wt PAR / wt PICS / wt PO by hand; an attachment ticks them for everyone.
  // PAR and PICS were one "wt PAR&Pics" box until 2026-11-24.
  const { can } = useAuth();
  const canMark = can('/reports/pending-billing', 'can_update');
  const [marking, setMarking] = useState('');
  // Ticking wt PAR or wt PICS asks for the date it was sent (2026-11-13): { row, target, date }.
  const [askSent, setAskSent] = useState(null);
  const todayKey = new Date().toLocaleDateString('en-CA');
  const WHAT = { par: 'PAR', pics: 'Pictures', po: 'PO' };
  const perJo = (target) => target === 'par' || target === 'pics';

  // Email the sales rep (2026-11-24): the window shows who it goes to (their user account's email)
  // before anything is sent; an optional note goes in the email. { row, to, last, note, busy, error, sentTo }
  const [mail, setMail] = useState(null);
  async function openEmail(row) {
    setMail({ row, to: null, note: '', busy: true, error: '' });
    try {
      const { data: d } = await api.get('/reports/pending-billing/email-preview', { params: { job_order_id: row.id } });
      setMail((m) => m && { ...m, to: d.to, last: d.last, busy: false });
    } catch (e) {
      setMail((m) => m && { ...m, busy: false, error: e.response?.data?.error || 'Could not find the sales rep’s email.' });
    }
  }
  async function sendEmail() {
    setMail((m) => ({ ...m, busy: true, error: '' }));
    try {
      const { data: d } = await api.post('/reports/pending-billing/email', { job_order_id: mail.row.id, note: mail.note });
      setData((x) => ({ ...x, rows: x.rows.map((r) => (r.id === mail.row.id ? { ...r, email_mark: d.mark } : r)) }));
      setMail((m) => ({ ...m, busy: false, sentTo: d.to }));
    } catch (e) {
      setMail((m) => ({ ...m, busy: false, error: e.response?.data?.error || 'The email could not be sent.' }));
    }
  }

  // A PO mark belongs to the sales order, so it changes every row of that order.
  async function toggleMark(row, target, checked, sentDate) {
    if (perJo(target) && checked && !sentDate) { setAskSent({ row, target, date: todayKey }); return; }
    const id = perJo(target) ? row.id : row.sales_order_id;
    setMarking(`${target}|${id}`); setError('');
    try {
      const { data: { mark } } = await api.put('/reports/pending-billing/mark', { target, id, checked, sent_date: sentDate || undefined });
      setData((d) => ({
        ...d,
        rows: d.rows.map((r) => {
          if (target === 'par' && r.id === id) return { ...r, par_mark: mark, with_par: r.par_file || !!mark };
          if (target === 'pics' && r.id === id) return { ...r, pics_mark: mark, with_pics: r.pics_file || !!mark };
          if (target === 'po' && r.sales_order_id === id) return { ...r, po_mark: mark, with_po: r.po_file || !!mark };
          return r;
        }),
      }));
    } catch (e) { setError(e.response?.data?.error || 'Could not save the tick.'); } finally { setMarking(''); }
  }

  const markBox = (row, target) => {
    const file = row[`${target}_file`];
    const mark = row[`${target}_mark`];
    const id = perJo(target) ? row.id : row.sales_order_id;
    const editable = canMark && !file && !!id && marking !== `${target}|${id}`;
    const what = WHAT[target];
    let title = `No ${what} yet`;
    if (file) title = `${what} attached`;
    else if (mark) title = `${mark.sent ? `Sent ${displayDate(mark.sent)} · ` : ''}Ticked by ${mark.by || 'someone'}${mark.at ? `, ${displayDateTime(mark.at)}` : ''}`;
    return (
      <>
        <input type="checkbox" checked={!!(file || mark)} title={title} aria-label={`with ${what}`}
          readOnly={!editable} style={{ cursor: editable ? 'pointer' : 'default' }}
          onClick={editable ? undefined : (e) => e.preventDefault()}
          onChange={editable ? (e) => toggleMark(row, target, e.target.checked) : undefined} />
        {!file && mark?.sent && <div className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>Sent {displayDate(mark.sent)}</div>}
      </>
    );
  };

  useEffect(() => { api.get('/employees').then((r) => setReps(r.data)).catch(() => {}); }, []);
  useEffect(() => {
    api.get('/lookups/locations')
      .then(({ data: d }) => {
        const locs = Array.isArray(d) ? d : (d?.rows || []);
        setLocations(locs);
        const ho = locs.find((l) => String(l.location_name || '').trim().toLowerCase() === 'head office');
        setF((x) => (x.location_id === null ? { ...x, location_id: ho ? String(ho.id) : '' } : x));
      })
      .catch(() => setF((x) => (x.location_id === null ? { ...x, location_id: '' } : x)));
  }, []);

  const params = () => ({
    search: f.search || undefined, sales_rep_id: f.sales_rep_id || undefined, location_id: f.location_id || undefined,
    from: f.from || undefined, to: f.to || undefined,
  });

  useEffect(() => {
    if (f.location_id === null) return undefined;
    const t = setTimeout(() => {
      setError('');
      api.get('/reports/pending-billing', { params: params() })
        .then((r) => setData(r.data))
        .catch((e) => { setError(e.response?.data?.error || 'Could not load the report.'); setData({ rows: [], totals: {} }); });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f]);

  async function exportExcel() {
    setExporting(true);
    try {
      const { data: blob } = await api.get('/reports/pending-billing/export', { params: params(), responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `pending-billing-${new Date().toLocaleDateString('en-CA')}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Could not export.'); } finally { setExporting(false); }
  }

  // Email selected (2026-11-24): tick JOs, then one email per sales rep listing all of theirs.
  // The selection keeps only JOs still on screen after the list reloads.
  const [picked, setPicked] = useState(() => new Set());
  useEffect(() => {
    if (!data?.rows) return;
    const onScreen = new Set(data.rows.map((r) => r.id));
    setPicked((p) => new Set([...p].filter((id) => onScreen.has(id))));
  }, [data?.rows]);
  const togglePick = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = !!data?.rows?.length && data.rows.every((r) => picked.has(r.id));
  const pickAll = (on) => setPicked(on ? new Set((data?.rows || []).map((r) => r.id)) : new Set());
  // { plan, note, busy, error, done }
  const [bulk, setBulk] = useState(null);
  async function openBulk() {
    setBulk({ plan: null, note: '', busy: true, error: '' });
    try {
      const { data: plan } = await api.post('/reports/pending-billing/email-bulk/preview', { job_order_ids: [...picked] });
      setBulk((b) => b && { ...b, plan, busy: false });
    } catch (e) { setBulk((b) => b && { ...b, busy: false, error: e.response?.data?.error || 'Could not prepare the emails.' }); }
  }
  async function sendBulk() {
    setBulk((b) => ({ ...b, busy: true, error: '' }));
    try {
      const { data: d } = await api.post('/reports/pending-billing/email-bulk', { job_order_ids: [...picked], note: bulk.note });
      setData((x) => ({ ...x, rows: x.rows.map((r) => (d.marks[r.id] ? { ...r, email_mark: d.marks[r.id] } : r)) }));
      setBulk((b) => ({ ...b, busy: false, done: d }));
      if (d.results.every((x) => x.ok)) setPicked(new Set());
    } catch (e) { setBulk((b) => ({ ...b, busy: false, error: e.response?.data?.error || 'The emails could not be sent.' })); }
  }

  const upd = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const t = data?.totals || {};

  return (
    <div>
      <div className="page-header">
        <h1>Pending Billing</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-sm btn-primary" disabled={!picked.size} onClick={openBulk}
            title="One email to each sales rep, listing all of their selected Job Orders">
            ✉ Email selected{picked.size ? ` (${picked.size})` : ''}
          </button>
          <button type="button" className="btn btn-sm" disabled={exporting || !data?.rows?.length} onClick={exportExcel}>{exporting ? 'Exporting…' : 'Export to Excel'}</button>
        </div>
      </div>
      {bulk && (
        <Modal title={`Email ${picked.size || ''} selected Job Order${picked.size === 1 ? '' : 's'}`} onClose={() => setBulk(null)}>
          {bulk.done ? (
            <>
              {bulk.done.results.length === 0 && <p style={{ marginTop: 0 }}>Nothing was sent.</p>}
              {bulk.done.results.map((x) => (
                <div key={x.email} style={{ padding: '3px 0', color: x.ok ? undefined : '#b91c1c' }}>
                  {x.ok ? '✓' : '✗'} {x.name} &lt;{x.email}&gt; — {x.jos} JO{x.jos === 1 ? '' : 's'}{x.ok ? '' : `: ${x.error}`}
                </div>
              ))}
              {bulk.done.no_email.length > 0 && <p className="muted" style={{ fontSize: 12 }}>Not sent (no email): {bulk.done.no_email.map((x) => x.name).join(', ')}</p>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button type="button" className="btn btn-primary" onClick={() => setBulk(null)}>Close</button></div>
            </>
          ) : !bulk.plan ? (
            <>{bulk.busy ? <p style={{ marginTop: 0 }}>Grouping the Job Orders by sales rep…</p> : null}
              {bulk.error && <div className="error-banner">{bulk.error}</div>}</>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); if (!bulk.busy && bulk.plan.recipients.length) sendBulk(); }}>
              <p style={{ marginTop: 0 }}>One email to each sales rep, listing all of their selected Job Orders:</p>
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px' }}>
                {bulk.plan.recipients.length === 0 && <div className="muted" style={{ padding: 6 }}>Nobody to email.</div>}
                {bulk.plan.recipients.map((x) => (
                  <div key={x.email} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span><strong>{x.name}</strong> <span className="muted">&lt;{x.email}&gt;</span></span>
                    <span style={{ whiteSpace: 'nowrap' }}>{x.jos} JO{x.jos === 1 ? '' : 's'} · {money(x.amount)}</span>
                  </div>
                ))}
              </div>
              {bulk.plan.no_email.length > 0 && (
                <div className="warning-banner" style={{ marginTop: 8, fontSize: 12 }}>
                  Skipped -- no email on their account: {bulk.plan.no_email.map((x) => `${x.name} (${x.jos.length})`).join(', ')}.
                </div>
              )}
              {(bulk.plan.skipped_recent.length > 0 || bulk.plan.no_rep.length > 0) && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  {bulk.plan.skipped_recent.length > 0 && <>Skipped -- emailed in the last 10 minutes: {bulk.plan.skipped_recent.join(', ')}. </>}
                  {bulk.plan.no_rep.length > 0 && <>Skipped -- no sales rep: {bulk.plan.no_rep.join(', ')}.</>}
                </div>
              )}
              <div className="field" style={{ marginTop: 10 }}>
                <label>Note (optional, in every email)</label>
                <textarea rows={3} maxLength={2000} value={bulk.note} placeholder="e.g. Please send the signed PARs so we can bill before month end."
                  onChange={(e) => setBulk((b) => ({ ...b, note: e.target.value }))} style={{ width: '100%' }} />
              </div>
              {bulk.error && <div className="error-banner" style={{ marginTop: 8 }}>{bulk.error}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="btn" onClick={() => setBulk(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={bulk.busy || !bulk.plan.recipients.length}>
                  {bulk.busy ? 'Sending…' : `Send ${bulk.plan.recipients.length} email${bulk.plan.recipients.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      <p className="muted" style={{ marginTop: -8 }}>Job Orders built, QI'd and delivered but not yet on a Delivery Ticket or Invoice, oldest first.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>General Searching</label><SearchInput value={f.search} placeholder="JO, SO, customer or description..." onChange={(e) => upd('search', e.target.value)} /></div>
          <div className="field">
            <label>Sales Rep</label>
            <FilterPicker label="Sales Rep" items={reps} value={f.sales_rep_id} onChange={(v) => upd('sales_rep_id', v)}
              getLabel={(r) => `${r.first_name} ${r.last_name}`} allLabel="All" />
          </div>
          <div className="field">
            <label>Office Location</label>
            <FilterPicker label="Office Location" items={locations} value={f.location_id ?? ''} onChange={(v) => upd('location_id', v)}
              getLabel={(l) => l.location_name} allLabel="All" />
          </div>
          <div className="field"><label>Completed From</label><input type="date" value={f.from} onChange={(e) => upd('from', e.target.value)} /></div>
          <div className="field"><label>Completed To</label><input type="date" value={f.to} onChange={(e) => upd('to', e.target.value)} /></div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {askSent && (
        <Modal title={`${WHAT[askSent.target]} sent`} onClose={() => setAskSent(null)}>
          <p style={{ marginTop: 0 }}>{askSent.row.job_order_no} -- the date the {askSent.target === 'par' ? 'PAR' : 'pictures'} {askSent.target === 'par' ? 'was' : 'were'} sent.</p>
          <form onSubmit={(e) => {
            e.preventDefault();
            if (!askSent.date) return;
            const { row, target, date } = askSent;
            setAskSent(null);
            toggleMark(row, target, true, date);
          }}>
            <div className="field">
              <label>Date Sent *</label>
              <input type="date" required autoFocus max={todayKey} value={askSent.date}
                onChange={(e) => setAskSent((a) => ({ ...a, date: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="btn" onClick={() => setAskSent(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!askSent.date}>Save</button>
            </div>
          </form>
        </Modal>
      )}
      {mail && (
        <Modal title={`Email the sales rep · ${mail.row.job_order_no}`} onClose={() => setMail(null)}>
          {mail.sentTo ? (
            <>
              <p style={{ marginTop: 0 }}>✓ Sent to <strong>{mail.sentTo.name}</strong> ({mail.sentTo.email}).</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" className="btn btn-primary" onClick={() => setMail(null)}>Close</button></div>
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); if (mail.to && !mail.busy) sendEmail(); }}>
              <p style={{ marginTop: 0 }}>
                A reminder that <strong>{mail.row.job_order_no}</strong> ({mail.row.customer_name}) is delivered but not billed:
                {' '}{qty(mail.row.uninvoiced_qty)} to bill, {money(mail.row.unbilled_amount)}, {mail.row.days_pending ?? '?'} days pending
                {[!mail.row.with_par && 'PAR', !mail.row.with_pics && 'pictures', !mail.row.with_po && mail.row.sales_order_id && 'PO'].filter(Boolean).length
                  ? <> — still missing {[!mail.row.with_par && 'PAR', !mail.row.with_pics && 'pictures', !mail.row.with_po && mail.row.sales_order_id && 'PO'].filter(Boolean).join(', ')}</> : null}.
              </p>
              <div className="field">
                <label>To</label>
                <div style={{ padding: '6px 0' }}>
                  {mail.busy && !mail.to ? 'Finding the sales rep’s email…' : mail.to ? <><strong>{mail.to.name}</strong> &lt;{mail.to.email}&gt;</> : '—'}
                </div>
              </div>
              {mail.last && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Last emailed {displayDateTime(mail.last.at)}{mail.last.by ? ` by ${mail.last.by}` : ''}.</div>}
              <div className="field">
                <label>Note (optional)</label>
                <textarea rows={3} maxLength={2000} value={mail.note} placeholder="e.g. Please send the signed PAR so we can bill this week."
                  onChange={(e) => setMail((m) => ({ ...m, note: e.target.value }))} style={{ width: '100%' }} />
              </div>
              {mail.error && <div className="error-banner" style={{ marginTop: 8 }}>{mail.error}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="btn" onClick={() => setMail(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={!mail.to || mail.busy}>{mail.busy && mail.to ? 'Sending…' : 'Send email'}</button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {!data ? <LoadingSpinner /> : (
        <>
          <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div><span className="muted">Job Orders</span><div className="hi-lg">{(t.jobs || 0).toLocaleString()}</div></div>
            <div><span className="muted">Qty to Bill</span><div className="hi-lg">{qty(t.qty)}</div></div>
            <div><span className="muted">Unbilled Amount</span><div className="hi-lg">{money(t.amount)}</div></div>
            <div><span className="muted">Pending over 30 days</span><div className="hi-lg" style={{ color: t.over30 ? 'var(--danger, #b91c1c)' : undefined }}>{money(t.over30)}</div></div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={allPicked} disabled={!data.rows.length}
                        onChange={(e) => pickAll(e.target.checked)} title="Select every Job Order listed" aria-label="Select all" />
                    </th>
                    <th>Job Order</th><th>SO / NSSO</th><th>Customer</th><th>Sales Rep</th><th>Department</th><th>Description</th>
                    <th>Completed</th>
                    <th title="The Job Order has a PAR file (Production > Job Order > Production Attachment), or someone with Update rights here ticked it" style={{ textAlign: 'center' }}>wt PAR</th>
                    <th title="The Job Order has a Picture file (Production > Job Order > Production Attachment), or someone with Update rights here ticked it" style={{ textAlign: 'center' }}>wt PICS</th>
                    <th title="The Sales Order has a file typed PO (Sales Order > Attachment), or someone with Update rights here ticked it" style={{ textAlign: 'center' }}>wt PO</th>
                    <th className="text-right">Days Pending</th><th className="text-right">Qty</th>
                    <th className="text-right">Delivered</th><th className="text-right">Invoiced</th><th className="text-right">To Bill</th>
                    <th className="text-right">Unit Price</th><th className="text-right">Unbilled Amount</th>
                    <th title="Email the Job Order's sales rep a reminder to follow it up for billing">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={19} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing pending billing.</td></tr>}
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td><input type="checkbox" style={{ width: 'auto' }} checked={picked.has(r.id)} onChange={() => togglePick(r.id)} aria-label={`Select ${r.job_order_no}`} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}><Link to={`/job-orders/${r.id}`}>{r.job_order_no}</Link></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.sales_order_id ? <Link to={`/sales-orders/${r.sales_order_id}`}>{r.sales_order_no}</Link> : (r.nsso_no || '')}</td>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td>{r.sales_rep_name || ''}</td>
                      <td>{r.department_name || ''}</td>
                      <td style={{ maxWidth: 320 }}>{r.description}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{displayDate(r.completed_date || r.so_date)}</td>
                      <td style={{ textAlign: 'center' }}>{markBox(r, 'par')}</td>
                      <td style={{ textAlign: 'center' }}>{markBox(r, 'pics')}</td>
                      <td style={{ textAlign: 'center' }}>{markBox(r, 'po')}</td>
                      <td className="text-right" style={r.days_pending > 30 ? { color: 'var(--danger, #b91c1c)', fontWeight: 600 } : undefined}>{r.days_pending ?? ''}</td>
                      <td className="text-right">{qty(r.quantity)}</td>
                      <td className="text-right">{qty(r.quantity_delivered)}</td>
                      <td className="text-right" title={r.invoice_nos || ''}>{qty(r.invoiced_qty)}</td>
                      <td className="text-right"><strong>{qty(r.uninvoiced_qty)}</strong></td>
                      <td className="text-right">{money(r.unit_gross)}</td>
                      <td className="text-right"><strong>{money(r.unbilled_amount)}</strong></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm" onClick={() => openEmail(r)} title={`Email ${r.sales_rep_name || 'the sales rep'} about ${r.job_order_no}`}>✉ Email</button>
                        {r.email_mark && (
                          <div className="muted" style={{ fontSize: 11 }} title={`Emailed by ${r.email_mark.by || 'someone'}, ${displayDateTime(r.email_mark.at)}`}>
                            Emailed {displayDate(String(r.email_mark.at).slice(0, 10))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.rows.length > 0 && (
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                      <td colSpan={15}>Total</td><td className="text-right">{qty(t.qty)}</td><td /><td className="text-right">{money(t.amount)}</td><td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
