import { Fragment, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { money } from './CoaTreeRows';

function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

const SOURCE_LABELS = {
  sales_invoice: 'Invoice', assembly_build: 'Assembly Build', item_delivery: 'Item Delivery',
  item_fulfillment: 'Item Fulfillment', item_receipt: 'Item Receipt', vendor_bill: 'Vendor Bill',
  inventory_adjustment: 'Inventory Adjustment', bill_credit: 'Bill Credit',
};

// Mirrors the real system's Accounting > Reports > General Ledger: a flat per-account
// balance list with each row's underlying transaction lines available on demand. The
// real UI fetches those lines via a separate "Expand" click; ours already has them
// inline in the response (this clone's data volumes are small enough that the extra
// payload is trivial), so "expand" here is just a local show/hide toggle, not a
// second request.
export default function GeneralLedger() {
  const [asOf, setAsOf] = useState(today());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(() => new Set());

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/general-ledger', { params: { asOf } });
      setReport(data);
      setOpen(new Set());
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  function toggle(code) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  return (
    <div>
      <div className="page-header">
        <h1>General Ledger</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date as of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner />}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12 }}><strong>As of {report.as_of}</strong></div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th></th><th>Account #</th><th>Account Title</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No accounts found.</td></tr>
                )}
                {report.rows.map((r) => {
                  const isOpen = open.has(r.account_code);
                  return (
                    <Fragment key={r.account_code}>
                      <tr onClick={() => r.ledgers.length > 0 && toggle(r.account_code)} style={{ cursor: r.ledgers.length ? 'pointer' : 'default' }}>
                        <td>{r.ledgers.length > 0 ? (isOpen ? '▾' : '▸') : ''}</td>
                        <td>{r.account_code}</td>
                        <td>{r.account_name}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.balance)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td />
                          <td colSpan={3} style={{ padding: 0 }}>
                            <table style={{ width: '100%' }}>
                              <thead>
                                <tr>
                                  <th>Transaction Date</th><th>Transaction #</th><th>Memo</th>
                                  <th style={{ textAlign: 'right' }}>Debit</th>
                                  <th style={{ textAlign: 'right' }}>Credit</th>
                                  <th style={{ textAlign: 'right' }}>Balance</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.ledgers.map((l, idx) => (
                                  <tr key={idx}>
                                    <td>{formatDate(l.entry_date)}</td>
                                    <td>{SOURCE_LABELS[l.source_type] || l.source_type} {l.source_no}</td>
                                    <td>{l.memo || ''}</td>
                                    <td style={{ textAlign: 'right' }}>{l.debit ? money(l.debit) : ''}</td>
                                    <td style={{ textAlign: 'right' }}>{l.credit ? money(l.credit) : ''}</td>
                                    <td style={{ textAlign: 'right' }}>{money(l.balance)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
