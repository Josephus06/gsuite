import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { computeProcessCosting } from '../utils/costing';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDateTime } from '../utils/dates';
import { PROCESS_COSTING_COLUMNS, processCostingHeaderGroups, fmt2 } from '../utils/processCostingColumns';

// One process's costing brackets, read-only, as the source's process cost view: the process name
// in the banner, Costing and System Information tabs, a row per quantity bracket. Every figure is
// computeProcessCosting's, the same as the estimate wizard prices with.
export default function ProcessCostingView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [process, setProcess] = useState(null);
  const [brackets, setBrackets] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [tab, setTab] = useState('costing');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/processes'),
      api.get(`/processes/${id}/cost-brackets`),
      api.get(`/processes/${id}/audit-logs`).catch(() => ({ data: [] })),
    ]).then(([p, b, a]) => {
      setProcess(p.data.find((x) => String(x.id) === String(id)) || null);
      setBrackets(b.data);
      setAuditLogs(a.data);
      setLoading(false);
    });
  }, [id]);

  if (loading) return <LoadingSpinner />;
  if (!process) return <div className="card">Process not found.</div>;

  const groups = processCostingHeaderGroups();

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => navigate('/process-costing')}>Back</button>
          {(can('/process-costing', 'can_edit') || can('/process-costing', 'can_add')) && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/process-costing/${id}/edit`)}>Edit</button>
          )}
        </div>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1 style={{ fontSize: '2em' }}>{process.process_name}</h1>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 16 }}>
        <button type="button" className={`status-tab ${tab === 'costing' ? 'active' : ''}`} onClick={() => setTab('costing')}>Costing</button>
        <button type="button" className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Information</button>
      </div>

      {tab === 'costing' && (
        <div className="card">
          <div className="spreadsheet-wrap">
            <table className="spreadsheet-table pc-table">
              <thead>
                <tr>
                  <th>Qty Bracket</th>
                  {groups.map((g, i) => (
                    <th key={i} colSpan={g.span} className={`${g.shade ? 'pc-shade' : ''}${g.highlight ? ' pc-highlight' : ''}`}>{g.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {brackets.length === 0 && (
                  <tr><td colSpan={PROCESS_COSTING_COLUMNS.length + 1} className="muted" style={{ textAlign: 'center', padding: 20 }}>No costing brackets yet.</td></tr>
                )}
                {brackets.map((b) => {
                  const c = computeProcessCosting(b) || {};
                  return (
                    <tr key={b.id}>
                      <td className="text-right" style={{ whiteSpace: 'nowrap' }}>{`${Number(b.qty_min)}-${Number(b.qty_max)}`}</td>
                      {PROCESS_COSTING_COLUMNS.map((col) => (
                        <td
                          key={col.key || col.calc}
                          className={`${col.text ? '' : 'text-right'}${col.shade ? ' pc-shade' : ''}${col.highlight ? ' pc-highlight' : ''}`}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {col.text ? (b[col.key] || '') : fmt2(col.calc ? c[col.calc] : b[col.key])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'Date Time', render: (r) => displayDateTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' },
              { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' },
              { key: 'old_value', label: 'Old Value' },
              { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No changes recorded for this process yet."
          />
        </div>
      )}
    </div>
  );
}
