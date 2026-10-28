import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { periodTitle } from './HrDaReport';

// One DA Report, filled in as the sheet is (2026-10-28): the period, then each section (stage of the
// disciplinary action) with its rows -- Employee Name / Violation / Section Violated / Final
// Sanction -- all saved together. Blank rows are left out when saved.
// Each row has its Date (2026-10-28): HR logs cases day by day and presents the week's report --
// Present opens HrDaReportPresent.jsx.

const ymd = (d) => d.toISOString().slice(0, 10);
// Same periods the server works out: the month, or the Monday-to-Sunday week, of the date picked.
function periodOf(type, date) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(date || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1)));
  if (type === 'weekly') {
    const from = new Date(d); from.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const to = new Date(from); to.setUTCDate(from.getUTCDate() + 6);
    return { from: ymd(from), to: ymd(to) };
  }
  return { from: ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))), to: ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) };
}

const blankRow = (entryDate = '') => ({ entry_date: entryDate, employee_id: '', employee_name: '', violation: '', violation_type_id: '', section_violated: '', final_sanction: 'ISSUED NTE' });
const blankSection = (stage = 'NOTICE TO EXPLAIN') => ({ stage, rows: [blankRow(), blankRow(), blankRow()] });

export default function HrDaReportForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [meta, setMeta] = useState(null);
  const [report, setReport] = useState(null);
  const [type, setType] = useState(params.get('type') === 'weekly' ? 'weekly' : 'monthly');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [sections, setSections] = useState([blankSection()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    api.get('/hr-da-reports/meta').then(({ data }) => setMeta(data)).catch(() => setMeta({}));
    if (id) {
      api.get(`/hr-da-reports/${id}`).then(({ data }) => {
        setReport(data);
        setType(data.report_type);
        setDate(data.period_from);
        setSections(data.sections.length
          ? data.sections.map((s) => ({ stage: s.stage, rows: s.rows.map((r) => ({ ...blankRow(), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? ''])) })) }))
          : [blankSection()]);
      }).catch((e) => setError(e.response?.data?.error || 'Could not load the report.'));
    }
  }, [id]);

  const editable = id ? can('/hrd/da-report', 'can_edit') : can('/hrd/da-report', 'can_add');
  const period = id && report ? { from: report.period_from, to: report.period_to } : periodOf(type, type === 'monthly' ? `${date.slice(0, 7)}-01` : date);

  // A new row's date: today when it falls in the report's period, else the period's first day.
  const today = new Date().toLocaleDateString('en-CA');
  const defaultDay = () => (period && today >= period.from && today <= period.to ? today : period?.from || '');
  const withDates = (ss) => ss.map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r, entry_date: r.entry_date || defaultDay() })) }));

  const setSection = (si, patch) => setSections((ss) => ss.map((s, i) => (i === si ? { ...s, ...patch } : s)));
  const setRow = (si, ri, patch) => setSections((ss) => ss.map((s, i) => (i === si ? { ...s, rows: s.rows.map((r, j) => (j === ri ? { ...r, ...patch } : r)) } : s)));
  const addRow = (si) => setSections((ss) => ss.map((s, i) => (i === si ? { ...s, rows: [...s.rows, blankRow(defaultDay())] } : s)));
  const removeRow = (si, ri) => setSections((ss) => ss.map((s, i) => (i === si ? { ...s, rows: s.rows.filter((_, j) => j !== ri) } : s)));
  const addSection = () => {
    const used = new Set(sections.map((s) => s.stage));
    setSections((ss) => [...ss, blankSection((meta?.stages || []).find((x) => !used.has(x)) || '')]);
  };

  async function save() {
    setError(''); setSaved(''); setSaving(true);
    try {
      if (id) {
        await api.put(`/hr-da-reports/${id}`, { sections: withDates(sections) });
        setSaved('Saved.');
        setSaving(false);
      } else {
        const { data } = await api.post('/hr-da-reports', { report_type: type, period_from: period.from, sections: withDates(sections) });
        navigate(`/hrd/da-report/${data.id}`, { replace: true });
      }
    } catch (e) {
      const d = e.response?.data;
      setError(d?.error || 'Could not save the report.');
      if (d?.id && confirm(`${d.error}\n\nOpen it now?`)) navigate(`/hrd/da-report/${d.id}`);
      setSaving(false);
    }
  }

  if (id && !report && !error) return <LoadingSpinner />;
  const typeLabel = type === 'weekly' ? 'Weekly' : 'Monthly';
  const sectionLabels = (meta?.violation_types || []).map((t) => t.label);

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>
          DA REPORT <span className="muted">/ {typeLabel}{report ? ` / ${report.report_no}` : ' / New'}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/hrd/da-report">Back to Lists</Link>
          {id && <button className="btn btn-sm" onClick={() => window.open(`/hrd/da-report/${id}/present`, '_blank')}>Present</button>}
          {id && can('/hrd/da-report', 'can_print') && <button className="btn btn-sm" onClick={() => window.open(`/hrd/da-report/${id}/print`, '_blank')}>Print</button>}
          {editable && <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="success-banner" style={{ marginBottom: 12 }}>{saved}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Report</label>
            <select value={type} disabled={!!id} onChange={(e) => setType(e.target.value)}>
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div className="field">
            <label>{type === 'weekly' ? 'Week (pick any day of it)' : 'Month'}</label>
            {type === 'weekly'
              ? <input type="date" value={date} disabled={!!id} onChange={(e) => e.target.value && setDate(e.target.value)} />
              : <input type="month" value={date.slice(0, 7)} disabled={!!id} onChange={(e) => e.target.value && setDate(`${e.target.value}-01`)} />}
          </div>
        </div>
        <h3 style={{ margin: '14px 0 0', textAlign: 'center' }}>
          Discipline Management Report ({periodTitle(type, period?.from, period?.to)})
        </h3>
      </div>

      <datalist id="da-stages">{(meta?.stages || []).map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="da-sanctions">{(meta?.sanctions || []).map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="da-sections">{sectionLabels.map((s) => <option key={s} value={s} />)}</datalist>

      {sections.map((s, si) => (
        <div className="card" key={si} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <input list="da-stages" value={s.stage} disabled={!editable} placeholder="Section, e.g. NOTICE TO EXPLAIN"
              onChange={(e) => setSection(si, { stage: e.target.value.toUpperCase() })}
              style={{ fontWeight: 700, textAlign: 'center', flex: 1 }} />
            {editable && sections.length > 1 && (
              <button className="btn btn-sm btn-danger" onClick={() => confirm(`Remove the ${s.stage || 'section'} section and its rows?`) && setSections((ss) => ss.filter((_, i) => i !== si))}>Remove Section</button>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Date</th>
                  <th style={{ width: '22%' }}>Employee Name</th>
                  <th style={{ width: '22%' }}>Violation</th>
                  <th style={{ width: '27%' }}>Section Violated</th>
                  <th style={{ width: '16%' }}>Final Sanction</th>
                  {editable && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, ri) => (
                  <tr key={ri}>
                    <td style={{ padding: 4 }}>
                      <input type="date" value={r.entry_date || ''} disabled={!editable} min={period?.from} max={period?.to}
                        placeholder={defaultDay()} onChange={(e) => setRow(si, ri, { entry_date: e.target.value })} />
                    </td>
                    <td style={{ padding: 4 }}>
                      {editable ? (
                        <EntityPicker
                          label="Employee" items={meta?.employees || []} value={r.employee_id || ''}
                          getLabel={(e) => e.report_name} placeholder={r.employee_name || 'Select employee...'}
                          columns={[{ key: 'report_name', label: 'Name' }, { key: 'employee_code', label: 'Code' }, { key: 'department_name', label: 'Department' }]}
                          searchKeys={['first_name', 'last_name', 'employee_code', 'department_name']}
                          onSelect={(e) => setRow(si, ri, { employee_id: e?.id || '', employee_name: e?.report_name || '' })}
                        />
                      ) : r.employee_name}
                    </td>
                    <td style={{ padding: 4 }}>
                      <input value={r.violation} disabled={!editable} maxLength={300} placeholder="e.g. 3 Habitual Tardiness"
                        onChange={(e) => setRow(si, ri, { violation: e.target.value })} />
                    </td>
                    <td style={{ padding: 4 }}>
                      <input list="da-sections" value={r.section_violated} disabled={!editable} maxLength={300} placeholder="Pick or type the section"
                        onChange={(e) => {
                          const t = (meta?.violation_types || []).find((x) => x.label === e.target.value);
                          setRow(si, ri, { section_violated: e.target.value, violation_type_id: t?.id || '' });
                        }} />
                    </td>
                    <td style={{ padding: 4 }}>
                      <input list="da-sanctions" value={r.final_sanction} disabled={!editable} maxLength={200}
                        onChange={(e) => setRow(si, ri, { final_sanction: e.target.value.toUpperCase() })} />
                    </td>
                    {editable && (
                      <td style={{ padding: 4 }}>
                        <button className="btn btn-sm" title="Remove row" onClick={() => removeRow(si, ri)}>×</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editable && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => addRow(si)}>+ Row</button>}
        </div>
      ))}

      {editable && <button className="btn" onClick={addSection}>+ Section</button>}
    </div>
  );
}
