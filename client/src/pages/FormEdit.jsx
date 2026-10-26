import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/useAuth';
import {
  ADJ_REASON_LABELS, ADJ_TIMES, DAY_PART_LABELS, MEMBER_FORMS, blankMemberLine, FUND_TYPES, HR_TYPES, LEAVE_TYPE_LABELS, NO_ITEM_TYPES, PAYMENT_TYPES,
  PURPOSE_LABELS, TYPE_LABELS, hoursMinutes, leaveDays, money, overtimeHours, undertimeMinutes,
} from '../utils/requestForms';
import EntityPicker from '../components/EntityPicker';

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
// One line of the Office Supply Requisition, HR's sheet columns (2026-10-26).
const blankOsItem = () => ({ particulars: '', brand: '', quantity: '', unit: '', remarks: '', accountable: '', last_purchase_date: '', purpose: '' });

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
    payable_to: '', address: '', date: '', from_account_id: '', to_account_id: '',
    driver_name: '', vehicle_plate_no: '', speedometer_begin: '', speedometer_end: '',
    total_mileage_km: '', trip_date: '', time_out: '', time_in: '', purpose: '',
    checked_by: '', noted_by: '',
    adjustment_date: '', am_in: '', am_out: '', pm_in: '', pm_out: '', ot_in: '', ot_out: '',
    reason: '', reason_other: '',
    // Overtime Request (2026-10-13)
    ot_for_self: false, ot_target_user_id: '', ot_date: '', ot_time_from: '', ot_time_to: '', ot_purpose: '', ot_reference_no: '',
    // Leave Application (2026-10-13)
    leave_type: '', leave_type_other: '', leave_date_from: '', leave_date_to: '', leave_day_part: 'whole', leave_reason: '', leave_contact: '',
    // Undertime Form (2026-10-20)
    ut_date: '', ut_shift_end: '', ut_time_out: '', ut_reason: '',
    // Employee Gate Pass (2026-10-14)
    gp_location_id: '', gp_date: '', gp_destination: '', gp_purpose: '',
    // Office Supply Requisition Form (2026-10-23)
    os_month: '',
    // HR member lists (2026-10-19)
    enrollment_for: 'HEALTH INSURANCE', letter_date: '',
    // Fuel Request (2026-10-19)
    fuel_date: isNew ? new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) : '', fuel_vehicle_asset_id: '', fuel_vehicle_label: '',
    fuel_liters: '', fuel_price_per_liter: '', fuel_amount: '', fuel_odometer_km: '', fuel_station: '', fuel_purpose: '',
    remarks: '',
    // Who approves (required, the General Manager by default) and who notes (optional) -- 2026-10-22.
    approver_user_id: '', noter_user_id: '',
  });
  const [memberLines, setMemberLines] = useState([]);
  // Fuel Request: the Fleet vehicles, and this user's monthly limit and what is left (GET /forms/meta/fuel).
  const [fuelMeta, setFuelMeta] = useState({ vehicles: [], usage: null });
  useEffect(() => {
    if (type !== 'fuel') return;
    api.get('/forms/meta/fuel', { params: { date: form.fuel_date || undefined, exclude: id || undefined } })
      .then(({ data }) => setFuelMeta(data)).catch(() => {});
  }, [type, form.fuel_date, id]);
  // Employee Gate Pass items: what is carried out, and the department it belongs to.
  const [gpItems, setGpItems] = useState([{ description: '', department: '' }]);
  const [osItems, setOsItems] = useState([blankOsItem()]);
  const [locations, setLocations] = useState([]);
  const [otPeople, setOtPeople] = useState([]);
  const [items, setItems] = useState([blankItem()]);
  const [departments, setDepartments] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api.get('/forms/meta/options')
      .then(({ data }) => {
        setDepartments(data.departments || []); setBankAccounts(data.bank_accounts || []); setOtPeople(data.ot_people || []); setLocations(data.locations || []);
        // A new form's approver starts as the General Manager.
        if (isNew && data.default_approver_id) setForm((f) => (f.approver_user_id ? f : { ...f, approver_user_id: String(data.default_approver_id) }));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => api.get(`/forms/${id}`).then(({ data }) => {
    setType(data.type);
    const d = data.detail || {};
    setForm({
      department: data.department || '', name: data.name || '', remarks: data.remarks || '',
      approver_user_id: data.approver_user_id ? String(data.approver_user_id) : '', noter_user_id: data.noter_user_id ? String(data.noter_user_id) : '',
      week_no: d.week_no || '', form_no: d.form_no || '',
      date_from: d.date_from ? String(d.date_from).slice(0, 10) : '',
      date_to: d.date_to ? String(d.date_to).slice(0, 10) : '',
      cash_advance_amount: d.cash_advance_amount ?? '',
      cash_advance_date: d.cash_advance_date ? String(d.cash_advance_date).slice(0, 10) : '',
      previous_balance: d.previous_balance ?? '', starting_balance: d.starting_balance ?? '',
      purposes: (data.purposes || []).map((p) => p.purpose),
      purpose_other_text: (data.purposes || []).find((p) => p.purpose === 'others')?.other_text || '',
      payable_to: d.payable_to || '', address: d.address || '',
      from_account_id: d.from_account_id || '', to_account_id: d.to_account_id || '',
      date: d.doc_date ? String(d.doc_date).slice(0, 10) : '',
      driver_name: d.driver_name || '', vehicle_plate_no: d.vehicle_plate_no || '',
      speedometer_begin: d.speedometer_begin || '', speedometer_end: d.speedometer_end || '',
      total_mileage_km: d.total_mileage_km ?? '',
      trip_date: d.trip_date ? String(d.trip_date).slice(0, 10) : '',
      time_out: d.time_out ? String(d.time_out).slice(0, 5) : '',
      time_in: d.time_in ? String(d.time_in).slice(0, 5) : '',
      purpose: d.purpose || '', checked_by: d.checked_by || '', noted_by: d.noted_by_name || '',
      adjustment_date: d.adjustment_date ? String(d.adjustment_date).slice(0, 10) : '',
      ...Object.fromEntries(ADJ_TIMES.map(([k]) => [k, d[k] ? String(d[k]).slice(0, 5) : ''])),
      reason: d.reason || '', reason_other: d.reason_other || '',
      ot_for_self: !!Number(d.for_self || 0), ot_target_user_id: d.target_user_id || '',
      ot_date: d.ot_date ? String(d.ot_date).slice(0, 10) : '',
      ot_time_from: d.time_from ? String(d.time_from).slice(0, 5) : '', ot_time_to: d.time_to ? String(d.time_to).slice(0, 5) : '',
      ot_purpose: data.type === 'overtime' ? (d.purpose || '') : '', ot_reference_no: d.reference_no || '',
      leave_type: d.leave_type || '', leave_type_other: d.leave_type_other || '',
      leave_date_from: data.type === 'leave' && d.date_from ? String(d.date_from).slice(0, 10) : '',
      leave_date_to: data.type === 'leave' && d.date_to ? String(d.date_to).slice(0, 10) : '',
      leave_day_part: d.day_part || 'whole', leave_reason: data.type === 'leave' ? (d.reason || '') : '',
      leave_contact: d.contact_while_on_leave || '',
      ...(data.type === 'undertime' ? {
        ut_date: d.ut_date ? String(d.ut_date).slice(0, 10) : '',
        ut_shift_end: d.shift_end ? String(d.shift_end).slice(0, 5) : '',
        ut_time_out: d.time_out ? String(d.time_out).slice(0, 5) : '',
        ut_reason: d.reason || '',
      } : {}),
      gp_location_id: data.type === 'gate_pass' ? (d.location_id || '') : '',
      gp_date: data.type === 'gate_pass' && d.pass_date ? String(d.pass_date).slice(0, 10) : '',
      gp_destination: d.destination || '', gp_purpose: data.type === 'gate_pass' ? (d.purpose || '') : '',
      ...(data.type === 'fuel' ? {
        fuel_date: d.fuel_date ? String(d.fuel_date).slice(0, 10) : '', fuel_vehicle_asset_id: d.vehicle_asset_id || '',
        fuel_vehicle_label: d.vehicle_label || '', fuel_liters: d.liters ?? '', fuel_price_per_liter: d.price_per_liter ?? '',
        fuel_amount: d.amount ?? '', fuel_odometer_km: d.odometer_km ?? '', fuel_station: d.station || '', fuel_purpose: d.purpose || '',
      } : {}),
    });
    if (MEMBER_FORMS[data.type]) {
      setForm((f) => ({ ...f, enrollment_for: d.enrollment_for || 'HEALTH INSURANCE', letter_date: d.letter_date ? String(d.letter_date).slice(0, 10) : '' }));
      setMemberLines((d.lines || []).length
        ? d.lines.map((l) => Object.fromEntries(MEMBER_FORMS[data.type].columns.map((c) => [c.key, c.type === 'date' && l[c.key] ? String(l[c.key]).slice(0, 10) : (l[c.key] ?? '')])))
        : [blankMemberLine(data.type)]);
    }
    if (data.type === 'office_supply') {
      setForm((f) => ({ ...f, os_month: d.osr_date ? String(d.osr_date).slice(0, 7) : '' }));
      setOsItems((d.items || []).length
        ? d.items.map((it) => ({
          ...blankOsItem(),
          ...Object.fromEntries(Object.keys(blankOsItem()).map((k) => [k, it[k] == null ? '' : String(it[k])])),
          quantity: it.quantity == null ? '' : Number(it.quantity),
          last_purchase_date: it.last_purchase_date ? String(it.last_purchase_date).slice(0, 10) : '',
        }))
        : [blankOsItem()]);
    }
    if (data.type === 'gate_pass') {
      setGpItems((d.items || []).length ? d.items.map((it) => ({ description: it.description || '', department: it.department || '' })) : [{ description: '', department: '' }]);
    }
    setItems((data.items || []).length
      ? data.items.map((i) => ({
        date: i.item_date ? String(i.item_date).slice(0, 10) : '',
        particulars: i.particulars || '',
        amount: i.amount ?? '',
        rejection_remark: i.rejection_remark || '',
        // A form from before lines had banks shows the form's one From / To on each line.
        from_account_id: i.from_account_id || d.from_account_id || '',
        to_account_id: i.to_account_id || d.to_account_id || '',
      }))
      : [blankItem()]);
    setLoading(false);
  }), [id]);

  useEffect(() => {
    if (isNew) return;
    load().catch((e) => { setError(e.response?.data?.error || 'Could not load this form.'); setLoading(false); });
  }, [isNew, load]);

  const isFund = FUND_TYPES.includes(type);
  const hasItems = type && !NO_ITEM_TYPES.includes(type);
  const itemsTotal = items.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  // Shown live while typing, because the printed form carries these two and somebody filling it in
  // wants to see the balance land where they expect before they commit to it.
  const endingBalance = (Number(form.starting_balance) || 0) - itemsTotal;

  // A new Fund Transfer line starts from the bank the line above takes from.
  function addRow() { setItems((rows) => [...rows, { ...blankItem(), from_account_id: rows[rows.length - 1]?.from_account_id || '' }]); }
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
      gp_items: type === 'gate_pass' ? gpItems.filter((r) => String(r.description || '').trim()) : undefined,
      os_items: type === 'office_supply' ? osItems.filter((r) => String(r.particulars || '').trim() || r.quantity !== '') : undefined,
      member_lines: MEMBER_FORMS[type] ? memberLines : undefined,
      items: hasItems
        ? items.filter((r) => r.particulars || r.amount).map((r) => ({
          date: r.date, particulars: r.particulars, amount: r.amount, from_account_id: r.from_account_id || null, to_account_id: r.to_account_id || null,
        }))
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
          <Link className="btn btn-sm" to={'/forms'}>Back</Link>
        </div>
        <div className="card">
          <p className="muted">Which form is this?</p>
          {/* HR forms on their own row (2026-10-13), the money forms on another. */}
          {[['HR', Object.entries(TYPE_LABELS).filter(([k]) => HR_TYPES.includes(k))],
            ['Finance', Object.entries(TYPE_LABELS).filter(([k]) => !HR_TYPES.includes(k))]].map(([group, list]) => (
            <div key={group} style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{group}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {list.map(([k, label]) => (
                  <button key={k} className="btn btn-primary" onClick={() => setType(k)}>{label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Fill Out a Form' : 'Edit Form'} — {TYPE_LABELS[type] || type}</h1>
        <Link className="btn btn-sm" to={isNew ? '/forms' : `/forms/${id}`}>Cancel</Link>
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

      {PAYMENT_TYPES.includes(type) && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{TYPE_LABELS[type]}</h3>
          {/* Fund Transfer Request Form (2026-10-13): each Particulars line has its own From and To bank,
              so one form can move money from one bank to several, or from several into one. */}
          {type === 'fund_transfer' && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Choose the From and To bank on each line below. Bank 1 to Banks 2 and 3: two lines, both From Bank 1.
              Banks 1 and 2 to Bank 3: two lines, both To Bank 3.
            </div>
          )}
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

      {type === 'overtime' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Overtime Request</h3>
          <div className="field">
            <label>Overtime for *</label>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                <input type="radio" name="ot-for" checked={form.ot_for_self} onChange={() => set('ot_for_self', true)} /> Myself
              </label>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                <input type="radio" name="ot-for" checked={!form.ot_for_self} onChange={() => set('ot_for_self', false)} /> Someone else
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {form.ot_for_self
                ? 'Goes to your department head for approval.'
                : "Noted by your department head, approved by the employee's department head, then accepted or declined by the employee."}
            </div>
          </div>
          {!form.ot_for_self && (
            <div className="field" style={{ maxWidth: 480 }}>
              <label>Employee *</label>
              <EntityPicker
                label="Employee" items={otPeople} value={form.ot_target_user_id} getLabel={(p) => `${p.name}${p.department ? ` (${p.department})` : ''}`}
                columns={[{ key: 'name', label: 'Name' }, { key: 'department', label: 'Department' }]} searchKeys={['name', 'department']}
                onSelect={(p) => set('ot_target_user_id', p ? p.id : '')}
              />
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0 16px' }}>
            <div className="field">
              <label>Date *</label>
              <input type="date" value={form.ot_date} onChange={(e) => set('ot_date', e.target.value)} />
            </div>
            <div className="field">
              <label>From *</label>
              <input type="time" value={form.ot_time_from} onChange={(e) => set('ot_time_from', e.target.value)} />
            </div>
            <div className="field">
              <label>To *</label>
              <input type="time" value={form.ot_time_to} onChange={(e) => set('ot_time_to', e.target.value)} />
            </div>
            <div className="field">
              <label>Hours</label>
              <input disabled value={overtimeHours(form.ot_time_from, form.ot_time_to) ?? ''} />
            </div>
          </div>
          <div className="field">
            <label>Purpose / work to be done *</label>
            <textarea rows={3} value={form.ot_purpose} onChange={(e) => set('ot_purpose', e.target.value)} />
          </div>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Reference (JO / SO #)</label>
            <input value={form.ot_reference_no} onChange={(e) => set('ot_reference_no', e.target.value)} />
          </div>
        </div>
      )}

      {MEMBER_FORMS[type] && (() => {
        const cfg = MEMBER_FORMS[type];
        const lines = memberLines.length ? memberLines : [blankMemberLine(type)];
        const setLine = (i, k, v) => setMemberLines(() => lines.map((r, ri) => (ri === i ? { ...r, [k]: v } : r)));
        return (
          <div className="card" style={{ marginTop: 16 }}>
            <h3>{cfg.title}</h3>
            {type === 'hmo_enrollment' && (
              <div className="field" style={{ maxWidth: 360 }}>
                <label>Enrollment For</label>
                <input value={form.enrollment_for} onChange={(e) => set('enrollment_for', e.target.value)} />
              </div>
            )}
            {type === 'bpi_deletion' && (
              <>
                <div className="field" style={{ maxWidth: 220 }}>
                  <label>Date</label>
                  <input type="date" value={form.letter_date} onChange={(e) => set('letter_date', e.target.value)} />
                </div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  To BPI GF Insular Mall, Basak, Mandaue City: please delete from the payroll list under Cebu Graphicstar Imaging Corp. the following separated employees.
                </div>
              </>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th style={{ width: 36 }}>#</th>{cfg.columns.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}<th style={{ width: 40 }} /></tr>
                </thead>
                <tbody>
                  {lines.map((r, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      {cfg.columns.map((c) => (
                        <td key={c.key}>
                          {c.type === 'select' ? (
                            <select value={r[c.key] || ''} onChange={(e) => setLine(i, c.key, e.target.value)}>
                              <option value="">—</option>
                              {c.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          ) : (
                            <input type={c.type === 'date' ? 'date' : 'text'} value={r[c.key] || ''} placeholder={c.placeholder || ''}
                              onChange={(e) => setLine(i, c.key, e.target.value)} />
                          )}
                        </td>
                      ))}
                      <td>
                        <button type="button" className="btn btn-sm btn-danger" title="Remove"
                          onClick={() => setMemberLines(lines.length > 1 ? lines.filter((_, ri) => ri !== i) : [blankMemberLine(type)])}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-sm" style={{ marginTop: 8 }}
              onClick={() => setMemberLines([...lines, blankMemberLine(type)])}>{cfg.addLabel}</button>
          </div>
        );
      })()}

      {/* Office Supply Requisition Form (asked 2026-10-23), laid out as HR's sheet since 2026-10-26:
          the MONTH, then OFFICE SUPPLIES / BRAND / QUANTITY (+ unit) / REMARKS / ACCOUNTABLE /
          DATE OF LAST PURCHASE / PURPOSE. Department above is the requesting department. */}
      {type === 'office_supply' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Office Supplies Requisition</h3>
          <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
            Department above is the requesting department. Noted by the Department Head, then released by HR.
          </div>
          <div className="field-row">
            <div className="field" style={{ maxWidth: 260 }}>
              <label>Month *</label>
              <input type="month" value={form.os_month} onChange={(e) => set('os_month', e.target.value)} />
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }}>#</th>
                  <th style={{ minWidth: 200 }}>Office Supplies *</th>
                  <th style={{ minWidth: 110 }}>Brand</th>
                  <th style={{ width: 90 }}>Quantity *</th>
                  <th style={{ width: 90 }}>Unit</th>
                  <th style={{ minWidth: 110 }}>Remarks</th>
                  <th style={{ minWidth: 110 }}>Accountable</th>
                  <th style={{ width: 150 }}>Date of Last Purchase</th>
                  <th style={{ minWidth: 140 }}>Purpose</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {osItems.map((r, i) => {
                  const setOs = (k) => (e) => setOsItems((rs) => rs.map((x, xi) => (xi === i ? { ...x, [k]: e.target.value } : x)));
                  return (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td><input value={r.particulars} placeholder="e.g. Correction tape wiper" onChange={setOs('particulars')} /></td>
                      <td><input value={r.brand} onChange={setOs('brand')} /></td>
                      <td><input type="number" min="0" step="any" value={r.quantity} onChange={setOs('quantity')} /></td>
                      <td><input value={r.unit} placeholder="PCS, BOX" onChange={setOs('unit')} /></td>
                      <td><input value={r.remarks} placeholder="e.g. Short" onChange={setOs('remarks')} /></td>
                      <td><input value={r.accountable} placeholder="e.g. HR" onChange={setOs('accountable')} /></td>
                      <td><input type="date" value={r.last_purchase_date} onChange={setOs('last_purchase_date')} /></td>
                      <td><input value={r.purpose} placeholder="e.g. Replacement" onChange={setOs('purpose')} /></td>
                      <td>
                        <button type="button" className="btn btn-sm btn-danger" title="Remove"
                          onClick={() => setOsItems((rs) => (rs.length > 1 ? rs.filter((_, xi) => xi !== i) : [blankOsItem()]))}>×</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 8 }}
            onClick={() => setOsItems((rs) => [...rs, blankOsItem()])}>Add Item</button>
        </div>
      )}

      {type === 'gate_pass' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Employee Gate Pass</h3>
          <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
            Name and Department above are the personnel going out. Approved by their Department Head, noted by HR,
            then checked and released by the security guard on duty.
          </div>
          <div className="field-row">
            <div className="field">
              <label>Location</label>
              <select value={form.gp_location_id} onChange={(e) => set('gp_location_id', e.target.value)}>
                <option value="">—</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Date * <span className="muted" style={{ fontWeight: 400 }}>(valid only on this date)</span></label>
              <input type="date" value={form.gp_date} onChange={(e) => set('gp_date', e.target.value)} />
            </div>
            <div className="field">
              <label>Destination *</label>
              <input value={form.gp_destination} onChange={(e) => set('gp_destination', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Purpose *</label>
            <textarea rows={2} value={form.gp_purpose} onChange={(e) => set('gp_purpose', e.target.value)} />
          </div>
          <h4 style={{ margin: '14px 0 6px' }}>Items</h4>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>All items should be listed and noted by the department concerned.</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 40 }}>#</th><th>Description</th><th>Department</th><th style={{ width: 40 }}></th></tr></thead>
              <tbody>
                {gpItems.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td><input value={r.description} placeholder="e.g. Laptop (Dell, SN 12345)"
                      onChange={(e) => setGpItems((rs) => rs.map((x, xi) => (xi === i ? { ...x, description: e.target.value } : x)))} /></td>
                    <td>
                      <select value={r.department} onChange={(e) => setGpItems((rs) => rs.map((x, xi) => (xi === i ? { ...x, department: e.target.value } : x)))}>
                        <option value="">—</option>
                        {r.department && !departments.includes(r.department) && <option value={r.department}>{r.department}</option>}
                        {departments.map((dp) => <option key={dp} value={dp}>{dp}</option>)}
                      </select>
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm btn-danger" title="Remove"
                        onClick={() => setGpItems((rs) => (rs.length > 1 ? rs.filter((_, xi) => xi !== i) : [{ description: '', department: '' }]))}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 8 }}
            onClick={() => setGpItems((rs) => [...rs, { description: '', department: form.department || '' }])}>Add Item</button>
        </div>
      )}

      {type === 'fuel' && (() => {
        const u = fuelMeta.usage;
        const liters = Number(form.fuel_liters) || 0;
        const over = u?.has_limit && liters > (u.remaining ?? 0) + 0.0005;
        const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Fuel</h3>
            {u?.has_limit && (
              <div className={over ? 'error-banner' : 'muted'} style={{ marginBottom: 10 }}>
                Your fuel limit: <strong>{u.limit} L</strong> a month · {u.month}: {u.used} L requested, <strong>{u.remaining} L left</strong>.
                {over && ' This request is more than what is left -- it cannot be submitted.'}
              </div>
            )}
            <div className="filter-grid">
              <div className="field"><label>Date *</label><input type="date" value={form.fuel_date} onChange={set('fuel_date')} /></div>
              <div className="field"><label>Vehicle *</label>
                <select value={form.fuel_vehicle_asset_id} onChange={(e) => setForm({ ...form, fuel_vehicle_asset_id: e.target.value })}>
                  <option value="">-- Other (type it below) --</option>
                  {fuelMeta.vehicles.map((v) => <option key={v.asset_id} value={v.asset_id}>{[v.plate_no, [v.brand, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || v.reference_no}</option>)}
                </select>
              </div>
              {!form.fuel_vehicle_asset_id && (
                <div className="field"><label>Vehicle (if not listed)</label><input value={form.fuel_vehicle_label} onChange={set('fuel_vehicle_label')} placeholder="Plate no. / description" /></div>
              )}
              <div className="field"><label>Litres *</label><input type="number" step="0.001" min="0" value={form.fuel_liters} onChange={set('fuel_liters')} /></div>
              <div className="field"><label>Odometer (km)</label><input type="number" step="any" min="0" value={form.fuel_odometer_km} onChange={set('fuel_odometer_km')} /></div>
              <div className="field"><label>Station</label><input value={form.fuel_station} onChange={set('fuel_station')} /></div>
            </div>
            <div className="field"><label>Purpose *</label><textarea rows={2} value={form.fuel_purpose} onChange={set('fuel_purpose')} placeholder="What the fuel is for (delivery, installation, site visit ...)" /></div>
            <div className="muted" style={{ fontSize: 12 }}>Goes straight to the Fuel Approver once submitted. Once approved, a request for a listed vehicle is added to that vehicle's fuel log (Assets &gt; Fleet).</div>
          </div>
        );
      })()}

      {type === 'leave' && (() => {
        const oneDay = form.leave_date_from && (!form.leave_date_to || form.leave_date_to === form.leave_date_from);
        const days = leaveDays(form.leave_date_from, form.leave_date_to, oneDay ? form.leave_day_part : 'whole');
        return (
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Leave Application</h3>
            <div className="field">
              <label>Type of Leave *</label>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                {Object.entries(LEAVE_TYPE_LABELS).map(([k, label]) => (
                  <label key={k} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                    <input type="radio" name="leave-type" checked={form.leave_type === k} onChange={() => set('leave_type', k)} /> {label}
                  </label>
                ))}
              </div>
            </div>
            {form.leave_type === 'others' && (
              <div className="field">
                <label>Others, specify *</label>
                <input value={form.leave_type_other} placeholder="e.g. Service Incentive Leave" onChange={(e) => set('leave_type_other', e.target.value)} />
              </div>
            )}
            <div className="field-row">
              <div className="field">
                <label>From *</label>
                <input type="date" value={form.leave_date_from} onChange={(e) => set('leave_date_from', e.target.value)} />
              </div>
              <div className="field">
                <label>To</label>
                <input type="date" value={form.leave_date_to} min={form.leave_date_from || undefined}
                  onChange={(e) => set('leave_date_to', e.target.value)} />
              </div>
              {oneDay && (
                <div className="field">
                  <label>Whole / Half day</label>
                  <select value={form.leave_day_part} onChange={(e) => set('leave_day_part', e.target.value)}>
                    {Object.entries(DAY_PART_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>No. of Days</label>
                <input value={form.leave_date_from ? days : ''} readOnly />
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
              Sundays are not counted. Leave To empty for a single day.
              {form.leave_type === 'sick' && days > 2 ? ' For more than 2 days of sick leave, attach a medical certificate on the form after saving it.' : ''}
            </div>
            <div className="field">
              <label>Reason *</label>
              <textarea rows={3} value={form.leave_reason} onChange={(e) => set('leave_reason', e.target.value)} />
            </div>
            <div className="field">
              <label>Contact number while on leave</label>
              <input value={form.leave_contact} onChange={(e) => set('leave_contact', e.target.value)} />
            </div>
          </div>
        );
      })()}

      {type === 'undertime' && (() => {
        const mins = undertimeMinutes(form.ut_time_out, form.ut_shift_end);
        return (
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Undertime Form</h3>
            <div className="field-row">
              <div className="field">
                <label>Date *</label>
                <input type="date" value={form.ut_date} onChange={(e) => set('ut_date', e.target.value)} />
              </div>
              <div className="field">
                <label>Scheduled Time Out *</label>
                <input type="time" value={form.ut_shift_end} onChange={(e) => set('ut_shift_end', e.target.value)} />
              </div>
              <div className="field">
                <label>Time Out (leaving at) *</label>
                <input type="time" value={form.ut_time_out} onChange={(e) => set('ut_time_out', e.target.value)} />
              </div>
              <div className="field">
                <label>Undertime</label>
                <input value={mins == null ? '' : mins > 0 ? hoursMinutes(mins) : '—'} readOnly />
              </div>
            </div>
            {mins != null && mins <= 0 && (
              <div className="error" style={{ marginTop: -6, marginBottom: 10 }}>The time you leave has to be before your scheduled time out.</div>
            )}
            <div className="field">
              <label>Reason *</label>
              <textarea rows={3} value={form.ut_reason} onChange={(e) => set('ut_reason', e.target.value)} />
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Goes to your supervisor and approver the same way a Leave Application does.
            </div>
          </div>
        );
      })()}

      {type === 'attendance_adjustment' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Attendance Adjustment</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            For a day the biometric has no record of your time in or out. Fill in only the times you are claiming.
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label>Date *</label>
            <input type="date" value={form.adjustment_date} onChange={(e) => set('adjustment_date', e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0 16px' }}>
            {ADJ_TIMES.map(([k, label]) => (
              <div className="field" key={k}>
                <label>{label}</label>
                <input type="time" value={form[k]} onChange={(e) => set(k, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="field">
            <label>Reason *</label>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              {Object.entries(ADJ_REASON_LABELS).map(([k, label]) => (
                <label key={k} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                  <input type="radio" name="adj-reason" checked={form.reason === k} onChange={() => set('reason', k)} /> {label}
                </label>
              ))}
            </div>
          </div>
          {form.reason === 'others' && (
            <div className="field">
              <label>Others, specify *</label>
              <input value={form.reason_other} placeholder="e.g. Biometric error" onChange={(e) => set('reason_other', e.target.value)} />
            </div>
          )}
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
          <h3>{PAYMENT_TYPES.includes(type) ? 'Particulars' : 'Expenses'}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {isFund && <th style={{ width: 160 }}>Date</th>}
                  {type === 'fund_transfer' && <th style={{ width: '24%' }}>From *</th>}
                  {type === 'fund_transfer' && <th style={{ width: '24%' }}>To *</th>}
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
                    {type === 'fund_transfer' && ['from_account_id', 'to_account_id'].map((k) => (
                      <td key={k}>
                        <EntityPicker
                          label={k === 'from_account_id' ? 'From (Bank)' : 'To (Bank)'}
                          items={bankAccounts.filter((a) => String(a.id) !== String(r[k === 'from_account_id' ? 'to_account_id' : 'from_account_id']))}
                          value={r[k]}
                          getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                          columns={[{ key: 'bank_name', label: 'Bank' }, { key: 'account_name', label: 'Account' }, { key: 'account_code', label: 'Code' }]}
                          searchKeys={['bank_name', 'account_name', 'account_code']}
                          onSelect={(a) => setRow(i, k, a.id)} onClear={() => setRow(i, k, '')}
                        />
                      </td>
                    ))}
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
              <span className="muted">{PAYMENT_TYPES.includes(type) ? 'Total Amount' : 'Reimbursement Amount'}</span>
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

      {/* Who notes and who approves this form (2026-10-22): the requestor's choice, on every form type. */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Approval</h3>
        <div className="field-row">
          <div className="field">
            <label>Noter</label>
            <select value={form.noter_user_id} onChange={(e) => set('noter_user_id', e.target.value)}>
              <option value="">— None (goes straight to approval) —</option>
              {otPeople.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` — ${p.department}` : ''}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Approver *</label>
            <select value={form.approver_user_id} onChange={(e) => set('approver_user_id', e.target.value)}>
              <option value="">— Choose —</option>
              {otPeople.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` — ${p.department}` : ''}</option>)}
            </select>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {form.noter_user_id ? 'Once submitted it goes to the noter, then to the approver.' : 'No noter: once submitted it goes straight to the approver.'}
        </div>
      </div>

      {/* The filer's own note on the request, on every form type -- shown on the form and printed. */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="field">
          <label>Remarks</label>
          <textarea rows={3} maxLength={2000} value={form.remarks} onChange={(e) => set('remarks', e.target.value)}
            placeholder="Anything the approvers should know about this request" />
        </div>
      </div>

      <div className="modal-actions" style={{ marginTop: 16 }}>
        <Link className="btn" to={isNew ? '/forms' : `/forms/${id}`}>Cancel</Link>
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
