import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const EMPTY = { supplier_code: '', name: '', company_name: '', tin: '', payment_term_id: '', is_active: true };
const EMPTY_CONTACT = { contact_name: '', title: '', email: '', phone: '', is_primary: false };
const EMPTY_ADDRESS = { address_line: '', is_default: false };

export default function Suppliers() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [newContact, setNewContact] = useState(EMPTY_CONTACT);
  const [newAddress, setNewAddress] = useState(EMPTY_ADDRESS);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [s, pt] = await Promise.all([api.get('/suppliers'), api.get('/lookups/payment-terms')]);
    setRows(s.data);
    setPaymentTerms(pt.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  }

  async function openEdit(row) {
    const { data } = await api.get(`/suppliers/${row.id}`);
    setForm({
      supplier_code: data.supplier_code || '', name: data.name, company_name: data.company_name || '',
      tin: data.tin || '', payment_term_id: data.payment_term_id || '', is_active: !!data.is_active,
    });
    setEditing(data);
    setNewContact(EMPTY_CONTACT);
    setNewAddress(EMPTY_ADDRESS);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = { ...form, payment_term_id: form.payment_term_id || null };
    try {
      if (editing === 'new') {
        await api.post('/suppliers', payload);
        setEditing(null);
      } else {
        await api.put(`/suppliers/${editing.id}`, payload);
        await openEdit(editing);
      }
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete supplier "${row.name}"?`)) return;
    try {
      await api.delete(`/suppliers/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function addContact() {
    if (!newContact.contact_name) return;
    await api.post(`/suppliers/${editing.id}/contacts`, newContact);
    setNewContact(EMPTY_CONTACT);
    openEdit(editing);
  }

  async function removeContact(contactId) {
    await api.delete(`/suppliers/${editing.id}/contacts/${contactId}`);
    openEdit(editing);
  }

  async function addAddress() {
    if (!newAddress.address_line) return;
    await api.post(`/suppliers/${editing.id}/addresses`, newAddress);
    setNewAddress(EMPTY_ADDRESS);
    openEdit(editing);
  }

  async function removeAddress(addressId) {
    await api.delete(`/suppliers/${editing.id}/addresses/${addressId}`);
    openEdit(editing);
  }

  const columns = [
    { key: 'supplier_code', label: 'Code' },
    { key: 'name', label: 'Name' },
    { key: 'company_name', label: 'Company' },
    { key: 'payment_term_name', label: 'Payment Term' },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Suppliers</h1>
        {can('/suppliers', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add Supplier</button>}
      </div>
      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            actions={(row) => (
              <>
                {can('/suppliers', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/suppliers', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Supplier' : `Edit Supplier — ${editing.name}`} onClose={() => setEditing(null)} large>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field-row">
              <div className="field">
                <label>Supplier Code</label>
                <input value={form.supplier_code} onChange={(e) => setForm({ ...form, supplier_code: e.target.value })} />
              </div>
              <div className="field">
                <label>Name</label>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Company Name</label>
                <input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
              </div>
              <div className="field">
                <label>TIN</label>
                <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Payment Term</label>
                <select value={form.payment_term_id} onChange={(e) => setForm({ ...form, payment_term_id: e.target.value })}>
                  <option value="">—</option>
                  {paymentTerms.map((p) => <option key={p.id} value={p.id}>{p.term_name}</option>)}
                </select>
              </div>
              <div className="field field-checkbox" style={{ alignSelf: 'center', marginTop: 18 }}>
                <input type="checkbox" id="sup-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                <label htmlFor="sup-active">Active</label>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Close</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>

          {editing !== 'new' && (
            <>
              <div className="subsection">
                <h3>Contacts</h3>
                <DataTable
                  columns={[
                    { key: 'contact_name', label: 'Name' },
                    { key: 'title', label: 'Title' },
                    { key: 'email', label: 'Email' },
                    { key: 'phone', label: 'Phone' },
                  ]}
                  rows={editing.contacts || []}
                  actions={(c) => <button className="btn btn-sm btn-danger" onClick={() => removeContact(c.id)}>Remove</button>}
                  emptyLabel="No contacts yet."
                />
                <div className="inline-form" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label>Name</label>
                    <input value={newContact.contact_name} onChange={(e) => setNewContact({ ...newContact, contact_name: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Title</label>
                    <input value={newContact.title} onChange={(e) => setNewContact({ ...newContact, title: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Email</label>
                    <input value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Phone</label>
                    <input value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} />
                  </div>
                  <button type="button" className="btn" onClick={addContact}>Add</button>
                </div>
              </div>

              <div className="subsection">
                <h3>Addresses</h3>
                <DataTable
                  columns={[{ key: 'address_line', label: 'Address' }]}
                  rows={editing.addresses || []}
                  actions={(a) => <button className="btn btn-sm btn-danger" onClick={() => removeAddress(a.id)}>Remove</button>}
                  emptyLabel="No addresses yet."
                />
                <div className="inline-form" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label>Address</label>
                    <input value={newAddress.address_line} onChange={(e) => setNewAddress({ ...newAddress, address_line: e.target.value })} />
                  </div>
                  <button type="button" className="btn" onClick={addAddress}>Add</button>
                </div>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
