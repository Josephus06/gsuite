import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';

const ROUTE = '/reports/artist-incentive';

// Artist incentives earned across both Job Orders and Non-Standard Job Orders, filtered on
// the date the artist actually finished the layout -- an incentive is earned when the work
// is done, not when the order was raised or planned.
//
// The two sources earn differently: a Non-Standard Job Order carries its incentive per
// materials line (5% of that line's Process Price, stored at save time), while a Job Order
// earns a flat 7.50 per unit of layout work -- an amount, not a percentage.
const money = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v).slice(0, 10) : '');

// Defaults to the current month, the period this is most often run for.
const monthStart = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
};
const today = () => new Date().toISOString().slice(0, 10);

export default function ArtistIncentiveReport() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [artistId, setArtistId] = useState('');
  const [artists, setArtists] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: result } = await api.get(ROUTE, { params: { from, to, artist_id: artistId } });
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [from, to, artistId]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get(`${ROUTE}/artists`).then(({ data: rows }) => setArtists(rows)); }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Artist Incentive Report</h1>
        <div>
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>{' '}
          <button className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Run Report'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Actual End Date — From</label>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="field">
            <label>Actual End Date — To</label>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="field">
            <label>Artist</label>
            <select value={artistId} onChange={(event) => setArtistId(event.target.value)}>
              <option value="">All artists</option>
              {artists.map((artist) => <option key={artist.id} value={artist.id}>{artist.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {loading && <LoadingSpinner />}

      {!loading && data && <>
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="subsection" style={{ marginTop: 0 }}>Summary by Artist</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Artist</th><th>JO Count</th><th style={{ textAlign: 'right' }}>JO Incentive</th><th>NSTDJO Count</th><th style={{ textAlign: 'right' }}>NSTDJO Incentive</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
              <tbody>
                {data.summary.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No incentives in this period.</td></tr>
                )}
                {data.summary.map((row) => (
                  <tr key={row.artist_employee_id}>
                    <td>{row.artist_name}</td>
                    <td>{row.jo_count}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.jo_amount)}</td>
                    <td>{row.nstdjo_count}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.nstdjo_amount)}</td>
                    <td style={{ textAlign: 'right' }}><strong>{money(row.total)}</strong></td>
                  </tr>
                ))}
              </tbody>
              {data.summary.length > 0 && (
                <tfoot>
                  <tr>
                    <th colSpan={5} style={{ textAlign: 'right' }}>Grand Total</th>
                    <th style={{ textAlign: 'right' }}>{money(data.grand_total)}</th>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>Detail</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Source</th><th>Doc #</th><th>Artist</th><th>Customer</th><th>Job Desc</th><th>Layout - Job Type</th><th>Actual End</th><th>Basis</th><th style={{ textAlign: 'right' }}>Incentive</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No completed layouts in this period.</td></tr>
                )}
                {data.rows.map((row) => (
                  <tr key={`${row.source}-${row.id}`}>
                    <td><span className="badge">{row.source}</span></td>
                    <td>{row.doc_no}</td>
                    <td>{row.artist_name}</td>
                    <td>{row.customer_name || ''}</td>
                    <td>{row.description}</td>
                    <td>{row.layout_job_type_name || ''}</td>
                    <td>{day(row.actual_end)}</td>
                    {/* A JO shows its flat amount x layout qty; an NSTDJO's incentive is
                        spread across its materials lines, so there is no single figure. */}
                    <td>{row.incentive_basis}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.incentive_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>}
    </div>
  );
}
