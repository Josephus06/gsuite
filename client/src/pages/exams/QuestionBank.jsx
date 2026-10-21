import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { useAuth } from '../../context/useAuth';
import { CHOICE_TYPES, LETTERS, TYPES, TYPE_LABELS, answerText, indexed } from '../../utils/exams';

// HRD > Question Bank (2026-10-21; routes/examAdmin.js): department heads keep their department's
// questions -- typed in, or a PDF the AI reads into drafts that are reviewed before saving. Each
// question tests a TOPIC; a topic carries the orientation an examinee weak in it is sent to.
const PAGE_SIZE = 25;
const BLANK = { type: 'multiple_choice', question: '', choices: ['', '', '', ''], answer: null, points: 1, difficulty: '', topic_id: '', topic: '' };

function keyText(q) {
  return answerText(q.type, q.answer, indexed(q.choices)) || (q.type === 'essay' ? '(graded by hand)' : '');
}

// The editor for one question -- a bank question or an import draft.
export function QuestionForm({ value, topics, onChange }) {
  const q = value;
  const set = (patch) => onChange({ ...q, ...patch });
  const setType = (type) => {
    const patch = { type, answer: null };
    if (CHOICE_TYPES.includes(type) && !(q.choices || []).length) patch.choices = ['', '', '', ''];
    if (type === 'multiple_select') patch.answer = [];
    if (type === 'essay') { patch.answer = { guide: '' }; if (Number(q.points) === 1) patch.points = 5; }
    if (type === 'identification') patch.answer = [];
    set(patch);
  };
  const choices = q.choices || [];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="filter-grid">
        <div className="field"><label>Type</label>
          <select value={q.type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select></div>
        <div className="field"><label>Topic</label>
          <select value={q.newTopic ? '__new' : (q.topic_id || '')} onChange={(e) => set(e.target.value === '__new' ? { newTopic: true, topic_id: '' } : { newTopic: false, topic_id: e.target.value, topic: '' })}>
            <option value="">-- none (General) --</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            <option value="__new">+ New topic…</option>
          </select></div>
        {q.newTopic && (
          <div className="field"><label>New topic name</label>
            <input value={q.topic || ''} onChange={(e) => set({ topic: e.target.value })} placeholder="e.g. Machinery Knowledge" /></div>
        )}
        <div className="field"><label>Points</label>
          <input type="number" min="0.5" step="0.5" value={q.points} onChange={(e) => set({ points: e.target.value })} /></div>
        <div className="field"><label>Difficulty</label>
          <select value={q.difficulty || ''} onChange={(e) => set({ difficulty: e.target.value })}>
            <option value="">--</option><option value="easy">Easy</option><option value="average">Average</option><option value="hard">Hard</option>
          </select></div>
      </div>
      <div className="field"><label>Question</label>
        <textarea rows={3} value={q.question} onChange={(e) => set({ question: e.target.value })} /></div>

      {q.type === 'true_false' && (
        <div className="field"><label>Correct answer</label>
          <div style={{ display: 'flex', gap: 16 }}>
            {[[true, 'True'], [false, 'False']].map(([v, l]) => (
              <label key={l} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" checked={q.answer === v} onChange={() => set({ answer: v })} /> {l}
              </label>
            ))}
          </div></div>
      )}

      {CHOICE_TYPES.includes(q.type) && (
        <div className="field"><label>Choices -- mark the correct {q.type === 'multiple_select' ? 'ones' : 'one'}</label>
          <div style={{ display: 'grid', gap: 6 }}>
            {choices.map((c, i) => {
              const on = q.type === 'multiple_select' ? (Array.isArray(q.answer) ? q.answer.map(Number) : []).includes(i) : Number(q.answer) === i && q.answer != null;
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type={q.type === 'multiple_select' ? 'checkbox' : 'radio'} checked={on} title="Correct"
                    onChange={() => {
                      if (q.type === 'multiple_select') {
                        const cur = Array.isArray(q.answer) ? q.answer.map(Number) : [];
                        set({ answer: on ? cur.filter((x) => x !== i) : [...cur, i] });
                      } else set({ answer: i });
                    }}
                  />
                  <strong style={{ width: 16 }}>{LETTERS[i]}</strong>
                  <input value={c} onChange={(e) => set({ choices: choices.map((x, j) => (j === i ? e.target.value : x)) })} style={{ flex: 1 }} />
                  <button type="button" className="btn btn-sm" disabled={choices.length <= 2} onClick={() => {
                    const next = choices.filter((_, j) => j !== i);
                    let ans = q.answer;
                    if (q.type === 'multiple_select') ans = (Array.isArray(ans) ? ans : []).map(Number).filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
                    else ans = Number(ans) === i ? null : (Number(ans) > i ? Number(ans) - 1 : ans);
                    set({ choices: next, answer: ans });
                  }}>✕</button>
                </div>
              );
            })}
            {choices.length < 8 && <button type="button" className="btn btn-sm" style={{ justifySelf: 'start' }} onClick={() => set({ choices: [...choices, ''] })}>+ Choice</button>}
          </div></div>
      )}

      {q.type === 'identification' && (
        <div className="field"><label>Accepted answer(s) -- separate alternatives with |</label>
          <input value={Array.isArray(q.answer) ? q.answer.join(' | ') : (q.answer || '')} onChange={(e) => set({ answer: e.target.value.split('|').map((s) => s.trimStart()) })} placeholder="e.g. Cyan | C" />
          <div className="muted" style={{ fontSize: 11 }}>Checked without regard to capital letters or extra spaces.</div></div>
      )}

      {q.type === 'essay' && (
        <div className="field"><label>Grading guide (what a good answer covers) -- for the grader only</label>
          <textarea rows={3} value={q.answer?.guide || ''} onChange={(e) => set({ answer: { guide: e.target.value } })} /></div>
      )}
    </div>
  );
}

const payload = (q, departmentId) => ({
  department_id: departmentId, type: q.type, question: q.question, choices: q.choices, points: Number(q.points),
  difficulty: q.difficulty || null, topic_id: q.topic_id ? Number(q.topic_id) : null, topic: q.newTopic ? (q.topic || '').trim() || null : null,
  answer: q.type === 'identification' ? (Array.isArray(q.answer) ? q.answer.map((s) => s.trim()).filter(Boolean) : q.answer) : q.answer,
});

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// PDF (or pasted text) -> AI drafts -> review -> save.
function ImportModal({ departmentId, departments, topics, onClose, onSaved }) {
  const [dept, setDept] = useState(departmentId || departments[0]?.id || '');
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deptTopics = topics.filter((t) => !t.department_id || Number(t.department_id) === Number(dept));

  async function read() {
    if (!file && !text.trim()) { setError('Attach a PDF or Word file, or paste the questions.'); return; }
    if (file && file.size > 10 * 1024 * 1024) { setError('The file is over 10MB.'); return; }
    setBusy(true); setError('');
    try {
      const body = { department_id: dept };
      if (file) { body.file_data = await readFile(file); body.file_name = file.name; } else body.text = text;
      const { data } = await api.post('/exam-admin/questions/import', body);
      // A topic the AI named that already exists is linked to it; otherwise it becomes a new topic on save.
      setDrafts(data.drafts.map((d, i) => {
        const t = deptTopics.find((x) => x.name.toLowerCase() === String(d.topic || '').toLowerCase());
        return { ...d, key: i, topic_id: t ? String(t.id) : '', topic: t ? '' : (d.topic || ''), newTopic: !t && !!d.topic, difficulty: '' };
      }));
      if (!data.drafts.length) setError('No questions were found in that document.');
    } catch (e) { setError(e.response?.data?.error || 'The AI could not read that document.'); }
    finally { setBusy(false); }
  }

  async function saveAll() {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/exam-admin/questions/bulk', { department_id: dept, source: 'pdf', questions: drafts.map((d) => payload(d, dept)) });
      onSaved(data.count);
    } catch (e) { setError(e.response?.data?.error || 'Could not save the questions.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Import Questions" onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      {!drafts ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            The AI reads the document into questions -- type, choices, the answer key if the document has one, and a topic for each.
            Nothing is saved until you review them.
          </div>
          <div className="field" style={{ maxWidth: 360 }}><label>Department</label>
            <select value={dept} onChange={(e) => setDept(e.target.value)}>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
          <div className="field"><label>PDF or Word .docx (up to 10MB)</label>
            <input type="file" accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
          {!file && (
            <div className="field"><label>…or paste the questions</label>
              <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'1. The press must be stopped before cleaning the rollers. (True/False)\n2. Which ink is used for... a) ... b) ...'} /></div>
          )}
          <div><button className="btn btn-primary" disabled={busy} onClick={read}>{busy ? 'Reading… (this can take a minute)' : 'Read with AI'}</button></div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <span><strong>{drafts.length}</strong> question(s) read. Check each -- especially the answers -- then save.
              {drafts.some((d) => d.problem) && <span style={{ color: 'var(--danger, #b91c1c)' }}> {drafts.filter((d) => d.problem).length} need fixing.</span>}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setDrafts(null)}>Start Over</button>
              <button className="btn btn-primary" disabled={busy || !drafts.length} onClick={saveAll}>Save {drafts.length} Question(s)</button>
            </div>
          </div>
          <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Topic</th><th>Answer</th><th>Pts</th><th /></tr></thead>
              <tbody>
                {drafts.map((d, i) => (
                  <tr key={d.key} style={d.problem ? { background: 'var(--danger-soft, #fde2e2)' } : undefined}>
                    <td>{i + 1}</td>
                    <td style={{ maxWidth: 380, whiteSpace: 'normal' }}>{d.question}
                      {CHOICE_TYPES.includes(d.type) && <div className="muted" style={{ fontSize: 11 }}>{(d.choices || []).map((c, j) => `${LETTERS[j]}. ${c}`).join('   ')}</div>}
                      {d.problem && <div style={{ color: 'var(--danger, #b91c1c)', fontSize: 12 }}>{d.problem}</div>}</td>
                    <td>{TYPE_LABELS[d.type] || d.type}</td>
                    <td>{d.topic_id ? deptTopics.find((t) => String(t.id) === String(d.topic_id))?.name
                      : d.newTopic && d.topic ? <span>{d.topic} <span className="badge badge-info">new</span></span> : <span className="muted">General</span>}</td>
                    <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>{keyText(d)}</td>
                    <td>{d.points}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => setEditing({ ...d })}>Edit</button>{' '}
                      <button className="btn btn-sm" onClick={() => setDrafts(drafts.filter((x) => x.key !== d.key))}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && (
        <Modal title="Edit Draft" onClose={() => setEditing(null)} large>
          <QuestionForm value={editing} topics={deptTopics} onChange={setEditing} />
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => { setDrafts(drafts.map((x) => (x.key === editing.key ? { ...editing, problem: null } : x))); setEditing(null); }}>Done</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function TopicsModal({ departments, topics, all, onClose, onChanged }) {
  const [dept, setDept] = useState(departments[0]?.id || '');
  const [name, setName] = useState('');
  const [orientation, setOrientation] = useState('');
  const [edits, setEdits] = useState({});
  const [error, setError] = useState('');
  const list = topics.filter((t) => (dept ? Number(t.department_id) === Number(dept) : !t.department_id));

  async function add() {
    setError('');
    try { await api.post('/exam-admin/topics', { department_id: dept || null, name, orientation_name: orientation }); setName(''); setOrientation(''); onChanged(); }
    catch (e) { setError(e.response?.data?.error || 'Could not add the topic.'); }
  }
  async function save(t) {
    setError('');
    try { await api.put(`/exam-admin/topics/${t.id}`, { ...t, ...edits[t.id] }); setEdits((x) => ({ ...x, [t.id]: undefined })); onChanged(); }
    catch (e) { setError(e.response?.data?.error || 'Could not save the topic.'); }
  }

  return (
    <Modal title="Topics & Orientations" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        Each topic names the orientation an examinee is recommended when they score under the set&apos;s re-orientation line in it.
      </div>
      <div className="field" style={{ maxWidth: 360 }}><label>Department</label>
        <select value={dept} onChange={(e) => setDept(e.target.value)}>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          {all && <option value="">All departments (shared)</option>}
        </select></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Topic</th><th>Orientation</th><th>Active</th><th /></tr></thead>
          <tbody>
            {list.map((t) => {
              const e = { ...t, ...edits[t.id] };
              const dirty = !!edits[t.id];
              const ed = (patch) => setEdits((x) => ({ ...x, [t.id]: { ...x[t.id], ...patch } }));
              return (
                <tr key={t.id}>
                  <td><input value={e.name} onChange={(ev) => ed({ name: ev.target.value })} /></td>
                  <td><input value={e.orientation_name || ''} onChange={(ev) => ed({ orientation_name: ev.target.value })} /></td>
                  <td><input type="checkbox" checked={!!Number(e.is_active)} onChange={(ev) => ed({ is_active: ev.target.checked ? 1 : 0 })} /></td>
                  <td>{dirty && <button className="btn btn-sm btn-primary" onClick={() => save(t)}>Save</button>}</td>
                </tr>
              );
            })}
            <tr>
              <td><input value={name} onChange={(e) => setName(e.target.value)} placeholder="New topic, e.g. Machinery Knowledge" /></td>
              <td><input value={orientation} onChange={(e) => setOrientation(e.target.value)} placeholder="Orientation (default: <topic> Orientation)" /></td>
              <td />
              <td><button className="btn btn-sm btn-primary" disabled={!name.trim()} onClick={add}>Add</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export default function QuestionBank() {
  const { can } = useAuth();
  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState({ department_id: '', topic_id: '', type: '', q: '' });
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const loadMeta = useCallback(() => api.get('/exam-admin/bank/meta').then(({ data: m }) => setMeta(m)).catch((e) => setError(e.response?.data?.error || 'Could not load.')), []);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const load = useCallback(() => {
    api.get('/exam-admin/questions', { params: { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page, limit: PAGE_SIZE } })
      .then(({ data: d }) => setData(d)).catch((e) => setError(e.response?.data?.error || 'Could not load questions.'));
  }, [filters, page]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const set = (k) => (e) => { setPage(1); setFilters((f) => ({ ...f, [k]: e.target.value, ...(k === 'department_id' ? { topic_id: '' } : {}) })); };
  const departments = meta?.departments || [];
  const topics = meta?.topics || [];
  const topicsFor = (deptId) => topics.filter((t) => Number(t.is_active) && (!t.department_id || Number(t.department_id) === Number(deptId)));

  async function save() {
    setBusy(true); setError('');
    try {
      const body = payload(editing, editing.department_id);
      if (editing.id) await api.put(`/exam-admin/questions/${editing.id}`, body);
      else await api.post('/exam-admin/questions', body);
      setEditing(null); setNotice('Question saved.'); load(); loadMeta();
    } catch (e) { setError(e.response?.data?.error || 'Could not save the question.'); }
    finally { setBusy(false); }
  }

  async function remove(q) {
    if (!window.confirm('Remove this question from the bank?')) return;
    try {
      const { data: r } = await api.delete(`/exam-admin/questions/${q.id}`);
      setNotice(r.retired ? 'Removed. It stays on the sets and results that already use it.' : 'Removed.');
      load();
    } catch (e) { setError(e.response?.data?.error || 'Could not remove it.'); }
  }

  if (!meta) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;
  if (!departments.length) {
    return (
      <div>
        <div className="page-header"><h1>Question Bank</h1></div>
        <div className="card muted">You are not the head of any department, so there are no questions for you to keep. HR can grant View All on this page.</div>
      </div>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <div>
      <div className="page-header">
        <h1>Question Bank</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setTopicsOpen(true)}>Topics &amp; Orientations</button>
          {can('/hrd/exam-questions', 'can_add') && <button className="btn" onClick={() => setImporting(true)}>Import PDF / Word</button>}
          {can('/hrd/exam-questions', 'can_add') && (
            <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK, department_id: filters.department_id || departments[0].id })}>Add Question</button>
          )}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid var(--success, #16a34a)' }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>Department</label>
            <select value={filters.department_id} onChange={set('department_id')}>
              <option value="">{meta.all ? 'All departments' : 'My departments'}</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
          <div className="field"><label>Topic</label>
            <select value={filters.topic_id} onChange={set('topic_id')}>
              <option value="">All topics</option>
              {(filters.department_id ? topicsFor(filters.department_id) : topics).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
          <div className="field"><label>Type</label>
            <select value={filters.type} onChange={set('type')}>
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select></div>
          <div className="field"><label>Search</label><input value={filters.q} onChange={set('q')} placeholder="Question text" /></div>
        </div>
      </div>

      <div className="card">
        {!data ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead><tr><th>Question</th><th>Type</th><th>Topic</th><th>Department</th><th>Answer</th><th>Pts</th><th /></tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No questions yet. Add one or import a PDF.</td></tr>}
                {data.rows.map((q) => (
                  <tr key={q.id}>
                    <td data-label="Question" style={{ maxWidth: 420, whiteSpace: 'normal' }}>{q.question}
                      {CHOICE_TYPES.includes(q.type) && <div className="muted" style={{ fontSize: 11 }}>{(q.choices || []).map((c, j) => `${LETTERS[j]}. ${c}`).join('   ')}</div>}</td>
                    <td data-label="Type">{TYPE_LABELS[q.type]}</td>
                    <td data-label="Topic">{q.topic || <span className="muted">General</span>}</td>
                    <td data-label="Department">{q.department}</td>
                    <td data-label="Answer" style={{ maxWidth: 220, whiteSpace: 'normal' }}>{keyText(q)}</td>
                    <td data-label="Pts">{q.points}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {can('/hrd/exam-questions', 'can_edit') && (
                        <button className="btn btn-sm" onClick={() => setEditing({ ...q, topic_id: q.topic_id ? String(q.topic_id) : '', topic: '', difficulty: q.difficulty || '' })}>Edit</button>
                      )}{' '}
                      {can('/hrd/exam-questions', 'can_delete') && <button className="btn btn-sm" onClick={() => remove(q)}>Remove</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {editing && (
        <Modal title={editing.id ? 'Edit Question' : 'Add Question'} onClose={() => setEditing(null)} large>
          {error && <div className="error-banner">{error}</div>}
          {editing.used && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Already answered in an exam: only the wording, topic and difficulty can change.</div>}
          {!editing.id && (
            <div className="field" style={{ maxWidth: 360 }}><label>Department</label>
              <select value={editing.department_id} onChange={(e) => setEditing({ ...editing, department_id: e.target.value, topic_id: '' })}>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select></div>
          )}
          <QuestionForm value={editing} topics={topicsFor(editing.department_id)} onChange={setEditing} />
          <div style={{ marginTop: 12 }}><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button></div>
        </Modal>
      )}
      {importing && (
        <ImportModal
          departmentId={filters.department_id} departments={departments} topics={topics.filter((t) => Number(t.is_active))}
          onClose={() => setImporting(false)}
          onSaved={(n) => { setImporting(false); setNotice(`${n} question(s) imported.`); load(); loadMeta(); }}
        />
      )}
      {topicsOpen && <TopicsModal departments={departments} topics={topics} all={meta.all} onClose={() => setTopicsOpen(false)} onChanged={loadMeta} />}
    </div>
  );
}
