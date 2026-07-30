import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

  // Load nestable Sales Orders when the type calls for them.
  useEffect(() => {
    if (nestsToSalesOrder(header.type)) {
      api.get('/non-standard-sales-orders/nestable-sales-orders', { params: { type: header.type } })
        .then(({ data }) => setNestableSos(data)).catch(() => setNestableSos([]));
    }
  }, [header.type]);

  // On entering step 2 for an SO-nested type, load the nested SO's job orders.
  useEffect(() => {
    if (step === 2 && nestsToSalesOrder(header.type) && header.nested_sales_order_id) {
      api.get(`/non-standard-sales-orders/source-job-orders/${header.nested_sales_order_id}`)
        .then(({ data }) => setSourceJos(data)).catch(() => setSourceJos([]));
    }
  }, [step, header.type, header.nested_sales_order_id]);

  // Sample nests to an approved Estimate: load the picker list, then its job-type lines on step 2.
  useEffect(() => {
    if (nestsToEstimate(header.type)) {
      api.get('/non-standard-sales-orders/nestable-estimates')
        .then(({ data }) => setNestableEstimates(data)).catch(() => setNestableEstimates([]));
    }
  }, [header.type]);
  useEffect(() => {
    if (step === 2 && nestsToEstimate(header.type) && header.nested_estimate_id) {
      api.get(`/non-standard-sales-orders/source-estimate-jobs/${header.nested_estimate_id}`)
        .then(({ data }) => setSourceEjos(data)).catch(() => setSourceEjos([]));
    }
  }, [step, header.type, header.nested_estimate_id]);

  // Customer billing block (credit terms + address) for the Billing / Review steps.
  useEffect(() => {
    if (header.customer_id) api.get(`/non-standard-sales-orders/customer-billing/${header.customer_id}`).then(({ data }) => setBilling(data)).catch(() => setBilling(null));
    else setBilling(null);
  }, [header.customer_id]);

  function onCustomerSelect(c) {
    setH({ customer_id: c?.id || '', contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '' });
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
  const addInternalLine = () => setLines((ls) => [...ls, { ...EMPTY_LINE }]);
  const setInternalLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const delInternalLine = (i) => setLines((ls) => ls.filter((_, idx) => idx !== i));
  async function saveInternalLines() {
    const payload = lines.filter((l) => l.job_type_id).map((l) => ({
      job_type_id: l.job_type_id, job_location_id: l.job_location_id || null, description: l.description, quantity: l.quantity,
      units: l.units, uom: l.uom, length: l.length, width: l.width, height: l.height, delivery_date: l.delivery_date || null, memo: l.memo, remarks: l.remarks,
    }));
    const { data } = await api.put(`/non-standard-sales-orders/${nssoId}/lines`, { lines: payload });
    setLines(data);
    return data;
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

  async function saveHeaderAndGoTo(n) {
    setBusy(true); setError('');
    try { await saveHeader(); if (header.type === 'internal' && step === 2) await saveInternalLines(); setStep(n); }
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
  const isSoNested = nestsToSalesOrder(header.type);
  const isSample = header.type === 'sample';
  const isInternal = header.type === 'internal';

  return (
    <div>
      <div className="page-header">
        <h1>Non Standard Sales Order</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/non-standard-sales-orders')}>Back</button>
          {nssoId && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/non-standard-sales-orders/${nssoId}`)}>Save</button>}
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
                      searchKeys={['sales_order_no', 'customer_name']} placeholder="--Select--" onSelect={onSalesOrderSelect} />
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
                    <thead><tr><th>#</th><th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th>Units</th></tr></thead>
                    <tbody>
                      {lines.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 16 }}>No job orders added yet.</td></tr>}
                      {lines.map((l, i) => {
                        const jt = meta.jobTypes.find((x) => String(x.id) === String(l.job_type_id));
                        return (<tr key={l.id}><td>{i + 1}</td><td>{jt?.display_name || ''}</td><td>{l.description}</td>
                          <td style={{ textAlign: 'right' }}>{Number(l.quantity)}</td><td>{l.units}</td></tr>);
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
                    <thead><tr><th>#</th><th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Sample Qty</th>
                      <th style={{ textAlign: 'right' }}>Sample Amt</th><th style={{ textAlign: 'right' }}>Allowance</th></tr></thead>
                    <tbody>
                      {lines.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>No samples added yet.</td></tr>}
                      {lines.map((l, i) => {
                        const jt = meta.jobTypes.find((x) => String(x.id) === String(l.job_type_id));
                        return (<tr key={l.id}><td>{i + 1}</td><td>{jt?.display_name || ''}</td><td>{l.description}</td>
                          <td style={{ textAlign: 'right' }}>{Number(l.sample_qty)}</td>
                          <td style={{ textAlign: 'right' }}>{money(l.sample_amount)}</td>
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
              <button className="btn btn-primary" onClick={() => navigate(`/non-standard-sales-orders/${nssoId}`)}>Save &amp; View</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
