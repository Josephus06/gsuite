// AI for Budgets / Budget vs Actual: explain the report, answer questions about it, and suggest a
// budget. Plus FLAGS, which are deliberately not AI.
//
// What the model is and is not trusted with:
//  - Flags are plain rules computed here (a month far above the account's norm, an expense with a
//    credit balance, spending with no budget, a total made mostly of inventory adjustments or
//    hand journals). Free, instant, repeatable, and never hallucinated. The AI is told about them.
//  - Explain / Ask see ONLY what this report computed plus the largest transactions behind the
//    biggest variances, and are told to answer from that and say so when it isn't enough.
//  - Suggest never lets the model write monthly figures. T1S builds the baseline itself (last
//    year's total spread by the account's own seasonality over up to three years); the model may
//    only choose a growth % per account, clamped to -50%..+50%, with a one-line reason.
//
// Uses the same OpenAI setup as the CRM drafts and the chatbot (OPENAI_API_KEY, OPENAI_MODEL).
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const aiConfigured = () => !!process.env.OPENAI_API_KEY;

async function chat(messages, { json = false, temperature = 0.2, timeoutMs = 60000 } = {}) {
  if (!aiConfigured()) {
    throw Object.assign(new Error('AI is not set up on this server (no OPENAI_API_KEY).'), { status: 503 });
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL, temperature, messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Say which failure it is: an empty OpenAI balance (seen 2026-09-30) is the owner's to fix by
    // adding credit, not something to retry.
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code || body?.error?.type || '';
    const msg = code === 'insufficient_quota' || code === 'credit_balance_exhausted'
      ? 'The OpenAI account has no credit left. Add credit at platform.openai.com (Billing), then try again.'
      : `The AI service did not answer (${res.status}${code ? `: ${code}` : ''}).`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

// ---------------------------------------------------------------- flags (rules, not AI)

const MANUAL_SOURCES = { inventory_adjustment: 'inventory adjustments', journal: 'hand-entered journals' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

// row: a report row; months: signed actual per month (1..toMonth); sources: { source_type: signed amount }
function flagsFor(row, { income, months, sources }) {
  const flags = [];
  const ytd = row.ytd_actual;
  // 1. One month far out of line with the account's own other months.
  const nonzero = months.filter((v) => Math.abs(v) > 0.005).map(Math.abs);
  if (nonzero.length >= 3) {
    months.forEach((v, i) => {
      const others = nonzero.filter((x) => x !== Math.abs(v));
      const med = median(others);
      if (med > 0 && Math.abs(v) > 3 * med && Math.abs(v) > 50000) {
        flags.push({ kind: 'spike', text: `${MONTHS[i]} actual ${round2(v).toLocaleString('en-US')} is ${(Math.abs(v) / med).toFixed(1)}x this account's usual month` });
      }
    });
  }
  // 2. A cost with a credit balance (money coming back out of an expense) is almost always a
  //    posting error or a reversal worth a look. Income accounts are skipped: contra-revenue
  //    (Sales Discount) sits there with a debit balance by design.
  if (!income && ytd < -1000) flags.push({ kind: 'sign', text: `year-to-date actual is negative (${round2(ytd).toLocaleString('en-US')}) for a cost account` });
  // 3. Spending nobody budgeted for.
  if (!row.annual_budget && Math.abs(ytd) > 10000) flags.push({ kind: 'unbudgeted', text: `${round2(ytd).toLocaleString('en-US')} booked with no budget` });
  // 4. Mostly manual adjustments rather than trading documents.
  const total = Object.values(sources).reduce((s, v) => s + Math.abs(v), 0);
  for (const [src, label] of Object.entries(MANUAL_SOURCES)) {
    const part = Math.abs(sources[src] || 0);
    if (total > 0 && part / total > 0.5 && part > 100000) {
      flags.push({ kind: 'manual', text: `${Math.round((part / total) * 100)}% of this actual comes from ${label}` });
    }
  }
  return flags;
}

// ---------------------------------------------------------------- explain / ask

const SYSTEM_REPORT = [
  'You are a management accountant writing for the General Manager of GraphicStar, a signage and printing company in the Philippines. Amounts are Philippine pesos.',
  'You are given a Budget vs Actual report as JSON: section totals, Gross Profit and Net Income, account rows, rule-based flags, and the largest transactions behind the biggest variances.',
  'Variance is signed so POSITIVE IS GOOD: income above budget, costs below budget.',
  'Use ONLY the data given. Do not invent causes, vendors, or figures. When the data cannot explain something, say what to check instead.',
  'Flags mark numbers that may be wrong (spikes, manual adjustments, negative costs, unbudgeted spending). Treat a flagged actual with caution and say so.',
  'Write plainly, no jargon, no preamble. Use peso amounts with thousands separators.',
].join('\n');

function reportContext(report, drivers) {
  const rows = [];
  for (const s of report.sections) {
    for (const r of s.rows) {
      rows.push({
        section: s.label, account: `${r.account_code} ${r.account_name}`,
        budget: r.budget, actual: r.actual, ytd_budget: r.ytd_budget, ytd_actual: r.ytd_actual,
        annual_budget: r.annual_budget, flags: (r.flags || []).map((f) => f.text),
      });
    }
  }
  return {
    budget: `${report.budget.name} (v${report.budget.version}, ${report.budget.status})`,
    budgeted_by: report.budget.dimension_label, period: report.period_label,
    sections: report.sections.map((s) => ({ section: s.label, ...s.totals })),
    gross_profit_and_net_income: report.summary,
    accounts: rows,
    biggest_variance_transactions: drivers,
  };
}

async function explainReport(report, drivers) {
  const text = await chat([
    { role: 'system', content: SYSTEM_REPORT },
    {
      role: 'user',
      content: `Write a short briefing (under 220 words):\n1. One or two sentences on the overall result for the period (Net Income vs budget).\n2. The 3-5 biggest variances that matter, each with what drove it according to the transactions given.\n3. Any flagged numbers that should be checked before trusting the report.\nUse short paragraphs or bullets.\n\nDATA:\n${JSON.stringify(reportContext(report, drivers))}`,
    },
  ], { temperature: 0.2 });
  return text;
}

async function askReport(report, drivers, question, history = []) {
  const past = (Array.isArray(history) ? history : []).slice(-6).flatMap((h) => [
    { role: 'user', content: String(h.q || '').slice(0, 500) },
    { role: 'assistant', content: String(h.a || '').slice(0, 2000) },
  ]);
  return chat([
    { role: 'system', content: `${SYSTEM_REPORT}\nAnswer the user's question in under 150 words. If the question is about something not in the data (another period, another budget, a document not listed), say so and suggest where in T1S to look.\n\nDATA:\n${JSON.stringify(reportContext(report, drivers))}` },
    ...past,
    { role: 'user', content: String(question).slice(0, 500) },
  ], { temperature: 0.1 });
}

// ---------------------------------------------------------------- suggest

// accounts: [{ account_code, account_name, section, income, years: { [year]: number[12] } }]
// Returns { [account_code]: { growth_pct, reason } }. Throws when AI is unavailable.
async function suggestGrowth(budget, accounts) {
  const facts = accounts.map((a) => ({
    account: `${a.account_code} ${a.account_name}`, section: a.section,
    yearly_totals: Object.fromEntries(Object.entries(a.years).map(([y, m]) => [y, round2(m.reduce((s, v) => s + v, 0))])),
  }));
  const raw = await chat([
    {
      role: 'system',
      content: [
        'You help set a company budget for GraphicStar (signage and printing, Philippines, pesos).',
        `The budget is FY ${budget.fiscal_year}, ${budget.dimension_label}.`,
        "For each account you get its actual yearly totals for past years. T1S will take the LAST year's total, spread by the account's own seasonality, and apply your growth %.",
        'Choose a realistic growth_pct per account between -50 and 50. Base it on the trend in the totals; be conservative where history is short, erratic, or near zero.',
        'Give a reason of at most 15 words that refers to the numbers (e.g. "grew ~12% a year for two years").',
        'Reply with JSON only: {"accounts": {"<account code>": {"growth_pct": number, "reason": "..."}}}.',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(facts) },
  ], { json: true, temperature: 0.2, timeoutMs: 90000 });
  let parsed = {};
  try { parsed = JSON.parse(raw).accounts || {}; } catch { parsed = {}; }
  const out = {};
  for (const [code, v] of Object.entries(parsed)) {
    const g = Number(v?.growth_pct);
    if (!Number.isFinite(g)) continue;
    out[String(code).split(' ')[0]] = { growth_pct: Math.max(-50, Math.min(50, g)), reason: String(v.reason || '').slice(0, 160) };
  }
  return out;
}

module.exports = { aiConfigured, flagsFor, explainReport, askReport, suggestGrowth };
