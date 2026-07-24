// READ-ONLY: calls generate_customer_ledger with the array payload the app uses
// ([account, date, location]) and dumps its shape to see if it carries payment->invoice
// application. Writes nothing.
require('dotenv').config();
const SITE = 'http://gsuite.graphicstar.com.ph';
async function login() {
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  return (await r.json())?.data?.token;
}
async function post(token, ep, payload, ms = 90000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SITE}/api/${ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: ctl.signal,
    });
    clearTimeout(t); return await r.json();
  } catch (e) { clearTimeout(t); return { __err: e.name === 'AbortError' ? 'timeout' : e.message }; }
}
const rows = (res) => (Array.isArray(res.data?.[0]) ? res.data[0] : (res.data || []));

async function main() {
  const token = await login();
  console.log('Logged in.');
  // A customer with real invoice+payment activity: pick one of our reps' customers.
  const custs = rows(await post(token, 'get_customers', { searchKey: 'Terraganics', limit: 3, offset: 0 }));
  const cust = custs[0];
  const custPk = cust?.SysPK_Cust;
  console.log('Customer:', cust?.Name_Cust, custPk, '\n');

  // App calls: GenerateCustomerLedger([account, date, location]) -> data: [account,date,location]
  const res = await post(token, 'generate_customer_ledger', [custPk, '2026-07-31', null]);
  if (res.__err) { console.log('array[account,date,null] ERR:', res.__err); }
  else {
    const d = res.data;
    console.log('generate_customer_ledger success:', res.success, '| data:', Array.isArray(d) ? `array[${d.length}]` : typeof d);
    const segs = Array.isArray(d) ? d : [d];
    segs.forEach((s, i) => {
      if (Array.isArray(s)) {
        console.log(`  [${i}] array[${s.length}]${s[0] ? ' keys=' + Object.keys(s[0]).join(',') : ''}`);
        if (s[0]) console.log(`      sample: ${JSON.stringify(s[0]).slice(0, 500)}`);
        if (s[1]) console.log(`      sample2: ${JSON.stringify(s[1]).slice(0, 500)}`);
      } else if (s && typeof s === 'object') console.log(`  [${i}] object keys=${Object.keys(s).join(',')}`);
      else console.log(`  [${i}] ${String(s)}`);
    });
  }
  console.log('\nDone.');
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
