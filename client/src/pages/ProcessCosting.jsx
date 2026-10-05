import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';

const PAGE_SIZE = 15;

// Costing > Process Costing, laid out as the source's PROCESS COSTING list: General Searching, then
// Process Code / Process Name / UOM with a View button. View opens the process's costing brackets
// (ProcessCostingView), Edit there opens the bracket form (ProcessCostingEdit).
export default function ProcessCosting() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [processes, setProcesses] = useState([]);
  const [unitCode, setUnitCode] = useState(new Map());
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    Promise.all([api.get('/lookups/processes'), api.get('/lookups/units-of-measure')]).then(([p, u]) => {
      setProcesses(p.data.filter((x) => x.is_active).sort((a, b) => String(a.process_code).localeCompare(String(b.process_code))));
      setUnitCode(new Map(u.data.map((x) => [x.id, x.code])));
      setLoading(false);
    });
  }, []);

  function runSearch() { setApplied(search); setPage(1); }
  useAutoSearch(search, runSearch);

  const q = applied.trim().toLowerCase();
  const rows = processes.filter((p) => !q
    || String(p.process_name || '').toLowerCase().includes(q)
    || String(p.process_code || '').toLowerCase().includes(q));
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Process Costing <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>Lists</span></h1>
        {can('/process-costing', 'can_add') && (
          <button type="button" className="btn btn-primary" onClick={() => navigate('/process-costing/new')}>Add New</button>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field" style={{ maxWidth: 860 }}>
          <label>General Searching</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Search" />
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Process Code</th><th>Process Name</th><th>UOM</th><th style={{ width: 70 }} /></tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No processes found.</td></tr>
                )}
                {pageRows.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Process Code">{p.process_code}</td>
                    <td data-label="Process Name">{p.process_name}</td>
                    <td data-label="UOM">{unitCode.get(p.base_unit_id) || ''}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/process-costing/${p.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
