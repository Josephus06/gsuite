import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { RATINGS, STEPS, fmtScore, pts, ratingLabel } from './perfUtils';

// One quarterly Performance Evaluation (2026-10-23; routes/performance.js), laid out as the PEF:
// the rating scale, A. Productivity & Efficiency (the position's KRAs), B. Core Values, the rating
// summary, the superior's comments, Part 2 the development plan, Part 3 the sign-offs. Beside it,
// the quarter's remarks -- logged by the employee and the supervisor while it runs.
const fmtDay = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const fmtWhen = (v) => (v ? new Date(`${String(v).replace(' ', 'T')}Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');

// A core value's Critical Incidents, as on the PEF: the employee's remarks (yellow), the rater's (blue).
const CV_SELF_BG = 'rgba(253, 230, 138, 0.35)';
const CV_RATER_BG = 'rgba(147, 197, 253, 0.3)';

function RatingSelect({ value, onChange, disabled }) {
  return (
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} style={{ minWidth: 64 }}>
      <option value="">—</option>
      {RATINGS.map(([n, l]) => <option key={n} value={n}>{n} - {l}</option>)}
    </select>
  );
}

export default function EvaluationView() {
  const { id } = useParams();
  const [e, setE] = useState(null);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({});
  const [remark, setRemark] = useState({ item_id: '', remark_date: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10), body: '' });
  const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => api.get(`/performance/evaluations/${id}`).then(({ data }) => {
    setE(data);
    setItems(data.items);
    setForm({
      superior_comments: data.superior_comments || '', strengths: data.strengths || '', improvements: data.improvements || '',
      coaching: data.coaching || '', career_plans: data.career_plans || '', discussion_date: data.discussion_date ? String(data.discussion_date).slice(0, 10) : '',
    });
  }).catch((err) => setError(err.response?.data?.error || 'Could not load the evaluation.')), [id]);
  useEffect(() => { load(); }, [load]);

  if (!e) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  const r = e.role;
  const setItem = (iid, patch) => setItems((list) => list.map((i) => (i.id === iid ? { ...i, ...patch } : i)));
  const run = async (fn, okMsg) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); setNotice(okMsg); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
    finally { setBusy(false); }
  };
  const saveSelf = (submit) => run(() => api.put(`/performance/evaluations/${id}/self`, {
    submit, items: items.map((i) => ({ id: i.id, self_rating: i.self_rating, actual_results: i.actual_results })),
  }), submit ? 'Self rating submitted to your supervisor.' : 'Saved.');
  const saveRate = (submit) => run(() => api.put(`/performance/evaluations/${id}/rate`, {
    submit, ...form, items: items.map((i) => ({ id: i.id, superior_rating: i.superior_rating, actual_results: i.actual_results, rater_results: i.rater_results })),
  }), submit ? 'Rating submitted -- the employee is asked to sign conforme after your discussion.' : 'Saved.');
  const addRemark = () => run(async () => {
    await api.post(`/performance/evaluations/${id}/remarks`, remark);
    setRemark((x) => ({ ...x, body: '' }));
  }, 'Remark added.');
  const delRemark = (rid) => run(() => api.delete(`/performance/remarks/${rid}`), 'Remark removed.');
  const conforme = () => window.confirm('Sign conforme: you have discussed this evaluation with your supervisor.')
    && run(() => api.post(`/performance/evaluations/${id}/conforme`), 'Signed. It goes on for review.');
  const doReview = (action) => {
    if (action === 'return' && !review.trim()) { setError('Say why it is returned.'); return; }
    run(() => api.post(`/performance/evaluations/${id}/review`, { action, remarks: review }), action === 'return' ? 'Returned to the supervisor.' : 'Approved.');
  };

  const kras = items.filter((i) => i.section === 'kra');
  const cvs = items.filter((i) => i.section === 'cv');
  const stepIdx = STEPS.findIndex((s) => s[0] === e.status);
  const editResults = r.canSelfRate || r.canRate;
  const sub = (list, field) => (list.every((i) => i[field]) ? list.reduce((m, i) => m + pts(i[field], i.weight), 0) : null);
  const selfKra = sub(kras, 'self_rating'); const selfCv = sub(cvs, 'self_rating');
  const supKra = sub(kras, 'superior_rating'); const supCv = sub(cvs, 'superior_rating');
  const kw = Number(e.kra_weight) / 100; const cw = Number(e.cv_weight) / 100;
  const selfAll = selfKra != null && selfCv != null ? selfKra * kw + selfCv * cw : null;
  const supAll = supKra != null && supCv != null ? supKra * kw + supCv * cw : null;
  const showSup = !(r.employee && !r.rater && ['open', 'self_rating', 'supervisor_rating'].includes(e.status));
  const remarksFor = (iid) => e.remarks.filter((x) => Number(x.item_id) === Number(iid));

  const remarkBox = (i, k, editable) => (editable
    ? <textarea rows={3} style={{ width: '100%', fontSize: 12 }} value={i[k] || ''} onChange={(ev) => setItem(i.id, { [k]: ev.target.value })} />
    : <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{i[k] || <span className="muted">—</span>}</div>);

  const itemRows = (list, kind) => list.map((i) => (
    <tr key={i.id}>
      <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
        <strong>{i.label}</strong>
        {i.description && <div className="muted" style={{ fontSize: 11 }}>{i.description}</div>}
        {remarksFor(i.id).length > 0 && e.status === 'open' && <div style={{ fontSize: 11, marginTop: 2 }}>💬 {remarksFor(i.id).length} remark(s)</div>}
      </td>
      <td style={{ textAlign: 'right' }}>{Number(i.weight)}%</td>
      {kind === 'kra' && <td style={{ whiteSpace: 'normal', minWidth: 180, fontSize: 12 }}>{i.kpi}</td>}
      {kind === 'kra' && <td style={{ fontSize: 12 }}>{i.timeframe}</td>}
      {kind === 'kra' ? (
        <td style={{ minWidth: 220 }}>{remarkBox(i, 'actual_results', editResults)}</td>
      ) : (
        <>
          <td style={{ minWidth: 200, background: CV_SELF_BG }}>{remarkBox(i, 'actual_results', r.canSelfRate)}</td>
          <td style={{ minWidth: 200, background: CV_RATER_BG }}>{showSup ? remarkBox(i, 'rater_results', r.canRate) : <span className="muted" style={{ fontSize: 12 }}>— (after the supervisor rates)</span>}</td>
        </>
      )}
      <td>{r.canSelfRate ? <RatingSelect value={i.self_rating} onChange={(v) => setItem(i.id, { self_rating: v })} /> : (i.self_rating || '—')}</td>
      <td style={{ textAlign: 'right' }}>{fmtScore(pts(i.self_rating, i.weight))}</td>
      <td>{r.canRate ? <RatingSelect value={i.superior_rating} onChange={(v) => setItem(i.id, { superior_rating: v })} /> : (showSup ? (i.superior_rating || '—') : '—')}</td>
      <td style={{ textAlign: 'right' }}>{showSup ? fmtScore(pts(i.superior_rating, i.weight)) : '—'}</td>
    </tr>
  ));

  const text = (k, label, rows = 3) => (
    <div className="field"><label>{label}</label>
      {r.canRate ? <textarea rows={rows} value={form[k]} onChange={(ev) => setForm({ ...form, [k]: ev.target.value })} />
        : <div style={{ whiteSpace: 'pre-wrap', minHeight: 20 }}>{showSup ? (e[k] || <span className="muted">—</span>) : <span className="muted">— (after the supervisor rates)</span>}</div>}
    </div>
  );

  return (
    <div className="pe-print">
      {/* On paper the tables print whole (no scroll box to clip the rating columns) in a smaller type. */}
      <style>{`@media print {
        .pe-noprint { display: none !important; }
        .pe-grid { display: block !important; }
        .pe-print .table-wrap { overflow: visible !important; }
        .pe-print table { font-size: 10px; width: 100%; }
        .pe-print td, .pe-print th { padding: 3px 4px !important; }
        .pe-print select { appearance: none; border: none; padding: 0; }
        .pe-print .card { break-inside: avoid; box-shadow: none; }
        .pe-print td, .pe-print th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }`}</style>
      <div className="page-header pe-noprint">
        <h1>Performance Evaluation <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>Q{e.quarter} {e.year}</span></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/performance">Back</Link>
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid var(--success, #16a34a)' }}>{notice}</div>}
      {e.returned_reason && e.status === 'supervisor_rating' && <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid var(--danger, #b91c1c)' }}>Returned: {e.returned_reason}</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="filter-grid">
          <div><span className="muted">Employee</span><div style={{ fontWeight: 700 }}>{e.employee_name}</div></div>
          <div><span className="muted">Position</span><div style={{ fontWeight: 600 }}>{e.position_title}</div></div>
          <div><span className="muted">Department</span><div>{e.department || '—'}</div></div>
          <div><span className="muted">Rater</span><div>{e.rater_name || <span style={{ color: 'var(--danger, #b91c1c)' }}>no supervisor set</span>}</div></div>
          <div><span className="muted">Appraisal period</span><div>{fmtDay(e.start_date)} — {fmtDay(e.end_date)}</div></div>
          <div><span className="muted">Purpose</span><div>Q{e.quarter} {e.year} evaluation</div></div>
        </div>
        <div className="pe-noprint" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 12 }}>
          {STEPS.map(([k, l], i) => (
            <span key={k} className={`badge ${i < stepIdx ? 'badge-success' : i === stepIdx ? 'badge-warning' : 'badge-muted'}`}>{i + 1}. {l}</span>
          ))}
        </div>
      </div>

      <div className="pe-grid" style={{ display: 'grid', gridTemplateColumns: e.status === 'open' || e.remarks.length ? 'minmax(0, 1fr) 340px' : 'minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Rating</th><th>Level</th><th>A. Productivity &amp; Efficiency</th><th>B. Core Values</th></tr></thead>
                <tbody>{RATINGS.map(([n, l, a, b]) => <tr key={n}><td><strong>{n}</strong></td><td>{l}</td><td style={{ fontSize: 12 }}>{a}</td><td style={{ fontSize: 12 }}>{b}</td></tr>)}</tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>A. Productivity &amp; Efficiency ({Number(e.kra_weight)}%)</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Key Result Area</th><th style={{ textAlign: 'right' }}>Weight</th><th>KPI</th><th>Timeframe</th><th>Actual Results</th><th>Self</th><th style={{ textAlign: 'right' }}>Pts</th><th>Superior</th><th style={{ textAlign: 'right' }}>Pts</th></tr></thead>
                <tbody>{itemRows(kras, 'kra')}</tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>B. Core Values ({Number(e.cv_weight)}%)</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Core Value</th><th style={{ textAlign: 'right' }}>Weight</th><th style={{ background: CV_SELF_BG }}>Employee&apos;s Remarks</th><th style={{ background: CV_RATER_BG }}>Rater&apos;s Remarks</th><th>Self</th><th style={{ textAlign: 'right' }}>Pts</th><th>Superior</th><th style={{ textAlign: 'right' }}>Pts</th></tr></thead>
                <tbody>{itemRows(cvs, 'cv')}</tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Rating Summary</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th /><th style={{ textAlign: 'right' }}>Self Subtotal</th><th style={{ textAlign: 'right' }}>Weight</th><th style={{ textAlign: 'right' }}>Self Rating</th><th style={{ textAlign: 'right' }}>Superior Subtotal</th><th style={{ textAlign: 'right' }}>Superior Rating</th></tr></thead>
                <tbody>
                  <tr><td>A. Productivity &amp; Efficiency</td><td style={{ textAlign: 'right' }}>{fmtScore(selfKra)}</td><td style={{ textAlign: 'right' }}>{Number(e.kra_weight)}%</td><td style={{ textAlign: 'right' }}>{fmtScore(selfKra != null ? selfKra * kw : null)}</td><td style={{ textAlign: 'right' }}>{showSup ? fmtScore(supKra) : '—'}</td><td style={{ textAlign: 'right' }}>{showSup ? fmtScore(supKra != null ? supKra * kw : null) : '—'}</td></tr>
                  <tr><td>B. Core Values</td><td style={{ textAlign: 'right' }}>{fmtScore(selfCv)}</td><td style={{ textAlign: 'right' }}>{Number(e.cv_weight)}%</td><td style={{ textAlign: 'right' }}>{fmtScore(selfCv != null ? selfCv * cw : null)}</td><td style={{ textAlign: 'right' }}>{showSup ? fmtScore(supCv) : '—'}</td><td style={{ textAlign: 'right' }}>{showSup ? fmtScore(supCv != null ? supCv * cw : null) : '—'}</td></tr>
                  <tr style={{ fontWeight: 700 }}><td>OVER-ALL RATING</td><td /><td /><td style={{ textAlign: 'right' }}>{fmtScore(selfAll)} {selfAll != null && <span className="muted" style={{ fontWeight: 400 }}>({ratingLabel(selfAll)})</span>}</td><td /><td style={{ textAlign: 'right' }}>{showSup ? <>{fmtScore(supAll)} {supAll != null && <span className="muted" style={{ fontWeight: 400 }}>({ratingLabel(supAll)})</span>}</> : '—'}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            {text('superior_comments', "Superior's comments and recommendation")}
            <h3>Part 2: Individual Development Plan</h3>
            <div className="filter-grid">
              {text('strengths', "Employee's strengths / potentials")}
              {text('improvements', 'Specific areas for improvement / skills requirements')}
              {text('coaching', 'Proposed coaching or learning sessions and timing')}
              {text('career_plans', 'Career plans for the employee')}
            </div>
            <div className="field" style={{ maxWidth: 260 }}><label>Performance discussion held on</label>
              {r.canRate ? <input type="date" value={form.discussion_date} onChange={(ev) => setForm({ ...form, discussion_date: ev.target.value })} /> : <div>{fmtDay(e.discussion_date) || '—'}</div>}</div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Part 3: Discussion, Agreement and Approval</h3>
            <div className="filter-grid">
              <div><span className="muted">Immediate head (rated)</span><div>{e.rater_name || '—'}</div><div className="muted" style={{ fontSize: 11 }}>{fmtWhen(e.rated_at)}</div></div>
              <div><span className="muted">Employee (conforme)</span><div>{e.employee_name}</div><div className="muted" style={{ fontSize: 11 }}>{e.employee_conforme_at ? fmtWhen(e.employee_conforme_at) : 'not yet'}</div></div>
              <div><span className="muted">Department head</span><div>{e.dept_head_name || '— (none)'}</div><div className="muted" style={{ fontSize: 11 }}>{fmtWhen(e.dept_head_at)}{e.dept_head_remarks ? ` · ${e.dept_head_remarks}` : ''}</div></div>
              <div><span className="muted">Reviewed by HR</span><div className="muted" style={{ fontSize: 11 }}>{fmtWhen(e.hr_at) || 'not yet'}{e.hr_remarks ? ` · ${e.hr_remarks}` : ''}</div></div>
              <div><span className="muted">Approved by the GM</span><div className="muted" style={{ fontSize: 11 }}>{fmtWhen(e.gm_at) || 'not yet'}{e.gm_remarks ? ` · ${e.gm_remarks}` : ''}</div></div>
            </div>
          </div>

          <div className="pe-noprint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {r.canSelfRate && <>
              <button className="btn" disabled={busy} onClick={() => saveSelf(false)}>Save</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => window.confirm('Submit your self rating to your supervisor? It cannot be changed after.') && saveSelf(true)}>Submit Self Rating</button>
            </>}
            {r.canRate && <>
              <button className="btn" disabled={busy} onClick={() => saveRate(false)}>Save</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => window.confirm('Submit your rating? The employee then signs conforme after your discussion.') && saveRate(true)}>Submit Rating</button>
            </>}
            {r.canConforme && <button className="btn btn-primary" disabled={busy} onClick={conforme}>Sign Conforme</button>}
          </div>
          {r.canReview && (
            <div className="card pe-noprint" style={{ marginBottom: 20 }}>
              <h3 style={{ marginTop: 0 }}>{e.status === 'dept_head_review' ? 'Department Head Review' : e.status === 'hr_review' ? 'HR Review' : 'GM Approval'}</h3>
              <textarea rows={2} style={{ width: '100%' }} value={review} onChange={(ev) => setReview(ev.target.value)} placeholder="Remarks (required to return)" />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => doReview('approve')}>{e.status === 'gm_approval' ? 'Approve' : 'Approve & Forward'}</button>
                <button className="btn" disabled={busy} onClick={() => doReview('return')}>Return to Supervisor</button>
              </div>
            </div>
          )}
        </div>

        {(e.status === 'open' || e.remarks.length > 0) && (
          <div className="card pe-noprint" style={{ position: 'sticky', top: 12 }}>
            <h3 style={{ marginTop: 0 }}>Remarks this Quarter</h3>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {e.status === 'open'
                ? `Logged by ${e.employee_name} and ${e.rater_name || 'the supervisor'} until ${fmtDay(e.end_date)}; both see them. When the quarter closes they fill in Actual Results.`
                : 'Logged during the quarter (closed).'}
            </div>
            {r.canRemark && (
              <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                <select value={remark.item_id} onChange={(ev) => setRemark({ ...remark, item_id: ev.target.value })}>
                  <option value="">General</option>
                  <optgroup label="A. Key Result Areas">{kras.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</optgroup>
                  <optgroup label="B. Core Values">{cvs.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</optgroup>
                </select>
                <input type="date" value={remark.remark_date} onChange={(ev) => setRemark({ ...remark, remark_date: ev.target.value })} />
                <textarea rows={3} value={remark.body} onChange={(ev) => setRemark({ ...remark, body: ev.target.value })}
                  placeholder={r.employee ? 'An accomplishment, e.g. resolved the BIR report issue within 3 hours' : 'What you observed, e.g. resolved the BIR report issue within 3 hours'} />
                <button className="btn btn-primary btn-sm" disabled={busy || !remark.body.trim()} onClick={addRemark}>Add Remark</button>
              </div>
            )}
            {e.remarks.length === 0 && <div className="muted">No remarks yet.</div>}
            {e.remarks.map((x) => {
              const it = items.find((i) => Number(i.id) === Number(x.item_id));
              return (
                <div key={x.id} style={{ borderTop: '1px solid var(--border, #e5e7eb)', padding: '8px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 12 }}>
                    <span><span className={`badge ${x.author_role === 'supervisor' ? 'badge-info' : 'badge-muted'}`}>{x.author_role === 'supervisor' ? 'Supervisor' : 'Employee'}</span> {x.author_name}</span>
                    <span className="muted">{fmtDay(x.remark_date)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 11, margin: '2px 0' }}>{it ? it.label : 'General'}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{x.body}</div>
                  {e.status === 'open' && ((x.author_role === 'employee' && r.employee) || (x.author_role === 'supervisor' && r.rater)) && (
                    <button type="button" className="link-btn" style={{ fontSize: 11 }} onClick={() => window.confirm('Remove this remark?') && delRemark(x.id)}>Remove</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
