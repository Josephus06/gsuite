import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

const STEPS = ['Customer and Non Standard SO', 'Job Orders', 'Billing', 'Completed'];
const TYPES = [
  { value: 'rma', label: 'RMA' },
  { value: 'rma_installation', label: 'RMA - Installation' },
  { value: 'sample', label: 'Sample' },
  { value: 'internal', label: 'Internal' },
];
const nestsToSalesOrder = (t) => t === 'rma' || t === 'rma_installation';
const nestsToEstimate = (t) => t === 'sample';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function today() { return new Date().toISOString().slice(0, 10); }

const EMPTY_HEADER = {
  type: '', date_created: today(), customer_id: '', contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '',
  sales_rep_id: '', sales_division_id: '', office_location_id: '', contract_description: '', memo: '', shipping_address: '',
  nested_sales_order_id: '', nested_estimate_id: '', production_lead_time: '',
  print_warranty: 0, structure_warranty: 0, electrical_warranty: 0,
};

// Create/edit wizard for a Non-Standard Sales Order, mirroring the Estimate wizard's 4-step,
// save-as-you-go flow. This build wires the RMA type end to end (nest to a Sales Order with a
// Completed job order, then pull those job orders in as the NSSO's lines).
export default function NonStandardSalesOrderWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [nssoId, setNssoId] = useState(id || null);
  const [step, setStep] = useState(1);
  const [header, setHeader] = useState(EMPTY_HEADER);
  const [meta, setMeta] = useState(null);
  const [nestableSos, setNestableSos] = useState([]);
  const [sourceJos, setSourceJos] = useState([]);
  const [selectedJos, setSelectedJos] = useState({});
  const [nestableEstimates, setNestableEstimates] = useState([]);
  const [sourceEjos, setSourceEjos] = useState([]);
  const [selectedEjos, setSelectedEjos] = useState({});
  const [lines, setLines] = useState([]);
  const [billing, setBilling] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const savedRef = useRef(false);

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));

  useEffect(() => {
    (async () => {
      const { data } = await api.get('/non-standard-sales-orders/meta');
      setMeta(data);
      if (id) {
        const { data: n } = await api.get(`/non-standard-sales-orders/${id}`);
        setHeader({ ...EMPTY_HEADER, ...n, date_created: String(n.date_created).slice(0, 10) });
        setLines(n.lines || []);
        setStep(2);
      } else if (data.defaults) {
        // Autofill Sales Rep / Sales Division / Office Location from the logged-in user.
        setHeader((h) => ({
          ...h,
          sales_rep_id: data.defaults.sales_rep_id || '',
          sales_division_id: data.defaults.sales_division_id || '',
          office_location_id: data.defaults.office_location_id || '',
        }));
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]);

  // Load nestable Sales Orders when the type calls for them. The server returns at most 300, newest
  // first, so the picker searches the server as you type (SO-72404 was older than the newest 300
  // and could not be found). include_id keeps the chosen SO in the list so its number still shows.
  function loadNestableSos(search) {
    if (!nestsToSalesOrder(header.type)) return;
    api.get('/non-standard-sales-orders/nestable-sales-orders', {
      params: { type: header.type, search: search || undefined, include_id: header.nested_sales_order_id || undefined },
    }).then(({ data }) => setNestableSos(data)).catch(() => setNestableSos([]));
  }
  useEffect(() => { loadNestableSos(''); }, [header.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // On entering step 2 for an SO-nested type, load the nested SO's job orders.
  useEffect(() => {
    if (step === 2 && nestsToSalesOrder(header.type) && header.nested_sales_order_id) {
      api.get(`/non-standard-sales-orders/source-job-orders/${header.nested_sales_order_id}`)
        .then(({ data }) => setSourceJos(data)).catch(() => setSourceJos([]));
    }
  }, [step, header.type, header.nested_sales_order_id]);

  // Sample nests to an Estimate of the chosen customer (asked 2026-10-08: that customer's estimates
  // only, all of them), then its job-type lines on step 2. No customer yet, no list.
  useEffect(() => {
    if (!nestsToEstimate(header.type)) return;
    if (!header.customer_id) { setNestableEstimates([]); return; }
    api.get('/non-standard-sales-orders/nestable-estimates', { params: { customer_id: header.customer_id } })
      .then(({ data }) => setNestableEstimates(data)).catch(() => setNestableEstimates([]));
  }, [header.type, header.customer_id]);
  useEffect(() => {
    if (step === 2 && nestsToEstimate(header.type) && header.nested_estimate_id) {
      api.get(`/non-standard-sales-orders/source-estimate-jobs/${header.nested_estimate_id}`)
        .then(({ data }) => setSourceEjos(data)).catch(() => setSourceEjos([]));
    }
  }, [step, header.type, header.nested_estimate_id]);

  // The customer's contacts, and the inline "new contact" panel -- as on the estimate form. A new
  // contact is saved to the customer in Master Lists, then selected here.
  const [contacts, setContacts] = useState([]);
  const [newContact, setNewContact] = useState(null);
  const [savingContact, setSavingContact] = useState(false);
  const [contactError, setContactError] = useState('');
  useEffect(() => {
    setNewContact(null);
    if (header.customer_id) api.get(`/non-standard-sales-orders/customer-contacts/${header.customer_id}`).then(({ data }) => setContacts(data)).catch(() => setContacts([]));
    else setContacts([]);
  }, [header.customer_id]);
  function onContactSelect(c) {
    setH({ contact_person_id: c.id, contact_email: c.email || '', contact_title: c.title || '', contact_phone: c.phone || '' });
  }
  async function saveNewContact() {
    if (!newContact?.contact_name.trim()) { setContactError('Contact name is required.'); return; }
    setSavingContact(true);
    setContactError('');
    try {
      const { data } = await api.post('/non-standard-sales-orders/contacts', { ...newContact, customer_id: header.customer_id });
      setContacts((current) => [...current, data]);
      onContactSelect(data);
      setNewContact(null);
    } catch (err) {
      setContactError(err.response?.data?.error || 'Could not save this contact.');
    } finally {
      setSavingContact(false);
    }
  }

  // Customer billing block (credit terms + address) for the Billing / Review steps.
  useEffect(() => {
    if (header.customer_id) api.get(`/non-standard-sales-orders/customer-billing/${header.customer_id}`).then(({ data }) => setBilling(data)).catch(() => setBilling(null));
    else setBilling(null);
  }, [header.customer_id]);

  function onCustomerSelect(c) {
    // A different customer: an Estimate picked for the previous one no longer belongs (its list is that customer's).
    const changed = String(c?.id || '') !== String(header.customer_id || '');
    setH({ customer_id: c?.id || '', contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '', ...(changed ? { nested_estimate_id: '' } : {}) });
  }
  function onSalesOrderSelect(so) {
    setH({ nested_sales_order_id: so?.id || '' });
    if (so && !header.customer_id) setH({ customer_id: so.customer_id || '' });
  }
  function onEstimateSelect(e) {
    setH({ nested_estimate_id: e?.id || '' });
    if (e && !header.customer_id) setH({ customer_id: e.customer_id || '' });
  }

  async function saveHeader() {
    const body = { ...header };
    ['print_warranty', 'structure_warranty', 'electrical_warranty', 'has_multiple_shipping'].forEach((k) => { body[k] = header[k] ? 1 : 0; });
    if (!nssoId) {
      const { data } = await api.post('/non-standard-sales-orders', body);
      setNssoId(data.id);
      navigate(`/non-standard-sales-orders/${data.id}/edit`, { replace: true });
      return data.id;
    }
    await api.put(`/non-standard-sales-orders/${nssoId}`, body);
    return nssoId;
  }

  async function goNextFromStep1() {
    setError('');
    if (!header.type) { setError('Choose a Type.'); return; }
    if (nestsToSalesOrder(header.type) && !header.nested_sales_order_id) { setError('Select the Sales Order this NSSO applies to.'); return; }
    if (nestsToEstimate(header.type) && !header.nested_estimate_id) { setError('Select the Estimate this Sample NSSO applies to.'); return; }
    setBusy(true);
    try { await saveHeader(); setStep(2); }
    catch (e) { setError(e.response?.data?.error || 'Save failed.'); }
    finally { setBusy(false); }
  }

  async function addSelectedJos() {
    setError('');
    const ids = sourceJos.filter((j) => selectedJos[j.id]).map((j) => j.id);
    if (!ids.length) { setError('Select at least one job order.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post(`/non-standard-sales-orders/${nssoId}/lines/from-source`, { source_job_order_ids: ids });
      setLines(data);
    } catch (e) { setError(e.response?.data?.error || 'Failed to add job orders.'); }
    finally { setBusy(false); }
  }

  // Internal type: job-type lines are entered by hand (no source JO). These edit the working `lines`
  // array in place; saveInternalLines persists the whole set via PUT /:id/lines.
  const EMPTY_LINE = { job_type_id: '', job_location_id: '', description: '', quantity: 1, units: 'PC/S', uom: 'INCH', length: '', width: '', height: '', delivery_date: '', memo: '', remarks: '' };
  // Every edit marks the lines dirty; the effect below saves them a moment later, the way an
  // Estimate's job items save as they are filled in. Before this nothing reached the server until
  // Save Lines or Next Step, and the header Save button only navigated -- so lines typed and then
  // "saved" from the top of the page were simply lost (NSSO-INT-61).
  const linesDirty = useRef(false);
  const saveChain = useRef(Promise.resolve());
  const [linesStatus, setLinesStatus] = useState('');
  const editLines = (fn) => { linesDirty.current = true; setLines(fn); };
  const addInternalLine = () => editLines((ls) => [...ls, { ...EMPTY_LINE }]);
  const setInternalLine = (i, patch) => editLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const delInternalLine = (i) => editLines((ls) => ls.filter((_, idx) => idx !== i));

  // PUT /lines replaces the whole set, so two saves must never overlap: each waits for the last.
  // `replace` swaps in the server's rows (explicit saves); an autosave leaves the screen alone,
  // or a half-filled row with no Job Type yet -- which the server skips -- would vanish mid-typing.
  function saveInternalLines(replace = true, current = lines) {
    const payload = current.filter((l) => l.job_type_id).map((l) => ({
      job_type_id: l.job_type_id, job_location_id: l.job_location_id || null, description: l.description, quantity: l.quantity,
      units: l.units, uom: l.uom, length: l.length, width: l.width, height: l.height, delivery_date: l.delivery_date || null, memo: l.memo, remarks: l.remarks,
    }));
    linesDirty.current = false;
    const run = async () => {
      const { data } = await api.put(`/non-standard-sales-orders/${nssoId}/lines`, { lines: payload });
      if (replace) setLines(data);
      return data;
    };
    saveChain.current = saveChain.current.catch(() => {}).then(run);
    return saveChain.current;
  }

  useEffect(() => {
    if (header.type !== 'internal' || step !== 2 || !nssoId || !linesDirty.current) return undefined;
    const timer = setTimeout(() => {
      setLinesStatus('Saving...');
      saveInternalLines(false, lines)
        .then(() => setLinesStatus('All changes saved'))
        .catch((e) => { linesDirty.current = true; setLinesStatus(''); setError(e.response?.data?.error || 'Could not save the job lines.'); });
    }, 700);
    return () => clearTimeout(timer);
  }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveAndView() {
    setBusy(true); setError('');
    try {
      await saveHeader();
      if (header.type === 'internal' && step === 2) await saveInternalLines();
      await addTickedOnLeave();
      navigate(`/non-standard-sales-orders/${nssoId}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); }
    finally { setBusy(false); }
  }

  async function addSelectedEjos() {
    setError('');
    const ids = sourceEjos.filter((j) => selectedEjos[j.id]).map((j) => j.id);
    if (!ids.length) { setError('Select at least one estimate job order.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post(`/non-standard-sales-orders/${nssoId}/lines/from-estimate`, { estimate_job_order_ids: ids });
      setLines(data);
    } catch (e) { setError(e.response?.data?.error || 'Failed to add estimate job orders.'); }
    finally { setBusy(false); }
  }

  // A sample line's Qty / Amount (its Net of Tax), saved when the field is left if it changed. The
  // server re-derives price, tax and gross from them (PUT .../lines/:lineId/sample).
  async function saveSampleLine(line, field, value) {
    const v = Number(value);
    const current = field === 'quantity' ? Number(line.sample_qty) : Number(line.sample_amount);
    if (value === '' || !Number.isFinite(v) || Math.abs(v - current) < 0.005) return;
    setError(''); setBusy(true);
    try {
      const { data } = await api.put(`/non-standard-sales-orders/${nssoId}/lines/${line.id}/sample`, { [field]: v });
      setLines((ls) => ls.map((x) => (x.id === line.id ? { ...x, ...data } : x)));
    } catch (e) { setError(e.response?.data?.error || 'Could not save the sample line.'); }
    finally { setBusy(false); }
  }

  // Lines ticked on step 2 but never put on the NSSO with "Add Selected" are added on the way out
  // of the step. NSSO-SAM-2438 was saved and approved with no lines at all: its estimate's four job
  // lines were ticked (or meant to be), the Next button moved on, and nothing had been added.
  // Returns the NSSO's lines as they stand afterwards.
  async function addTickedOnLeave() {
    if (step !== 2 || !nssoId) return lines;
    const pick = (src, sel) => src.filter((j) => sel[j.id]).map((j) => j.id);
    const same = (ids, field) => ids.length === lines.length && ids.every((id) => lines.some((l) => Number(l[field]) === Number(id)));
    if (nestsToEstimate(header.type)) {
      const ids = pick(sourceEjos, selectedEjos);
      if (ids.length && !same(ids, 'source_estimate_job_order_id')) {
        const { data } = await api.post(`/non-standard-sales-orders/${nssoId}/lines/from-estimate`, { estimate_job_order_ids: ids });
        setLines(data); return data;
      }
    } else if (nestsToSalesOrder(header.type)) {
      const ids = pick(sourceJos, selectedJos);
      if (ids.length && !same(ids, 'source_job_order_id')) {
        const { data } = await api.post(`/non-standard-sales-orders/${nssoId}/lines/from-source`, { source_job_order_ids: ids });
        setLines(data); return data;
      }
    }
    return lines;
  }

  async function saveHeaderAndGoTo(n) {
    setBusy(true); setError('');
    try {
      await saveHeader();
      if (header.type === 'internal' && step === 2) await saveInternalLines();
      // Going forward from the job-lines step needs at least one line on the NSSO.
      if (step === 2 && n > 2 && header.type !== 'internal') {
        const now = await addTickedOnLeave();
        if (!now.length) {
          setError(nestsToEstimate(header.type)
            ? 'Tick the estimate job orders this sample is for, then continue -- the NSSO has no lines yet.'
            : 'Tick the job orders this NSSO is for, then continue -- the NSSO has no lines yet.');
          return;
        }
      }
      setStep(n);
    }
    catch (e) { setError(e.response?.data?.error || 'Save failed.'); }
    finally { setBusy(false); }
  }

  if (loading) return <LoadingSpinner />;

  const emp = (e) => `${e.first_name} ${e.last_name}`;
  const nameOf = (arr, id, fn) => { const x = (arr || []).find((a) => String(a.id) === String(id)); return x ? fn(x) : ''; };
  const empName = (id) => nameOf(meta.employees, id, emp);
  const custName = (id) => nameOf(meta.customers, id, (c) => c.name);
  const divName = (id) => nameOf(meta.divisions, id, (d) => d.name);
  const locName = (id) => nameOf(meta.locations, id, (l) => l.location_name);
  const jtName = (id) => nameOf(meta.jobTypes, id, (j) => j.display_name);
  // Description and Job Location of a copied (RMA / INST / Sample) line, saved on their own
  // (PUT .../lines/:lineId/details). The line's Job Order, if created, follows.
  async function saveLineDetails(l, patch) {
    setError('');
    try {
      const { data } = await api.put(`/non-standard-sales-orders/${nssoId}/lines/${l.id}/details`, patch);
      setLines((prev) => prev.map((x) => (x.id === l.id ? { ...x, ...data } : x)));
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the line.');
    }
  }
  const lineDescriptionCell = (l) => (
    <input key={`d-${l.id}-${l.description}`} defaultValue={l.description || ''} disabled={busy} style={{ width: 240 }}
      onBlur={(e) => { if (e.target.value !== (l.description || '')) saveLineDetails(l, { description: e.target.value }); }} />
  );
  const lineLocationCell = (l) => (
    <EntityPicker label="Job Location" items={meta.locations} value={l.job_location_id || ''} getLabel={(x) => x.location_name}
      columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="--Select--"
      onSelect={(x) => saveLineDetails(l, { job_location_id: x?.id || null })} />
  );

  const isSoNested = nestsToSalesOrder(header.type);
  const isSample = header.type === 'sample';
  const isInternal = header.type === 'internal';

  return (
    <div>
      <div className="page-header">
        <h1>Non Standard Sales Order</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/non-standard-sales-orders'}>Back</Link>
          {nssoId && <button className="btn btn-sm btn-primary" disabled={busy} onClick={saveAndView}>Save</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="wizard-steps">
          {STEPS.map((label, i) => (
            <Fragment key={label}>
              <button type="button" className={`wizard-step ${step === i + 1 ? 'active' : ''}`}
                disabled={i + 1 > 1 && !nssoId} onClick={() => setStep(i + 1)}>
                <span className="num">{i + 1}</span> {label}
              </button>
              {i < STEPS.length - 1 && <span className="wizard-step-line" />}
            </Fragment>
          ))}
        </div>

        {step === 1 && (
          <div style={{ marginTop: 20 }}>
            <h3>Enter your Customer and Non Standard SO Details</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, alignItems: 'start', marginTop: 12 }}>
              {/* Column 1 — Customer / contact */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="field">
                  <label>Date Created</label>
                  <input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} />
                </div>
                <div className="field">
                  <label>Customer</label>
                  <EntityPicker label="Customer" items={meta.customers} value={header.customer_id} getLabel={(c) => c.name}
                    columns={[{ key: 'name', label: 'Name' }, { key: 'tin', label: 'TIN' }]} searchKeys={['name', 'company_name', 'customer_code']}
                    placeholder="--Select--" onSelect={onCustomerSelect} />
                </div>
                <div className="field">
                  <label>Contact Name</label>
                  <EntityPicker
                    label="Contact Name" items={contacts} value={header.contact_person_id} getLabel={(c) => c.contact_name}
                    columns={[{ key: 'contact_name', label: 'Name' }, { key: 'title', label: 'Title' }, { key: 'email', label: 'Email' }]}
                    searchKeys={['contact_name', 'email']}
                    onSelect={onContactSelect}
                    disabled={!header.customer_id}
                    placeholder={header.customer_id ? 'Select contact...' : 'Select a customer first'}
                  />
                  {header.customer_id && !newContact && (
                    <button type="button" className="btn btn-link" style={{ padding: '4px 0' }}
                      onClick={() => { setContactError(''); setNewContact({ contact_name: '', title: '', email: '', phone: '' }); }}>
                      + Add new contact
                    </button>
                  )}
                  {newContact && (
                    <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 6, padding: 10, marginTop: 6 }}>
                      <label>New Contact <span className="muted">(saved to this customer in Master Lists)</span></label>
                      {contactError && <div className="error-banner">{contactError}</div>}
                      {[['contact_name', 'Name *'], ['title', 'Title'], ['email', 'Email'], ['phone', 'Contact No']].map(([key, label]) => (
                        <input key={key} placeholder={label} value={newContact[key]} style={{ marginBottom: 6 }}
                          onChange={(e) => setNewContact((current) => ({ ...current, [key]: e.target.value }))} />
                      ))}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="btn btn-primary" disabled={savingContact} onClick={saveNewContact}>
                          {savingContact ? 'Saving...' : 'Save Contact'}
                        </button>
                        <button type="button" className="btn" disabled={savingContact} onClick={() => setNewContact(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="field">
                  <label>Contact Title</label>
                  <input value={header.contact_title || ''} onChange={(e) => setH({ contact_title: e.target.value })} />
                </div>
                <div className="field">
                  <label>Contact Email</label>
                  <input value={header.contact_email || ''} onChange={(e) => setH({ contact_email: e.target.value })} />
                </div>
                <div className="field">
                  <label>Contact Phone</label>
                  <input value={header.contact_phone || ''} onChange={(e) => setH({ contact_phone: e.target.value })} />
                </div>
              </div>

              {/* Column 2 — Sales / contract */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="field">
                  <label>Sales Rep.</label>
                  <EntityPicker label="Sales Rep" items={meta.employees} value={header.sales_rep_id} getLabel={emp}
                    columns={[{ key: 'first_name', label: 'First' }, { key: 'last_name', label: 'Last' }]} searchKeys={['first_name', 'last_name', 'employee_code']}
                    placeholder="--Select--" onSelect={(e) => setH({ sales_rep_id: e?.id || '' })} />
                </div>
                <div className="field">
                  <label>Sales Division</label>
                  <EntityPicker label="Sales Division" items={meta.divisions} value={header.sales_division_id} getLabel={(d) => d.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--" onSelect={(d) => setH({ sales_division_id: d?.id || '' })} />
                </div>
                <div className="field">
                  <label>Office Location</label>
                  <EntityPicker label="Office Location" items={meta.locations} value={header.office_location_id} getLabel={(l) => l.location_name}
                    columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]} searchKeys={['location_name', 'location_code']}
                    placeholder="--Select--" onSelect={(l) => setH({ office_location_id: l?.id || '' })} />
                </div>
                <div className="field">
                  <label>Contract Description</label>
                  <textarea value={header.contract_description || ''} onChange={(e) => setH({ contract_description: e.target.value })} rows={2} />
                </div>
                <div className="field">
                  <label>Memo</label>
                  <textarea value={header.memo || ''} onChange={(e) => setH({ memo: e.target.value })} rows={2} />
                </div>
                <div className="field">
                  <label>Shipping Address</label>
                  <input value={header.shipping_address || ''} onChange={(e) => setH({ shipping_address: e.target.value })} />
                </div>
              </div>

              {/* Column 3 — Type / nesting / warranties */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="field">
                  <label>Type</label>
                  <select value={header.type} onChange={(e) => { setH({ type: e.target.value, nested_sales_order_id: '', nested_estimate_id: '' }); }}>
                    <option value="">--Select--</option>
                    {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                {isSoNested && (
                  <div className="field">
                    <label>Sales Order #</label>
                    <EntityPicker label="Sales Order" items={nestableSos} value={header.nested_sales_order_id} getLabel={(s) => s.sales_order_no}
                      columns={[{ key: 'sales_order_no', label: 'SO #' }, { key: 'customer_name', label: 'Customer' }, { key: 'status', label: 'Status' }]}
                      searchKeys={['sales_order_no', 'customer_name']} placeholder="--Select--" onSelect={onSalesOrderSelect} onSearch={loadNestableSos} />
                  </div>
                )}
                {isSample && (
                  <div className="field">
                    <label>Estimate #</label>
                    <EntityPicker label="Estimate" items={nestableEstimates} value={header.nested_estimate_id} getLabel={(e) => e.estimate_no}
                      columns={[{ key: 'estimate_no', label: 'Estimate #' }, { key: 'customer_name', label: 'Customer' }, { key: 'status', label: 'Status' }]}
                      searchKeys={['estimate_no', 'customer_name']} placeholder="--Select--" onSelect={onEstimateSelect} />
                  </div>
                )}
                <div className="field">
                  <label>Production Lead Time</label>
                  <input value={header.production_lead_time || ''} onChange={(e) => setH({ production_lead_time: e.target.value })} />
                </div>
                <div className="field">
                  <label>Warranties</label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                    <input type="checkbox" checked={!!header.print_warranty} onChange={(e) => setH({ print_warranty: e.target.checked ? 1 : 0 })} /> Print Warranty</label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                    <input type="checkbox" checked={!!header.structure_warranty} onChange={(e) => setH({ structure_warranty: e.target.checked ? 1 : 0 })} /> Structure Warranty</label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                    <input type="checkbox" checked={!!header.electrical_warranty} onChange={(e) => setH({ electrical_warranty: e.target.checked ? 1 : 0 })} /> Electrical Warranty</label>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-primary" disabled={busy} onClick={goNextFromStep1}>{busy ? 'Saving...' : 'Next Step'}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ marginTop: 20 }}>
            <h3>Add Job Orders</h3>
            {isSoNested ? (
              <>
                <p className="muted">Select the job order(s) from {header.nested_sales_order_id ? 'the nested Sales Order' : 'the Sales Order'} to include in this NSSO.</p>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th></th><th>JO #</th><th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Stage</th></tr></thead>
                    <tbody>
                      {sourceJos.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>No job orders on the nested Sales Order.</td></tr>}
                      {sourceJos.map((j) => (
                        <tr key={j.id}>
                          <td><input type="checkbox" checked={!!selectedJos[j.id]} onChange={(e) => setSelectedJos((s) => ({ ...s, [j.id]: e.target.checked }))} /></td>
                          <td>{j.job_order_no}</td><td>{j.job_type_name}</td><td>{j.description}</td>
                          <td style={{ textAlign: 'right' }}>{Number(j.quantity)}</td><td>{j.production_stage || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button className="btn btn-sm btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={addSelectedJos}>Add Selected to NSSO</button>

                <h4 style={{ marginTop: 20 }}>NSSO Job Orders</h4>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>#</th><th>Job Type</th><th>Job Location</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Units</th></tr></thead>
                    <tbody>
                      {lines.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>No job orders added yet.</td></tr>}
                      {lines.map((l, i) => {
                        const jt = meta.jobTypes.find((x) => String(x.id) === String(l.job_type_id));
                        return (<tr key={l.id}><td>{i + 1}</td><td>{jt?.display_name || ''}</td>
                          <td>{lineLocationCell(l)}</td><td>{lineDescriptionCell(l)}</td>
                          {/* Qty editable until the line's Job Order exists (the server holds the same rule). */}
                          <td style={{ textAlign: 'right' }}>
                            <input key={`q-${l.id}-${l.quantity}`} type="number" min="0" step="any" defaultValue={Number(l.quantity)} disabled={busy}
                              style={{ width: 80, textAlign: 'right' }}
                              onBlur={(e) => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && Math.abs(v - Number(l.quantity)) > 1e-9) saveLineDetails(l, { quantity: v }); }} />
                          </td><td>{l.units}</td></tr>);
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : isSample ? (
              <>
                <p className="muted">Select the job type(s) from the nested Estimate to sample.</p>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th></th><th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Units</th>
                      <th style={{ textAlign: 'right' }}>Price/Unit</th><th style={{ textAlign: 'right' }}>Net of Tax</th></tr></thead>
                    <tbody>
                      {sourceEjos.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>No job orders on the nested Estimate.</td></tr>}
                      {sourceEjos.map((j) => (
                        <tr key={j.id}>
                          <td><input type="checkbox" checked={!!selectedEjos[j.id]} onChange={(e) => setSelectedEjos((s) => ({ ...s, [j.id]: e.target.checked }))} /></td>
                          <td>{j.job_type_name}</td><td>{j.description}</td>
                          <td style={{ textAlign: 'right' }}>{Number(j.quantity)}</td><td>{j.units}</td>
                          <td style={{ textAlign: 'right' }}>{money(j.price_per_unit)}</td><td style={{ textAlign: 'right' }}>{money(j.net_of_tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button className="btn btn-sm btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={addSelectedEjos}>Add Selected to NSSO</button>

                <h4 style={{ marginTop: 20 }}>NSSO Samples</h4>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>#</th><th>Job Type</th><th>Job Location</th><th>Description</th><th style={{ textAlign: 'right' }}>Sample Qty</th>
                      <th style={{ textAlign: 'right' }}>Sample Amt</th><th style={{ textAlign: 'right' }}>Allowance</th></tr></thead>
                    <tbody>
                      {lines.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>No samples added yet.</td></tr>}
                      {lines.map((l, i) => {
                        const jt = meta.jobTypes.find((x) => String(x.id) === String(l.job_type_id));
                        return (<tr key={l.id}><td>{i + 1}</td><td>{jt?.display_name || ''}</td>
                          <td>{lineLocationCell(l)}</td><td>{lineDescriptionCell(l)}</td>
                          {/* Editable even once the line's JO exists -- the JO follows, until it has been built on (server). */}
                          <td style={{ textAlign: 'right' }}><input key={`q-${l.id}-${l.sample_qty}`} type="number" min="0" step="any" defaultValue={Number(l.sample_qty)} disabled={busy}
                                style={{ width: 80, textAlign: 'right' }} onBlur={(e) => saveSampleLine(l, 'quantity', e.target.value)} /></td>
                          <td style={{ textAlign: 'right' }}><input key={`a-${l.id}-${l.sample_amount}`} type="number" min="0" step="0.01" defaultValue={Number(l.sample_amount)} disabled={busy}
                            style={{ width: 110, textAlign: 'right' }} onBlur={(e) => saveSampleLine(l, 'amount', e.target.value)} /></td>
                          <td style={{ textAlign: 'right' }}>{money(l.allowance_amount)}</td></tr>);
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : isInternal ? (
              <>
                <p className="muted">Add the job type(s) for this internal work order. Processes and items are added later, after approval.</p>
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th></th><th>Job Type</th><th>Job Location</th><th>Description</th>
                      <th style={{ textAlign: 'right' }}>Qty</th><th>Units</th>
                      <th style={{ textAlign: 'right' }}>Length</th><th style={{ textAlign: 'right' }}>Width</th><th style={{ textAlign: 'right' }}>Height</th>
                      <th>UOM</th><th>Delivery Date</th><th>Memo</th>
                    </tr></thead>
                    <tbody>
                      {lines.length === 0 && <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 16 }}>No job types yet. Click Add Line.</td></tr>}
                      {lines.map((l, i) => (
                        <tr key={i}>
                          <td><button type="button" className="btn btn-sm btn-warning" onClick={() => delInternalLine(i)}>✕</button></td>
                          <td style={{ minWidth: 200 }}>
                            <EntityPicker label="Job Type" items={meta.jobTypes} value={l.job_type_id} getLabel={(j) => j.display_name}
                              columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]} searchKeys={['item_code', 'display_name']}
                              placeholder="--Select--" onSelect={(j) => setInternalLine(i, { job_type_id: j?.id || '' })} />
                          </td>
                          <td style={{ minWidth: 170 }}>
                            <EntityPicker label="Job Location" items={meta.locations} value={l.job_location_id} getLabel={(x) => x.location_name}
                              columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]} searchKeys={['location_name', 'location_code']}
                              placeholder="--Select--" onSelect={(x) => setInternalLine(i, { job_location_id: x?.id || '' })} />
                          </td>
                          <td><input value={l.description || ''} onChange={(e) => setInternalLine(i, { description: e.target.value })} style={{ width: 180 }} /></td>
                          <td><input type="number" value={l.quantity ?? 0} onChange={(e) => setInternalLine(i, { quantity: e.target.value })} style={{ width: 70 }} /></td>
                          <td><input value={l.units || ''} onChange={(e) => setInternalLine(i, { units: e.target.value })} style={{ width: 70 }} /></td>
                          <td><input type="number" value={l.length ?? ''} onChange={(e) => setInternalLine(i, { length: e.target.value })} style={{ width: 65 }} /></td>
                          <td><input type="number" value={l.width ?? ''} onChange={(e) => setInternalLine(i, { width: e.target.value })} style={{ width: 65 }} /></td>
                          <td><input type="number" value={l.height ?? ''} onChange={(e) => setInternalLine(i, { height: e.target.value })} style={{ width: 65 }} /></td>
                          <td><input value={l.uom || ''} onChange={(e) => setInternalLine(i, { uom: e.target.value })} style={{ width: 65 }} /></td>
                          <td><input type="date" value={l.delivery_date ? String(l.delivery_date).slice(0, 10) : ''} onChange={(e) => setInternalLine(i, { delivery_date: e.target.value })} /></td>
                          <td><input value={l.memo || ''} onChange={(e) => setInternalLine(i, { memo: e.target.value })} style={{ width: 120 }} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn btn-sm btn-primary" onClick={addInternalLine}>Add Line</button>
                  <button className="btn btn-sm" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await saveInternalLines(); } catch (e) { setError(e.response?.data?.error || 'Save failed.'); } finally { setBusy(false); } }}>Save Lines</button>
                  {linesStatus && <span className="muted" style={{ alignSelf: 'center', fontSize: 12 }}>{linesStatus}</span>}
                </div>
              </>
            ) : (
              <p className="muted">Job-order entry for the {header.type || 'this'} type is coming next — RMA is wired first.</p>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => saveHeaderAndGoTo(3)}>Next Step</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ marginTop: 20 }}>
            <h3>Billing Details</h3>
            <div style={{ lineHeight: 2.2, maxWidth: 900 }}>
              <div>Credit Term : <span className="hi">{billing?.credit_term || ''}</span></div>
              <div>Credit Limit : <span className="hi">{billing?.credit_limit != null && billing?.credit_limit !== '' ? money(billing.credit_limit) : ''}</span></div>
              <div>Credit Balance : <span className="hi">{money(billing?.credit_balance || 0)}</span></div>
              <div>Bill To : <span className="hi">{billing?.bill_to || ''}</span></div>
              <div>Address : <span className="hi">{billing?.address || ''}</span></div>
              <div>Contact Number : <span className="hi">{billing?.contact_number || ''}</span></div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
              <button className="btn" onClick={() => setStep(2)}>Previous</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => saveHeaderAndGoTo(4)}>Next Step</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={{ marginTop: 20 }}>
            <h3>Review your Details and Submit</h3>
            <h4 style={{ marginBottom: 6 }}>Customer and NonStandardSalesOrder Details</h4>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#2563eb', marginBottom: 12 }}>{custName(header.customer_id) || '—'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, lineHeight: 1.9 }}>
              <div>
                <div>Contact Title : <span className="hi">{header.contact_title || ''}</span></div>
                <div>Contact Email : <span className="hi">{header.contact_email || ''}</span></div>
                <div>Contact Phone : <span className="hi">{header.contact_phone || ''}</span></div>
              </div>
              <div>
                <div>Date Created : <span className="hi">{header.date_created}</span></div>
                <div>Sales Division : <span className="hi">{divName(header.sales_division_id)}</span></div>
                <div>Office Location : <span className="hi">{locName(header.office_location_id)}</span></div>
                <div>Contract Desc. : <span className="hi">{header.contract_description || ''}</span></div>
                <div>Memo : <span className="hi">{header.memo || ''}</span></div>
                <div>Shipping Address : <span className="hi">{header.shipping_address || ''}</span></div>
              </div>
              <div>
                <div>Sales Rep : <span className="hi">{empName(header.sales_rep_id)}</span></div>
                <div>Prepared By : <span className="hi">{empName(header.prepared_by_id) || ''}</span></div>
                <div>Approved By : <span className="hi">{empName(header.approved_by_id) || ''}</span></div>
              </div>
              <div>
                <div>Credit Term : <span className="hi">{billing?.credit_term || ''}</span></div>
                <div>Credit Limit : <span className="hi">{billing?.credit_limit != null && billing?.credit_limit !== '' ? money(billing.credit_limit) : ''}</span></div>
                <div>Credit Balance : <span className="hi">{money(billing?.credit_balance || 0)}</span></div>
                <div>Bill To : <span className="hi">{billing?.bill_to || ''}</span></div>
                <div>Address : <span className="hi">{billing?.address || ''}</span></div>
                <div>Contact Number : <span className="hi">{billing?.contact_number || ''}</span></div>
              </div>
            </div>

            <h4 style={{ marginTop: 24 }}>Job Types</h4>
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>#</th><th>Job Type</th><th>Ref. JO #</th><th>Job Location</th><th>Description</th>
                  <th style={{ textAlign: 'right' }}>Quantity</th><th>Units</th>
                  <th style={{ textAlign: 'right' }}>Price / Unit</th><th style={{ textAlign: 'right' }}>Subtotal</th>
                  <th style={{ textAlign: 'right' }}>Disc. %</th><th style={{ textAlign: 'right' }}>Disc. Amt</th>
                  <th style={{ textAlign: 'right' }}>Net of Tax</th>
                  <th style={{ textAlign: 'right' }}>Length</th><th style={{ textAlign: 'right' }}>Width</th><th style={{ textAlign: 'right' }}>Height</th>
                  <th>UOM</th><th>Remarks</th><th>Memo</th><th>Delivery Date</th>
                </tr></thead>
                <tbody>
                  {lines.length === 0 && <tr><td colSpan={19} className="muted" style={{ textAlign: 'center', padding: 16 }}>No job orders.</td></tr>}
                  {lines.map((l, i) => (
                    <tr key={l.id}>
                      <td>{i + 1}</td>
                      <td>{l.job_type_name || jtName(l.job_type_id)}</td>
                      <td>{l.source_job_order_no || '—'}</td>
                      <td>{l.job_location_name || locName(l.job_location_id)}</td>
                      <td>{l.description}</td>
                      <td style={{ textAlign: 'right' }}>{Number(l.quantity)}</td>
                      <td>{l.units}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.price_per_unit)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.subtotal)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.disc_percent)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.disc_amount)}</td>
                      <td style={{ textAlign: 'right' }}>{money(l.net_of_tax)}</td>
                      <td style={{ textAlign: 'right' }}>{l.length ?? '-'}</td>
                      <td style={{ textAlign: 'right' }}>{l.width ?? '-'}</td>
                      <td style={{ textAlign: 'right' }}>{l.height ?? '-'}</td>
                      <td>{l.uom || ''}</td><td>{l.remarks || ''}</td><td>{l.memo || ''}</td>
                      <td>{l.delivery_date ? String(l.delivery_date).slice(0, 10) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
              <button className="btn" onClick={() => setStep(3)}>Previous</button>
              <Link className="btn btn-primary" to={`/non-standard-sales-orders/${nssoId}`}>Save &amp; View</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
