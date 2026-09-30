import { Fragment, useEffect, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
// Variance is signed so positive is always GOOD: income above budget, costs below it.
const variance = (income, budget, actual) => (income ? actual - budget : budget - actual);
const pct = (v, budget) => (budget ? `${((v / budget) * 100).toFixed(1)}%` : '—');
const tone = (v) => (v < -0.005 ? { color: 'var(--danger, #b91c1c)' } : v > 0.005 ? { color: 'var(--success, #15803d)' } : undefined);

// Reports > Budget vs Actual: one budget against the GL for a month, a quarter or year-to-date.
// Actuals come from the same derived GL as the Income Statement.
export default function BudgetVsActual() {
  const [options, setOptions] = useState([]);
  const [form, setForm] = useState({ budget_id: '', period: 'ytd', month: String(new Date().getMonth() + 1) });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  // AI: a briefing, and questions about what is on screen. Both are asked of the report exactly as
  // generated (budget / period / month), never of a half-changed filter.
  const [generated, setGenerated] = useState(null);
  const [briefing, setBriefing] = useState('');
  const [question, setQuestion] = useState('');
  const [qa, setQa] = useState([]);
  const [aiBusy, setAiBusy] = useState('');
  const [aiError, setAiError] = useState('');

  useEffect(() => {
    api.get('/budgets/report/options').then(({ data: o }) => {
      setOptions(o);
      if (o.length) set({ budget_id: String(o[0].id) });
    }).catch((e) => setError(e.response?.data?.error || 'Could not load budgets.'));
  }, []);

  async function generate() {
    if (!form.budget_id) { setError('Choose a budget.'); return; }
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/budgets/report/vs-actual', { params: form });
      setData(d); setGenerated({ ...form }); setBriefing(''); setQa([]); setAiError('');
    }
    catch (e) { setError(e.response?.data?.error || 'Could not build the report.'); }
    setLoading(false);
  }
  async function extract() {
    try {
      const { data: blob } = await api.get('/budgets/report/vs-actual/export', { params: form, responseType: 'blob' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `budget-vs-actual-${form.month}.xlsx`; a.click(); URL.revokeObjectURL(url);
    } catch { setError('Could not extract the report.'); }
  }

  async function explain() {
    setAiBusy('explain'); setAiError('');
    try { const { data: d } = await api.post('/budgets/report/ai/explain', generated); setBriefing(d.text); }
    catch (e) { setAiError(e.response?.data?.error || 'The AI could not explain this report.'); }
    setAiBusy('');
  }
  async function ask() {
    const q = question.trim(); if (!q) return;
    setAiBusy('ask'); setAiError('');
    try {
      const { data: d } = await api.post('/budgets/report/ai/ask', { ...generated, question: q, history: qa });
      setQa((prev) => [...prev, { q, a: d.answer }]); setQuestion('');
    } catch (e) { setAiError(e.response?.data?.error || 'The AI could not answer.'); }
    setAiBusy('');
  }

  const label = (o) => `${o.fiscal_year} · ${o.name} · ${o.dimension_label} · v${o.version}${o.status === 'draft' ? ' (DRAFT)' : ''}`;

  return (
    <div>
      <div className="page-header"><h1>Budget vs Actual</h1></div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>Budget</label>
            <select value={form.budget_id} onChange={(e) => set({ budget_id: e.target.value })}>
              {options.length === 0 && <option value="">No budgets yet</option>}
              {options.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Period</label>
            <select value={form.period} onChange={(e) => set({ period: e.target.value })}>
              <option value="month">Month</option>
              <option value="quarter">Quarter to date</option>
              <option value="ytd">Year to date</option>
            </select>
          </div>
          <div className="field">
            <label>{form.period === 'month' ? 'Month' : 'Up to'}</label>
            <select value={form.month} onChange={(e) => set({ month: e.target.value })}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" disabled={loading} onClick={generate}>{loading ? 'Generating...' : 'Generate'}</button>
          <button className="btn" disabled={!data} onClick={extract}>Extract</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <LoadingSpinner />}
      {data && !loading && (
        <div className="card">
          {data.flag_count > 0 && (
            <div className="error-banner" style={{ marginBottom: 10 }}>
              ⚠ {data.flag_count} account{data.flag_count === 1 ? '' : 's'} flagged: the actual may be wrong (a spike, mostly manual
              adjustments, a negative cost, or spending with no budget). Hover the ⚠ beside an account to see why.
            </div>
          )}
          <div className="card" style={{ marginBottom: 12, background: 'var(--surface-2, #f8fafc)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>AI</strong>
              {!data.ai_available && <span className="muted">AI is not set up on this server.</span>}
              {data.ai_available && (
                <>
                  <button className="btn btn-sm btn-primary" disabled={!!aiBusy} onClick={explain}>{aiBusy === 'explain' ? 'Thinking...' : 'Explain this report'}</button>
                  <input style={{ flex: 1, minWidth: 240 }} value={question} onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder="Ask about these numbers, e.g. why are operating expenses over budget?" />
                  <button className="btn btn-sm" disabled={!!aiBusy || !question.trim()} onClick={ask}>{aiBusy === 'ask' ? 'Thinking...' : 'Ask'}</button>
                </>
              )}
            </div>
            {aiError && <div className="error-banner" style={{ marginTop: 8 }}>{aiError}</div>}
            {briefing && <div style={{ whiteSpace: 'pre-wrap', marginTop: 10, lineHeight: 1.5 }}>{briefing}</div>}
            {qa.map((x, i) => (
              <div key={i} style={{ marginTop: 10 }}>
                <div><strong>Q:</strong> {x.q}</div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}><strong>A:</strong> {x.a}</div>
              </div>
            ))}
            {data.ai_available && (briefing || qa.length > 0) && (
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>AI-written from this report's figures and the transactions behind them. Check anything important against the ledger.</div>
            )}
          </div>
          <div style={{ marginBottom: 10 }}>
            <strong>{data.budget.name}</strong> · {data.budget.dimension_label} · {data.period_label}
            {data.budget.status === 'draft' && <span className="badge badge-warning" style={{ marginLeft: 8 }}>Draft budget</span>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th><th className="text-right">Budget</th><th className="text-right">Actual</th>
                  <th className="text-right">Variance</th><th className="text-right">%</th>
                  <th className="text-right">YTD Budget</th><th className="text-right">YTD Actual</th><th className="text-right">YTD Variance</th>
                  <th className="text-right">Annual Budget</th>
                </tr>
              </thead>
              <tbody>
                {data.sections.map((s) => (
                  <Fragment key={s.key}>
                    <tr><td colSpan={9} style={{ fontWeight: 700, background: 'var(--surface-2, #f3f4f6)' }}>{s.label}</td></tr>
                    {s.rows.length === 0 && <tr><td colSpan={9} className="muted">Nothing budgeted or booked.</td></tr>}
                    {s.rows.map((r) => {
                      const v = variance(s.income, r.budget, r.actual); const yv = variance(s.income, r.ytd_budget, r.ytd_actual);
                      return (
                        <tr key={r.account_id}>
                          <td>
                            {r.account_code} — {r.account_name}
                            {r.flags?.length > 0 && (
                              <span title={r.flags.map((f) => f.text).join('\n')} style={{ marginLeft: 6, cursor: 'help', color: 'var(--danger, #b91c1c)' }}>⚠</span>
                            )}
                          </td>
                          <td className="text-right">{money(r.budget)}</td>
                          <td className="text-right">{money(r.actual)}</td>
                          <td className="text-right" style={tone(v)}>{money(v)}</td>
                          <td className="text-right" style={tone(v)}>{pct(v, r.budget)}</td>
                          <td className="text-right">{money(r.ytd_budget)}</td>
                          <td className="text-right">{money(r.ytd_actual)}</td>
                          <td className="text-right" style={tone(yv)}>{money(yv)}</td>
                          <td className="text-right muted">{money(r.annual_budget)}</td>
                        </tr>
                      );
                    })}
                    {(() => {
                      const T = s.totals; const v = variance(s.income, T.budget, T.actual); const yv = variance(s.income, T.ytd_budget, T.ytd_actual);
                      return (
                        <tr style={{ fontWeight: 700 }}>
                          <td>Total {s.label}</td>
                          <td className="text-right">{money(T.budget)}</td><td className="text-right">{money(T.actual)}</td>
                          <td className="text-right" style={tone(v)}>{money(v)}</td><td className="text-right" style={tone(v)}>{pct(v, T.budget)}</td>
                          <td className="text-right">{money(T.ytd_budget)}</td><td className="text-right">{money(T.ytd_actual)}</td>
                          <td className="text-right" style={tone(yv)}>{money(yv)}</td><td></td>
                        </tr>
                      );
                    })()}
                  </Fragment>
                ))}
                {[['Gross Profit', 'gross_profit'], ['Net Income', 'net_income']].map(([lbl, k]) => {
                  const S = data.summary; const v = S.actual[k] - S.budget[k]; const yv = S.ytd_actual[k] - S.ytd_budget[k];
                  return (
                    <tr key={k} style={{ fontWeight: 800, borderTop: '2px solid var(--border, #d1d5db)' }}>
                      <td>{lbl}</td>
                      <td className="text-right">{money(S.budget[k])}</td><td className="text-right">{money(S.actual[k])}</td>
                      <td className="text-right" style={tone(v)}>{money(v)}</td><td className="text-right" style={tone(v)}>{pct(v, S.budget[k])}</td>
                      <td className="text-right">{money(S.ytd_budget[k])}</td><td className="text-right">{money(S.ytd_actual[k])}</td>
                      <td className="text-right" style={tone(yv)}>{money(yv)}</td><td></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            Variance is positive when it is good for the business: income above budget, costs below it. Actuals are the same
            GL figures as the Income Statement{data.budget.dimension !== 'company' ? ', counting only transactions carrying this budget\'s department/location' : ''}.
          </p>
        </div>
      )}
    </div>
  );
}
