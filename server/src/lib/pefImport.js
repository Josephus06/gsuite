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
  const raw = typeof v === 'object' && v ? v.result : v;
  if (raw == null || String(raw).trim() === '') return null; // an empty cell is no weight, not 0
  const n = Number(String(raw).replace(/[%,\s]/g, ''));
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
        if (!v || v.toUpperCase().startsWith(label)) continue;
        // A blank field: the next thing along is the next label ("DEPARTMENT:") or the PMS-cycle
        // notes, not this field's value.
        if (/:\s*$/.test(v) || /^(PHASE \d|SUPERIOR'?S|PMS CYCLE)/i.test(v)) break;
        found = v; return;
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
  // The KRA table: its header row (in whichever column the form starts -- some sheets start at B),
  // then rows until "B. CORE VALUES". A KRA with no weight of its own is a heading for the sub-items
  // under it ("Submission of reports" -> "a. Timeliness", "b. Efficiency & Accuracy"), each weighted;
  // they are read as "Submission of reports -- a. Timeliness".
  let headerRow = null;
  let startCol = 1;
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (headerRow != null) return;
    row.eachCell({ includeEmpty: false }, (c, col) => {
      if (headerRow == null && col <= 3 && clean(text(c)).toUpperCase().startsWith('KEY RESULT')) { headerRow = r; startCol = col; }
    });
  });
  const kras = [];
  if (headerRow != null) {
    const hdr = ws.getRow(headerRow);
    const colOf = (re) => { let k = null; hdr.eachCell({ includeEmpty: false }, (c, col) => { if (k == null && re.test(clean(text(c)).toUpperCase())) k = col; }); return k; };
    const wCol = colOf(/^WEIGHT/);
    const kpiCol = colOf(/KEY PERFORMANCE|KPI/);
    const tfCol = colOf(/TIMEFRAME/);
    let heading = null;
    for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const main = clean(text(row.getCell(startCol)));
      const sub = clean(text(row.getCell(startCol + 1)));
      // The first column's text is the row's label (a merged cell repeats it in the next column); text
      // only in the next column is an indented sub-item.
      const label = main;
      if (/^B\.\s*CORE VALUES/i.test(main) || /^EMPLOYEE PERFORMANCE RATING/i.test(main)) break;
      const w = wCol ? num(row.getCell(wCol)) : null;
      if (!w) { if (label) heading = label; continue; }
      let kra = label || sub;
      if (!kra) continue;
      // A sub-item -- lettered (a., b.) or only in the indented column -- belongs to the heading above it.
      if (heading && (!label || /^[a-z]\.\s/i.test(kra))) kra = `${heading} -- ${kra}`;
      else heading = null;
      kras.push({ kra, weight: w, kpi: kpiCol ? clean(text(row.getCell(kpiCol))) || null : null, timeframe: tfCol ? clean(text(row.getCell(tfCol))) || null : null });
    }
  }
  // Weights written as fractions (0.4) become percents (40).
  const raw = kras.reduce((m, k) => m + k.weight, 0);
  if (raw > 0 && kras.every((k) => k.weight <= 1)) kras.forEach((k) => { k.weight = Math.round(k.weight * 10000) / 100; });
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
