// A Job Order's GP Computation tab (asked 2026-10-08): how the footer's Estimated GP Rate and
// Amount come about, laid out as the working -- the estimate's GP Computations tab, for one job.
//
//   Revenue      the Sales Order line this job came from: Subtotal - Discount = Net of Tax
//   Total Cost   the sum of the job's process lines' Total Cost (the Processes tab's own figure)
//   GP Amount    Net of Tax - Total Cost
//   GP Rate      GP Amount / Net of Tax x 100, against the job type's Passing Rate
//
// It is worked out from the same numbers the footer uses (JobOrderView / ProductionJobOrderView),
// so the tab and the footer cannot disagree.
const right = { textAlign: 'right' };
const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const money = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}%`);

export default function JoGpComputation({ jo, processes }) {
  const subtotal = n(jo.line_subtotal);
  const discount = n(jo.line_disc_amount);
  const net = subtotal - discount;
  const totalCost = processes.reduce((s, p) => s + n(p.total_cost), 0);
  const gp = net - totalCost;
  const rate = net ? (gp / net) * 100 : null;
  const passing = jo.passing_gp_rate != null && jo.passing_gp_rate !== '' ? Number(jo.passing_gp_rate) : null;
  const pass = passing != null && rate != null ? rate >= passing : null;
  // A rework or non-standard job has no Sales Order line to earn from, so its revenue is nil.
  const noRevenue = !jo.sales_order_line_id && !subtotal;

  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
        Net of Tax = Subtotal − Discount (this job&apos;s Sales Order line) &nbsp;·&nbsp; GP Amount = Net of Tax − Total Cost
        &nbsp;·&nbsp; GP Rate = GP Amount ÷ Net of Tax × 100 &nbsp;·&nbsp; it passes when the GP Rate is at least the job type&apos;s Passing Rate.
      </div>
      {noRevenue && (
        <div className="muted" style={{ marginBottom: 10, fontSize: 13, color: '#b45309' }}>
          This job has no Sales Order line behind it (a rework or non-standard job), so it has no revenue of its own.
        </div>
      )}

      <h4 style={{ margin: '4px 0 6px' }}>1. Revenue</h4>
      <table style={{ maxWidth: 520 }}>
        <tbody>
          <tr><td>Subtotal{jo.sales_order_no ? ` (${jo.sales_order_no})` : ''}</td><td style={right}>{money(subtotal)}</td></tr>
          <tr><td>− Discount</td><td style={right}>{money(discount)}</td></tr>
          <tr style={{ fontWeight: 700 }}><td>= Net of Tax</td><td style={right}>{money(net)}</td></tr>
        </tbody>
      </table>

      <h4 style={{ margin: '16px 0 6px' }}>2. Total Cost (the process lines)</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Process</th><th>Item</th><th style={right}>Qty</th>
              <th style={right}>Process Cost</th><th style={right}>Material Cost</th><th style={right}>Total Cost</th>
            </tr>
          </thead>
          <tbody>
            {processes.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 16 }}>No process lines, so no cost yet.</td></tr>
            )}
            {processes.map((p, i) => (
              <tr key={p.id || i}>
                <td>{i + 1}</td>
                <td>{p.process_name || '—'}</td>
                <td style={{ whiteSpace: 'normal' }}>{p.item_name || ''}</td>
                <td style={right}>{n(p.qty).toLocaleString('en-US', { maximumFractionDigits: 4 })} {p.unit || ''}</td>
                <td style={right}>{money(p.process_cost)}</td>
                <td style={right}>{money(p.material_cost)}</td>
                <td style={right}>{money(p.total_cost)}</td>
              </tr>
            ))}
          </tbody>
          {processes.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={6}>Total Cost</td>
                <td style={right}>{money(totalCost)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <h4 style={{ margin: '16px 0 6px' }}>3. GP</h4>
      <table style={{ maxWidth: 620 }}>
        <tbody>
          <tr><td>Net of Tax</td><td style={right}>{money(net)}</td></tr>
          <tr><td>− Total Cost</td><td style={right}>{money(totalCost)}</td></tr>
          <tr style={{ fontWeight: 700 }}><td>= GP Amount</td><td style={right}>{money(gp)}</td></tr>
          <tr style={{ fontWeight: 700 }}>
            <td>GP Rate {net ? <span className="muted" style={{ fontWeight: 400 }}>= {money(gp)} ÷ {money(net)} × 100</span> : null}</td>
            <td style={right}>{pct(rate)}</td>
          </tr>
          <tr><td>Passing Rate{jo.job_type_name ? ` (${jo.job_type_name})` : ''}</td><td style={right}>{passing != null ? pct(passing) : '—'}</td></tr>
          <tr>
            <td>Result</td>
            <td style={{ ...right, fontWeight: 700, color: pass === false ? '#b91c1c' : pass ? '#15803d' : undefined }}>
              {pass == null ? '—' : pass ? 'Passed' : 'Below passing rate'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
