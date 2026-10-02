// Excel extracts of AR Aging, AR Aging Details, AP Aging and AP Aging Details (asked 2026-10-02).
// Each is built from the same report data the screen shows -- the summary rows, or the open
// items behind them -- so the sheet always adds up to what was on screen for the same filters.
//
// Money is written as numbers with a display format, never as preformatted text: the first thing
// anyone does to an aging sheet is total or filter a column. Dates are YYYY-MM-DD text, the
// choice lib/artistIncentiveWorkbook.js documents (an Excel date built from a JS Date can land on
// the previous day).
const ExcelJS = require('exceljs');

const MONEY = '#,##0.00';
const day = (v) => (v ? String(v).slice(0, 10) : '');
const num = (v) => Number(v || 0);

function sheet(wb, name, columns) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

function finish(ws, moneyKeys, lastCol) {
  moneyKeys.forEach((k) => { ws.getColumn(k).numFmt = MONEY; });
  ws.autoFilter = { from: 'A1', to: `${lastCol}1` };
}

const BUCKETS = [
  { header: 'Current', key: 'current' },
  { header: '1-30 days', key: 'd1_30' },
  { header: '31-60 days', key: 'd31_60' },
  { header: '61-90 days', key: 'd61_90' },
  { header: 'Over 90 days', key: 'over_90' },
  { header: 'Total Balance', key: 'total_balance' },
];

// AR Aging / AP Aging: one row per customer or vendor, then the totals row.
function summaryWorkbook({ title, partyHeader, partyKey, data }) {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, title, [
    { header: partyHeader, key: 'party', width: 46 },
    ...BUCKETS.map((b) => ({ ...b, width: 16 })),
  ]);
  for (const r of data.rows || []) {
    ws.addRow({ party: r[partyKey], ...Object.fromEntries(BUCKETS.map((b) => [b.key, num(r[b.key])])) });
  }
  const t = data.totals || {};
  const total = ws.addRow({ party: `TOTAL (as of ${day(data.as_of)})`, ...Object.fromEntries(BUCKETS.map((b) => [b.key, num(t[b.key])])) });
  total.font = { bold: true };
  finish(ws, BUCKETS.map((b) => b.key), 'G');
  return wb;
}

function arAgingWorkbook(data) {
  return summaryWorkbook({ title: 'AR Aging', partyHeader: 'Customer Name', partyKey: 'customer_name', data });
}

function apAgingWorkbook(data) {
  return summaryWorkbook({ title: 'AP Aging', partyHeader: 'Vendor Name', partyKey: 'supplier_name', data });
}

// AR Aging Details: the documents behind AR Aging, grouped by customer with a total under each --
// the same columns and order as the page's Download CSV.
function arAgingDetailsWorkbook(groups, asOf) {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'AR Aging Details', [
    { header: 'Customer', key: 'customer', width: 40 },
    { header: 'Trans Date', key: 'trans_date', width: 12 },
    { header: 'Trans #', key: 'trans_no', width: 16 },
    { header: 'BS #', key: 'bs_no', width: 14 },
    { header: 'Memo', key: 'memo', width: 40 },
    { header: 'PO #', key: 'po_no', width: 16 },
    { header: 'Date Due', key: 'date_due', width: 12 },
    { header: 'Age', key: 'age', width: 8 },
    { header: 'Open Balance', key: 'open_balance', width: 16 },
    { header: 'Location', key: 'location', width: 20 },
  ]);
  let grand = 0;
  for (const g of groups) {
    for (const it of g.items) {
      ws.addRow({
        customer: g.customer_name, trans_date: day(it.trans_date), trans_no: it.trans_no || '', bs_no: it.bs_no || '',
        memo: it.memo || '', po_no: it.po_no || '', date_due: day(it.date_due), age: num(it.age),
        open_balance: num(it.open_balance), location: it.location_name || '',
      });
    }
    ws.addRow({ customer: `${g.customer_name} -- total`, open_balance: num(g.total_balance) }).font = { bold: true };
    grand += num(g.total_balance);
  }
  ws.addRow({ customer: `GRAND TOTAL (as of ${day(asOf)})`, open_balance: Math.round(grand * 100) / 100 }).font = { bold: true };
  finish(ws, ['open_balance'], 'J');
  return wb;
}

// AP Aging Details: every open payables item behind AP Aging, grouped by vendor with a total under
// each -- the columns of a vendor's Details on the page, plus the vendor.
function apAgingDetailsWorkbook(items, asOf, daysOverdue) {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'AP Aging Details', [
    { header: 'Vendor', key: 'vendor', width: 40 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Reference', key: 'reference', width: 16 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Due Date', key: 'due_date', width: 12 },
    { header: 'Days Overdue', key: 'days_overdue', width: 12 },
    { header: 'Original', key: 'original_amount', width: 16 },
    { header: 'Balance', key: 'balance', width: 16 },
    { header: 'PO #', key: 'po_no', width: 16 },
    { header: 'Ref #', key: 'ref_no', width: 16 },
    { header: 'Memo', key: 'memo', width: 40 },
    { header: 'Location', key: 'location', width: 20 },
  ]);
  const byVendor = new Map();
  for (const it of items) {
    const k = it.supplier_name || '(no vendor)';
    if (!byVendor.has(k)) byVendor.set(k, []);
    byVendor.get(k).push(it);
  }
  let grand = 0;
  for (const name of [...byVendor.keys()].sort((a, b) => a.localeCompare(b))) {
    const list = byVendor.get(name)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.reference).localeCompare(String(b.reference)));
    let sub = 0;
    for (const it of list) {
      ws.addRow({
        vendor: name, type: it.type || '', reference: it.reference || '', date: day(it.date), due_date: day(it.due_date),
        days_overdue: daysOverdue(it), original_amount: num(it.original_amount), balance: num(it.balance),
        po_no: it.po_no || '', ref_no: it.ref_no || '', memo: it.memo || '', location: it.location_name || '',
      });
      sub += num(it.balance);
    }
    ws.addRow({ vendor: `${name} -- total`, balance: Math.round(sub * 100) / 100 }).font = { bold: true };
    grand += sub;
  }
  ws.addRow({ vendor: `GRAND TOTAL (as of ${day(asOf)})`, balance: Math.round(grand * 100) / 100 }).font = { bold: true };
  finish(ws, ['original_amount', 'balance'], 'L');
  return wb;
}

async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { arAgingWorkbook, apAgingWorkbook, arAgingDetailsWorkbook, apAgingDetailsWorkbook, sendWorkbook };
