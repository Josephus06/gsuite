import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

// Editing an OPEN invoice's header.
//
// The items are deliberately absent. They came from delivered-but-unbilled quantities, and
// billing them moved running totals on the job orders and the Sales Order's status -- see the
// note on PUT /sales-invoices/:id. What this corrects is the header: a mistyped PO number, the
// wrong term or due date, a missing BS/SI number, the wrong EWT rate. Quantities and prices are
// shown on the invoice behind this and stay exactly as billed.
//
// The one field here that moves money is Withholding Tax %, so the figures it drives are
// recomputed live beside it rather than appearing only after saving.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const day = (v) => (v ? String(v).slice(0, 10) : '');

export default function SalesInvoiceEditModal({ invoice, onClose, onSaved }) {
  const [dateCreated, setDateCreated] = useState(day(invoice.date_created));
  const [dateDue, setDateDue] = useState(day(invoice.date_due));
  const [term, setTerm] = useState(invoice.term || '');
  const [paymentTerm, setPaymentTerm] = useState(null);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [bsSiNo, setBsSiNo] = useState(invoice.bs_si_no || '');
  const [poNo, setPoNo] = useState(invoice.po_no || '');
  const [salesRep, setSalesRep] = useState(
    invoice.sales_rep_id ? { id: invoice.sales_rep_id, name: invoice.sales_rep_name } : null,
  );
  const [officeLocation, setOfficeLocation] = useState(
    invoice.office_location_id ? { id: invoice.office_location_id, location_name: invoice.office_location_name } : null,
  );
  const [department, setDepartment] = useState(
    invoice.department_id ? { id: invoice.department_id, name: invoice.department_name } : null,
  );
  const [billToAddress, setBillToAddress] = useState(invoice.bill_to_address || '');
  const [memo, setMemo] = useState(invoice.memo || '');
  const [withholdingPct, setWithholdingPct] = useState(Number(invoice.withholding_tax_pct || 0));
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/lookups/payment-terms'),
    ]).then(([empRes, locRes, deptRes, termRes]) => {
      setEmployees(empRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      const terms = termRes.data || [];
      setPaymentTerms(terms);
      // Open the picker on the term the invoice already carries. Matched case- and
      // space-insensitively, like the create modal, because these strings were typed by hand for
      // years before the list existed; one that matches nothing keeps its text rather than
      // blanking an agreed term.
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      setPaymentTerm(terms.find((t) => norm(t.term_name) === norm(invoice.term)) || null);
      setLoading(false);
    }).catch(() => { setError('Could not load the pickers.'); setLoading(false); });
  }, [invoice.term]);

  // The same arithmetic the server does, so the preview cannot say one thing and the save another:
  // the lines are fixed, so only EWT and Amount Due move.
  const pct = Number(withholdingPct) || 0;
  const ewt = Number(((Number(invoice.net_of_tax) || 0) * (pct / 100)).toFixed(2));
  const amountDue = Number(((Number(invoice.gross_amount) || 0) - ewt).toFixed(2));
  const pctValid = Number.isFinite(pct) && pct >= 0 && pct <= 100;

  async function save() {
    if (!pctValid) { setError('Withholding Tax % must be between 0 and 100.'); return; }
    setSaving(true);
    setError('');
    try {
      const { data } = await api.put(`/sales-invoices/${invoice.id}`, {
        date_created: dateCreated,
        date_due: dateDue || null,
        term: term || null,
        bs_si_no: bsSiNo,
        po_no: poNo,
        sales_rep_id: salesRep?.id || null,
        office_location_id: officeLocation?.id || null,
        department_id: department?.id || null,
        bill_to_address: billToAddress,
        memo,
        withholding_tax_pct: pct,
      });
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the Invoice.');
      setSaving(false);
    }
  }

  return (
    <Modal title={`Edit Invoice — ${invoice.invoice_no}`} onClose={onClose} large>
      {loading ? <LoadingSpinner /> : (
        <>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            {/* The term counts its days from the invoice date, so moving the date moves the due
                date with it -- the same rule the create form follows. */}
            <div className="field">
              <label>Date</label>
              <input
                type="date" value={dateCreated}
                onChange={(e) => {
                  setDateCreated(e.target.value);
                  if (paymentTerm && e.target.value) {
                    setDateDue(addDays(e.target.value, Number(paymentTerm.no_of_days) || 0));
                  }
                }}
              />
            </div>
            <div className="field">
              <label>Date Due</label>
              <input
                type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)}
                title={paymentTerm
                  ? `${paymentTerm.term_name} — ${Number(paymentTerm.no_of_days) || 0} day(s) from the invoice date`
                  : 'No term selected, so there is no basis for a due date'}
              />
            </div>
            <div className="field">
              <label>Term</label>
              <EntityPicker
                label="Term" items={paymentTerms} value={paymentTerm?.id || ''}
                getLabel={(t) => t.term_name}
                columns={[
                  { key: 'term_name', label: 'Term' },
                  { key: 'no_of_days', label: 'Days', render: (t) => Number(t.no_of_days || 0) },
                ]}
                searchKeys={['term_name']}
                placeholder={term || 'Select Term...'}
                onSelect={(t) => {
                  setPaymentTerm(t);
                  setTerm(t ? t.term_name : '');
                  if (t) setDateDue(addDays(dateCreated, Number(t.no_of_days) || 0));
                }}
                onClear={() => { setPaymentTerm(null); setTerm(''); }}
              />
            </div>
            <div className="field"><label>BS/SI #</label><input value={bsSiNo} onChange={(e) => setBsSiNo(e.target.value)} /></div>
            <div className="field"><label>PO #</label><input value={poNo} onChange={(e) => setPoNo(e.target.value)} /></div>
            <div className="field">
              <label>Sales Rep</label>
              <EntityPicker
                label="Sales Rep" items={employees} value={salesRep?.id || ''}
                getLabel={(e) => (e.name ? e.name : `${e.first_name} ${e.last_name}`)}
                columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={setSalesRep}
                onClear={() => setSalesRep(null)}
              />
            </div>
            <div className="field">
              <label>Office Location</label>
              <EntityPicker
                label="Office Location" items={locations} value={officeLocation?.id || ''}
                getLabel={(l) => l.location_name}
                columns={[{ key: 'location_name', label: 'Location' }]}
                searchKeys={['location_name']}
                onSelect={setOfficeLocation}
                onClear={() => setOfficeLocation(null)}
              />
            </div>
            <div className="field">
              <label>Department</label>
              <EntityPicker
                label="Department" items={departments} value={department?.id || ''}
                getLabel={(d) => d.name}
                columns={[{ key: 'name', label: 'Department' }]}
                searchKeys={['name']}
                onSelect={setDepartment}
                onClear={() => setDepartment(null)}
              />
            </div>
            <div className="field"><label>Bill to Address</label><input value={billToAddress} onChange={(e) => setBillToAddress(e.target.value)} /></div>
            <div className="field">
              <label>Withholding Tax %</label>
              <input
                type="number" min="0" max="100" step="0.01" value={withholdingPct}
                onChange={(e) => setWithholdingPct(e.target.value)}
              />
              {!pctValid && <span style={{ color: '#b91c1c', fontSize: 12 }}>Must be between 0 and 100.</span>}
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Memo</label>
              <textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          {/* What the edit will do to the money, before it is saved. Everything but EWT and
              Amount Due is the billed lines' own totals and cannot move here. */}
          <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)', marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax</span><span className="hi">{money(invoice.net_of_tax)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax</span><span className="hi">{money(invoice.tax_amount)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross</span><span className="hi">{money(invoice.gross_amount)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="muted">EWT</span>
              <span className="hi">
                {money(ewt)}
                {Number(ewt) !== Number(invoice.ewt_amount) && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>was {money(invoice.ewt_amount)}</span>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span>Amount Due</span>
              <span>
                {money(amountDue)}
                {Number(amountDue) !== Number(invoice.amount_due) && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12, fontWeight: 400 }}>was {money(invoice.amount_due)}</span>
                )}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || !pctValid}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
