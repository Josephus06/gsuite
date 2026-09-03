import { useCallback, useEffect, useRef, useState } from 'react';
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

// The two shapes the Download button offers. `layout` is the value the server switches on, so
// the label and the value live together rather than in two places that can drift apart.
const DOWNLOAD_OPTIONS = [
  {
    layout: 'all',
    label: 'All',
    hint: 'Everything generated: Summary by Artist, then one Detail sheet.',
  },
  {
    layout: 'per-artist',
    label: 'Per Artist',
    hint: "One sheet per artist, holding that artist's own transactions.",
  },
];

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
  // '' = both document types; 'JO' / 'NSTDJO' extract one on its own.
  const [source, setSource] = useState('');
  const [artists, setArtists] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [error, setError] = useState('');
  const menuRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: result } = await api.get(ROUTE, { params: { from, to, artist_id: artistId, source } });
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [from, to, artistId, source]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get(`${ROUTE}/artists`).then(({ data: rows }) => setArtists(rows)); }, []);

  // Close on a click anywhere else, or on Escape. Without it the only way out of the menu is
  // to pick something, which on a button that downloads a file is a trap, not a shortcut.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // The workbook is asked for with the SAME filters the report on screen was run with, and the
  // server builds it from the same query that answered that request (buildReport in
  // routes/artistIncentiveReport.js) -- so a downloaded file cannot disagree with the screen
  // it was downloaded from.
  async function download(layout) {
    setMenuOpen(false);
    setDownloading(layout);
    setError('');
    try {
      const res = await api.get(ROUTE, {
        params: { from, to, artist_id: artistId, source, format: 'xlsx', layout },
        responseType: 'blob',
      });
      // The server already names the file, after the period it covers. Read that back rather
      // than inventing a second name here for the two to drift apart.
      const disposition = res.headers['content-disposition'] || '';
      const named = /filename="?([^";]+)"?/.exec(disposition);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = named ? named[1] : 'artist-incentive.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      // An error response to a blob request arrives AS a blob, so the usual
      // err.response.data.error is a Blob object and renders as "[object Blob]" on screen.
      let message = 'Failed to download the report.';
      const body = err.response?.data;
      if (body instanceof Blob) {
        try { message = JSON.parse(await body.text()).error || message; } catch { /* not JSON */ }
      } else if (body?.error) {
        message = body.error;
      }
      setError(message);
    } finally {
      setDownloading('');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Artist Incentive Report</h1>
        {/* print-toolbar so these controls stay out of the printout itself -- a payout sheet
            with a Run Report button printed across the top of it is not a payout sheet. */}
        <div className="print-toolbar">
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>{' '}
          <div style={{ position: 'relative', display: 'inline-block' }} ref={menuRef}>
            <button
              className="btn btn-sm"
              onClick={() => setMenuOpen((open) => !open)}
              // Nothing to export until a report has been generated. A workbook built from a
              // half-finished run because the button was clicked mid-load is worse than a
              // button that is briefly unavailable.
              disabled={loading || !data || !!downloading}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {downloading ? 'Preparing…' : 'Download'} <span style={{ fontSize: '0.8em' }}>▾</span>
            </button>
            {menuOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4, minWidth: 260,
                  background: 'var(--surface, #fff)', border: '1px solid var(--border, #ddd)',
                  borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 6, zIndex: 10,
                }}
              >
                {DOWNLOAD_OPTIONS.map((option) => (
                  <button
                    key={option.layout}
                    type="button"
                    role="menuitem"
                    className="link-btn"
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px' }}
                    onClick={() => download(option.layout)}
                  >
                    <strong>{option.label}</strong>
                    <div className="muted" style={{ fontSize: '0.85em' }}>{option.hint}</div>
                  </button>
                ))}
              </div>
            )}
          </div>{' '}
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
          <div className="field">
            <label>Source</label>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">JO and NSTDJO</option>
              <option value="JO">Job Orders only</option>
              <option value="NSTDJO">Non-Standard JOs only</option>
            </select>
          </div>
        </div>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner />}

      {!loading && data && <>
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="subsection" style={{ marginTop: 0 }}>Summary by Artist</h3>
          <div className="table-wrap">
            <table className="table-centered">
              <thead><tr><th>Artist</th><th>JO Count</th><th>JO Incentive</th><th>NSTDJO Count</th><th>NSTDJO Incentive</th><th>Total</th></tr></thead>
              <tbody>
                {data.summary.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ padding: 20 }}>No incentives in this period.</td></tr>
                )}
                {data.summary.map((row) => (
                  <tr key={row.artist_employee_id}>
                    <td>{row.artist_name}</td>
                    <td>{row.jo_count}</td>
                    <td>{money(row.jo_amount)}</td>
                    <td>{row.nstdjo_count}</td>
                    <td>{money(row.nstdjo_amount)}</td>
                    <td><strong>{money(row.total)}</strong></td>
                  </tr>
                ))}
              </tbody>
              {data.summary.length > 0 && (
                <tfoot>
                  <tr>
                    <th colSpan={5}>Grand Total</th>
                    <th>{money(data.grand_total)}</th>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>Detail</h3>
          <div className="table-wrap">
            <table className="table-centered">
              <thead><tr><th>Source</th><th>Doc #</th><th>Artist</th><th>Customer</th><th>Sales Rep</th><th>Job Desc</th><th>Layout - Job Type</th><th>Actual End</th><th>Basis</th><th>Incentive</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ padding: 20 }}>No completed layouts in this period.</td></tr>
                )}
                {data.rows.map((row) => (
                  <tr key={`${row.source}-${row.id}`}>
                    <td><span className="badge">{row.source}</span></td>
                    <td>{row.doc_no}</td>
                    <td>{row.artist_name}</td>
                    <td>{row.customer_name || ''}</td>
                    <td>{row.sales_rep_name || ''}</td>
                    <td>{row.description}</td>
                    <td>{row.layout_job_type_name || ''}</td>
                    <td>{day(row.actual_end)}</td>
                    {/* A JO shows its flat amount x layout qty; an NSTDJO's incentive is
                        spread across its materials lines, so there is no single figure. */}
                    <td>{row.incentive_basis}</td>
                    <td>{money(row.incentive_amount)}</td>
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
