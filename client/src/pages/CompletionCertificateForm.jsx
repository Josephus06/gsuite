import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { displayDate } from '../utils/dates';

function today() { return new Date().toISOString().slice(0, 10); }
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Create / edit a Certificate of Completion (2026-10-28), as the source's form: pick a BILLED Sales
// Order -> PO #, Customer, Submitted By (its sales rep), Project Name / Location / Contract Package
// fill in; then the Approvers and Certifiers -- the customer's own contact persons, picked from its
// contact list (or added there on the spot), in signing order.
const ROLE_TABS = [{ key: 'approvers', role: 'approver', label: 'Approvers' }, { key: 'certifiers', role: 'certifier', label: 'Certifiers' }];

function ContactPicker({ customerId, role, contacts, onPick, onAdded, onClose }) {
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ contact_name: '', email: '', phone: '', title: '', description: '' });
  const [error, setError] = useState('');
  const flag = role === 'approver' ? 'is_approver' : 'is_certifier';
  const q = search.trim().toLowerCase();
  // The contacts already marked for this role first, then the rest.
  const shown = contacts
    .filter((c) => !q || [c.contact_name, c.email, c.phone, c.title, c.description].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => Number(b[flag]) - Number(a[flag]) || String(a.contact_name).localeCompare(String(b.contact_name)));

  async function add() {
    setError('');
    try {
      const { data } = await api.post('/completion-certificates/contacts', { ...form, customer_id: customerId, role });
      onAdded(data);
      onPick(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not add the contact person.'); }
  }

  return (
    <Modal title="Contact Person" onClose={onClose} large>
      {adding ? (
        <div>
          {error && <div className="error-banner">{error}</div>}
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div className="field"><label>Name *</label><input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} /></div>
            <div className="field"><label>Title</label><input value={form.title} placeholder="e.g. PROJECT ENGINEER" onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div className="field"><label>Email</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="field"><label>Contact Nos</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          </div>
          <div className="field"><label>Description</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setAdding(false)}>Back</button>
            <button className="btn btn-primary" onClick={add}>Save and Add</button>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} autoFocus />
            <button className="btn btn-primary" onClick={() => setAdding(true)}>Add New</button>
          </div>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Contact Nos</th><th>Title</th><th>Description</th></tr></thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 16 }}>No contact persons{q ? ' match' : ' on this customer yet -- Add New'}.</td></tr>}
                {shown.map((c) => (
                  <tr key={c.id} onClick={() => onPick(c)} style={{ cursor: 'pointer' }}>
                    <td>{c.contact_name}</td><td>{c.email}</td><td>{c.phone}</td><td>{c.title}</td><td>{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function CompletionCertificateForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [billedSos, setBilledSos] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [header, setHeader] = useState({
    date_created: today(), sales_order_id: '', sales_order_no: '', po_no: '', customer_id: '', customer_name: '',
    submitted_by_employee_id: '', submitted_by_name: '', project_name: '', location: '', contract_package: '',
  });
  const [signers, setSigners] = useState({ approvers: [], certifiers: [] });
  const [tab, setTab] = useState('approvers');
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const [{ data: sos }, { data: emps }] = await Promise.all([
        api.get('/completion-certificates/billable-sales-orders'),
        api.get('/employees'),
      ]);
      setBilledSos(sos);
      setEmployees(emps);
      if (id) {
        const { data: cc } = await api.get(`/completion-certificates/${id}`);
        setHeader({
          date_created: String(cc.date_created).slice(0, 10), sales_order_id: cc.sales_order_id || '', sales_order_no: cc.sales_order_no || '',
          po_no: cc.po_no || '', customer_id: cc.customer_id || '', customer_name: cc.customer_name || '',
          submitted_by_employee_id: cc.submitted_by_employee_id || '', submitted_by_name: cc.submitted_by_name || '',
          project_name: cc.project_name || '', location: cc.location || '', contract_package: cc.contract_package || '',
        });
        const pick = (s) => ({ contact_id: s.contact_id, name: s.name, job_title: s.job_title || '' });
        setSigners({ approvers: (cc.approvers || []).map(pick), certifiers: (cc.certifiers || []).map(pick) });
        if (cc.customer_id) setContacts((await api.get('/completion-certificates/contacts', { params: { customer_id: cc.customer_id } })).data);
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]);

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  const searchSos = (q) => api.get('/completion-certificates/billable-sales-orders', { params: { search: q } }).then(({ data }) => setBilledSos(data));

  async function onSelectSo(so) {
    if (!so) return;
    const { data } = await api.get(`/completion-certificates/source-sales-order/${so.id}`);
    const s = data.sales_order;
    setH({
      sales_order_id: s.id, sales_order_no: s.sales_order_no, po_no: s.po_no || '', customer_id: s.customer_id || '', customer_name: s.customer_name || '',
      submitted_by_employee_id: s.sales_rep_id || '', submitted_by_name: s.sales_rep_name || '',
      project_name: s.contract_description || '', location: s.shipping_address || '', contract_package: s.contract_description || '',
    });
    setContacts(data.contacts || []);
    // Another customer's contact persons cannot sign this one.
    if (String(s.customer_id) !== String(header.customer_id)) setSigners({ approvers: [], certifiers: [] });
  }

  const list = signers[tab];
  const setList = (next) => setSigners((sg) => ({ ...sg, [tab]: next }));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  };

  async function save() {
    setError('');
    if (!header.sales_order_id) { setError('Select a billed Sales Order.'); return; }
    setSaving(true);
    try {
      const body = { ...header, ...signers };
      if (id) { await api.put(`/completion-certificates/${id}`, body); navigate(`/completion-certificates/${id}`); }
      else { const { data } = await api.post('/completion-certificates', body); navigate(`/completion-certificates/${data.id}`); }
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading) return <LoadingSpinner />;
  const roleTab = ROLE_TABS.find((t) => t.key === tab);

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>CERTIFICATE OF COMPLETION <span className="muted">/ {id ? 'Edit' : 'Create'}</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/completion-certificates'}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field"><label>Date Created</label><input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} /></div>
            <div className="field">
              <label>SO # <span className="muted">(billed only)</span></label>
              <EntityPicker label="Sales Orders" items={billedSos} value={header.sales_order_id} getLabel={(s) => s.sales_order_no}
                columns={[
                  { key: 'sales_order_no', label: 'SO #' },
                  { key: 'date_created', label: 'Date', render: (s) => displayDate(String(s.date_created).slice(0, 10)) },
                  { key: 'customer_name', label: 'Customer' },
                  { key: 'total_amount', label: 'Total Amount', render: (s) => money(s.total_amount) },
                  { key: 'status', label: 'Status', render: (s) => String(s.status || '').toUpperCase() },
                ]}
                searchKeys={['sales_order_no', 'customer_name']} placeholder={header.sales_order_no || '--Select--'} onSelect={onSelectSo} onSearch={searchSos} disabled={!!id} />
            </div>
            <div className="field"><label>PO #</label><input value={header.po_no} onChange={(e) => setH({ po_no: e.target.value })} /></div>
            <div className="field"><label>Customer</label><input value={header.customer_name} readOnly disabled /></div>
            <div className="field">
              <label>Submitted By</label>
              <EntityPicker label="Employee" items={employees} value={header.submitted_by_employee_id}
                getLabel={(e) => `${e.first_name} ${e.last_name}`} placeholder={header.submitted_by_name || '--Select--'}
                columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }, { key: 'department_name', label: 'Department' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={(e) => setH({ submitted_by_employee_id: e?.id || '', submitted_by_name: e ? `${e.first_name} ${e.last_name}` : '' })} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field"><label>Project Name</label><textarea rows={3} value={header.project_name} onChange={(e) => setH({ project_name: e.target.value })} /></div>
            <div className="field"><label>Location</label><textarea rows={3} value={header.location} onChange={(e) => setH({ location: e.target.value })} /></div>
            <div className="field"><label>Contract Package</label><textarea rows={3} value={header.contract_package} onChange={(e) => setH({ contract_package: e.target.value })} /></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 8 }}>
          {ROLE_TABS.map((t) => (
            <button key={t.key} className={`status-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label} {signers[t.key].length > 0 && <span className="badge badge-muted">{signers[t.key].length}</span>}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th style={{ width: 120 }}></th><th>Name</th><th>Job Title</th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 16 }}>No {roleTab.label.toLowerCase()} yet.</td></tr>}
              {list.map((s, i) => (
                <tr key={`${s.contact_id}-${i}`}>
                  <td style={{ display: 'flex', gap: 4 }}>
                    <button type="button" className="btn btn-sm" title="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button type="button" className="btn btn-sm" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" className="btn btn-sm btn-danger" title="Remove" onClick={() => setList(list.filter((_, j) => j !== i))}>✕</button>
                  </td>
                  <td>{s.name}</td>
                  <td><input value={s.job_title} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, job_title: e.target.value } : x)))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} disabled={!header.customer_id}
          title={header.customer_id ? '' : 'Pick the Sales Order first'} onClick={() => setPicking(true)}>Add</button>
      </div>

      {picking && (
        <ContactPicker
          customerId={header.customer_id} role={roleTab.role} contacts={contacts}
          onClose={() => setPicking(false)}
          onAdded={(c) => setContacts((cs) => [...cs, c])}
          onPick={(c) => {
            if (!list.some((s) => String(s.contact_id) === String(c.id))) {
              setList([...list, { contact_id: c.id, name: String(c.contact_name || '').toUpperCase(), job_title: String(c.title || '').toUpperCase() }]);
            }
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
