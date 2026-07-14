import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's "Add / Update User" screen: a 4-step wizard (User
// Account -> User Branches -> User Permissions and Restrictions -> Account Type)
// instead of a single modal form + a separate permissions modal.
const STEPS = ['User Account', 'User Branches', 'User Permissions and Restrictions', 'Account Type'];

const ACCOUNT_TYPE_OPTIONS = [
  'Sales', 'Production', 'Costing', 'Logistics', 'Accounts Receivable',
  'Account Manager', 'Artist', 'General Manager', 'System Admin',
];

const PERMISSION_ACTIONS = [
  { key: 'can_view', label: 'Can View' },
  { key: 'can_add', label: 'Can Add' },
  { key: 'can_edit', label: 'Can Update' },
  { key: 'can_delete', label: 'Can Delete' },
  { key: 'can_approve', label: 'Can Approve' },
];

const EMPTY_ACCOUNT = {
  is_active: true, username: '', password: '', email: '', display_name: '', employee_id: '', default_branch_id: '',
};

const EMPTY_ACCOUNT_TYPE = {
  user_group_id: '', account_type: '', can_approve_sales_estimate: false, is_account_officer: false,
  is_supervisor: false, is_sales_manager: false, is_sales_marketing_director: false, is_sales_business_unit: false,
  is_design_supervisor: false, is_purchasing_supervisor: false, approval_code: '', supervisor_id: '',
};

const EMPTY_BRANCH = { location_id: '', department_id: '', can_override_date: false, remarks: '', is_default: false };

export default function UserWizard() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [userId, setUserId] = useState(id ? Number(id) : null);
  const [account, setAccount] = useState(EMPTY_ACCOUNT);
  const [accountType, setAccountType] = useState(EMPTY_ACCOUNT_TYPE);
  const [branches, setBranches] = useState([]);
  const [permMap, setPermMap] = useState({});

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [userGroups, setUserGroups] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [pages, setPages] = useState([]);
  const [permSearch, setPermSearch] = useState('');

  useEffect(() => { init(); }, [id]);

  async function init() {
    setLoading(true);
    const [emp, loc, dept, groups, pgs, usrs] = await Promise.all([
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/lookups/user-groups'),
      api.get('/users/meta/pages'),
      api.get('/users'),
    ]);
    setEmployees(emp.data);
    setLocations(loc.data);
    setDepartments(dept.data);
    setUserGroups(groups.data);
    setPages(pgs.data);
    setAllUsers(usrs.data.filter((u) => !id || u.id !== Number(id)));

    if (id) {
      const { data } = await api.get(`/users/${id}`);
      setUserId(data.id);
      setAccount({
        is_active: !!data.is_active, username: data.username, password: '', email: data.email,
        display_name: data.display_name, employee_id: data.employee_id || '', default_branch_id: data.default_branch_id || '',
      });
      setAccountType({
        user_group_id: data.user_group_id || '', account_type: data.account_type || '',
        can_approve_sales_estimate: !!data.can_approve_sales_estimate, is_account_officer: !!data.is_account_officer,
        is_supervisor: !!data.is_supervisor, is_sales_manager: !!data.is_sales_manager,
        is_sales_marketing_director: !!data.is_sales_marketing_director, is_sales_business_unit: !!data.is_sales_business_unit,
        is_design_supervisor: !!data.is_design_supervisor, is_purchasing_supervisor: !!data.is_purchasing_supervisor,
        approval_code: data.approval_code || '', supervisor_id: data.supervisor_id || '',
      });
      setBranches((data.branches || []).map((b) => ({
        location_id: b.location_id, department_id: b.department_id || '',
        can_override_date: !!b.can_override_date, remarks: b.remarks || '', is_default: !!b.is_default,
      })));
      const map = {};
      for (const p of data.permissions) map[p.page_id] = p;
      setPermMap(map);
    }
    setLoading(false);
  }

  function handleEmployeeSelect(emp) {
    setAccount((a) => ({ ...a, employee_id: emp.id, display_name: `${emp.first_name} ${emp.last_name}` }));
  }

  function addBranchRow() {
    setBranches((prev) => [...prev, { ...EMPTY_BRANCH }]);
  }

  function updateBranch(idx, field, value) {
    setBranches((prev) => prev.map((b, i) => {
      if (i !== idx) {
        // Only one branch can be the default login location.
        if (field === 'is_default' && value) return { ...b, is_default: false };
        return b;
      }
      return { ...b, [field]: value };
    }));
  }

  function removeBranch(idx) {
    setBranches((prev) => prev.filter((_, i) => i !== idx));
  }

  function togglePerm(pageId, key) {
    setPermMap((prev) => {
      const current = prev[pageId] || { page_id: pageId, can_view: false, can_add: false, can_edit: false, can_delete: false, can_approve: false };
      return { ...prev, [pageId]: { ...current, [key]: !current[key] } };
    });
  }

  async function handleSave() {
    setError('');
    const payload = { ...account, ...accountType, employee_id: account.employee_id || null, default_branch_id: account.default_branch_id || null, user_group_id: accountType.user_group_id || null };
    if (!payload.password) delete payload.password;
    setSaving(true);
    try {
      let uid = userId;
      if (!uid) {
        if (!payload.username || !payload.password || !payload.email || !payload.display_name) {
          setError('Username, Password, Email Address, and Employee Name are required.');
          return false;
        }
        const { data } = await api.post('/users', payload);
        uid = data.id;
        setUserId(uid);
        navigate(`/users/${uid}/edit`, { replace: true });
      } else {
        await api.put(`/users/${uid}`, payload);
      }
      await api.put(`/users/${uid}/branches`, { branches });
      await api.put(`/users/${uid}/permissions`, { permissions: Object.values(permMap) });
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function goNext() {
    if (await handleSave()) setStep((s) => Math.min(4, s + 1));
  }

  async function handleSubmit() {
    if (await handleSave()) navigate('/users');
  }

  const employeeLabel = (e) => `${e.first_name} ${e.last_name}`;
  const filteredPages = pages.filter((p) => p.name.toLowerCase().includes(permSearch.toLowerCase()));

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Add / Update User</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate('/users')}>Back</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="wizard-steps">
          {STEPS.map((label, i) => (
            <Fragment key={label}>
              <button
                type="button"
                className={`wizard-step ${step === i + 1 ? 'active' : ''}`}
                disabled={i + 1 > 1 && !userId}
                onClick={() => setStep(i + 1)}
              >
                <span className="num">{i + 1}</span> {label}
              </button>
              {i < STEPS.length - 1 && <span className="wizard-step-line" />}
            </Fragment>
          ))}
        </div>

        {step === 1 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Enter your User Account Details</h3>
            <div className="field-checkbox">
              <input type="checkbox" id="user-active" checked={account.is_active} onChange={(e) => setAccount({ ...account, is_active: e.target.checked })} />
              <label htmlFor="user-active">Active</label>
            </div>
            <div className="field">
              <label>Username</label>
              <input value={account.username} onChange={(e) => setAccount({ ...account, username: e.target.value })} />
            </div>
            <div className="field">
              <label>Password {userId && <span className="muted">(leave blank to keep unchanged)</span>}</label>
              <input type="password" value={account.password} onChange={(e) => setAccount({ ...account, password: e.target.value })} />
            </div>
            <div className="field">
              <label>Email Address</label>
              <input type="email" value={account.email} onChange={(e) => setAccount({ ...account, email: e.target.value })} />
            </div>
            <div className="field">
              <label>Employee Name</label>
              <EntityPicker
                label="Employee" items={employees} value={account.employee_id} getLabel={employeeLabel}
                columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={handleEmployeeSelect}
              />
            </div>
            <div className="wizard-actions">
              <span />
              <button type="button" className="btn btn-primary" disabled={saving} onClick={goNext}>Next Step</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Define User Branches that it can access</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Department</th>
                    <th>Can Override Date</th>
                    <th>Remarks</th>
                    <th>Default Login Location</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((b, idx) => (
                    <tr key={idx}>
                      <td>
                        <select value={b.location_id} onChange={(e) => updateBranch(idx, 'location_id', e.target.value)}>
                          <option value="">Select...</option>
                          {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={b.department_id} onChange={(e) => updateBranch(idx, 'department_id', e.target.value)}>
                          <option value="">—</option>
                          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={b.can_override_date} onChange={(e) => updateBranch(idx, 'can_override_date', e.target.checked)} />
                      </td>
                      <td>
                        <input value={b.remarks} onChange={(e) => updateBranch(idx, 'remarks', e.target.value)} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={b.is_default} onChange={(e) => updateBranch(idx, 'is_default', e.target.checked)} />
                      </td>
                      <td><button type="button" className="btn btn-sm btn-danger" onClick={() => removeBranch(idx)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={addBranchRow}>Add Branch</button>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(1)}>Previous</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={goNext}>Next Step</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Define User Permission and Restrictions</h3>
            <div className="field" style={{ maxWidth: 320 }}>
              <input placeholder="Search..." value={permSearch} onChange={(e) => setPermSearch(e.target.value)} />
            </div>
            <div className="table-wrap">
              <table className="perm-table">
                <thead>
                  <tr>
                    <th>Page</th>
                    {PERMISSION_ACTIONS.map((a) => <th key={a.key}>{a.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredPages.map((page) => {
                    const perm = permMap[page.id] || {};
                    return (
                      <tr key={page.id}>
                        <td>{page.name}</td>
                        {PERMISSION_ACTIONS.map((a) => (
                          <td key={a.key} style={{ textAlign: 'center' }}>
                            <input type="checkbox" checked={!!perm[a.key]} onChange={() => togglePerm(page.id, a.key)} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(2)}>Previous</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={goNext}>Next Step</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Define Account Type</h3>
            <div className="field">
              <label>User Group</label>
              <EntityPicker
                label="User Group" items={userGroups} value={accountType.user_group_id} getLabel={(g) => g.name}
                columns={[{ key: 'name', label: 'Name' }]}
                searchKeys={['name']}
                onSelect={(g) => setAccountType({ ...accountType, user_group_id: g.id })}
              />
            </div>
            <div className="field">
              <label>Account Type</label>
              <select value={accountType.account_type} onChange={(e) => setAccountType({ ...accountType, account_type: e.target.value })}>
                <option value="">Select...</option>
                {ACCOUNT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            {[
              ['can_approve_sales_estimate', 'Can Approve Sales Estimate'],
              ['is_account_officer', 'Account Officer'],
              ['is_supervisor', 'Supervisor'],
              ['is_sales_manager', 'Sales Manager'],
              ['is_sales_marketing_director', 'Sales and Marketing Director'],
              ['is_sales_business_unit', 'Sales Business Unit'],
              ['is_design_supervisor', 'Design Supervisor'],
              ['is_purchasing_supervisor', 'Purchasing Supervisor'],
            ].map(([key, label]) => (
              <div className="field-checkbox" key={key}>
                <input type="checkbox" id={key} checked={accountType[key]} onChange={(e) => setAccountType({ ...accountType, [key]: e.target.checked })} />
                <label htmlFor={key}>{label}</label>
              </div>
            ))}
            <div className="field">
              <label>Approval Code</label>
              <input value={accountType.approval_code} onChange={(e) => setAccountType({ ...accountType, approval_code: e.target.value })} />
            </div>
            <div className="field">
              <label>Supervisor <span className="muted">(who this Account Officer's Dashboard data rolls up to)</span></label>
              <EntityPicker
                label="Supervisor" items={allUsers} value={accountType.supervisor_id} getLabel={(u) => u.display_name}
                columns={[{ key: 'display_name', label: 'Name' }, { key: 'username', label: 'Username' }]}
                searchKeys={['display_name', 'username']}
                onSelect={(u) => setAccountType({ ...accountType, supervisor_id: u.id })}
              />
            </div>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(3)}>Previous</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSubmit}>Submit</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
