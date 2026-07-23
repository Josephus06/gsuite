import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import NonStandardJobOrderFormModal from '../components/NonStandardJobOrderFormModal';

const ROUTE = '/non-standard-job-orders';

export default function NonStandardJobOrders() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  async function load() {
    const { data } = await api.get(ROUTE, { params: { page, limit: 10, search } });
    setRows(data.rows);
    setTotal(data.total);
  }

  useEffect(() => { load(); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-header">
        <h1>Saved Non-Standard Job Orders</h1>
        <div>
          <button className="btn btn-sm" onClick={() => { setPage(1); load(); }}>Search</button>{' '}
          <button className="btn btn-primary" onClick={() => setOpen(true)}>Add New</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field">
          <label>General Searching</label>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="JO #, customer, or job description" />
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="responsive-cards">
            <thead><tr><th>JO #</th><th>Date Created</th><th>Sales Division</th><th>Job Type</th><th>PMS Job Type</th><th>Job Desc</th><th>Qty</th><th>Customer</th><th>Contact Person</th><th>Sales Rep</th><th>Artist</th><th>Delivery Date</th><th>Delivery Time</th><th>Status</th><th>Sub Status</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={16} className="muted" style={{ textAlign: 'center', padding: 20 }}>No non-standard job orders found.</td></tr>}
              {rows.map((row) => <tr key={row.id}>
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

      {open && <NonStandardJobOrderFormModal onClose={() => setOpen(false)} onSaved={load} />}
    </div>
  );
}
