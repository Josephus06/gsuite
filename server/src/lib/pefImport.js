const ExcelJS = require('exceljs');

// Reads a Performance Evaluation Form workbook (the PEF, 2026-10-23) -- one sheet per employee --
// into templates: each sheet's POSITION TITLE, its Key Result Areas (KRA, weight, KPI, timeframe)
// from the "A. PRODUCTIVITY & EFFICIENCY" table, and the NAME OF EMPLOYEE / RATER / DEPARTMENT in the
// header. Labels are found by their text and columns by the table's own header row, so a department
// that moved a column or added a KRA still reads.
const text = (c) => {
  const v = c?.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result != null) return String(v.result);
    if (v.text) return String(v.text);
    return '';
  }
  return String(v);
};
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const num = (c) => {
  const v = c?.value;
  const n = typeof v === 'object' && v ? Number(v.result) : Number(String(v ?? '').replace(/[%,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// The value beside a label: the first cell to its right whose text is not the label (merged cells
// repeat the label across their span).
function valueBeside(ws, label) {
  let found = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (found !== null) return;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (found !== null) return;
      const t = clean(text(cell)).toUpperCase();
      if (!t.startsWith(label)) return;
      for (let c = col + 1; c <= row.cellCount + 1; c += 1) {
        const v = clean(text(row.getCell(c)));
        if (v && !v.toUpperCase().startsWith(label)) { found = v; return; }
      }
      found = '';
    });
  });
  return found || '';
}

function readSheet(ws) {
  const position = valueBeside(ws, 'POSITION TITLE');
  const employee = valueBeside(ws, 'NAME OF EMPLOYEE');
  const rater = valueBeside(ws, 'RATER');
  const department = valueBeside(ws, 'DEPARTMENT');
  // The KRA table: its header row, then rows until "B. CORE VALUES".
  let headerRow = null;
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (headerRow == null && clean(text(row.getCell(1))).toUpperCase().startsWith('KEY RESULT')) headerRow = r;
  });
  const kras = [];
  if (headerRow != null) {
    const hdr = ws.getRow(headerRow);
    const colOf = (re) => { let k = null; hdr.eachCell({ includeEmpty: false }, (c, col) => { if (k == null && re.test(clean(text(c)).toUpperCase())) k = col; }); return k; };
    const wCol = colOf(/^WEIGHT/);
    const kpiCol = colOf(/KEY PERFORMANCE|KPI/);
    const tfCol = colOf(/TIMEFRAME/);
    for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const kra = clean(text(row.getCell(1)));
      if (/^B\.\s*CORE VALUES/i.test(kra) || /^EMPLOYEE PERFORMANCE RATING/i.test(kra)) break;
      if (!kra) continue;
      const w = wCol ? num(row.getCell(wCol)) : null;
      if (w == null) continue;
      kras.push({ kra, weight: w, kpi: kpiCol ? clean(text(row.getCell(kpiCol))) || null : null, timeframe: tfCol ? clean(text(row.getCell(tfCol))) || null : null });
    }
  }
  // Weights written as fractions (0.4) become percents (40).
  const raw = kras.reduce((m, k) => m + k.weight, 0);
  if (raw > 0 && raw <= 1.0001) kras.forEach((k) => { k.weight = Math.round(k.weight * 10000) / 100; });
  kras.forEach((k) => { if (!k.timeframe) k.timeframe = 'Quarterly'; });
  const total = Math.round(kras.reduce((m, k) => m + k.weight, 0) * 100) / 100;
  return { sheet: ws.name, position_title: position.toUpperCase(), employee_name: employee, rater_name: rater, department, kras, total };
}

async function readPef(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets.map(readSheet).filter((s) => s.position_title || s.kras.length);
}

module.exports = { readPef };
