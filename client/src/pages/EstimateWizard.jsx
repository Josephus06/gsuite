import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import { computeAutoPricing } from '../utils/costing';
import LoadingSpinner from '../components/LoadingSpinner';

const STEPS = ['Customer and Estimate', 'Job Orders', 'Billing', 'Completed'];

// Matches the real system's Job Order Units dropdown -- a fixed list, not a
// free-text/lookup field.
const UNIT_OPTIONS = ['PC/S', 'SET/S', 'BOX/ES', 'LOT/S', 'ROLL/S'];

const EMPTY_HEADER = {
  date_created: new Date().toISOString().slice(0, 10),
  customer_id: '', contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '',
  blanket_po_id: '', blanket_po_memo: '', sales_rep_id: '', sales_division_id: '', office_location_id: '',
  contract_description: '', memo: '', shipping_address: '', has_multiple_shipping: false,
  production_lead_time: '', price_validity: '', order_confirmation_type: '',
  print_warranty: false, print_warranty_term: '', structure_warranty: false, structure_warranty_term: '',
  electrical_warranty: false, electrical_warranty_term: '',
  prepared_by_id: '', approved_by_id: '', credit_term: '', credit_limit: '', credit_balance: '',
  bill_to_contact_number: '', status: 'pending_supervisor_approval',
  subtotal: '', discount_total: '', net_of_tax: '', tax_total: '', total_amount: '', est_gp_rate: '', est_gp_amount: '',
};

const ORDER_CONFIRMATION_OPTIONS = ['PO#', 'PO# with Payment', 'Conforme', 'Payment'];

const EMPTY_JO = {
  nstdjo_no: '', job_type_id: '', job_location_id: '', description: '', quantity: '', units: '',
  price_per_unit: '', subtotal: '', disc_percent: '', disc_per_unit: '', disc_amount: '', disc_price_per_unit: '',
  net_of_tax: '', tax_code_id: '', tax_amount: '', gross_amount: '', length: '', width: '', height: '', uom: '',
  shipping: '', remarks: '', memo: '', delivery_date: '', delivery_time: '', gp_rate: '', gp_amount: '',
};

const EMPTY_PROC = {
  process_id: '', process_qty: '', process_uom: '', item_id: '', length: '', width: '',
  uom: '', qty: '', total: '', unit: '', process_price: '', process_disc_percent: '', process_disc_amount: '',
  disc_process_price: '', material_price: '', material_disc_percent: '', material_disc_amount: '',
  disc_material_price: '', net_of_tax: '', tax_amount: '', gross_amount: '',
  remarks: '', memo: '', gp_rate: '', process_cost: '', material_cost: '',
  total_cost: '', total_price: '',
};

const JOB_ORDER_FIELDS = Object.keys(EMPTY_JO);
const PROCESS_FIELDS = Object.keys(EMPTY_PROC);

const JOB_ORDER_COLUMNS = [
  { key: 'nstdjo_no', label: 'NSTDJO #', type: 'text' },
  { key: 'job_type_id', label: 'Job Type', type: 'picker-jobtype' },
  { key: 'job_location_id', label: 'Job Location', type: 'picker-location' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'units', label: 'Units', type: 'select-units' },
  { key: 'price_per_unit', label: 'Price/Unit', type: 'number', readOnly: true },
  { key: 'subtotal', label: 'Subtotal', type: 'number', readOnly: true },
  { key: 'disc_percent', label: 'Disc %', type: 'number' },
  { key: 'disc_per_unit', label: 'Disc/Unit', type: 'number' },
  { key: 'disc_amount', label: 'Disc Amt', type: 'number' },
  { key: 'disc_price_per_unit', label: 'Disc Price/Unit', type: 'number' },
  { key: 'net_of_tax', label: 'Net of Tax', type: 'number', readOnly: true },
  { key: 'tax_code_id', label: 'Tax Code', type: 'picker-tax' },
  { key: 'tax_amount', label: 'Tax Amt', type: 'number', readOnly: true },
  { key: 'gross_amount', label: 'Gross Amt', type: 'number', readOnly: true },
  { key: 'length', label: 'Length', type: 'number' },
  { key: 'width', label: 'Width', type: 'number' },
  { key: 'height', label: 'Height', type: 'number' },
  { key: 'uom', label: 'UOM', type: 'text' },
  { key: 'shipping', label: 'Shipping', type: 'number' },
  { key: 'remarks', label: 'Remarks', type: 'text' },
  { key: 'memo', label: 'Memo', type: 'text' },
  { key: 'delivery_date', label: 'Delivery Date', type: 'date' },
  { key: 'delivery_time', label: 'Delivery Time', type: 'time' },
  { key: 'gp_rate', label: 'GP Rate', type: 'number', readOnly: true },
  { key: 'gp_amount', label: 'GP Amount', type: 'number', readOnly: true },
];

// readOnly columns are computed by the pricing engine (or auto-fetched from the
// selected Process/Item's base unit) -- per the user's spec, the only fields a person
// types into on a process line are process_qty, length, width, qty, process_disc_percent,
// process_disc_amount, material_disc_percent, and material_disc_amount. Everything else
// is either a selection (Process/Item picker) or derived.
const PROCESS_COLUMNS = [
  { key: 'process_id', label: 'Process', type: 'picker-process' },
  { key: 'process_qty', label: 'Process Qty', type: 'number' },
  { key: 'process_uom', label: 'Process UOM', type: 'text', readOnly: true },
  { key: 'item_id', label: 'Item', type: 'picker-item' },
  { key: 'length', label: 'Length', type: 'number' },
  { key: 'width', label: 'Width', type: 'number' },
  { key: 'uom', label: 'UOM', type: 'select-uom' },
  { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'total', label: 'Total', type: 'number', readOnly: true },
  { key: 'unit', label: 'Unit', type: 'text', readOnly: true },
  { key: 'process_price', label: 'Process Price', type: 'number', readOnly: true },
  { key: 'process_disc_percent', label: 'Process Disc %', type: 'number' },
  { key: 'process_disc_amount', label: 'Process Disc Amt', type: 'number' },
  { key: 'disc_process_price', label: 'Disc Process Price', type: 'number', readOnly: true },
  { key: 'material_price', label: 'Material Price', type: 'number', readOnly: true },
  { key: 'material_disc_percent', label: 'Material Disc %', type: 'number' },
  { key: 'material_disc_amount', label: 'Material Disc Amt', type: 'number' },
  { key: 'disc_material_price', label: 'Disc Material Price', type: 'number', readOnly: true },
  { key: 'net_of_tax', label: 'Net of Tax', type: 'number', readOnly: true },
  { key: 'tax_amount', label: 'Tax Amt', type: 'number', readOnly: true },
  { key: 'gross_amount', label: 'Gross Amt', type: 'number', readOnly: true },
  { key: 'remarks', label: 'Remarks', type: 'text' },
  { key: 'memo', label: 'Memo', type: 'text' },
  { key: 'gp_rate', label: 'GP Rate', type: 'number', readOnly: true },
  { key: 'process_cost', label: 'Process Cost', type: 'number', readOnly: true },
  { key: 'material_cost', label: 'Material Cost', type: 'number', readOnly: true },
  { key: 'total_cost', label: 'Total Cost', type: 'number', readOnly: true },
  { key: 'total_price', label: 'Total Price', type: 'number', readOnly: true },
];

function toPayload(row, fields) {
  const payload = {};
  fields.forEach((f) => { payload[f] = row[f] === '' || row[f] === undefined ? null : row[f]; });
  return payload;
}

export default function EstimateWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isNew = !id;

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [estimateId, setEstimateId] = useState(id ? Number(id) : null);
  const [estimateNo, setEstimateNo] = useState('');
  const [header, setHeader] = useState(EMPTY_HEADER);
  const [jobOrders, setJobOrders] = useState([]);
  const [shippingAddresses, setShippingAddresses] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [blanketPos, setBlanketPos] = useState([]);
  const [newPo, setNewPo] = useState('');
  const [newShipping, setNewShipping] = useState('');

  const [customers, setCustomers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [salesDivisions, setSalesDivisions] = useState([]);
  const [locations, setLocations] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [processesList, setProcessesList] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [units, setUnits] = useState([]);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [bracketsByProcess, setBracketsByProcess] = useState({});
  const [uomsByItem, setUomsByItem] = useState({});

  const jobOrdersRef = useRef(jobOrders);
  useEffect(() => { jobOrdersRef.current = jobOrders; }, [jobOrders]);
  const postingJobOrders = useRef(new Set());
  const postingProcesses = useRef(new Set());
  const uomsRef = useRef(uomsByItem);
  useEffect(() => { uomsRef.current = uomsByItem; }, [uomsByItem]);
  const bracketsRef = useRef(bracketsByProcess);
  useEffect(() => { bracketsRef.current = bracketsByProcess; }, [bracketsByProcess]);

  useEffect(() => { init(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true);
    const [cust, emp, sd, loc, jt, proc, tax, itm, uom, pt] = await Promise.all([
      api.get('/customers'),
      api.get('/employees'),
      api.get('/lookups/sales-divisions'),
      api.get('/lookups/locations'),
      api.get('/job-types'),
      api.get('/lookups/processes'),
      api.get('/lookups/taxes'),
      api.get('/inventory'),
      api.get('/lookups/units-of-measure'),
      api.get('/lookups/payment-terms'),
    ]);
    setCustomers(cust.data);
    setEmployees(emp.data);
    setSalesDivisions(sd.data);
    setLocations(loc.data);
    setJobTypes(jt.data);
    setProcessesList(proc.data);
    setTaxes(tax.data);
    setInventoryItems(itm.data);
    setUnits(uom.data);
    setPaymentTerms(pt.data);

    if (id) {
      await loadEstimate(Number(id));
    } else {
      // New estimate: Sales Rep/Prepared By default to the creating user, and Office
      // Location/Sales Division default to that user's own "Default Login Location"
      // branch (User Branches tab) -- their location goes straight to Office Location
      // (both are the same locations table); their branch's Department is matched by
      // name against Sales Division (e.g. a user branched to "Support" gets Sales
      // Division "Support" pre-selected) since those are two separate lookup tables
      // with no direct FK between them.
      const overrides = {};
      if (user?.employee_id) {
        overrides.sales_rep_id = user.employee_id;
        overrides.prepared_by_id = user.employee_id;
      }
      if (user?.default_branch?.location_id) {
        overrides.office_location_id = user.default_branch.location_id;
      }
      if (user?.default_branch?.department_name) {
        const match = sd.data.find((s) => s.name.toLowerCase() === user.default_branch.department_name.toLowerCase());
        if (match) overrides.sales_division_id = match.id;
      }
      if (Object.keys(overrides).length) setHeader((h) => ({ ...h, ...overrides }));
    }
    setLoading(false);
  }

  async function loadEstimate(estId) {
    const { data } = await api.get(`/estimates/${estId}`);
    setEstimateId(data.id);
    setEstimateNo(data.estimate_no);
    const h = { ...EMPTY_HEADER };
    Object.keys(h).forEach((k) => { h[k] = typeof h[k] === 'boolean' ? !!data[k] : (data[k] ?? ''); });
    if (h.date_created) h.date_created = String(h.date_created).slice(0, 10);
    setHeader(h);
    const jobOrdersData = (data.jobOrders || []).map((jo) => ({ ...jo, processes: jo.processes || [] }));
    setJobOrders(jobOrdersData);
    const usedItemIds = [...new Set(jobOrdersData.flatMap((jo) => jo.processes.map((p) => p.item_id).filter(Boolean)))];
    usedItemIds.forEach((itemId) => ensureUomsLoaded(itemId));
    setShippingAddresses(data.shippingAddresses || []);
    await loadCustomerExtras(data.customer_id);
    const logs = await api.get(`/estimates/${estId}/audit-logs`);
    setAuditLogs(logs.data);
  }

  async function loadCustomerExtras(customerId) {
    if (!customerId) { setContacts([]); setBlanketPos([]); return; }
    const [custRes, poRes] = await Promise.all([
      api.get(`/customers/${customerId}`),
      api.get(`/blanket-pos?customer_id=${customerId}`),
    ]);
    setContacts(custRes.data.contacts || []);
    setBlanketPos(poRes.data);
  }

  function unitLabel(unitId) {
    return units.find((u) => u.id === unitId)?.title || '';
  }

  function setHeaderField(field, value) {
    setHeader((h) => ({ ...h, [field]: value }));
  }

  async function handleCustomerSelect(cust) {
    setHeader((h) => ({ ...h, customer_id: cust.id, contact_person_id: '', contact_email: '', contact_title: '', contact_phone: '', blanket_po_id: '' }));
    await loadCustomerExtras(cust.id);
  }

  function handleContactSelect(contact) {
    setHeader((h) => ({
      ...h, contact_person_id: contact.id,
      contact_email: contact.email || '', contact_title: contact.title || '', contact_phone: contact.phone || '',
    }));
  }

  function buildHeaderPayload() {
    const payload = { ...header };
    ['customer_id', 'contact_person_id', 'blanket_po_id', 'sales_rep_id', 'sales_division_id', 'office_location_id', 'prepared_by_id', 'approved_by_id']
      .forEach((k) => { payload[k] = payload[k] || null; });
    ['credit_limit', 'credit_balance', 'subtotal', 'discount_total', 'net_of_tax', 'tax_total', 'total_amount', 'est_gp_rate', 'est_gp_amount']
      .forEach((k) => { payload[k] = payload[k] === '' ? null : payload[k]; });
    return payload;
  }

  async function saveHeader() {
    if (!estimateId) return;
    await api.put(`/estimates/${estimateId}`, buildHeaderPayload());
  }

  async function goNextFromStep1(e) {
    e.preventDefault();
    setError('');
    try {
      if (!estimateId) {
        const { data } = await api.post('/estimates', buildHeaderPayload());
        setEstimateId(data.id);
        setEstimateNo(data.estimate_no);
        navigate(`/estimates/${data.id}/edit`, { replace: true });
      } else {
        await api.put(`/estimates/${estimateId}`, buildHeaderPayload());
      }
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function saveHeaderAndGoTo(nextStep) {
    setError('');
    try {
      await api.put(`/estimates/${estimateId}`, buildHeaderPayload());
      if (nextStep === 4) {
        const logs = await api.get(`/estimates/${estimateId}/audit-logs`);
        setAuditLogs(logs.data);
      }
      setStep(nextStep);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  // --- Job order row helpers ---

  function addJobOrderRow() {
    setJobOrders((prev) => [...prev, { _tempId: `draft-${Date.now()}`, id: null, ...EMPTY_JO, processes: [] }]);
  }

  function updateJobOrderField(idx, field, value) {
    setJobOrders((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  async function commitJobOrderRow(idx, overrides = {}) {
    if (Object.keys(overrides).length) {
      setJobOrders((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], ...overrides };
        return next;
      });
    }
    const row = { ...jobOrdersRef.current[idx], ...overrides };
    if (!row) return;
    if (row.id) {
      await api.put(`/estimates/${estimateId}/job-orders/${row.id}`, toPayload(row, JOB_ORDER_FIELDS));
      return;
    }
    if (!row.job_type_id || !row.quantity || !row.units) return;
    // A POST may already be in flight for this still-draft row (rapid sequential edits each
    // trigger a commit on blur). Skip firing a duplicate; the in-flight one will pick up the
    // latest field values once it resolves, and the next blur's PUT will catch anything after that.
    if (postingJobOrders.current.has(idx)) return;
    postingJobOrders.current.add(idx);
    try {
      const { data } = await api.post(`/estimates/${estimateId}/job-orders`, toPayload(row, JOB_ORDER_FIELDS));
      // Merge in only the server-assigned identifiers — keep whatever the user has typed into
      // this row since the request was fired, rather than overwriting it with the stale payload.
      setJobOrders((prev) => prev.map((r, i) => (i === idx ? { ...r, id: data.id, line_no: data.line_no, processes: [] } : r)));
    } finally {
      postingJobOrders.current.delete(idx);
    }
  }

  // triggerKey mirrors the process-line pattern: editing Quantity or Gross Amount
  // derives Price/Unit = Gross Amount / Quantity (Gross Amount itself comes from the
  // process lines' Total Price, via recalcJobOrderSubtotal); editing Disc % or Disc Amt
  // derives the other one from the (auto-computed) Subtotal, same bidirectional link as
  // the process discount fields.
  async function recalcAndCommitJobOrder(idx, overrides = {}, triggerKey = null) {
    const current = { ...jobOrdersRef.current[idx], ...overrides };
    const computed = {};

    if (triggerKey === 'quantity') {
      const qty = Number(current.quantity) || 0;
      computed.price_per_unit = qty ? Number((Number(current.gross_amount || 0) / qty).toFixed(4)) : null;
    }

    if (triggerKey === 'disc_percent' || triggerKey === 'disc_amount') {
      const subtotal = Number(current.subtotal) || 0;
      if (triggerKey === 'disc_percent') {
        computed.disc_amount = subtotal ? Number((subtotal * (Number(current.disc_percent) || 0) / 100).toFixed(2)) : 0;
      } else {
        computed.disc_percent = subtotal ? Number(((Number(current.disc_amount) || 0) / subtotal * 100).toFixed(2)) : 0;
      }
      const discAmount = computed.disc_amount ?? current.disc_amount;
      Object.assign(computed, computeJobOrderTax(subtotal, discAmount, current.tax_code_id));
      const qty = Number(current.quantity) || 0;
      computed.price_per_unit = qty ? Number((computed.gross_amount / qty).toFixed(4)) : null;
      const totalCost = Number((current.processes || []).reduce((s, p) => s + (Number(p.total_cost) || 0), 0).toFixed(2));
      computed.gp_amount = Number((computed.net_of_tax - totalCost).toFixed(2));
      computed.gp_rate = computed.net_of_tax ? Number((computed.gp_amount / computed.net_of_tax * 100).toFixed(2)) : null;
    }

    await commitJobOrderRow(idx, { ...overrides, ...computed });
  }

  async function deleteJobOrderRow(idx) {
    const row = jobOrdersRef.current[idx];
    if (row.id) {
      if (!confirm(`Delete job order line #${row.line_no}?`)) return;
      await api.delete(`/estimates/${estimateId}/job-orders/${row.id}`);
    }
    setJobOrders((prev) => prev.filter((_, i) => i !== idx));
  }

  // --- Process row helpers ---

  function addProcessRow(joIdx) {
    setJobOrders((prev) => prev.map((r, i) => (i === joIdx
      ? { ...r, processes: [...(r.processes || []), { _tempId: `draft-${Date.now()}`, id: null, ...EMPTY_PROC }] }
      : r)));
  }

  function updateProcessField(joIdx, procIdx, field, value) {
    setJobOrders((prev) => {
      const next = [...prev];
      const jo = { ...next[joIdx] };
      const procs = [...(jo.processes || [])];
      procs[procIdx] = { ...procs[procIdx], [field]: value };
      jo.processes = procs;
      next[joIdx] = jo;
      return next;
    });
  }

  async function commitProcessRow(joIdx, procIdx, overrides = {}) {
    if (Object.keys(overrides).length) {
      setJobOrders((prev) => {
        const next = [...prev];
        const jo = { ...next[joIdx] };
        const procs = [...(jo.processes || [])];
        procs[procIdx] = { ...procs[procIdx], ...overrides };
        jo.processes = procs;
        next[joIdx] = jo;
        return next;
      });
    }
    const jo = jobOrdersRef.current[joIdx];
    const row = { ...jo?.processes?.[procIdx], ...overrides };
    if (!jo?.id || !row) return;
    if (row.id) {
      await api.put(`/estimates/${estimateId}/job-orders/${jo.id}/processes/${row.id}`, toPayload(row, PROCESS_FIELDS));
      const updatedProcs = (jo.processes || []).map((p, pi) => (pi === procIdx ? row : p));
      await recalcJobOrderSubtotal(joIdx, updatedProcs);
    } else {
      if (!row.process_id) return;
      const key = `${joIdx}-${procIdx}`;
      if (postingProcesses.current.has(key)) return;
      postingProcesses.current.add(key);
      let data;
      try {
        ({ data } = await api.post(`/estimates/${estimateId}/job-orders/${jo.id}/processes`, toPayload(row, PROCESS_FIELDS)));
      } finally {
        postingProcesses.current.delete(key);
      }
      setJobOrders((prev) => prev.map((r, i) => {
        if (i !== joIdx) return r;
        const procs = [...(r.processes || [])];
        procs[procIdx] = { ...procs[procIdx], id: data.id, line_no: data.line_no };
        return { ...r, processes: procs };
      }));
      const updatedProcs = (jo.processes || []).map((p, pi) => (pi === procIdx ? { ...row, id: data.id, line_no: data.line_no } : p));
      await recalcJobOrderSubtotal(joIdx, updatedProcs);
    }
  }

  // Job Order Net of Tax = Subtotal - Disc Amt, Tax Amt = Net of Tax x the selected Tax
  // Code's rate (0 if none picked), Gross Amt = Net of Tax + Tax Amt -- computed here so
  // every trigger that can change subtotal, disc_amount, or tax_code_id (process-row
  // edits, Disc %/Amt edits, and picking a Tax Code) goes through the same formula.
  function computeJobOrderTax(subtotal, discAmount, taxCodeId) {
    const net_of_tax = Number((Number(subtotal || 0) - Number(discAmount || 0)).toFixed(2));
    const taxRate = taxCodeId ? Number(taxes.find((t) => t.id === Number(taxCodeId))?.rate) || 0 : 0;
    const tax_amount = Number((net_of_tax * taxRate / 100).toFixed(2));
    const gross_amount = Number((net_of_tax + tax_amount).toFixed(2));
    return { net_of_tax, tax_amount, gross_amount };
  }

  // Job Order Subtotal is the total of its process lines' Net of Tax -- recomputed
  // whenever a process line is added, edited, or removed. Net of Tax/Tax Amt/Gross Amt
  // then follow via computeJobOrderTax, and Price/Unit follows from the freshly computed
  // Gross Amount (Gross Amount / Quantity). If the job already has a Disc % set, Disc Amt
  // is refreshed to match the new subtotal (percent stays authoritative, same rule as the
  // process-line discount pairs).
  //
  // GP Amount = Net of Tax - (sum of process lines' Total Cost), GP Rate = GP Amount /
  // Net of Tax x 100 -- the same margin formula as each process line's own GP Rate, just
  // rolled up to the job-order's totals. Both are fully derived, never typed into.
  async function recalcJobOrderSubtotal(joIdx, processes) {
    const subtotal = Number(processes.reduce((s, p) => s + (Number(p.net_of_tax) || 0), 0).toFixed(2));
    const totalCost = Number(processes.reduce((s, p) => s + (Number(p.total_cost) || 0), 0).toFixed(2));
    const jo = jobOrdersRef.current[joIdx];
    const discPercent = Number(jo?.disc_percent) || 0;
    const qty = Number(jo?.quantity) || 0;
    const overrides = { subtotal };
    if (discPercent) {
      overrides.disc_amount = Number((subtotal * discPercent / 100).toFixed(2));
    }
    const discAmount = overrides.disc_amount ?? jo?.disc_amount;
    Object.assign(overrides, computeJobOrderTax(subtotal, discAmount, jo?.tax_code_id));
    overrides.price_per_unit = qty ? Number((overrides.gross_amount / qty).toFixed(4)) : null;
    overrides.gp_amount = Number((overrides.net_of_tax - totalCost).toFixed(2));
    overrides.gp_rate = overrides.net_of_tax ? Number((overrides.gp_amount / overrides.net_of_tax * 100).toFixed(2)) : null;
    await commitJobOrderRow(joIdx, overrides);
  }

  async function ensureBracketsLoaded(processId) {
    if (!processId) return [];
    if (bracketsRef.current[processId]) return bracketsRef.current[processId];
    const { data } = await api.get(`/processes/${processId}/cost-brackets`);
    bracketsRef.current = { ...bracketsRef.current, [processId]: data };
    setBracketsByProcess((prev) => ({ ...prev, [processId]: data }));
    return data;
  }

  // Each item's Unit dropdown on a process line is populated from that item's own
  // Unit of Measures list (Inventory item's "Unit of Measures" tab) -- fetched once per
  // item and cached, same pattern as ensureBracketsLoaded above.
  async function ensureUomsLoaded(itemId) {
    if (!itemId) return [];
    if (uomsRef.current[itemId]) return uomsRef.current[itemId];
    const { data } = await api.get(`/inventory/${itemId}/unit-of-measures`);
    uomsRef.current = { ...uomsRef.current, [itemId]: data };
    setUomsByItem((prev) => ({ ...prev, [itemId]: data }));
    return data;
  }

  // Auto-calculate process_cost/material_cost/total_cost/material_price/total_price/gross_amount
  // whenever the process, material, quantity, or size changes on a process line -- this is
  // what makes filling in qty + size "just generate the price" per the real system.
  //
  // triggerKey identifies which input field the user just blurred, and drives a
  // bidirectional link between each Disc % and its Disc Amt (Process and Material each
  // have their own independent pair):
  // - editing Disc % derives Disc Amt = price x pct / 100 (e.g. Price 100 + Disc % 10
  //   => Disc Amt 10)
  // - editing Disc Amt derives Disc % = amt / price x 100 (e.g. Price 100 + Disc Amt 10
  //   => Disc % 10)
  // Only the pair matching triggerKey is touched -- the other pair (and non-discount
  // fields) are left as whatever's already on the row.
  async function recalcAndCommitProcess(joIdx, procIdx, overrides = {}, triggerKey = null) {
    const current = { ...jobOrdersRef.current[joIdx]?.processes?.[procIdx], ...overrides };
    const brackets = await ensureBracketsLoaded(current.process_id);
    const inventory = current.item_id ? inventoryItems.find((i) => i.id === Number(current.item_id)) : null;
    const pricingArgs = {
      brackets, inventory, processQty: current.process_qty, qty: current.qty, length: current.length, width: current.width, uom: current.uom,
    };

    let discAmount = current.process_disc_amount;
    let materialDiscAmount = current.material_disc_amount;
    const discOverrides = {};

    const needsBase = ['process_disc_percent', 'process_disc_amount', 'material_disc_percent', 'material_disc_amount'].includes(triggerKey);
    if (needsBase) {
      const base = computeAutoPricing({ ...pricingArgs, discAmount, materialDiscAmount });
      if (triggerKey === 'process_disc_percent' && base.process_price) {
        discAmount = Number((base.process_price * (Number(current.process_disc_percent) || 0) / 100).toFixed(2));
        discOverrides.process_disc_amount = discAmount;
      }
      if (triggerKey === 'process_disc_amount' && base.process_price) {
        discOverrides.process_disc_percent = Number(((Number(current.process_disc_amount) || 0) / base.process_price * 100).toFixed(2));
      }
      if (triggerKey === 'material_disc_percent' && base.material_price) {
        materialDiscAmount = Number((base.material_price * (Number(current.material_disc_percent) || 0) / 100).toFixed(2));
        discOverrides.material_disc_amount = materialDiscAmount;
      }
      if (triggerKey === 'material_disc_amount' && base.material_price) {
        discOverrides.material_disc_percent = Number(((Number(current.material_disc_amount) || 0) / base.material_price * 100).toFixed(2));
      }
    }

    const computed = computeAutoPricing({ ...pricingArgs, discAmount, materialDiscAmount });
    await commitProcessRow(joIdx, procIdx, { ...overrides, ...discOverrides, ...computed });
  }

  async function deleteProcessRow(joIdx, procIdx) {
    const jo = jobOrdersRef.current[joIdx];
    const row = jo.processes[procIdx];
    if (row.id) {
      if (!confirm(`Delete process line #${row.line_no}?`)) return;
      await api.delete(`/estimates/${estimateId}/job-orders/${jo.id}/processes/${row.id}`);
    }
    setJobOrders((prev) => prev.map((r, i) => (i === joIdx ? { ...r, processes: r.processes.filter((_, pi) => pi !== procIdx) } : r)));
    const updatedProcs = jo.processes.filter((_, pi) => pi !== procIdx);
    await recalcJobOrderSubtotal(joIdx, updatedProcs);
  }

  // --- Shipping / Blanket PO ---

  async function addShipping() {
    if (!newShipping) return;
    const { data } = await api.post(`/estimates/${estimateId}/shipping-addresses`, { address: newShipping });
    setShippingAddresses((prev) => [...prev, data]);
    setNewShipping('');
  }

  async function removeShipping(addrId) {
    await api.delete(`/estimates/${estimateId}/shipping-addresses/${addrId}`);
    setShippingAddresses((prev) => prev.filter((a) => a.id !== addrId));
  }

  async function addBlanketPo() {
    if (!newPo || !header.customer_id) return;
    const { data } = await api.post('/blanket-pos', { customer_id: header.customer_id, po_number: newPo });
    setNewPo('');
    setBlanketPos((prev) => [data, ...prev]);
    setHeaderField('blanket_po_id', data.id);
  }

  // --- Cell renderers ---

  function jobOrderCell(col, row, idx) {
    const val = row[col.key] ?? '';
    if (col.type === 'picker-jobtype') {
      return (
        <EntityPicker
          label="Job Type" items={jobTypes} value={val} getLabel={(j) => j.display_name}
          columns={[{ key: 'display_name', label: 'Display Name' }, { key: 'base_unit', label: 'Base Unit' }]}
          searchKeys={['display_name']}
          onSelect={(j) => commitJobOrderRow(idx, { job_type_id: j.id })}
        />
      );
    }
    if (col.type === 'picker-location') {
      return (
        <EntityPicker
          label="Job Location" items={locations} value={val} getLabel={(l) => l.location_name}
          columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
          searchKeys={['location_name', 'location_code']}
          onSelect={(l) => commitJobOrderRow(idx, { job_location_id: l.id })}
        />
      );
    }
    if (col.type === 'picker-tax') {
      return (
        <EntityPicker
          label="Tax Code" items={taxes} value={val} getLabel={(t) => t.code}
          columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate %' }]}
          searchKeys={['code', 'name']}
          onSelect={(t) => {
            const jo = jobOrdersRef.current[idx];
            const computed = computeJobOrderTax(jo?.subtotal, jo?.disc_amount, t.id);
            const qty = Number(jo?.quantity) || 0;
            computed.price_per_unit = qty ? Number((computed.gross_amount / qty).toFixed(4)) : null;
            commitJobOrderRow(idx, { tax_code_id: t.id, ...computed });
          }}
        />
      );
    }
    if (col.type === 'select-units') {
      return (
        <select value={val} onChange={(e) => { updateJobOrderField(idx, col.key, e.target.value); commitJobOrderRow(idx, { units: e.target.value }); }}>
          <option value="">—</option>
          {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      );
    }
    if (col.readOnly) {
      return <input value={val} readOnly tabIndex={-1} />;
    }
    const isPricingInput = col.key === 'quantity' || col.key === 'disc_percent' || col.key === 'disc_amount';
    return (
      <input
        type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : col.type === 'time' ? 'time' : 'text'}
        step={col.type === 'number' ? '0.0001' : undefined}
        value={val}
        onChange={(e) => updateJobOrderField(idx, col.key, e.target.value)}
        onBlur={() => (isPricingInput ? recalcAndCommitJobOrder(idx, {}, col.key) : commitJobOrderRow(idx))}
      />
    );
  }

  function processCell(col, row, joIdx, procIdx) {
    const val = row[col.key] ?? '';
    if (col.type === 'picker-process') {
      return (
        <EntityPicker
          label="Process" items={processesList} value={val} getLabel={(p) => p.process_name}
          columns={[{ key: 'process_name', label: 'Process Name' }, { key: 'process_code', label: 'Code' }, { key: 'base_unit', label: 'Base Unit', render: (p) => unitLabel(p.base_unit_id) }]}
          searchKeys={['process_name', 'process_code']}
          onSelect={(p) => recalcAndCommitProcess(joIdx, procIdx, { process_id: p.id, process_uom: unitLabel(p.base_unit_id) })}
        />
      );
    }
    if (col.type === 'picker-item') {
      return (
        <EntityPicker
          label="Material" items={inventoryItems} value={val} getLabel={(i) => i.display_name}
          columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }, { key: 'category_name', label: 'Category' }]}
          searchKeys={['item_code', 'display_name']}
          onSelect={async (i) => {
            await ensureUomsLoaded(i.id);
            recalcAndCommitProcess(joIdx, procIdx, {
              item_id: i.id, unit: unitLabel(i.base_unit_id), uom: i.base_unit_code || '',
            });
          }}
        />
      );
    }
    if (col.type === 'select-uom') {
      const uomOptions = row.item_id ? (uomsByItem[row.item_id] || []) : [];
      return (
        <select
          value={val}
          disabled={!row.item_id}
          onChange={(e) => recalcAndCommitProcess(joIdx, procIdx, { uom: e.target.value })}
        >
          {val && !uomOptions.some((u) => u.code === val) && <option value={val}>{val}</option>}
          <option value="">—</option>
          {uomOptions.map((u) => <option key={u.id} value={u.code}>{u.code}</option>)}
        </select>
      );
    }
    if (col.readOnly) {
      return <input value={val} readOnly tabIndex={-1} />;
    }
    const isPricingInput = col.key === 'qty' || col.key === 'length' || col.key === 'width'
      || col.key === 'process_qty' || col.key === 'process_disc_amount' || col.key === 'material_disc_amount'
      || col.key === 'process_disc_percent' || col.key === 'material_disc_percent';
    return (
      <input
        type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : col.type === 'time' ? 'time' : 'text'}
        step={col.type === 'number' ? '0.0001' : undefined}
        value={val}
        onChange={(e) => updateProcessField(joIdx, procIdx, col.key, e.target.value)}
        onBlur={() => (isPricingInput ? recalcAndCommitProcess(joIdx, procIdx, {}, col.key) : commitProcessRow(joIdx, procIdx))}
      />
    );
  }

  const employeeLabel = (e) => `${e.first_name} ${e.last_name}`;
  const employeeColumns = [
    { key: 'name', label: 'Name', render: employeeLabel },
    { key: 'position_title', label: 'Position' },
  ];

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>ESTIMATE — {isNew && !estimateId ? 'Create' : estimateNo}</h1>
        <button className="btn" onClick={() => navigate('/estimates')}>Back to Lists</button>
      </div>

      <div className="card">
        <div className="wizard-steps">
          {STEPS.map((label, i) => (
            <Fragment key={label}>
              <button
                type="button"
                className={`wizard-step ${step === i + 1 ? 'active' : ''}`}
                disabled={i + 1 > 1 && !estimateId}
                onClick={() => setStep(i + 1)}
              >
                <span className="num">{i + 1}</span> {label}
              </button>
              {i < STEPS.length - 1 && <span className="wizard-step-line" />}
            </Fragment>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {step === 1 && (
          <form onSubmit={goNextFromStep1}>
            <div className="wizard-cols">
              <div className="wizard-col">
                <div className="field">
                  <label>Date Created</label>
                  <input required type="date" value={header.date_created} onChange={(e) => setHeaderField('date_created', e.target.value)} />
                </div>
                <div className="field">
                  <label>Customer</label>
                  <EntityPicker
                    required label="Customer" items={customers} value={header.customer_id} getLabel={(c) => c.name}
                    columns={[{ key: 'name', label: 'Name' }, { key: 'company_name', label: 'Company' }]}
                    searchKeys={['name', 'company_name', 'customer_code']}
                    onSelect={handleCustomerSelect}
                  />
                </div>
                <div className="field">
                  <label>Contact Name</label>
                  <EntityPicker
                    label="Contact Name" items={contacts} value={header.contact_person_id} getLabel={(c) => c.contact_name}
                    columns={[{ key: 'contact_name', label: 'Name' }, { key: 'title', label: 'Title' }, { key: 'email', label: 'Email' }]}
                    searchKeys={['contact_name', 'email']}
                    onSelect={handleContactSelect}
                    disabled={!header.customer_id}
                    placeholder={header.customer_id ? 'Select contact...' : 'Select a customer first'}
                  />
                </div>
                <div className="field"><label>Contact Email</label><input value={header.contact_email} onChange={(e) => setHeaderField('contact_email', e.target.value)} /></div>
                <div className="field"><label>Contact Title</label><input value={header.contact_title} onChange={(e) => setHeaderField('contact_title', e.target.value)} /></div>
                <div className="field"><label>Contact Phone</label><input value={header.contact_phone} onChange={(e) => setHeaderField('contact_phone', e.target.value)} /></div>
                <div className="field">
                  <label>Blanket PO</label>
                  <EntityPicker
                    label="Blanket PO" items={blanketPos} value={header.blanket_po_id} getLabel={(p) => p.po_number}
                    columns={[{ key: 'po_number', label: 'PO Number' }, { key: 'memo', label: 'Memo' }]}
                    searchKeys={['po_number']}
                    onSelect={(p) => setHeaderField('blanket_po_id', p.id)}
                    disabled={!header.customer_id}
                    placeholder={header.customer_id ? 'Select PO...' : 'Select a customer first'}
                  />
                  {header.customer_id && (
                    <div className="inline-form" style={{ marginTop: 6 }}>
                      <div className="field"><input placeholder="New PO number" value={newPo} onChange={(e) => setNewPo(e.target.value)} /></div>
                      <button type="button" className="btn btn-sm" onClick={addBlanketPo}>Add</button>
                    </div>
                  )}
                </div>
                <div className="field"><label>Blanket PO Memo</label><input value={header.blanket_po_memo} onChange={(e) => setHeaderField('blanket_po_memo', e.target.value)} /></div>
              </div>

              <div className="wizard-col">
                <div className="field">
                  <label>Sales Rep.</label>
                  <EntityPicker
                    label="Sales Rep" items={employees} value={header.sales_rep_id} getLabel={employeeLabel}
                    columns={employeeColumns} searchKeys={['first_name', 'last_name', 'employee_code']}
                    onSelect={(e) => setHeaderField('sales_rep_id', e.id)}
                  />
                </div>
                <div className="field">
                  <label>Sales Division</label>
                  <EntityPicker
                    label="Sales Division" items={salesDivisions} value={header.sales_division_id} getLabel={(s) => s.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                    onSelect={(s) => setHeaderField('sales_division_id', s.id)}
                  />
                </div>
                <div className="field">
                  <label>Office Location</label>
                  <EntityPicker
                    label="Office Location" items={locations} value={header.office_location_id} getLabel={(l) => l.location_name}
                    columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
                    searchKeys={['location_name', 'location_code']}
                    onSelect={(l) => setHeaderField('office_location_id', l.id)}
                  />
                </div>
                <div className="field">
                  <label>Contract Description</label>
                  <textarea required rows={2} value={header.contract_description} onChange={(e) => setHeaderField('contract_description', e.target.value)} />
                </div>
                <div className="field">
                  <label>Memo</label>
                  <textarea rows={2} value={header.memo} onChange={(e) => setHeaderField('memo', e.target.value)} />
                </div>
                <div className="field"><label>Shipping Address</label><input value={header.shipping_address} onChange={(e) => setHeaderField('shipping_address', e.target.value)} /></div>
                <div className="field-checkbox">
                  <input type="checkbox" id="multi-ship" checked={header.has_multiple_shipping} onChange={(e) => setHeaderField('has_multiple_shipping', e.target.checked)} />
                  <label htmlFor="multi-ship">Multiple Shipping Address</label>
                </div>
              </div>

              <div className="wizard-col">
                <div className="field"><label>Production Lead Time</label><input required value={header.production_lead_time} onChange={(e) => setHeaderField('production_lead_time', e.target.value)} placeholder="e.g. 5 working days" /></div>
                <div className="field"><label>Price Validity</label><input value={header.price_validity} onChange={(e) => setHeaderField('price_validity', e.target.value)} placeholder="e.g. 30 days" /></div>
                <div className="field">
                  <label>Order Confirmation</label>
                  <select value={header.order_confirmation_type} onChange={(e) => setHeaderField('order_confirmation_type', e.target.value)}>
                    <option value="">—</option>
                    {ORDER_CONFIRMATION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className="field">
                  <div className="field-checkbox">
                    <input type="checkbox" id="print-w" checked={header.print_warranty} onChange={(e) => setHeaderField('print_warranty', e.target.checked)} />
                    <label htmlFor="print-w">Print Warranty</label>
                  </div>
                  {header.print_warranty && <input placeholder="Term e.g. 6 Months" value={header.print_warranty_term} onChange={(e) => setHeaderField('print_warranty_term', e.target.value)} />}
                </div>
                <div className="field">
                  <div className="field-checkbox">
                    <input type="checkbox" id="struct-w" checked={header.structure_warranty} onChange={(e) => setHeaderField('structure_warranty', e.target.checked)} />
                    <label htmlFor="struct-w">Structure Warranty</label>
                  </div>
                  {header.structure_warranty && <input placeholder="Term e.g. 12 Months" value={header.structure_warranty_term} onChange={(e) => setHeaderField('structure_warranty_term', e.target.value)} />}
                </div>
                <div className="field">
                  <div className="field-checkbox">
                    <input type="checkbox" id="elec-w" checked={header.electrical_warranty} onChange={(e) => setHeaderField('electrical_warranty', e.target.checked)} />
                    <label htmlFor="elec-w">Electrical Warranty</label>
                  </div>
                  {header.electrical_warranty && <input placeholder="Term e.g. 3 Months" value={header.electrical_warranty_term} onChange={(e) => setHeaderField('electrical_warranty_term', e.target.value)} />}
                </div>
              </div>
            </div>

            <div className="wizard-actions">
              <span />
              <button type="submit" className="btn btn-primary">NEXT</button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div>
            <div className="field-row" style={{ maxWidth: 500, marginBottom: 16 }}>
              <div className="field">
                <label>Shipping Address</label>
                <input value={header.shipping_address} onChange={(e) => setHeaderField('shipping_address', e.target.value)} onBlur={saveHeader} />
              </div>
              <div className="field-checkbox" style={{ alignSelf: 'center', marginTop: 18 }}>
                <input type="checkbox" id="multi-ship-2" checked={header.has_multiple_shipping} onChange={(e) => { setHeaderField('has_multiple_shipping', e.target.checked); api.put(`/estimates/${estimateId}`, { ...buildHeaderPayload(), has_multiple_shipping: e.target.checked }); }} />
                <label htmlFor="multi-ship-2">Multiple Shipping Address</label>
              </div>
            </div>
            {header.has_multiple_shipping && (
              <div className="subsection" style={{ marginTop: 0 }}>
                <DataTable
                  columns={[{ key: 'address', label: 'Address' }]}
                  rows={shippingAddresses}
                  actions={(a) => <button className="btn btn-sm btn-danger" onClick={() => removeShipping(a.id)}>Remove</button>}
                  emptyLabel="No additional shipping addresses yet."
                />
                <div className="inline-form" style={{ marginTop: 10 }}>
                  <div className="field"><input placeholder="New address" value={newShipping} onChange={(e) => setNewShipping(e.target.value)} /></div>
                  <button type="button" className="btn btn-sm" onClick={addShipping}>Add</button>
                </div>
              </div>
            )}

            <div className="spreadsheet-wrap">
              <table className="spreadsheet-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {JOB_ORDER_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                {jobOrders.map((jo, idx) => {
                  const missing = !jo.job_type_id || !jo.quantity || !jo.units;
                  return (
                    <tbody key={jo.id || jo._tempId}>
                      <tr className={!jo.id ? 'draft-row' : ''}>
                        <td>
                          <div className="spreadsheet-row-actions">
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => deleteJobOrderRow(idx)}>✕</button>
                          </div>
                        </td>
                        {JOB_ORDER_COLUMNS.map((col) => <td key={col.key}>{jobOrderCell(col, jo, idx)}</td>)}
                      </tr>
                      <tr>
                        <td colSpan={JOB_ORDER_COLUMNS.length + 1} style={{ background: 'var(--bg)' }}>
                          {!jo.id ? (
                            <p className="muted" style={{ margin: 8 }}>
                              {missing ? 'Fill Job Type, Quantity, and Units to save this line before adding processes.' : 'Saving…'}
                            </p>
                          ) : (
                            <div style={{ padding: 8 }}>
                              <div className="spreadsheet-wrap">
                                <table className="spreadsheet-table">
                                  <thead>
                                    <tr>
                                      <th>#</th>
                                      {PROCESS_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(jo.processes || []).map((proc, procIdx) => (
                                      <tr key={proc.id || proc._tempId} className={`process-row ${!proc.id ? 'draft-row' : ''}`}>
                                        <td>
                                          <button type="button" className="btn btn-sm btn-danger" onClick={() => deleteProcessRow(idx, procIdx)}>✕</button>
                                        </td>
                                        {PROCESS_COLUMNS.map((col) => <td key={col.key}>{processCell(col, proc, idx, procIdx)}</td>)}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => addProcessRow(idx)}>Add Process</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  );
                })}
              </table>
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={addJobOrderRow}>Add Job</button>

            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(1)}>PREVIOUS</button>
              <button type="button" className="btn btn-primary" onClick={() => saveHeaderAndGoTo(3)}>NEXT</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="wizard-cols">
              <div className="wizard-col">
                <div className="field">
                  <label>Credit Term</label>
                  <EntityPicker
                    label="Credit Term" items={paymentTerms}
                    value={paymentTerms.find((t) => t.term_name === header.credit_term)?.id ?? ''}
                    getLabel={(t) => t.term_name}
                    columns={[{ key: 'term_name', label: 'Term' }, { key: 'no_of_days', label: 'No. of Days' }]}
                    searchKeys={['term_name']}
                    onSelect={(t) => setHeaderField('credit_term', t.term_name)}
                  />
                </div>
                <div className="field"><label>Credit Limit</label><input type="number" step="0.01" value={header.credit_limit} onChange={(e) => setHeaderField('credit_limit', e.target.value)} /></div>
                <div className="field"><label>Credit Balance</label><input type="number" step="0.01" value={header.credit_balance} onChange={(e) => setHeaderField('credit_balance', e.target.value)} /></div>
                <div className="field"><label>Bill-To Contact #</label><input value={header.bill_to_contact_number} onChange={(e) => setHeaderField('bill_to_contact_number', e.target.value)} /></div>
              </div>
            </div>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(2)}>PREVIOUS</button>
              <button type="button" className="btn btn-primary" onClick={() => saveHeaderAndGoTo(4)}>NEXT</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h3>Summary</h3>
            <div className="review-grid">
              <div className="item"><div className="label">Estimate No.</div><div className="value">{estimateNo}</div></div>
              <div className="item"><div className="label">Customer</div><div className="value">{customers.find((c) => c.id === header.customer_id)?.name || '—'}</div></div>
              <div className="item"><div className="label">Status</div><div className="value">{header.status.replaceAll('_', ' ')}</div></div>
              <div className="item"><div className="label">Total Amount</div><div className="value">{jobOrders.reduce((s, jo) => s + (Number(jo.gross_amount) || 0), 0).toFixed(2)}</div></div>
              <div className="item"><div className="label">Sales Rep</div><div className="value">{employees.find((e) => e.id === header.sales_rep_id) ? employeeLabel(employees.find((e) => e.id === header.sales_rep_id)) : '—'}</div></div>
              <div className="item"><div className="label">Production Lead Time</div><div className="value">{header.production_lead_time || '—'}</div></div>
            </div>

            <h3 className="subsection">Job Orders</h3>
            <DataTable
              columns={[
                { key: 'line_no', label: '#' },
                { key: 'description', label: 'Description' },
                { key: 'quantity', label: 'Qty' },
                { key: 'units', label: 'Units' },
                { key: 'gross_amount', label: 'Gross' },
              ]}
              rows={jobOrders.filter((jo) => jo.id)}
              emptyLabel="No job order lines."
            />

            <h3 className="subsection">Shipping Addresses</h3>
            <DataTable columns={[{ key: 'address', label: 'Address' }]} rows={shippingAddresses} emptyLabel="None." />

            <h3 className="subsection">Audit Trail</h3>
            <DataTable
              columns={[
                { key: 'set_at', label: 'When', render: (r) => new Date(r.set_at).toLocaleString() },
                { key: 'set_by_name', label: 'Set By' },
                { key: 'event_type', label: 'Type' },
                { key: 'field_name', label: 'Field' },
                { key: 'old_value', label: 'Old Value' },
                { key: 'new_value', label: 'New Value' },
              ]}
              rows={auditLogs}
              emptyLabel="No audit history yet."
            />

            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(3)}>PREVIOUS</button>
              <button type="button" className="btn btn-primary" onClick={() => navigate('/estimates')}>Back to Lists</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
