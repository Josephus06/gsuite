import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { computeProcessCosting } from '../utils/costing';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

const EMPTY_BRACKET = {
  qty_min: '', qty_max: '', click_charge: 0, ink_cost: 0, direct_labor: 0,
  moh_power_equipment: 0, moh_depreciation: 0, moh_repairs_maintenance: 0,
  moh_indirect_materials: 0, moh_indirect_labor: 0, other_charges: 0, sub_con: 0,
  costing_allowance_pct: 0, markup_cogs_pct: 0, opex_admin_pct: 0, opex_selling_pct: 0,
  disc_ceiling_pct: 0, disc_supervisor_pct: 0, disc_manager_pct: 0, disc_gm_pct: 0,
  selling_price_override: '', is_active: true,
};

const BRACKET_FIELDS = Object.keys(EMPTY_BRACKET);

const COLUMNS = [
  { key: 'qty_min', label: 'Qty Min' },
  { key: 'qty_max', label: 'Qty Max' },
  { key: 'click_charge', label: 'Click Charge' },
  { key: 'ink_cost', label: 'Ink Cost' },
  { key: 'direct_labor', label: 'Direct Labor' },
  { key: 'moh_power_equipment', label: 'MOH (P/E)' },
  { key: 'moh_depreciation', label: 'MOH (DC)' },
  { key: 'moh_repairs_maintenance', label: 'MOH (R&M)' },
  { key: 'moh_indirect_materials', label: 'MOH (IM&C)' },
  { key: 'moh_indirect_labor', label: 'MOH (IL)' },
  { key: 'other_charges', label: 'Other Charges' },
  { key: 'sub_con', label: 'Sub Con' },
  { key: 'costing_allowance_pct', label: 'Costing Allowance %' },
  { key: 'markup_cogs_pct', label: 'Mark-Up COGS %' },
  { key: 'opex_admin_pct', label: 'OPEX Admin %' },
  { key: 'opex_selling_pct', label: 'OPEX Selling %' },
  { key: 'disc_ceiling_pct', label: 'Disc. Ceiling %' },
  { key: 'disc_supervisor_pct', label: 'Disc. Supervisor %' },
  { key: 'disc_manager_pct', label: 'Disc. Manager %' },
  { key: 'disc_gm_pct', label: 'Disc. GM %' },
  { key: 'selling_price_override', label: 'Price Override' },
];

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

  async function selectProcess(proc) {
    setSelected(proc);
    const { data } = await api.get(`/processes/${proc.id}/cost-brackets`);
    setBrackets(data);
  }

  function updateBracketField(idx, field, value) {
    setBrackets((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  async function commitBracket(idx) {
    const row = brackets[idx];
    const payload = {};
    BRACKET_FIELDS.forEach((f) => { payload[f] = row[f] === '' ? null : row[f]; });
    if (row.id) {
      await api.put(`/processes/${selected.id}/cost-brackets/${row.id}`, payload);
    } else {
      if (row.qty_min === '' || row.qty_max === '') return;
      const { data } = await api.post(`/processes/${selected.id}/cost-brackets`, payload);
      setBrackets((prev) => prev.map((r, i) => (i === idx ? data : r)));
    }
  }

  function addBracket() {
    setBrackets((prev) => [...prev, { ...EMPTY_BRACKET }]);
  }

  async function deleteBracket(idx) {
    const row = brackets[idx];
    if (row.id) {
      if (!confirm('Delete this cost bracket?')) return;
      await api.delete(`/processes/${selected.id}/cost-brackets/${row.id}`);
    }
    setBrackets((prev) => prev.filter((_, i) => i !== idx));
  }

  const filteredProcesses = processes.filter((p) =>
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
                One row per quantity bracket. Cost/COGS/Price are computed live from the raw inputs.
              </p>
              <div className="spreadsheet-wrap">
                <table className="spreadsheet-table">
                  <thead>
                    <tr>
                      <th></th>
                      {COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                      <th>SubTotal MOH</th>
                      <th>Cost Basis <span className="muted">(SubTotal + Sub Con)</span></th>
                      <th>COGS</th>
                      <th>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brackets.map((b, idx) => {
                      const computed = computeProcessCosting(b);
                      return (
                        <tr key={b.id || `draft-${idx}`} className={!b.id ? 'draft-row' : ''}>
                          <td>
                            {can('/process-costing', 'can_delete') && (
                              <button type="button" className="btn btn-sm btn-danger" onClick={() => deleteBracket(idx)}>✕</button>
                            )}
                          </td>
                          {COLUMNS.map((c) => (
                            <td key={c.key}>
                              <input
                                type={c.key === 'is_active' ? 'checkbox' : 'number'}
                                step="0.01"
                                value={b[c.key]}
                                onChange={(e) => updateBracketField(idx, c.key, e.target.value)}
                                onBlur={() => commitBracket(idx)}
                              />
                            </td>
                          ))}
                          <td>{computed ? computed.subtotalMoh.toFixed(2) : '—'}</td>
                          <td><strong>{computed ? computed.costBasis.toFixed(2) : '—'}</strong></td>
                          <td>{computed ? computed.costPerUnit.toFixed(2) : '—'}</td>
                          <td><strong>{computed ? computed.pricePerUnit.toFixed(2) : '—'}</strong></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {can('/process-costing', 'can_add') && (
                <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={addBracket}>Add Bracket</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
