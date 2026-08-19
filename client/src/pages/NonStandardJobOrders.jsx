import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import NonStandardJobOrderFormModal from '../components/NonStandardJobOrderFormModal';

const ROUTE = '/non-standard-job-orders';
const SUB_SBU_APPROVAL = 'SBU Approval';
const SUB_SALES_APPROVAL = 'Sales Approval';

// Kept in step with LIST_TABS on the server, which is what actually filters. "For Approval"
// is both gates this module has -- an order queued for its SBU approver and a finished
// layout queued for Sales -- which is the same pair this page already lets an approver tick
// and bulk-approve, so the tab and the checkboxes agree about what is outstanding.
const LIST_TABS = [
  { key: 'all', label: 'All' },
  { key: 'for_approval', label: 'For Approval' },
  { key: 'approved', label: 'Approved' },
];

export default function NonStandardJobOrders() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('all');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [counts, setCounts] = useState({});

  const canApproveSales = can(ROUTE, 'can_approve');

  // An order is tickable only if this user could actually approve it: their own SBU queue,
  // or -- with approval rights -- a layout waiting on Sales. Offering a checkbox against a
  // row that will only ever come back "not yours" wastes the approver's time twice, once
  // ticking it and once reading why it failed.
  function selectable(row) {
    if (row.status === 'Cancelled') return false;
    if (row.sub_status === SUB_SBU_APPROVAL) return !!row.is_my_approval;
    if (row.sub_status === SUB_SALES_APPROVAL) return canApproveSales;
    return false;
  }

  const selectableIds = useMemo(() => rows.filter(selectable).map((r) => r.id), [rows, canApproveSales]); // eslint-disable-line react-hooks/exhaustive-deps
  const allTicked = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));

  function toggle(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function approveSelected() {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`${ROUTE}/bulk-approve`, { ids: selected });
      setResult(data);
      setSelected([]);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not approve the selected job orders.');
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const params = { page, limit: 10, search };
    if (tab !== 'all') params.tab = tab;
    const { data } = await api.get(ROUTE, { params });
    setRows(data.rows);
    setTotal(data.total);
    setCounts(data.counts || {});
    // Selection is per page of results. Carrying ticks across a page change would let
    // someone approve rows they can no longer see.
    setSelected([]);
  }

  useEffect(() => { load(); }, [page, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Page 1 whenever the criteria change: staying on page 4 of the previous result set
  // shows an empty table and looks like the search found nothing.
  function runSearch() {
    if (page === 1) load();
    else setPage(1);
  }

  function pickTab(key) {
    setPage(1);
    setTab(key);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Saved Non-Standard Job Orders</h1>
        <div>
          {selected.length > 0 && (
            <>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={approveSelected}>
                {busy ? 'Approving…' : `Approve ${selected.length} Selected`}
              </button>{' '}
            </>
          )}
          <button className="btn btn-sm" onClick={runSearch}>Search</button>{' '}
          <button className="btn btn-primary" onClick={() => setOpen(true)}>Add New</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field">
          <label>General Searching</label>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); runSearch(); } }}
            placeholder="JO #, customer, or job description"
          />
        </div>
      </div>

      <div className="status-tabs">
        {LIST_TABS.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => pickTab(t.key)}
          >
            {t.label} <span className="badge badge-muted">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr>
              <th style={{ width: 32 }}>
                {/* Ticks only what this user can actually approve on this page, which is
                    rarely every row -- so it is not a plain "select all". */}
                <input
                  type="checkbox" checked={allTicked} disabled={selectableIds.length === 0}
                  onChange={() => setSelected(allTicked ? [] : selectableIds)}
                  title="Select every job order on this page awaiting your approval"
                />
              </th>
              <th>JO #</th><th>Date Created</th><th>Sales Division</th><th>Job Type</th><th>PMS Job Type</th><th>Job Desc</th><th>Qty</th><th>Customer</th><th>Contact Person</th><th>Sales Rep</th><th>Artist</th><th>Delivery Date</th><th>Delivery Time</th><th>Status</th><th>Sub Status</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={17} className="muted" style={{ textAlign: 'center', padding: 20 }}>No non-standard job orders found.</td></tr>}
              {rows.map((row) => <tr key={row.id}>
                <td>
                  {selectable(row) && (
                    <input
                      type="checkbox" checked={selected.includes(row.id)}
                      onChange={() => toggle(row.id)}
                      title={`Approve ${row.nstdjo_no}`}
                    />
                  )}
                </td>
                <td>{row.nstdjo_no}</td><td>{String(row.date_created).slice(0, 10)}</td><td>{row.sales_division_name}</td>
                <td>{row.job_type}</td>
                <td>{row.pms_job_type_name || ''}</td><td>{row.description}</td><td>{row.quantity}</td><td>{row.customer_name}</td>
                <td>{row.contact_person_name || ''}</td>
                <td>{row.sales_rep_name}</td><td>{row.artist_name || ''}</td><td>{String(row.delivery_date).slice(0, 10)}</td><td>{row.delivery_time || ''}</td><td>{row.status}</td>
                {/* Flagged so an approver can spot what is waiting on them from the list. */}
                <td>{row.sub_status}{row.is_my_approval && row.sub_status === 'SBU Approval' ? ' (yours)' : ''}</td>
                <td><button className="btn btn-sm" onClick={() => navigate(`${ROUTE}/${row.id}`)}>View</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / 10))} onChange={setPage} />
      </div>

      {result && (
        <Modal title="Approval Results" onClose={() => setResult(null)}>
          <p>
            {result.approved.length} of {result.requested} approved
            {result.skipped.length > 0 ? `, ${result.skipped.length} not.` : '.'}
          </p>
          {result.approved.length > 0 && (
            <ul>
              {result.approved.map((r) => (
                <li key={`ok-${r.id}`}>{r.nstdjo_no} — approved ({r.gate} gate) → {r.sub_status}</li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <>
              <h4>Not approved</h4>
              <ul>
                {result.skipped.map((r) => (
                  <li key={`no-${r.id}`}>{r.nstdjo_no || `#${r.id}`} — {r.reason}</li>
                ))}
              </ul>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setResult(null)}>Close</button>
          </div>
        </Modal>
      )}

      {open && <NonStandardJobOrderFormModal onClose={() => setOpen(false)} onSaved={load} />}
    </div>
  );
}
