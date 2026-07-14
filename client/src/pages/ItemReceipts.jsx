import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }
function locationLabel(l) { return l ? l.location_name : ''; }
function employeeLabel(e) { return e ? `${e.first_name} ${e.last_name}` : ''; }

// Global "Saved Item Receipts" list -- every Item Receipt across every Transfer Order /
// Item Fulfillment, filterable the same way the real system's own screen is. Previously
// these were only reachable one Item Fulfillment at a time (its Related Records tab);
// this gives the same standalone browse the real system has. Creating one still only
// happens via a specific OPEN Item Fulfillment's "Receive" flow -- that flow already
// exists and doesn't need a second entry point here.
export default function ItemReceipts() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [withdrawFrom, setWithdrawFrom] = useState(null);
  const [transferTo, setTransferTo] = useState(null);
  const [requestor, setRequestor] = useState(null);
  const [asOf, setAsOf] = useState('');

  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
    api.get('/employees').then(({ data }) => setEmployees(data));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    const params = {};
    if (search) params.search = search;
    if (withdrawFrom) params.withdraw_from = withdrawFrom.id;
    if (transferTo) params.transfer_to = transferTo.id;
    if (requestor) params.requestor_id = requestor.id;
    if (asOf) params.as_of = asOf;
    const { data } = await api.get('/transfer-orders/item-receipts', { params });
    setRows(data);
    setLoading(false);
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 16, textTransform: 'uppercase', margin: 0 }}>Saved Item Receipts</h1>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="IR No., IF No. or TO No..." />
          </div>
          <div className="field">
            <label>Withdraw From</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ flex: 1 }}>
                <EntityPicker
                  label="Withdraw From" items={locations} value={withdrawFrom?.id || ''} getLabel={locationLabel}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setWithdrawFrom}
                />
              </div>
              {withdrawFrom && <button type="button" className="btn" title="Clear" onClick={() => setWithdrawFrom(null)}>×</button>}
            </div>
          </div>
          <div className="field">
            <label>Transfer To</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ flex: 1 }}>
                <EntityPicker
                  label="Transfer To" items={locations} value={transferTo?.id || ''} getLabel={locationLabel}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setTransferTo}
                />
              </div>
              {transferTo && <button type="button" className="btn" title="Clear" onClick={() => setTransferTo(null)}>×</button>}
            </div>
          </div>
          <div className="field">
            <label>Requestor</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ flex: 1 }}>
                <EntityPicker
                  label="Requestor" items={employees} value={requestor?.id || ''} getLabel={employeeLabel}
                  columns={[{ key: 'name', label: 'Name', render: employeeLabel }]} searchKeys={['first_name', 'last_name']}
                  onSelect={setRequestor}
                />
              </div>
              {requestor && <button type="button" className="btn" title="Clear" onClick={() => setRequestor(null)}>×</button>}
            </div>
          </div>
          <div className="field">
            <label>Date (As of)</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={load}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Item Receipt #</th>
                  <th>Date Created</th>
                  <th>TO No.</th>
                  <th>IF No.</th>
                  <th>Withdraw From</th>
                  <th>Transfer To</th>
                  <th>Requestor</th>
                  <th>Memo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No item receipts found.</td></tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Item Receipt #">{row.receipt_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="TO No.">{row.to_no}</td>
                    <td data-label="IF No.">{row.fulfillment_no}</td>
                    <td data-label="Withdraw From">{row.withdraw_from_name}</td>
                    <td data-label="Transfer To">{row.transfer_to_name}</td>
                    <td data-label="Requestor">{row.requestor_name || '—'}</td>
                    <td data-label="Memo">{row.memo}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/transfer-orders/item-receipts/${row.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
