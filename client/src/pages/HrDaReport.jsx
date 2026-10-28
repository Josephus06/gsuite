import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// HRD > DA Report (2026-10-28). HR's monthly Discipline Management Report on the company's sheet:
// a section per stage of the disciplinary action (NOTICE TO EXPLAIN, ...), each a table of
// EMPLOYEE NAME / VIOLATION / SECTION VIOLATED / FINAL SANCTION. Pick a month, add its lines, print.

const thisMonth = () => new Date().toISOString().slice(0, 7);
export const monthTitle = (m) => (m
  ? new Date(`${m}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase()
  : '');

function blankForm(month, meta) {
  return {
    report_month: month,
    stage: meta?.stages?.[0] || 'NOTICE TO EXPLAIN',
    employee_id: '',
    employee_name: '',
    violation: '',
    violation_type_id: '',
    section_violated: '',
    final_sanction: meta?.sanctions?.[0] || 'ISSUED NTE',
  };
}

function EntryModal({ meta, month, existing, onClose, onSaved }) {
  const [form, setForm] = useState(() => (existing
    ? { ...blankForm(month, meta), ...Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, v ?? ''])), report_month: existing.month }
    : blankForm(month, meta)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setError(''); setSaving(true);
    try {
      if (existing) await api.put(`/hr-da-reports/${existing.id}`, form);
      else await api.post('/hr-da-reports', form);
      onSaved(form.report_month);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save.');
      setSaving(false);
    }
  }

  return (
    <Modal title={existing ? 'Edit DA Report line' : 'Add to DA Report'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="field">
          <label>Month *</label>
          <input type="month" value={form.report_month} onChange={(e) => set({ report_month: e.target.value })} />
        </div>
        <div className="field">
          <label>Section *</label>
          <input list="da-stages" value={form.stage} maxLength={80} onChange={(e) => set({ stage: e.target.value.toUpperCase() })} />
          <datalist id="da-stages">{(meta?.stages || []).map((s) => <option key={s} value={s} />)}</datalist>
        </div>
      </div>
      <div className="field">
        <label>Employee Name *</label>
        <EntityPicker
          label="Employee" items={meta?.employees || []} value={form.employee_id || ''}
          getLabel={(e) => e.report_name}
          placeholder={form.employee_name || undefined}
          columns={[
            { key: 'report_name', label: 'Name' },
            { key: 'employee_code', label: 'Code' },
            { key: 'department_name', label: 'Department' },
          ]}
          searchKeys={['first_name', 'last_name', 'employee_code', 'department_name']}
          onSelect={(e) => set({ employee_id: e?.id || '', employee_name: e?.report_name || '' })}
        />
      </div>
      <div className="field">
        <label>Violation *</label>
        <input value={form.violation} maxLength={300} placeholder="e.g. 3 Habitual Tardiness" onChange={(e) => set({ violation: e.target.value })} />
      </div>
      <div className="field">
        <label>Section Violated</label>
        {(meta?.violation_types || []).length > 0 && (
          <select
            value={form.violation_type_id || ''}
            onChange={(e) => {
              const t = meta.violation_types.find((x) => String(x.id) === e.target.value);
              set({ violation_type_id: t?.id || '', section_violated: t ? t.label : form.section_violated });
            }}
            style={{ marginBottom: 6 }}
          >
            <option value="">Pick from the Violation list...</option>
            {meta.violation_types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
        <input value={form.section_violated} maxLength={300} placeholder="e.g. Section 3.49 Tardiness and Absenteeism"
          onChange={(e) => set({ section_violated: e.target.value, violation_type_id: '' })} />
      </div>
      <div className="field">
        <label>Final Sanction</label>
        <input list="da-sanctions" value={form.final_sanction} maxLength={200} onChange={(e) => set({ final_sanction: e.target.value.toUpperCase() })} />
        <datalist id="da-sanctions">{(meta?.sanctions || []).map((s) => <option key={s} value={s} />)}</datalist>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}

export default function HrDaReport() {
  const { can } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback((m) => {
    setData(null);
    api.get('/hr-da-reports', { params: { month: m } })
      .then(({ data: d }) => setData(d))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the report.'));
  }, []);
  useEffect(() => { load(month); }, [month, load]);
  useEffect(() => { api.get('/hr-da-reports/meta').then(({ data: d }) => setMeta(d)).catch(() => setMeta({})); }, []);

  async function remove(row) {
    if (!confirm(`Remove ${row.employee_name} from the ${monthTitle(row.month)} report?`)) return;
    try { await api.delete(`/hr-da-reports/${row.id}`); load(month); }
    catch (e) { alert(e.response?.data?.error || 'Could not remove it.'); }
  }

  // Grouped by section, in the server's order.
  const groups = [];
  for (const r of data?.rows || []) {
    let g = groups.find((x) => x.stage === r.stage);
    if (!g) { g = { stage: r.stage, rows: [] }; groups.push(g); }
    g.rows.push(r);
  }

  return (
    <div>
      <div className="page-header">
        <h1>DA Report</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {can('/hrd/da-report', 'can_print') && (
            <button className="btn" disabled={!data?.rows?.length} onClick={() => window.open(`/hrd/da-report/print?month=${month}`, '_blank')}>Print</button>
          )}
          {can('/hrd/da-report', 'can_add') && <button className="btn btn-primary" onClick={() => setEditing('new')}>Add</button>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Month</label>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </div>
          {(data?.months || []).length > 0 && (
            <div className="field">
              <label>Months with entries</label>
              <select value="" onChange={(e) => e.target.value && setMonth(e.target.value)}>
                <option value="">Jump to...</option>
                {data.months.map((m) => <option key={m.month} value={m.month}>{monthTitle(m.month)} ({m.n})</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0, textAlign: 'center' }}>Discipline Management Report ({monthTitle(month)})</h3>
        {!data ? <LoadingSpinner /> : groups.length === 0 ? (
          <div className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing reported for {monthTitle(month)} yet.</div>
        ) : groups.map((g) => (
          <div key={g.stage} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, textAlign: 'center', padding: '6px 0', borderTop: '1px solid var(--border, #e2e8f0)' }}>{g.stage}</div>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr><th>Employee Name</th><th>Violation</th><th>Section Violated</th><th>Final Sanction</th><th /></tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Employee Name">{r.employee_name}</td>
                      <td data-label="Violation">{r.violation}</td>
                      <td data-label="Section Violated">{r.section_violated}</td>
                      <td data-label="Final Sanction">{r.final_sanction}</td>
                      <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {can('/hrd/da-report', 'can_edit') && <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>}
                        {can('/hrd/da-report', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => remove(r)}>Delete</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <EntryModal
          meta={meta} month={month} existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); if (m !== month) setMonth(m); else load(month); }}
        />
      )}
    </div>
  );
}
