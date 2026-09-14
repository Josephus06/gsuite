import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/useAuth';
import { FUND_TYPES, PURPOSE_LABELS, TYPE_LABELS, money } from '../utils/requestForms';

// Filling out a form, and revising one. The same page does both: an edit is the same boxes with
// the answers already in them, and keeping one copy is what stops the create and edit forms from
// quietly drifting apart the way they had in the source (two 200-line Blade partials each).
//
// WHICH BOXES APPEAR is decided by type, and type is fixed once the form exists -- you cannot turn
// a liquidation into a business trip, because they are different printed documents.
//
// Revising a REJECTED form sends it back for a decision on save. The server decides where it lands
// (back to NOTED if it had been noted, otherwise SUBMITTED); this page only reports what came back.


const blankItem = () => ({ date: '', particulars: '', amount: '' });

export default function FormEdit() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isNew = !id;

  const [type, setType] = useState(params.get('type') || '');
  const [form, setForm] = useState({
    // Both default to whoever is filling the form in -- their name, and the department on their
    // default login branch, which is the same source an Estimate auto-fills from. Editable, because
    // somebody does occasionally file one on a colleague's behalf, and both are STORED on the form
    // rather than read back from the user, so a printed document does not change its mind years
    // later when somebody moves department.
    department: isNew ? (user?.default_branch?.department_name || '') : '',
    name: isNew ? (user?.display_name || '') : '',
    week_no: '', form_no: '', date_from: '', date_to: '',
    cash_advance_amount: '', cash_advance_date: '', previous_balance: '', starting_balance: '',
    purposes: [], purpose_other_text: '',
    payable_to: '', address: '', date: '',
    driver_name: '', vehicle_plate_no: '', speedometer_begin: '', speedometer_end: '',
    total_mileage_km: '', trip_date: '', time_out: '', time_in: '', purpose: '',
    checked_by: '', noted_by: '',
  });
  const [items, setItems] = useState([blankItem()]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api.get('/forms/meta/options')
      .then(({ data }) => setDepartments(data.departments || []))
      .catch(() => {});
  }, []);

  const load = useCallback(() => api.get(`/forms/${id}`).then(({ data }) => {
    setType(data.type);
    const d = data.detail || {};
    setForm({
      department: data.department || '', name: data.name || '',
      week_no: d.week_no || '', form_no: d.form_no || '',
      date_from: d.date_from ? String(d.date_from).slice(0, 10) : '',
      date_to: d.date_to ? String(d.date_to).slice(0, 10) : '',
      cash_advance_amount: d.cash_advance_amount ?? '',
      cash_advance_date: d.cash_advance_date ? String(d.cash_advance_date).slice(0, 10) : '',
      previous_balance: d.previous_balance ?? '', starting_balance: d.starting_balance ?? '',
      purposes: (data.purposes || []).map((p) => p.purpose),
      purpose_other_text: (data.purposes || []).find((p) => p.purpose === 'others')?.other_text || '',
      payable_to: d.payable_to || '', address: d.address || '',
      date: d.doc_date ? String(d.doc_date).slice(0, 10) : '',
      driver_name: d.driver_name || '', vehicle_plate_no: d.vehicle_plate_no || '',
      speedometer_begin: d.speedometer_begin || '', speedometer_end: d.speedometer_end || '',
      total_mileage_km: d.total_mileage_km ?? '',
      trip_date: d.trip_date ? String(d.trip_date).slice(0, 10) : '',
      time_out: d.time_out ? String(d.time_out).slice(0, 5) : '',
      time_in: d.time_in ? String(d.time_in).slice(0, 5) : '',
      purpose: d.purpose || '', checked_by: d.checked_by || '', noted_by: d.noted_by_name || '',
    });
    setItems((data.items || []).length
      ? data.items.map((i) => ({
        date: i.item_date ? String(i.item_date).slice(0, 10) : '',
        particulars: i.particulars || '',
        amount: i.amount ?? '',
        rejection_remark: i.rejection_remark || '',
      }))
      : [blankItem()]);
    setLoading(false);
  }), [id]);

  useEffect(() => {
    if (isNew) return;
    load().catch((e) => { setError(e.response?.data?.error || 'Could not load this form.'); setLoading(false); });
  }, [isNew, load]);

  const isFund = FUND_TYPES.includes(type);
  const hasItems = type && type !== 'business_trip';
  const itemsTotal = items.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  // Shown live while typing, because the printed form carries these two and somebody filling it in
  // wants to see the balance land where they expect before they commit to it.
  const endingBalance = (Number(form.starting_balance) || 0) - itemsTotal;

  function addRow() { setItems((rows) => [...rows, blankItem()]); }
  function removeRow(i) { setItems((rows) => (rows.length === 1 ? rows : rows.filter((_, n) => n !== i))); }
  function setRow(i, k, v) { setItems((rows) => rows.map((r, n) => (n === i ? { ...r, [k]: v } : r))); }
  function togglePurpose(k) {
    setForm((f) => ({
      ...f,
      purposes: f.purposes.includes(k) ? f.purposes.filter((p) => p !== k) : [...f.purposes, k],
    }));
  }

  async function save() {
    setSaving(true); setError('');
    const payload = {
      ...form, type,
      items: hasItems
        ? items.filter((r) => r.particulars || r.amount).map((r) => ({ date: r.date, particulars: r.particulars, amount: r.amount }))
        : [],
    };
    try {
      if (isNew) {
        const { data } = await api.post('/forms', payload);
        navigate(`/forms/${data.id}`);
      } else {
        await api.put(`/forms/${id}`, payload);
        navigate(`/forms/${id}`);
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save this form.');
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  // Nothing to fill in until we know which form this is.
  if (isNew && !type) {
    return (
      <div>
        <div className="page-header"><h1>Fill Out a Form</h1>
          <button className="btn btn-sm" onClick={() => navigate('/forms')}>Back</button>
        </div>
        <div className="card">
          <p className="muted">Which form is this?</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            {Object.entries(TYPE_LABELS).map(([k, label]) => (
              <button key={k} className="btn btn-primary" onClick={() => setType(k)}>{label}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Fill Out a Form' : 'Edit Form'} — {TYPE_LABELS[type] || type}</h1>
        <button className="btn btn-sm" onClick={() => navigate(isNew ? '/forms' : `/forms/${id}`)}>Cancel</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="field-row">
          <div className="field">
            <label>Department</label>
            {/* A free-typed department would not match the ones the rest of the system knows, so
                this is the same list -- with the typed value kept if an older form carries one. */}
            <select value={form.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">—</option>
              {form.department && !departments.includes(form.department) && (
                <option value={form.department}>{form.department}</option>
              )}
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Name</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Whose form this is" />
          </div>
        </div>
      </div>

      {isFund && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{type === 'liquidation' ? 'Liquidation' : 'Revolving Fund'}</h3>
          <div className="field-row">
            <div className="field">
              <label>Week No.</label>
              <input value={form.week_no} onChange={(e) => set('week_no', e.target.value)} />
            </div>
            {type === 'liquidation' && (
              <div className="field">
                <label>Form No.</label>
                <input value={form.form_no} onChange={(e) => set('form_no', e.target.value)} placeholder="The serial printed on the pad" />
              </div>
            )}
          </div>
          <div className="field-row">
            <div className="field">
              <label>Date From</label>
              <input type="date" value={form.date_from} onChange={(e) => set('date_from', e.target.value)} />
            </div>
            <div className="field">
              <label>Date To</label>
              <input type="date" value={form.date_to} onChange={(e) => set('date_to', e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Cash Advance Amount</label>
              <input type="number" step="0.01" value={form.cash_advance_amount} onChange={(e) => set('cash_advance_amount', e.target.value)} />
            </div>
            <div className="field">
              <label>Cash Advance Date</label>
              <input type="date" value={form.cash_advance_date} onChange={(e) => set('cash_advance_date', e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Previous Balance</label>
              <input type="number" step="0.01" value={form.previous_balance} onChange={(e) => set('previous_balance', e.target.value)} />
            </div>
            <div className="field">
              <label>Starting Balance</label>
              <input type="number" step="0.01" value={form.starting_balance} onChange={(e) => set('starting_balance', e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {type === 'liquidation' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Purpose</h3>
          <div className="filter-grid">
            {Object.entries(PURPOSE_LABELS).map(([k, label]) => (
              <div className="field-checkbox" key={k}>
                <input type="checkbox" id={`purpose-${k}`} checked={form.purposes.includes(k)} onChange={() => togglePurpose(k)} />
                <label htmlFor={`purpose-${k}`}>{label}</label>
              </div>
            ))}
          </div>
          {form.purposes.includes('others') && (
            <div className="field" style={{ marginTop: 10 }}>
              <label>If Others, specify</label>
              <input value={form.purpose_other_text} onChange={(e) => set('purpose_other_text', e.target.value)} />
            </div>
          )}
        </div>
      )}

      {type === 'payment' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Request for Payment</h3>
          <div className="field-row">
            <div className="field">
              <label>Payable To *</label>
              <input value={form.payable_to} onChange={(e) => set('payable_to', e.target.value)} />
            </div>
            <div className="field">
              <label>Date</label>
              <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Address</label>
            <input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </div>
        </div>
      )}

      {type === 'business_trip' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Business Trip</h3>
          <div className="field-row">
            <div className="field">
              <label>Driver Name *</label>
              <input value={form.driver_name} onChange={(e) => set('driver_name', e.target.value)} />
            </div>
            <div className="field">
              <label>Vehicle Plate No. *</label>
              <input value={form.vehicle_plate_no} onChange={(e) => set('vehicle_plate_no', e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Trip Date *</label>
              <input type="date" value={form.trip_date} onChange={(e) => set('trip_date', e.target.value)} />
            </div>
            <div className="field">
              <label>Total Mileage (km)</label>
              <input type="number" step="0.01" value={form.total_mileage_km} onChange={(e) => set('total_mileage_km', e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Speedometer Begin</label>
              <input value={form.speedometer_begin} onChange={(e) => set('speedometer_begin', e.target.value)} />
            </div>
            <div className="field">
              <label>Speedometer End</label>
              <input value={form.speedometer_end} onChange={(e) => set('speedometer_end', e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Time Out</label>
              <input type="time" value={form.time_out} onChange={(e) => set('time_out', e.target.value)} />
            </div>
            <div className="field">
              <label>Time In</label>
              <input type="time" value={form.time_in} onChange={(e) => set('time_in', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Purpose of Trip</label>
            <textarea rows={3} value={form.purpose} onChange={(e) => set('purpose', e.target.value)} />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Checked By</label>
              <input value={form.checked_by} onChange={(e) => set('checked_by', e.target.value)} />
            </div>
            <div className="field">
              <label>Noted By</label>
              <input value={form.noted_by} onChange={(e) => set('noted_by', e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {hasItems && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{type === 'payment' ? 'Particulars' : 'Expenses'}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {isFund && <th style={{ width: 160 }}>Date</th>}
                  <th>Particulars</th>
                  <th style={{ width: 160 }}>Amount</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={i}>
                    {isFund && (
                      <td><input type="date" value={r.date} onChange={(e) => setRow(i, 'date', e.target.value)} /></td>
                    )}
                    <td>
                      <input value={r.particulars} onChange={(e) => setRow(i, 'particulars', e.target.value)} />
                      {/* The approver's remark against THIS line, kept visible while it is being
                          fixed -- that is the whole reason rejection is per line. */}
                      {r.rejection_remark && (
                        <div className="muted" style={{ color: 'var(--danger, #b91c1c)', fontSize: 12, marginTop: 4 }}>
                          Returned: {r.rejection_remark}
                        </div>
                      )}
                    </td>
                    <td><input type="number" step="0.01" value={r.amount} onChange={(e) => setRow(i, 'amount', e.target.value)} /></td>
                    <td>
                      <button type="button" className="btn btn-sm btn-danger" disabled={items.length === 1} onClick={() => removeRow(i)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={addRow}>Add Line</button>

          <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)', marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="muted">{type === 'payment' ? 'Total Amount' : 'Reimbursement Amount'}</span>
              <span className="hi">{money(itemsTotal)}</span>
            </div>
            {isFund && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span>Ending Balance</span><span>{money(endingBalance)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="modal-actions" style={{ marginTop: 16 }}>
        <button className="btn" onClick={() => navigate(isNew ? '/forms' : `/forms/${id}`)}>Cancel</button>
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
