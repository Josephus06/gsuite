import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/useAuth';
import { STATUS_BADGE, fmtScore, ratingLabel } from './perfUtils';

// HRD > Performance Evaluation (2026-10-23; routes/performance.js): HR's side -- the quarters (open
// one: everyone with a template gets an evaluation; close it: remarks end and self rating begins),
// every evaluation's progress, the templates per position (KRAs, weights, who holds the position)
// and the company's core values.
const ROUTE = '/hrd/performance';

function Quarters({ meta }) {
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ year: new Date().getFullYear(), quarter: Math.floor(new Date().getMonth() / 3) + 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const load = useCallback(() => api.get('/performance/cycles').then(({ data: d }) => setData(d)).catch(() => setData({ rows: [], status_labels: {} })), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!open) { setDetail(null); return; }
    api.get(`/performance/cycles/${open}/evaluations`).then(({ data: d }) => setDetail(d)).catch(() => setDetail(null));
  }, [open, data]);

  const act = async (fn) => {
    setBusy(true); setError(''); setNotice(null);
    try { setNotice(await fn()); await load(); } catch (e) { setError(e.response?.data?.error || 'Could not do that.'); } finally { setBusy(false); }
  };
  const create = () => act(async () => {
    const { data: r } = await api.post('/performance/cycles', form);
    setOpen(r.id);
    return { text: `Q${form.quarter} ${form.year} opened: ${r.created} evaluation(s).`, skipped: r.skipped };
  });
  const generate = (id) => act(async () => { const { data: r } = await api.post(`/performance/cycles/${id}/generate`); return { text: `${r.created} new evaluation(s).`, skipped: r.skipped }; });
  const close = (c) => window.confirm(`Close Q${c.quarter} ${c.year}? Remarks end and everyone is asked for their self rating. (It also closes on its own the day after ${String(c.end_date).slice(0, 10)}.)`)
    && act(async () => { const { data: r } = await api.post(`/performance/cycles/${c.id}/close`); return { text: `Closed: ${r.evaluations} evaluation(s) moved to self rating.` }; });

  if (!data) return <LoadingSpinner />;
  const labels = data.status_labels;
  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {notice && (
        <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid var(--success, #16a34a)' }}>
          {notice.text}
          {notice.skipped?.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              No template for their position, so no evaluation ({notice.skipped.length}): {notice.skipped.map((s) => `${s.name}${s.position_title ? ` (${s.position_title})` : ''}`).join(', ')}.
              {' '}Assign them to a template under Templates, then Generate again.
            </div>
          )}
        </div>
      )}
      {can(ROUTE, 'can_add') && (
        <div className="card" style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ marginBottom: 0 }}><label>Year</label><input type="number" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} style={{ width: 100 }} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>Quarter</label>
            <select value={form.quarter} onChange={(e) => setForm({ ...form, quarter: e.target.value })}>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}</select></div>
          <button className="btn btn-primary" disabled={busy} onClick={create}>Open Quarter</button>
          <span className="muted" style={{ fontSize: 12 }}>Everyone whose position has a template gets an evaluation and is told to log their accomplishments.</span>
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Quarter</th><th>Period</th><th>Status</th><th>Evaluations</th><th>Progress</th><th /></tr></thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No quarter opened yet.</td></tr>}
              {data.rows.map((c) => (
                <tr key={c.id} style={open === c.id ? { background: 'var(--surface-2, #f1f5f9)' } : undefined}>
                  <td data-label="Quarter" style={{ fontWeight: 600 }}>Q{c.quarter} {c.year}</td>
                  <td data-label="Period">{String(c.start_date).slice(0, 10)} — {String(c.end_date).slice(0, 10)}</td>
                  <td data-label="Status"><span className={`badge ${c.status === 'open' ? 'badge-info' : 'badge-muted'}`}>{c.status === 'open' ? 'Open (remarks)' : 'Closed'}</span></td>
                  <td data-label="Evaluations">{c.evaluations}</td>
                  <td data-label="Progress" style={{ fontSize: 12 }}>{Object.keys(labels).filter((s) => Number(c[`n_${s}`])).map((s) => `${labels[s]} ${c[`n_${s}`]}`).join(' · ')}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-primary" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Hide' : 'View'}</button>{' '}
                    {can(ROUTE, 'can_add') && <button className="btn btn-sm" disabled={busy} onClick={() => generate(c.id)}>Generate</button>}{' '}
                    {c.status === 'open' && can(ROUTE, 'can_edit') && <button className="btn btn-sm" disabled={busy} onClick={() => close(c)}>Close Quarter</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {detail && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Q{detail.cycle.quarter} {detail.cycle.year} Evaluations</h3>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Employee</th><th>Department</th><th>Position</th><th>Rater</th><th>Dept Head</th><th>Remarks (emp / sup)</th><th>Status</th><th style={{ textAlign: 'right' }}>Self</th><th style={{ textAlign: 'right' }}>Superior</th><th /></tr></thead>
              <tbody>
                {detail.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Employee" style={{ fontWeight: 600 }}>{r.employee_name}</td>
                    <td data-label="Department">{r.department}</td>
                    <td data-label="Position">{r.position_title}</td>
                    <td data-label="Rater">{r.rater_name || <span style={{ color: 'var(--danger, #b91c1c)' }}>none</span>}</td>
                    <td data-label="Dept Head">{r.dept_head_name || '—'}</td>
                    <td data-label="Remarks">{r.employee_remarks} / <span style={{ color: Number(r.supervisor_remarks) ? undefined : 'var(--danger, #b91c1c)' }}>{r.supervisor_remarks}</span></td>
                    <td data-label="Status"><span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{r.status_label}</span></td>
                    <td data-label="Self" style={{ textAlign: 'right' }}>{fmtScore(r.self_overall)}</td>
                    <td data-label="Superior" style={{ textAlign: 'right' }}>{fmtScore(r.sup_overall)}{r.sup_overall != null && <div className="muted" style={{ fontSize: 11 }}>{ratingLabel(r.sup_overall)}</div>}</td>
                    <td><Link className="btn btn-sm" to={`/performance/${r.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {meta && <PeopleEditor meta={meta} rows={detail.rows} onSaved={() => setOpen((x) => x)} />}
        </div>
      )}
    </div>
  );
}

// HR fixes who rates / reviews one evaluation (a supervisor missing or changed).
function PeopleEditor({ meta, rows }) {
  const { can } = useAuth();
  const [pick, setPick] = useState(null);
  const [msg, setMsg] = useState('');
  if (!can(ROUTE, 'can_edit')) return null;
  const save = async () => {
    try { await api.put(`/performance/evaluations/${pick.id}/people`, pick); setMsg('Saved -- reopen the quarter view to see it.'); setPick(null); }
    catch (e) { setMsg(e.response?.data?.error || 'Could not save.'); }
  };
  const users = meta.users;
  return (
    <div style={{ marginTop: 10 }}>
      <select value="" onChange={(e) => { const r = rows.find((x) => String(x.id) === e.target.value); if (r) setPick({ id: r.id, name: r.employee_name, rater_user_id: '', dept_head_user_id: '' }); }}>
        <option value="">Change the rater / department head of…</option>
        {rows.filter((r) => r.status !== 'approved').map((r) => <option key={r.id} value={r.id}>{r.employee_name}</option>)}
      </select>
      {msg && <span className="muted" style={{ marginLeft: 8 }}>{msg}</span>}
      {pick && (
        <Modal title={`Rater / Department Head: ${pick.name}`} onClose={() => setPick(null)}>
          <div className="field"><label>Rater (supervisor)</label>
            <EntityPicker items={users} value={pick.rater_user_id} getLabel={(u) => u.display_name} searchKeys={['display_name', 'department']}
              columns={[{ key: 'display_name', label: 'Name' }, { key: 'department', label: 'Department' }]} onSelect={(u) => setPick({ ...pick, rater_user_id: u.id })} /></div>
          <div className="field"><label>Department head (blank = none)</label>
            <EntityPicker items={users} value={pick.dept_head_user_id} getLabel={(u) => u.display_name} searchKeys={['display_name', 'department']}
              columns={[{ key: 'display_name', label: 'Name' }, { key: 'department', label: 'Department' }]} onSelect={(u) => setPick({ ...pick, dept_head_user_id: u.id })}
              onClear={() => setPick({ ...pick, dept_head_user_id: '' })} /></div>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </Modal>
      )}
    </div>
  );
}

function TemplateEditor({ meta, id, onClose, onSaved }) {
  const { can } = useAuth();
  const [t, setT] = useState(id ? null : { position_title: '', department_id: '', is_active: true, kras: [{ kra: '', weight: '', kpi: '', timeframe: 'Quarterly' }], people: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/performance/templates/${id}`).then(({ data }) => setT({ ...data, department_id: data.department_id || '', is_active: !!data.is_active })), [id]);
  useEffect(() => { if (id) load(); }, [id, load]);
  if (!t) return <Modal title="Template" onClose={onClose}><LoadingSpinner /></Modal>;
  const total = t.kras.reduce((m, k) => m + (Number(k.weight) || 0), 0);
  const setK = (i, patch) => setT({ ...t, kras: t.kras.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (id) await api.put(`/performance/templates/${id}`, t); else await api.post('/performance/templates', t);
      onSaved();
    } catch (e) { setError(e.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  };
  const assign = async (body) => {
    try { await api.post(`/performance/templates/${id}/assign`, body); await load(); } catch (e) { setError(e.response?.data?.error || 'Could not assign.'); }
  };
  const canEdit = can(ROUTE, id ? 'can_edit' : 'can_add');
  return (
    <Modal title={id ? `Template: ${t.position_title}` : 'New Position Template'} onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      <div className="filter-grid">
        <div className="field"><label>Position</label><input value={t.position_title} disabled={!canEdit} onChange={(e) => setT({ ...t, position_title: e.target.value })} placeholder="e.g. SYSTEM ANALYST" /></div>
        <div className="field"><label>Department (optional)</label>
          <select value={t.department_id} disabled={!canEdit} onChange={(e) => setT({ ...t, department_id: e.target.value })}>
            <option value="">Any</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></div>
        <div className="field"><label>Active</label><label style={{ fontWeight: 400 }}><input type="checkbox" checked={t.is_active} disabled={!canEdit} onChange={(e) => setT({ ...t, is_active: e.target.checked })} /> used for new quarters</label></div>
      </div>
      <h3 style={{ marginBottom: 4 }}>A. Key Result Areas <span style={{ fontSize: 13, fontWeight: 400, color: Math.abs(total - 100) < 0.001 ? 'var(--success, #16a34a)' : 'var(--danger, #b91c1c)' }}>weights {total}% of 100%</span></h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Key Result Area / Objective</th><th>Weight %</th><th>KPI (target)</th><th>Timeframe</th><th /></tr></thead>
          <tbody>
            {t.kras.map((k, i) => (
              <tr key={i}>
                <td><textarea rows={2} style={{ width: '100%', minWidth: 240 }} value={k.kra} disabled={!canEdit} onChange={(e) => setK(i, { kra: e.target.value })} /></td>
                <td><input type="number" style={{ width: 80 }} value={k.weight} disabled={!canEdit} onChange={(e) => setK(i, { weight: e.target.value })} /></td>
                <td><textarea rows={2} style={{ width: '100%', minWidth: 220 }} value={k.kpi || ''} disabled={!canEdit} onChange={(e) => setK(i, { kpi: e.target.value })} /></td>
                <td><input style={{ width: 110 }} value={k.timeframe || ''} disabled={!canEdit} onChange={(e) => setK(i, { timeframe: e.target.value })} /></td>
                <td>{canEdit && t.kras.length > 1 && <button className="btn btn-sm" onClick={() => setT({ ...t, kras: t.kras.filter((_, j) => j !== i) })}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setT({ ...t, kras: [...t.kras, { kra: '', weight: '', kpi: '', timeframe: 'Quarterly' }] })}>+ KRA</button>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>B. Core Values are the company's (Core Values tab). Changing a template affects quarters opened after; evaluations already made keep their own copy.</div>
      {canEdit && <div style={{ marginTop: 10 }}><button className="btn btn-primary" disabled={busy} onClick={save}>Save Template</button></div>}

      {id && (
        <>
          <h3 style={{ marginBottom: 4 }}>Employees in this position ({t.people.length})</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {t.people.map((p) => (
              <span key={p.employee_id} className="badge badge-info">{p.display_name}
                {canEdit && <button type="button" className="link-btn" onClick={() => assign({ remove_employee_ids: [p.employee_id] })}> ✕</button>}</span>
            ))}
          </div>
          {canEdit && (
            <EntityPicker
              items={meta.users.filter((u) => u.employee_id && !t.people.some((p) => p.employee_id === u.employee_id))} value="" triggerLabel="+ Add an employee"
              getLabel={(u) => u.display_name} searchKeys={['display_name', 'department', 'position_title']}
              columns={[{ key: 'display_name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'position_title', label: 'Current Position' }]}
              onSelect={(u) => assign({ employee_ids: [u.employee_id] })}
            />
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Sets the Position Title on their employee record. Their next quarter uses this template.</div>
        </>
      )}
    </Modal>
  );
}

// Import a PEF workbook: each sheet's position becomes (or updates) its template and its employee is put
// in that position. Read first, check, then apply.
function ImportPef({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [data, setData] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = (f) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(f); });
  const send = async (apply) => {
    setBusy(true); setError('');
    try {
      const { data: d } = await api.post('/performance/templates/import', { file_data: data?.file || await read(file), apply });
      if (apply) { setResult(d.applied); onDone(); } else setData({ ...d, file: await read(file) });
    } catch (e) { setError(e.response?.data?.error || 'Could not read the workbook.'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Import PEF (Excel)" onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      {result ? (
        <div>
          {result.map((r) => <div key={r.sheet}>✓ {r.position_title}: template {r.updated ? 'updated' : 'created'}{r.assigned ? `, ${r.assigned} assigned` : ''}</div>)}
          <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={onClose}>Done</button>
        </div>
      ) : !data ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="muted" style={{ fontSize: 13 }}>The Performance Evaluation Form workbook -- one sheet per employee. Each sheet&apos;s POSITION TITLE and its A. Productivity &amp; Efficiency KRAs (weight, KPI, timeframe) become that position&apos;s template; the NAME OF EMPLOYEE is put in the position.</div>
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <div><button className="btn btn-primary" disabled={!file || busy} onClick={() => send(false)}>{busy ? 'Reading…' : 'Read Workbook'}</button></div>
        </div>
      ) : (
        <>
          {data.sheets.map((s) => (
            <div key={s.sheet} className="card" style={{ marginBottom: 10, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <strong>{s.position_title || '(no position)'} <span className="muted" style={{ fontWeight: 400 }}>sheet &quot;{s.sheet}&quot;</span></strong>
                {s.problem ? <span className="badge badge-danger">{s.problem}</span> : <span className={`badge ${s.template_exists ? 'badge-warning' : 'badge-success'}`}>{s.template_exists ? 'updates the template' : 'new template'}</span>}
              </div>
              <div style={{ fontSize: 12, margin: '4px 0' }}>
                Employee: {s.employee_name || '—'} {s.employee ? <span className="badge badge-success">→ {s.employee.name}</span> : <span className="badge badge-muted">not matched -- assign later</span>}
                {' · '}Rater on the form: {s.rater_name || '—'} {s.rater ? <span className="muted">({s.rater.name})</span> : ''}
                {' · '}Department: {s.department || '—'}
              </div>
              <table style={{ fontSize: 12 }}>
                <thead><tr><th>KRA</th><th style={{ textAlign: 'right' }}>Weight</th><th>KPI</th></tr></thead>
                <tbody>{s.kras.map((k, i) => <tr key={i}><td>{k.kra}</td><td style={{ textAlign: 'right' }}>{k.weight}%</td><td>{k.kpi}</td></tr>)}</tbody>
                <tfoot><tr><th>Total</th><th style={{ textAlign: 'right' }}>{s.total}%</th><th /></tr></tfoot>
              </table>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>The rater is read from each employee&apos;s supervisor in T1S, not from the form -- check it under Users if it differs.</div>
          <button className="btn btn-primary" disabled={busy || data.sheets.every((s) => s.problem)} onClick={() => send(true)}>Apply {data.sheets.filter((s) => !s.problem).length} Sheet(s)</button>
        </>
      )}
    </Modal>
  );
}

function Templates({ meta }) {
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => api.get('/performance/templates').then(({ data }) => setRows(data)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
        {can(ROUTE, 'can_add') && <button className="btn" onClick={() => setImporting(true)}>Import PEF (Excel)</button>}
        {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setEdit({})}>New Position Template</button>}
      </div>
      {importing && <ImportPef onClose={() => { setImporting(false); load(); }} onDone={load} />}
      {!rows ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Position</th><th>Department</th><th>KRAs</th><th>Weights</th><th>Employees</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No templates yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Position" style={{ fontWeight: 600 }}>{r.position_title}</td>
                  <td data-label="Department">{r.department || 'Any'}</td>
                  <td data-label="KRAs">{r.kras}</td>
                  <td data-label="Weights" style={{ color: Math.abs(r.total_weight - 100) < 0.001 ? undefined : 'var(--danger, #b91c1c)' }}>{r.total_weight}%</td>
                  <td data-label="Employees" style={{ color: Number(r.employees) ? undefined : 'var(--danger, #b91c1c)' }}>{r.employees}</td>
                  <td data-label="Status">{r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>}</td>
                  <td><button className="btn btn-sm btn-primary" onClick={() => setEdit({ id: r.id })}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <TemplateEditor meta={meta} id={edit.id} onClose={() => { setEdit(null); load(); }} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function CoreValues() {
  const { can } = useAuth();
  const [list, setList] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/performance/core-values').then(({ data }) => setList(data)).catch(() => setList([])); }, []);
  if (!list) return <LoadingSpinner />;
  const total = list.reduce((m, v) => m + (Number(v.weight) || 0), 0);
  const set = (i, patch) => setList(list.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const save = async () => {
    setMsg('');
    try { await api.put('/performance/core-values', { values: list }); setMsg('Saved. Quarters opened from now use these.'); }
    catch (e) { setMsg(e.response?.data?.error || 'Could not save.'); }
  };
  const canEdit = can(ROUTE, 'can_edit');
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>B. Core Values <span style={{ fontSize: 13, fontWeight: 400, color: Math.abs(total - 100) < 0.001 ? 'var(--success, #16a34a)' : 'var(--danger, #b91c1c)' }}>weights {total}% of 100%</span></h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Core Value</th><th>Description</th><th>Weight %</th><th /></tr></thead>
          <tbody>
            {list.map((v, i) => (
              <tr key={v.id || `n${i}`}>
                <td><input value={v.name} disabled={!canEdit} onChange={(e) => set(i, { name: e.target.value })} /></td>
                <td><textarea rows={2} style={{ width: '100%', minWidth: 320 }} value={v.description || ''} disabled={!canEdit} onChange={(e) => set(i, { description: e.target.value })} /></td>
                <td><input type="number" style={{ width: 80 }} value={v.weight} disabled={!canEdit} onChange={(e) => set(i, { weight: e.target.value })} /></td>
                <td>{canEdit && <button className="btn btn-sm" onClick={() => setList(list.filter((_, j) => j !== i))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setList([...list, { name: '', description: '', weight: '' }])}>+ Core Value</button>
          <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      )}
    </div>
  );
}

const TABS = [['quarters', 'Quarters & Evaluations'], ['templates', 'Templates (per Position)'], ['core', 'Core Values']];

export default function PerformanceAdmin() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'quarters';
  const [meta, setMeta] = useState(null);
  useEffect(() => { api.get('/performance/admin/meta').then(({ data }) => setMeta(data)).catch(() => setMeta({ departments: [], users: [] })); }, []);
  return (
    <div>
      <div className="page-header"><h1>Performance Evaluation</h1></div>
      <div className="status-tabs" style={{ marginBottom: 12 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {!meta ? <LoadingSpinner /> : (
        <>
          {tab === 'quarters' && <Quarters meta={meta} />}
          {tab === 'templates' && <Templates meta={meta} />}
          {tab === 'core' && <CoreValues />}
        </>
      )}
    </div>
  );
}
