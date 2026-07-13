import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const EMPTY = {
  customer_code: '', name: '', company_name: '', business_style_id: '',
  tin: '', payment_term_id: '', credit_limit: 0, sales_division_id: '', is_active: true,
};

const EMPTY_CONTACT = { contact_name: '', title: '', email: '', phone: '', is_primary: false };
const EMPTY_ADDRESS = { address_type: 'Shipping', address_line: '', is_default: false };

export default function Customers() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [businessStyles, setBusinessStyles] = useState([]);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [salesDivisions, setSalesDivisions] = useState([]);
  const [editing, setEditing] = useState(null); // 'new' | customer object
  const [form, setForm] = useState(EMPTY);
  const [newContact, setNewContact] = useState(EMPTY_CONTACT);
  const [newAddress, setNewAddress] = useState(EMPTY_ADDRESS);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [c, bs, pt, sd] = await Promise.all([
      api.get('/customers'),
      api.get('/lookups/business-styles'),
      api.get('/lookups/payment-terms'),
      api.get('/lookups/sales-divisions'),
    ]);
    setRows(c.data);
    setBusinessStyles(bs.data);
    setPaymentTerms(pt.data);
    setSalesDivisions(sd.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  }

  async function openEdit(row) {
    const { data } = await api.get(`/customers/${row.id}`);
    setForm({
      customer_code: data.customer_code || '', name: data.name, company_name: data.company_name || '',
      business_style_id: data.business_style_id || '', tin: data.tin || '',
      payment_term_id: data.payment_term_id || '', credit_limit: data.credit_limit || 0,
      sales_division_id: data.sales_division_id || '', is_active: !!data.is_active,
    });
    setEditing(data);
    setNewContact(EMPTY_CONTACT);
    setNewAddress(EMPTY_ADDRESS);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = {
      ...form,
      business_style_id: form.business_style_id || null,
      payment_term_id: form.payment_term_id || null,
      sales_division_id: form.sales_division_id || null,
    };
    try {
      if (editing === 'new') {
        await api.post('/customers', payload);
        setEditing(null);
      } else {
        await api.put(`/customers/${editing.id}`, payload);
        await openEdit(editing);
      }
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete customer "${row.name}"?`)) return;
    try {
      await api.delete(`/customers/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function addContact() {
    if (!newContact.contact_name) return;
    await api.post(`/customers/${editing.id}/contacts`, newContact);
    setNewContact(EMPTY_CONTACT);
    openEdit(editing);
  }

  async function removeContact(contactId) {
    await api.delete(`/customers/${editing.id}/contacts/${contactId}`);
    openEdit(editing);
  }

  async function addAddress() {
    if (!newAddress.address_line) return;
    await api.post(`/customers/${editing.id}/addresses`, newAddress);
    setNewAddress(EMPTY_ADDRESS);
    openEdit(editing);
  }

  async function removeAddress(addressId) {
    await api.delete(`/customers/${editing.id}/addresses/${addressId}`);
    openEdit(editing);
  }

  const columns = [
    { key: 'customer_code', label: 'Code' },
    { key: 'name', label: 'Name' },
    { key: 'company_name', label: 'Company' },
    { key: 'payment_term_name', label: 'Payment Term' },
    { key: 'credit_limit', label: 'Credit Limit' },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Customers</h1>
        {can('/customers', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add Customer</button>}
      </div>
      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            actions={(row) => (
              <>
                {can('/customers', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/customers', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Customer' : `Edit Customer — ${editing.name}`} onClose={() => setEditing(null)} large>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field-row">
              <div className="field">
                <label>Customer Code</label>
                <input value={form.customer_code} onChange={(e) => setForm({ ...form, customer_code: e.target.value })} />
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
                <label>Business Style</label>
                <select value={form.business_style_id} onChange={(e) => setForm({ ...form, business_style_id: e.target.value })}>
                  <option value="">—</option>
                  {businessStyles.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>TIN</label>
                <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
              </div>
              <div className="field">
                <label>Payment Term</label>
                <select value={form.payment_term_id} onChange={(e) => setForm({ ...form, payment_term_id: e.target.value })}>
                  <option value="">—</option>
                  {paymentTerms.map((p) => <option key={p.id} value={p.id}>{p.term_name}</option>)}
                </select>
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Credit Limit</label>
                <input type="number" step="0.01" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} />
              </div>
              <div className="field">
                <label>Sales Division</label>
                <select value={form.sales_division_id} onChange={(e) => setForm({ ...form, sales_division_id: e.target.value })}>
                  <option value="">—</option>
                  {salesDivisions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div className="field-checkbox">
              <input type="checkbox" id="cust-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              <label htmlFor="cust-active">Active</label>
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
                  columns={[
                    { key: 'address_type', label: 'Type' },
                    { key: 'address_line', label: 'Address' },
                  ]}
                  rows={editing.addresses || []}
                  actions={(a) => <button className="btn btn-sm btn-danger" onClick={() => removeAddress(a.id)}>Remove</button>}
                  emptyLabel="No addresses yet."
                />
                <div className="inline-form" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label>Type</label>
                    <select value={newAddress.address_type} onChange={(e) => setNewAddress({ ...newAddress, address_type: e.target.value })}>
                      <option>Billing</option>
                      <option>Shipping</option>
                      <option>Other</option>
                    </select>
                  </div>
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
