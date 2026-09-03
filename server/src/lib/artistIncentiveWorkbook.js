const ExcelJS = require('exceljs');

// The Artist Incentive Report as a workbook, in the two shapes the report offers:
//
//   'all'        Summary by Artist, then every transaction in one Detail sheet -- the report
//                exactly as the screen generates it.
//   'per-artist' the same summary, then ONE SHEET PER ARTIST holding that artist's own
//                transactions. This is what makes the file a payout pack: a sheet can be sent
//                to the artist it belongs to without anyone having to filter the others out.
//
// Both are built from the same rows the JSON response returns, so an exported file can never
// disagree with the report it was downloaded from.

// Money is written as a NUMBER with a display format, never as a preformatted string. A payout
// sheet whose amounts are text cannot be summed, which is the first thing anyone does to it.
const MONEY_FMT = '#,##0.00';

// Dates are written as plain YYYY-MM-DD text rather than as Excel dates on purpose. An Excel
// date is a timezone-less serial that exceljs fills from a JS Date, and every conversion in
// that chain is a chance to land on the previous day -- the same slide db.js sets
// `dateStrings: true` to avoid. The report only ever shows the day, and YYYY-MM-DD sorts
// correctly as text, so there is nothing to gain by risking it.
const day = (v) => (v ? String(v).slice(0, 10) : '');

const DETAIL_COLUMNS = [
  { header: 'Source', key: 'source', width: 10 },
  { header: 'Doc #', key: 'doc_no', width: 18 },
  { header: 'Artist', key: 'artist_name', width: 24 },
  { header: 'Customer', key: 'customer_name', width: 30 },
  { header: 'Sales Rep', key: 'sales_rep_name', width: 24 },
  { header: 'Job Desc', key: 'description', width: 46 },
  { header: 'Layout - Job Type', key: 'layout_job_type_name', width: 38 },
  { header: 'Actual End', key: 'actual_end', width: 13 },
  { header: 'Basis', key: 'incentive_basis', width: 16 },
  { header: 'Incentive', key: 'incentive_amount', width: 13 },
];

const SUMMARY_COLUMNS = [
  { header: 'Artist', key: 'artist_name', width: 28 },
  { header: 'JO Count', key: 'jo_count', width: 11 },
  { header: 'JO Incentive', key: 'jo_amount', width: 14 },
  { header: 'NSTDJO Count', key: 'nstdjo_count', width: 15 },
  { header: 'NSTDJO Incentive', key: 'nstdjo_amount', width: 18 },
  { header: 'Total', key: 'total', width: 14 },
];

// Excel rejects a worksheet name that is blank, longer than 31 characters, contains any of
// : \ / ? * [ ] or is quoted at either end -- and it compares names case-insensitively, so
// two artists whose names differ only in case or only after character 31 would collide and
// the workbook would fail to open. Truncation makes that likelier, not less likely, so the
// caller disambiguates with `taken`: a clashing name gives up its last characters to a
// counter rather than being dropped.
function safeSheetName(name, taken) {
  const cleaned = String(name || '').replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim();
  let base = (cleaned || 'Unnamed').slice(0, 31);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function styleHeader(sheet, rowNumber = 1) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEBFA' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBAE4' } } };
  });
  sheet.views = [{ state: 'frozen', ySplit: rowNumber }];
}

// The period and filters the file was run for, written above the table. Without it a saved
// export is an undated list of amounts, which is not something anyone can pay against later.
function writeCaption(sheet, title, filters, columnCount) {
  sheet.mergeCells(1, 1, 1, columnCount);
  const heading = sheet.getCell(1, 1);
  heading.value = title;
  heading.font = { bold: true, size: 14 };

  const range = `${filters.from || 'the beginning'} to ${filters.to || 'today'}`;
  const sourceLabel = { JO: 'Job Orders only', NSTDJO: 'Non-Standard JOs only' }[filters.source] || 'JO and NSTDJO';
  sheet.mergeCells(2, 1, 2, columnCount);
  const sub = sheet.getCell(2, 1);
  sub.value = `Actual End Date ${range}  ·  ${sourceLabel}  ·  ${filters.artist_label || 'All artists'}`;
  sub.font = { italic: true, color: { argb: 'FF666666' } };

  sheet.getRow(3).height = 6;
  return 4; // the row the table header goes on
}

function addTable(sheet, columns, rows, headerRow) {
  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width }));
  const header = sheet.getRow(headerRow);
  columns.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  header.commit();
  styleHeader(sheet, headerRow);

  rows.forEach((row) => sheet.addRow(row));
  // Autofilter over the table only -- it must not swallow the caption rows above it.
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow + rows.length, column: columns.length },
  };
}

function detailRows(rows) {
  return rows.map((r) => ({
    source: r.source,
    doc_no: r.doc_no,
    artist_name: r.artist_name || '',
    customer_name: r.customer_name || '',
    sales_rep_name: r.sales_rep_name || '',
    description: r.description || '',
    layout_job_type_name: r.layout_job_type_name || '',
    actual_end: day(r.actual_end),
    incentive_basis: r.incentive_basis || '',
    incentive_amount: Number(r.incentive_amount || 0),
  }));
}

function addDetailSheet(workbook, name, rows, filters, title, taken) {
  const sheet = workbook.addWorksheet(safeSheetName(name, taken));
  const headerRow = writeCaption(sheet, title, filters, DETAIL_COLUMNS.length);
  addTable(sheet, DETAIL_COLUMNS, detailRows(rows), headerRow);

  const amountCol = DETAIL_COLUMNS.length;
  sheet.getColumn(amountCol).numFmt = MONEY_FMT;

  const total = rows.reduce((sum, r) => sum + Number(r.incentive_amount || 0), 0);
  const totalRow = sheet.addRow({});
  totalRow.getCell(amountCol - 1).value = 'Total';
  totalRow.getCell(amountCol - 1).font = { bold: true };
  totalRow.getCell(amountCol).value = Number(total.toFixed(2));
  totalRow.getCell(amountCol).font = { bold: true };
  totalRow.getCell(amountCol).numFmt = MONEY_FMT;
  return sheet;
}

function addSummarySheet(workbook, report, taken) {
  const sheet = workbook.addWorksheet(safeSheetName('Summary by Artist', taken));
  const headerRow = writeCaption(sheet, 'Artist Incentive Report', report.filters, SUMMARY_COLUMNS.length);
  addTable(sheet, SUMMARY_COLUMNS, report.summary.map((s) => ({
    artist_name: s.artist_name || '',
    jo_count: Number(s.jo_count || 0),
    jo_amount: Number(s.jo_amount || 0),
    nstdjo_count: Number(s.nstdjo_count || 0),
    nstdjo_amount: Number(s.nstdjo_amount || 0),
    total: Number(s.total || 0),
  })), headerRow);

  for (const col of [3, 5, 6]) sheet.getColumn(col).numFmt = MONEY_FMT;

  const grand = sheet.addRow({});
  grand.getCell(1).value = 'Grand Total';
  grand.getCell(1).font = { bold: true };
  grand.getCell(SUMMARY_COLUMNS.length).value = Number(report.grand_total || 0);
  grand.getCell(SUMMARY_COLUMNS.length).font = { bold: true };
  grand.getCell(SUMMARY_COLUMNS.length).numFmt = MONEY_FMT;
  return sheet;
}

// `layout` is 'per-artist' or anything else, which means 'all'. Treating an unknown value as
// 'all' rather than rejecting it keeps a stale bookmark or a typo giving someone the report
// instead of an error page -- the same rule the `source` filter follows.
function buildArtistIncentiveWorkbook(report, layout) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cebu Graphicstar Imaging Corp.';
  workbook.created = new Date();

  const taken = new Set();
  addSummarySheet(workbook, report, taken);

  if (layout !== 'per-artist') {
    addDetailSheet(workbook, 'Detail', report.rows, report.filters, 'Detail', taken);
    return workbook;
  }

  // One sheet per artist, ordered as the summary is (highest earner first) so the workbook's
  // tabs read in the same order as the sheet someone is checking it against.
  //
  // Driven off `summary`, not off a second pass over `rows`: summary is already the set of
  // artists who earned in this period, in the right order, and re-deriving it here is how the
  // two would eventually disagree. An artist with no name falls back to their employee id --
  // a tab called "Unnamed" is impossible to pay against, and two of them would collide.
  for (const artist of report.summary) {
    const rows = report.rows.filter(
      (r) => String(r.artist_employee_id) === String(artist.artist_employee_id),
    );
    const name = artist.artist_name || `Employee ${artist.artist_employee_id}`;
    addDetailSheet(workbook, name, rows, report.filters, name, taken);
  }

  // Every artist filtered out leaves a workbook of one summary sheet, which is a truthful
  // empty report. A workbook with NO sheets at all is a corrupt file Excel refuses to open.
  if (report.summary.length === 0) {
    addDetailSheet(workbook, 'Detail', [], report.filters, 'Detail', taken);
  }
  return workbook;
}

module.exports = { buildArtistIncentiveWorkbook, safeSheetName };
