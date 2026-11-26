import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Sales > 3D Studio Job Types (2026-11-25): which T1S Job Type an estimate made from the studio's
// "Create Estimate" gets, per sign category. A category appears here the first time a project of
// that category is sent; until it has a Job Type, Sales picks one on the estimate.
export default function StudioJobTypes() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const canEdit = can('/3d-studio/job-types', 'can_edit');

  async function load() {
    try {
      const [m, jt] = await Promise.all([api.get('/studio-estimate-drafts/job-types'), api.get('/job-types')]);
      setRows(m.data);
      setJobTypes(jt.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the mapping.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function choose(row, jobType) {
    setError(''); setSaved('');
    try {
      await api.put(`/studio-estimate-drafts/job-types/${encodeURIComponent(row.category_code)}`, { job_type_id: jobType?.id || null });
      setRows((p) => p.map((r) => (r.category_code === row.category_code
        ? { ...r, job_type_id: jobType?.id || null, job_type_name: jobType?.display_name || null } : r)));
      setSaved(`${row.category_name || row.category_code}: ${jobType?.display_name || 'cleared'}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save.');
    }
  }

  if (loading) return <LoadingSpinner />;
  return (
    <div>
      <div className="page-header"><h1>3D Studio Job Types</h1></div>
      <div className="card" style={{ marginBottom: 16 }}>
        <p className="muted" style={{ margin: 0 }}>
          The Job Type an estimate gets when it is made with <strong>Create Estimate</strong> in the 3D Studio, by the project's sign
          category. A category is listed the first time a project of that kind is sent. Without a Job Type here, Sales picks one on the estimate.
        </p>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="card" style={{ marginBottom: 12, padding: 10 }}>Saved: {saved}</div>}
      <div className="card">
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>Sign category (3D Studio)</th><th>Job Type (T1S)</th></tr></thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No category yet -- they appear here once a project is sent with Create Estimate.
                </td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.category_code}>
                  <td data-label="Sign category">{r.category_name || r.category_code}</td>
                  <td data-label="Job Type" style={{ minWidth: 320 }}>
                    {canEdit ? (
                      <EntityPicker
                        label="Job Type" items={jobTypes} value={r.job_type_id || ''} getLabel={(j) => j.display_name}
                        columns={[{ key: 'display_name', label: 'Display Name' }]} searchKeys={['display_name']}
                        onSelect={(j) => choose(r, j)}
                        onClear={() => choose(r, null)}
                        placeholder="Pick the Job Type..."
                      />
                    ) : (r.job_type_name || <span className="muted">not set</span>)}
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
