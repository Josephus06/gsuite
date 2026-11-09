import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/useAuth';
import { displayDate } from '../utils/dates';
import { API, Check, MultiPick, STATUS_LABEL, errorOf, filePayload, openBlob, personName, vehicleLabel } from './installation/common';

// Production > Installation Planner > New / Edit Project -- PLANNER's project form. Picking the
// installation Job Order fills the title from "JO # - description" (PLANNER did it from the SO/JO);
// the planner is whoever creates the project. The picture, permit and BOM PDF upload after the
// project saves.
const EMPTY = {
  job_order_id: null, title: '', description: '', site_address: '', date_from: '', date_to: '', category_id: '',
  vehicles: [], needs_permit: false, driver_employee_id: '', installers: [], subcons: [],
  needs_safety_officer: false, safety_officer_employee_id: '', status: 'pending', progress: 0,
};
const empLabel = (e) => personName(e);
const empColumns = [
  { key: 'name', label: 'Name', render: empLabel },
  { key: 'department_name', label: 'Department' },
  { key: 'position_title', label: 'Position' },
];

export default function InstallationProjectForm() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const { user } = useAuth();
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [project, setProject] = useState(null);
  const [jobOrders, setJobOrders] = useState([]);
  // The chosen JO, kept apart from the search results so the picker still shows it after another search.
  const [chosenJo, setChosenJo] = useState(null);
  const [files, setFiles] = useState({ image: null, permit: null, bom: null });
  const [removeFiles, setRemoveFiles] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    api.get(`${API}/meta`).then(({ data }) => setMeta(data)).catch((err) => setError(errorOf(err)));
    searchJobOrders('');
    if (editing) {
      api.get(`${API}/projects/${id}`).then(({ data }) => {
        setProject(data);
        if (data.job_order_id) {
          setChosenJo({ id: data.job_order_id, job_order_no: data.job_order_no, customer_name: data.customer_name, description: data.job_order_description });
        }
        setForm({
          job_order_id: data.job_order_id, title: data.title || '', description: data.description || '', site_address: data.site_address || '',
          date_from: data.date_from ? String(data.date_from).slice(0, 10) : '', date_to: data.date_to ? String(data.date_to).slice(0, 10) : '',
          category_id: data.category_id || '', vehicles: data.vehicles.map((v) => v.id), needs_permit: !!data.needs_permit,
          driver_employee_id: data.driver_employee_id || '', installers: data.installers.map((e) => e.id), subcons: data.subcons.map((s) => s.id),
          needs_safety_officer: !!data.needs_safety_officer, safety_officer_employee_id: data.safety_officer_employee_id || '',
          status: data.status, progress: data.progress,
        });
      }).catch((err) => setError(errorOf(err)));
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  function searchJobOrders(q) {
    api.get(`${API}/job-orders`, { params: { search: q || undefined } })
      .then(({ data }) => setJobOrders(data))
      .catch(() => {});
  }

  function pickJobOrder(jo) {
    setChosenJo(jo);
    set({
      job_order_id: jo.id,
      title: form.title && editing ? form.title : `${jo.job_order_no}${jo.description ? ` - ${jo.description}` : ''}`.slice(0, 255),
      description: form.description || [jo.customer_name, jo.description].filter(Boolean).join('\n'),
      date_to: form.date_to || (jo.delivery_date ? String(jo.delivery_date).slice(0, 10) : ''),
    });
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (form.needs_permit && !files.permit && !(project?.files?.permit && !removeFiles.permit)) {
      setError('Attach the permit file, or untick Needs Permit.');
      return;
    }
    setSaving(true);
    try {
      const body = { ...form };
      const { data } = editing ? await api.put(`${API}/projects/${id}`, body) : await api.post(`${API}/projects`, body);
      const pid = data.id;
      for (const kind of ['image', 'permit', 'bom']) {
        if (files[kind]) await api.post(`${API}/projects/${pid}/files/${kind}`, await filePayload(files[kind]));
        else if (editing && removeFiles[kind]) await api.delete(`${API}/projects/${pid}/files/${kind}`);
      }
      // A permit no longer needed is not kept.
      if (editing && !form.needs_permit && project?.files?.permit) await api.delete(`${API}/projects/${pid}/files/permit`);
      navigate(`/installation-planner/projects/${pid}`);
    } catch (err) {
      setError(errorOf(err));
      setSaving(false);
    }
  }

  if (!meta || (editing && !project)) return <div className="page">{error ? <div className="error-banner">{error}</div> : <LoadingSpinner />}</div>;

  const jo = form.job_order_id ? (jobOrders.find((j) => j.id === form.job_order_id) || chosenJo) : null;
  const joItems = jo && !jobOrders.some((j) => j.id === jo.id) ? [jo, ...jobOrders] : jobOrders;
  const fileField = (kind, label, accept, hint) => {
    const current = project?.files?.[kind];
    return (
      <div className="field">
        <label>{label}</label>
        {current && !removeFiles[kind] && !files[kind] && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, fontSize: 13 }}>
            <button type="button" className="btn btn-sm" onClick={async () => { const m = await openBlob(`${API}/projects/${id}/files/${kind}`); if (m) setError(m); }}>
              View {current.file_name}
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoveFiles((r) => ({ ...r, [kind]: true }))}>Remove</button>
          </div>
        )}
        {removeFiles[kind] && !files[kind] && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Will be removed on save. <button type="button" className="btn btn-sm" onClick={() => setRemoveFiles((r) => ({ ...r, [kind]: false }))}>Undo</button>
          </div>
        )}
        <input type="file" accept={accept} onChange={(ev) => setFiles((f) => ({ ...f, [kind]: ev.target.files[0] || null }))} />
        <div className="muted" style={{ fontSize: 12 }}>{hint}</div>
      </div>
    );
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>{editing ? `Edit ${project.project_no}` : 'New Installation Project'}</h1>
        <Link className="btn" to={editing ? `/installation-planner/projects/${id}` : '/installation-planner/projects'}>Back</Link>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={save}>
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>Project</h3>
          <div className="filter-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Installation Job Order</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 320px' }}>
                  <EntityPicker
                    label="Job Order" items={joItems} value={form.job_order_id || ''}
                    getLabel={(j) => `${j.job_order_no}${j.customer_name ? ` · ${j.customer_name}` : ''}`}
                    columns={[
                      { key: 'job_order_no', label: 'JO #' }, { key: 'order_no', label: 'SO / NSSO' },
                      { key: 'customer_name', label: 'Customer' }, { key: 'description', label: 'Description' },
                      { key: 'delivery_date', label: 'Date Needed', render: (j) => displayDate(j.delivery_date) },
                      { key: 'project_nos', label: 'Project(s)' },
                    ]}
                    searchKeys={['job_order_no', 'order_no', 'customer_name', 'description']}
                    onSearch={searchJobOrders} onSelect={pickJobOrder}
                    onClear={() => { setChosenJo(null); set({ job_order_id: null }); }}
                  />
                </div>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {jo ? `${jo.job_type || ''}${jo.location ? ` · ${jo.location}` : ''}${jo.project_nos ? ` · already on ${jo.project_nos}` : ''}`
                  : 'Job Orders whose Job Type or a process is installation. Picking one fills the title from the JO.'}
              </div>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Project Title *</label>
              <input value={form.title} maxLength={255} required onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Description</label>
              <textarea rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Site Address</label>
              <input value={form.site_address} maxLength={300} onChange={(e) => set({ site_address: e.target.value })} />
            </div>
            <div className="field">
              <label>Timeline From</label>
              <input type="date" value={form.date_from} onChange={(e) => set({ date_from: e.target.value })} />
            </div>
            <div className="field">
              <label>Timeline To</label>
              <input type="date" value={form.date_to} min={form.date_from || undefined} onChange={(e) => set({ date_to: e.target.value })} />
            </div>
            <div className="field">
              <label>Project Category *</label>
              <select value={form.category_id} required onChange={(e) => set({ category_id: e.target.value })}>
                <option value="">-- Select Category --</option>
                {meta.categories.filter((c) => c.is_active || Number(c.id) === Number(form.category_id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {meta.categories.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No categories yet -- add them under Installation Categories.</div>}
            </div>
            <div className="field">
              <label>Status *</label>
              <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
                {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Progress (%)</label>
              <input type="number" min={0} max={100} value={form.progress} onChange={(e) => set({ progress: e.target.value === '' ? '' : Number(e.target.value) })} />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>Files</h3>
          <div className="filter-grid">
            {fileField('image', 'Project Picture', 'image/*', 'JPG / PNG / WEBP up to 10MB')}
            {fileField('bom', 'BOM (PDF)', 'application/pdf', 'BOM / cutting list PDF up to 10MB. Its lines go in on the project page (paste the text).')}
            <div className="field">
              <Check checked={form.needs_permit} onChange={(v) => set({ needs_permit: v })} style={{ marginBottom: 6 }}>Needs Permit</Check>
              {form.needs_permit && fileField('permit', 'Permit File *', 'application/pdf,image/*', 'PDF or image up to 10MB')}
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>Team &amp; Vehicles</h3>
          <div className="filter-grid">
            <div className="field">
              <label>Planner</label>
              <input value={editing ? project.planner_name || '' : user?.display_name || ''} readOnly />
            </div>
            <div className="field">
              <label>Driver</label>
              {/* Only Position Code DRIVER -- plus the project's current driver, so editing keeps them. */}
              <EntityPicker label="Driver"
                items={meta.employees.filter((e) => e.is_driver || Number(e.id) === Number(project?.driver_employee_id))}
                value={form.driver_employee_id || ''} getLabel={empLabel}
                columns={empColumns} searchKeys={['first_name', 'last_name', 'department_name']}
                onSelect={(e) => set({ driver_employee_id: e.id })} onClear={() => set({ driver_employee_id: '' })} />
              {!meta.employees.some((e) => e.is_driver) && (
                <div className="muted" style={{ fontSize: 12 }}>No employee has Position Code DRIVER yet -- set it on their employee record.</div>
              )}
            </div>
            <div className="field">
              <label>Car / Truck (select multiple)</label>
              <MultiPick items={meta.vehicles} value={form.vehicles} onChange={(v) => set({ vehicles: v })} getLabel={vehicleLabel} placeholder="Select vehicles..." />
              {meta.vehicles.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No vehicles in Assets &gt; Fleet yet.</div>}
            </div>
            <div className="field">
              <label>Installer(s)</label>
              {/* Only Position Code INSTALLER -- plus anyone already on this project, so editing keeps them. */}
              <MultiPick items={meta.employees.filter((e) => e.is_installer || form.installers.includes(Number(e.id)))}
                value={form.installers} onChange={(v) => set({ installers: v })}
                getLabel={empLabel} getSub={(e) => e.department_name} placeholder="Select installers..." />
              {!meta.employees.some((e) => e.is_installer) && (
                <div className="muted" style={{ fontSize: 12 }}>No employee has Position Code INSTALLER yet -- set it on their employee record.</div>
              )}
              <div className="muted" style={{ fontSize: 12 }}>Their days and hours are set on the project page, under Installer Schedule.</div>
            </div>
            <div className="field">
              <label>Subcon(s) Involved</label>
              <MultiPick items={meta.suppliers} value={form.subcons} onChange={(v) => set({ subcons: v })}
                getLabel={(s) => s.name} getSub={(s) => s.supplier_code} placeholder="Select subcontractors (suppliers)..." />
            </div>
            <div className="field">
              <Check checked={form.needs_safety_officer} style={{ marginBottom: 6 }}
                onChange={(v) => set({ needs_safety_officer: v, ...(v ? {} : { safety_officer_employee_id: '' }) })}>Assign Safety Officer</Check>
              {form.needs_safety_officer && (
                <EntityPicker label="Safety Officer" items={meta.employees} value={form.safety_officer_employee_id || ''} getLabel={empLabel}
                  columns={empColumns} searchKeys={['first_name', 'last_name', 'department_name']}
                  onSelect={(e) => set({ safety_officer_employee_id: e.id })} />
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Project'}</button>
          <Link className="btn" to={editing ? `/installation-planner/projects/${id}` : '/installation-planner/projects'}>Cancel</Link>
        </div>
      </form>
    </div>
  );
}
