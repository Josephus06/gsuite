import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

export default function Users() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/users');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(row) {
    if (!confirm(`Delete user "${row.username}"?`)) return;
    try {
      await api.delete(`/users/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  const columns = [
    { key: 'username', label: 'Username' },
    { key: 'account_type', label: 'Account Type' },
    { key: 'display_name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'default_branch_name', label: 'Default Branch' },
    { key: 'last_login_at', label: 'Last Login', render: (r) => (r.last_login_at ? new Date(r.last_login_at).toLocaleString() : '—') },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Users</h1>
        {can('/users', 'can_add') && <button className="btn btn-primary" onClick={() => navigate('/users/new')}>Add User</button>}
      </div>
      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            actions={(row) => (
              <>
                {can('/users', 'can_edit') && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/users/${row.id}/edit`)}>Edit</button>}
                {can('/users', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>
    </div>
  );
}
