import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { computeProcessCosting } from '../utils/costing';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

const EMPTY_BRACKET = {
  qty_min: '', qty_max: '', click_charge: 0, new_ink_cost: 0, ink_cost: 0, direct_labor: 0,
  moh_power_equipment: 0, moh_depreciation: 0, moh_repairs_maintenance: 0,
  moh_indirect_materials: 0, moh_indirect_labor: 0, other_charges: 0, sub_con: 0, markup_sub_con_pct: 0,
  costing_allowance_pct: 0, markup_cogs_pct: 0, opex_admin_pct: 0, markup_opex_admin_pct: 0,
  opex_selling_pct: 0, markup_opex_selling_pct: 0,
  disc_ceiling_pct: 0, disc_supervisor_pct: 0, disc_manager_pct: 0, disc_gm_pct: 0,
  selling_price_override: '', costing_reference: '', is_active: true,
};

const BRACKET_FIELDS = Object.keys(EMPTY_BRACKET);

// The costing team's workbook (costing.xlsx), column for column. An entry with `key` is an input;
// one with `calc` is a formula cell, computed live by computeProcessCosting (shared/costing.js,
// which documents each formula). Percent inputs sit left of the amount they produce, as in the
// workbook.
const COLUMNS = [
  { key: 'qty_min', label: 'Qty Min' },
  { key: 'qty_max', label: 'Qty Max' },
  { key: 'click_charge', label: 'Click Charge' },
  { key: 'new_ink_cost', label: 'New INK Cost' },
  { key: 'ink_cost', label: 'INK' },
  { key: 'direct_labor', label: 'DL' },
  { key: 'moh_power_equipment', label: 'MOH (P/E)' },
  { key: 'moh_depreciation', label: 'MOH (DC)' },
  { key: 'moh_repairs_maintenance', label: 'MOH (R&M)' },
  { key: 'moh_indirect_materials', label: 'MOH (IM&C)' },
  { key: 'moh_indirect_labor', label: 'MOH (IL)' },
  { key: 'other_charges', label: 'Other Charges' },
  { calc: 'subtotalMoh', label: 'SubTotal' },
  { key: 'costing_allowance_pct', label: 'Costing Allowance %' },
  { calc: 'costingAllowance', label: 'Costing Allowance' },
  { calc: 'subtotalAllowance', label: 'SubTotal (COGS)' },
  { key: 'markup_cogs_pct', label: 'Mark-Up (COGS) %' },
  { calc: 'markupCogs', label: 'Mark-Up (COGS)' },
  { calc: 'costPerUnit', label: 'Total (COGS)', strong: true },
  { key: 'opex_admin_pct', label: 'OPEX (Admin) %' },
  { calc: 'opexAdmin', label: 'OPEX (Admin)' },
  { key: 'markup_opex_admin_pct', label: 'Mark-Up OPEX (Admin) %' },
  { calc: 'markupOpexAdmin', label: 'Mark-Up OPEX (Admin)' },
  { key: 'opex_selling_pct', label: 'OPEX (Selling) %' },
  { calc: 'opexSelling', label: 'OPEX (Selling)' },
  { key: 'markup_opex_selling_pct', label: 'Mark-Up OPEX (Selling) %' },
  { calc: 'markupOpexSelling', label: 'Mark-Up OPEX (Selling)' },
  { calc: 'totalOpex', label: 'Total OPEX', strong: true },
  { key: 'sub_con', label: 'Sub Con' },
  { key: 'markup_sub_con_pct', label: 'Mark-Up Sub Con %' },
  { calc: 'markupSubCon', label: 'Mark-Up Sub Con' },
  { calc: 'totalSubCon', label: 'Total Sub Con', strong: true },
  { calc: 'priceUnrounded', label: 'Total Price', strong: true },
  { key: 'selling_price_override', label: 'Selling Price', placeholderCalc: 'pricePerUnit' },
  { key: 'costing_reference', label: 'Costing Reference', text: true },
  { key: 'disc_ceiling_pct', label: 'DC Account Officer %' },
  { calc: 'discCeiling', label: 'DC Account Officer' },
  { key: 'disc_supervisor_pct', label: 'DC Sales Supervisor %' },
  { calc: 'discSupervisor', label: 'DC Sales Supervisor' },
  { key: 'disc_manager_pct', label: 'DC Sales Manager %' },
  { calc: 'discManager', label: 'DC Sales Manager' },
  { key: 'disc_gm_pct', label: 'DC General Manager %' },
  { calc: 'discGm', label: 'DC General Manager' },
];
// Formula cells show 4 decimals, as the unit costs run to fractions of a centavo (0.1045).
const fmt = (v) => (v == null || Number.isNaN(v) ? '—' : Number(v.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 }));

export default function ProcessCosting() {
  const { can } = useAuth();
  const [processes, setProcesses] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [brackets, setBrackets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    (async () => {
      const { data } = await api.get('/lookups/processes');
      setProcesses(data);
      setLoading(false);
    })();
  }, []);

  // Edits are held on the screen until Save -- a changed row is marked `_dirty` (new rows start
  // dirty) and nothing reaches the server until the Save button sends them all.
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null); // { ok, text }
  const dirtyCount = brackets.filter((b) => b._dirty).length;

  // Leaving the page with unsaved edits asks first.
  useEffect(() => {
    if (!dirtyCount) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);

  async function selectProcess(proc) {
    if (dirtyCount && !confirm(`You have ${dirtyCount} unsaved bracket change${dirtyCount === 1 ? '' : 's'} on ${selected.process_name}. Discard them?`)) return;
    setSelected(proc);
    setSaveMsg(null);
    const { data } = await api.get(`/processes/${proc.id}/cost-brackets`);
    setBrackets(data);
  }

  function updateBracketField(idx, field, value) {
    setSaveMsg(null);
    setBrackets((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value, _dirty: true };
      return next;
    });
  }

  async function saveAll() {
    const incomplete = brackets.find((b) => b._dirty && !b.id && (b.qty_min === '' || b.qty_max === ''));
    if (incomplete) { setSaveMsg({ ok: false, text: 'Enter Qty Min and Qty Max on every new bracket before saving.' }); return; }
    setSaving(true);
    setSaveMsg(null);
    let saved = 0;
    const next = [...brackets];
    try {
      for (let i = 0; i < next.length; i += 1) {
        const row = next[i];
        if (!row._dirty) continue;
        const payload = {};
        BRACKET_FIELDS.forEach((f) => { payload[f] = row[f] === '' ? null : row[f]; });
        const { data } = row.id
          ? await api.put(`/processes/${selected.id}/cost-brackets/${row.id}`, payload)
          : await api.post(`/processes/${selected.id}/cost-brackets`, payload);
        next[i] = data;
        saved += 1;
      }
      setSaveMsg({ ok: true, text: `Saved ${saved} bracket${saved === 1 ? '' : 's'}.` });
    } catch (err) {
      setSaveMsg({ ok: false, text: `Saved ${saved}, then stopped: ${err.response?.data?.error || 'the save failed'}. The unsaved rows are still marked.` });
    } finally {
      setBrackets(next);
      setSaving(false);
    }
  }

  function addBracket() {
    setSaveMsg(null);
    setBrackets((prev) => [...prev, { ...EMPTY_BRACKET, _dirty: true }]);
  }

  async function deleteBracket(idx) {
    const row = brackets[idx];
    if (row.id) {
      if (!confirm('Delete this cost bracket?')) return;
      await api.delete(`/processes/${selected.id}/cost-brackets/${row.id}`);
    }
    setBrackets((prev) => prev.filter((_, i) => i !== idx));
  }

  const filteredProcesses = processes.filter((p) => p.is_active).filter((p) =>
    !search || p.process_name.toLowerCase().includes(search.toLowerCase()) || p.process_code.toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filteredProcesses.length / PAGE_SIZE));
  const pageProcesses = filteredProcesses.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Process Costing</h1>
      </div>
      <div className="field" style={{ maxWidth: 360 }}>
        <input placeholder="Search processes..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div className="card" style={{ width: 340, flexShrink: 0, maxHeight: 600, overflowY: 'auto' }}>
          {loading ? <LoadingSpinner /> : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {pageProcesses.map((p) => (
                    <tr
                      key={p.id}
                      className="picker-row"
                      style={selected?.id === p.id ? { background: 'var(--accent-bg)' } : undefined}
                      onClick={() => selectProcess(p)}
                    >
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.process_code}</div>
                        <div className="muted">{p.process_name}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
        </div>

        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          {!selected ? (
            <p className="muted">Select a process to manage its cost brackets.</p>
          ) : (
            <>
              <h2>{selected.process_name}</h2>
              <p className="muted" style={{ marginBottom: 16 }}>
                One row per quantity bracket, laid out as the costing workbook. Shaded columns are
                formulas, computed live from the inputs. Selling Price is the price set on the bracket;
                left blank, it is the Total Price rounded up to the peso.
              </p>
              <div className="spreadsheet-wrap">
                <table className="spreadsheet-table">
                  <thead>
                    <tr>
                      <th></th>
                      {COLUMNS.map((c) => <th key={c.key || c.calc} style={c.calc ? { background: 'var(--accent-bg)' } : undefined}>{c.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {brackets.map((b, idx) => {
                      const computed = computeProcessCosting(b);
                      return (
                        <tr key={b.id || `draft-${idx}`} className={!b.id ? 'draft-row' : ''}
                          style={b._dirty ? { boxShadow: 'inset 3px 0 0 var(--warning, #d97706)' } : undefined}
                          title={b._dirty ? 'Unsaved changes' : undefined}>
                          <td>
                            {can('/process-costing', 'can_delete') && (
                              <button type="button" className="btn btn-sm btn-danger" onClick={() => deleteBracket(idx)}>✕</button>
                            )}
                          </td>
                          {COLUMNS.map((c) => (c.calc ? (
                            <td key={c.calc} className="text-right" style={{ background: 'var(--accent-bg)', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                              {c.strong ? <strong>{fmt(computed?.[c.calc])}</strong> : fmt(computed?.[c.calc])}
                            </td>
                          ) : (
                            <td key={c.key}>
                              <input
                                type={c.text ? 'text' : 'number'}
                                step="any"
                                value={b[c.key] ?? ''}
                                placeholder={c.placeholderCalc && computed ? fmt(computed[c.placeholderCalc]) : undefined}
                                onChange={(e) => updateBracketField(idx, c.key, e.target.value)}
                              />
                            </td>
                          )))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                {can('/process-costing', 'can_add') && (
                  <button type="button" className="btn" onClick={addBracket}>Add Bracket</button>
                )}
                {(can('/process-costing', 'can_edit') || can('/process-costing', 'can_add')) && (
                  <button type="button" className="btn btn-primary" disabled={saving || !dirtyCount} onClick={saveAll}>
                    {saving ? 'Saving…' : `Save${dirtyCount ? ` (${dirtyCount})` : ''}`}
                  </button>
                )}
                {dirtyCount > 0 && !saving && <span className="muted">{dirtyCount} unsaved bracket{dirtyCount === 1 ? '' : 's'} — marked on the left.</span>}
                {saveMsg && <span style={{ color: saveMsg.ok ? 'var(--success, #15803d)' : 'var(--danger, #b91c1c)', fontWeight: 600 }}>{saveMsg.text}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
