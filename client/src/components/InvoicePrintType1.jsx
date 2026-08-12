import { money, qtyText, formatDate, paginate } from '../utils/invoicePrint';

// TYPE 1 -- overlay for the PRE-PRINTED "SERVICE INVOICE" pad.
//
// The physical form already carries the letterhead, column headings, the totals labels and
// every rule and box. So this prints DATA ONLY -- no titles, no borders, no table chrome --
// positioned to land inside the form's blanks. That is why it looks half-empty on screen:
// what you see is only the overlay, not the document.
//
// CALIBRATION: every position lives in FORM below, in millimetres from the top-left of the
// sheet. Nothing else in this file needs editing to fit the paper. Turn on the guides to
// overlay a 10mm grid and outline each field, print that onto a real form, and nudge the
// numbers until the data sits in the blanks.
export const FORM = {
  // The physical CEBU GRAPHICSTAR "SERVICE INVOICE" pad measures 8.3 x 5.4 inches, landscape.
  page: { width: 210.8, height: 137.2 },

  baseFontPt: 8,
  fontFamily: "'Courier New', Courier, monospace", // monospace keeps columns aligned in the blanks

  // Header blanks. The form prints its own "Sold to :", "TIN:" and "Address:" labels at the
  // left, so these x values sit just past them. NOTE: the form's serial (the red "No. 03041")
  // is pre-printed and is the document's legal identity -- we must never print over it, which
  // is why there is no invoice-number field here.
  header: {
    customerName: { x: 30, y: 32, w: 105 },
    customerTin: { x: 30, y: 39, w: 105 },
    customerAddress: { x: 30, y: 46, w: 105, lines: 2 },
    date: { x: 181, y: 25, w: 26 },
    terms: { x: 181, y: 33, w: 26, lines: 2 },
  },

  // Line-item band: QUANTITY | UNIT | DESCRIPTION | UNIT PRICE | AMOUNT.
  // `right: true` means x is the RIGHT edge -- how the money columns align on the form.
  items: {
    top: 68,
    rowHeight: 5,
    rowsPerPage: 6,
    columns: {
      qty: { x: 24, w: 16, right: true },
      unit: { x: 28, w: 18 },
      description: { x: 48, w: 95 },
      unitPrice: { x: 163, w: 26, right: true },
      amount: { x: 201, w: 28, right: true },
    },
    // "Order ID : SO-##### PO/Ref. Doc: #####" sits under the last item in the description area.
    orderId: { x: 48, w: 95, gap: 5 },
  },

  // Totals band. Left block is the BIR VAT breakdown the form labels VATABLE (V) /
  // VAT-Exempt (E) / Zero Rated (Z) / VAT (12%); right block is Total Sales /
  // Less: Withholding Tax / TOTAL AMOUNT DUE.
  totals: {
    vatableSales: { x: 158, w: 26, y: 110, right: true },
    vatExempt: { x: 158, w: 26, y: 115, right: true },
    zeroRated: { x: 158, w: 26, y: 120, right: true },
    vat: { x: 158, w: 26, y: 125, right: true },
    totalSales: { x: 201, w: 28, y: 110, right: true },
    lessWithholding: { x: 201, w: 28, y: 117, right: true },
    amountDue: { x: 201, w: 28, y: 125, right: true },
  },
};

// One positioned value. Renders nothing when empty so a blank never paints over the form.
function Field({ spec, children, calibrate, name }) {
  if (children === null || children === undefined || children === '') {
    return calibrate ? <Outline spec={spec} name={name} /> : null;
  }
  return (
    <>
      {calibrate && <Outline spec={spec} name={name} />}
      <div
        style={{
          position: 'absolute',
          left: `${spec.right ? spec.x - spec.w : spec.x}mm`,
          top: `${spec.y}mm`,
          width: `${spec.w}mm`,
          textAlign: spec.right ? 'right' : 'left',
          whiteSpace: spec.lines ? 'normal' : 'nowrap',
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </>
  );
}

function Outline({ spec, name }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${spec.right ? spec.x - spec.w : spec.x}mm`,
        top: `${spec.y}mm`,
        width: `${spec.w}mm`,
        height: `${(spec.lines || 1) * 5}mm`,
        outline: '0.2mm dashed rgba(220,38,38,.7)',
        pointerEvents: 'none',
      }}
    >
      <span style={{ position: 'absolute', top: '-3.4mm', left: 0, fontSize: '5pt', color: '#dc2626' }}>{name}</span>
    </div>
  );
}

// 10mm grid so a test print can be measured against the real form.
function Grid({ page }) {
  const lines = [];
  for (let x = 10; x < page.width; x += 10) {
    lines.push(<div key={`v${x}`} style={{ position: 'absolute', left: `${x}mm`, top: 0, bottom: 0, width: 0, borderLeft: '0.1mm solid rgba(59,130,246,.35)' }} />);
    if (x % 50 === 0) lines.push(<div key={`vl${x}`} style={{ position: 'absolute', left: `${x + 0.5}mm`, top: '1mm', fontSize: '5pt', color: '#3b82f6' }}>{x}</div>);
  }
  for (let y = 10; y < page.height; y += 10) {
    lines.push(<div key={`h${y}`} style={{ position: 'absolute', top: `${y}mm`, left: 0, right: 0, height: 0, borderTop: '0.1mm solid rgba(59,130,246,.35)' }} />);
    if (y % 50 === 0) lines.push(<div key={`hl${y}`} style={{ position: 'absolute', top: `${y + 0.5}mm`, left: '1mm', fontSize: '5pt', color: '#3b82f6' }}>{y}</div>);
  }
  return <>{lines}</>;
}

export default function InvoicePrintType1({ si, totals, calibrate }) {
  const pages = paginate(si.lines || [], FORM.items.rowsPerPage);

  return (
    <>
      <style>{`
        .si-sheet {
          position: relative;
          width: ${FORM.page.width}mm;
          height: ${FORM.page.height}mm;
          margin: 0 auto 16px;
          background: #fff;
          font-family: ${FORM.fontFamily};
          font-size: ${FORM.baseFontPt}pt;
          line-height: 1.15;
          color: #000;
          box-shadow: 0 1px 6px rgba(0,0,0,.25);
        }
        @media print {
          /* No margin: the form's own printing is the margin, and any page box would
             shift every field off the blanks. */
          @page { size: ${FORM.page.width}mm ${FORM.page.height}mm; margin: 0; }
          .si-sheet { box-shadow: none; margin: 0; page-break-after: always; }
          .si-sheet:last-child { page-break-after: auto; }
        }
      `}</style>

      {pages.map((pageLines, pageIdx) => {
        const isLast = pageIdx === pages.length - 1;
        return (
          <div className="si-sheet" key={pageIdx}>
            {calibrate && <Grid page={FORM.page} />}

            {/* Header blanks repeat on every sheet -- a continuation page is a second
                pre-printed form with its own serial, so it has to identify its customer too. */}
            <Field spec={FORM.header.customerName} calibrate={calibrate} name="customerName">{si.customer_name}</Field>
            <Field spec={FORM.header.customerTin} calibrate={calibrate} name="customerTin">{si.customer_tin}</Field>
            <Field spec={FORM.header.customerAddress} calibrate={calibrate} name="customerAddress">
              {si.customer_address || si.bill_to_address}
            </Field>
            <Field spec={FORM.header.date} calibrate={calibrate} name="date">{formatDate(si.date_created, true)}</Field>
            <Field spec={FORM.header.terms} calibrate={calibrate} name="terms">{si.term}</Field>

            {pageLines.map((l, rowIdx) => {
              const y = FORM.items.top + rowIdx * FORM.items.rowHeight;
              const c = FORM.items.columns;
              return (
                <div key={l.id}>
                  <Field spec={{ ...c.qty, y }} calibrate={calibrate && rowIdx === 0} name="qty">{qtyText(l.quantity)}</Field>
                  <Field spec={{ ...c.unit, y }} calibrate={calibrate && rowIdx === 0} name="unit">{l.units}</Field>
                  <Field spec={{ ...c.description, y }} calibrate={calibrate && rowIdx === 0} name="description">{l.description}</Field>
                  <Field spec={{ ...c.unitPrice, y }} calibrate={calibrate && rowIdx === 0} name="unitPrice">{money(l.price_per_unit)}</Field>
                  <Field spec={{ ...c.amount, y }} calibrate={calibrate && rowIdx === 0} name="amount">{money(l.gross_amount)}</Field>
                </div>
              );
            })}

            {isLast && (
              <Field
                spec={{ ...FORM.items.orderId, y: FORM.items.top + pageLines.length * FORM.items.rowHeight + FORM.items.orderId.gap }}
                calibrate={calibrate}
                name="orderId"
              >
                {`Order ID : ${si.sales_order_no || ''}${si.po_no ? `  PO/Ref. Doc: ${si.po_no}` : ''}`}
              </Field>
            )}

            {/* Totals print once, on the final sheet. */}
            {isLast && totals && (
              <>
                <Field spec={FORM.totals.vatableSales} calibrate={calibrate} name="vatableSales">{money(totals.vatable)}</Field>
                <Field spec={FORM.totals.vatExempt} calibrate={calibrate} name="vatExempt">{totals.exempt ? money(totals.exempt) : ''}</Field>
                <Field spec={FORM.totals.zeroRated} calibrate={calibrate} name="zeroRated">{totals.zeroRated ? money(totals.zeroRated) : ''}</Field>
                <Field spec={FORM.totals.vat} calibrate={calibrate} name="vat">{money(totals.vat)}</Field>
                <Field spec={FORM.totals.totalSales} calibrate={calibrate} name="totalSales">{money(totals.totalSales)}</Field>
                <Field spec={FORM.totals.lessWithholding} calibrate={calibrate} name="lessWithholding">
                  {totals.withholding ? money(totals.withholding) : ''}
                </Field>
                <Field spec={FORM.totals.amountDue} calibrate={calibrate} name="amountDue">{money(totals.amountDue)}</Field>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
