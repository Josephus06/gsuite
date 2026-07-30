import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

// Transaction Settings: the master list of transaction types with an "Is Posting" flag (whether the
// transaction posts to the ledger) and a display sequence. Mirrors the live screen.
export default function TransactionSettings() {
  const { can } = useAuth();
  const canEdit = can('/transaction-settings', 'can_edit');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    const { data } = await api.get('/transaction-settings');
    setRows(data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggle(row, value) {
    setError('');
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, is_posting: value ? 1 : 0 } : r)));
    try { await api.put(`/transaction-settings/${row.id}`, { is_posting: value ? 1 : 0 }); }
    catch (e) { setError(e.response?.data?.error || 'Update failed'); load(); }
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header"><h1>Transaction Settings</h1></div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th style={{ width: 70 }}>Seq</th><th>Transaction</th><th style={{ textAlign: 'center', width: 140 }}>Is Posting</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transaction types.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.seq}</td>
                  <td>{r.transaction_name}</td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={!!r.is_posting} disabled={!canEdit} onChange={(e) => toggle(r, e.target.checked)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
