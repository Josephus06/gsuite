// Transaction detail for months up to the cut-over, read live from the source system: T1S holds
// those months only as the source's per-account figures (lib/openingBalances.js), so the documents
// behind an amount are asked of the source itself -- get_transaction_ledgers, per account and
// department, exactly as its own department income statement drills down. Read-only on the source.
// Needs LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD in the server's .env.
const SITE = 'http://gsuite.graphicstar.com.ph';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

let sourceToken = null; let sourceTokenAt = 0;
async function sourceLogin() {
  if (sourceToken && Date.now() - sourceTokenAt < 20 * 60 * 1000) return sourceToken;
  if (!process.env.LIVE_SITE_USERNAME || !process.env.LIVE_SITE_PASSWORD) {
    throw Object.assign(new Error('Transactions for months before the cut-over come from the old system, and this server has no login for it (LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD).'), { status: 503 });
  }
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  sourceToken = (await r.json())?.data?.token; sourceTokenAt = Date.now();
  if (!sourceToken) throw Object.assign(new Error('Could not log in to the old system.'), { status: 502 });
  return sourceToken;
}

// One account's ledger lines in one source department over [from, to]. coa: a source_coa_keys row;
// deptPk: source_dept_keys.dept_pk (may be null). -> [{ date, document, memo, name, debit, credit, amount }]
async function departmentLedger({ coa, department, deptPk, from, to }) {
  const token = await sourceLogin();
  const body = {
    coa_pk: coa.coa_pk, coa_code: coa.account_code, coa_title: coa.title, side: coa.side,
    locdept: { type: 'Department', name: department, pk: deptPk || null }, dateFilter: [from, to],
  };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(`${SITE}/api/get_transaction_ledgers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await r.json();
    if (!j?.success) throw new Error(j?.message || 'the old system returned no ledger');
    const out = [];
    for (const t of (j.data?.[0] || [])) {
      const dr = Number(t.DRAmount_LdgrEntries) || 0; const cr = Number(t.CRAmount_LdgrEntries) || 0;
      if (!dr && !cr) continue;
      out.push({
        date: t.DateCreated_TransH, document: t.UserPK_TransH, memo: t.Memo_TransH,
        name: t.Name_Cust || t.Name_Accnt || t.Name_Empl || t.name || null,
        debit: round2(dr), credit: round2(cr), amount: round2(dr - cr),
      });
    }
    return out;
  } finally { clearTimeout(timer); }
}

// Runs fn over items, `width` at a time.
async function pool4(items, fn, width = 4) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

module.exports = { SITE, sourceLogin, departmentLedger, pool4 };
