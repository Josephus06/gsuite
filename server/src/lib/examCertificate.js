const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Certificate of Completion for a passed exam (2026-10-21; routes/exams.js and examAdmin.js). One
// landscape A4 page in the company's colours, built in memory like the estimate and PO PDFs.
const MARK_FILE = path.join(__dirname, '..', 'assets', 'brand', 'graphicstar-mark.png');
const BLUE = '#0b109f';
const ORANGE = '#ec7601';
const INK = '#333333';
const MUTED = '#666666';
const LEGAL = 'CEBU GRAPHICSTAR IMAGING CORP.';

const longDate = (ymd) => new Date(`${String(ymd).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

// { name, title, setName, percent, date (YYYY-MM-DD), certificateNo } -> Buffer
// heading / detail replace the exam wording, for a training course's certificate (lib/training.js).
function certificatePdf({ name, title, setName, percent, date, certificateNo, heading, detail }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate - ${name} - ${title}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width;
    const H = doc.page.height;

    // Double border, blue outside, orange inside.
    doc.lineWidth(6).strokeColor(BLUE).rect(22, 22, W - 44, H - 44).stroke();
    doc.lineWidth(1.5).strokeColor(ORANGE).rect(34, 34, W - 68, H - 68).stroke();

    let y = 62;
    if (fs.existsSync(MARK_FILE)) { doc.image(MARK_FILE, W / 2 - 32, y, { fit: [64, 64], align: 'center' }); y += 72; }
    doc.font('Helvetica-Bold').fontSize(13).fillColor(BLUE).text('GRAPHIC', 0, y, { width: W / 2 + 1, align: 'right', continued: false });
    doc.fillColor(ORANGE).text('STAR', W / 2 + 1, y, { width: W / 2, align: 'left' });
    y += 34;

    doc.font('Helvetica-Bold').fontSize(34).fillColor(BLUE).text('CERTIFICATE OF COMPLETION', 0, y, { width: W, align: 'center', characterSpacing: 1.5 });
    y += 56;
    doc.font('Helvetica').fontSize(13).fillColor(MUTED).text('This certifies that', 0, y, { width: W, align: 'center' });
    y += 28;
    doc.font('Helvetica-Bold').fontSize(30).fillColor(INK).text(name, 60, y, { width: W - 120, align: 'center' });
    y += 44;
    doc.moveTo(W / 2 - 210, y).lineTo(W / 2 + 210, y).lineWidth(0.8).strokeColor(ORANGE).stroke();
    y += 18;
    doc.font('Helvetica').fontSize(13).fillColor(MUTED).text(heading || 'has successfully completed the examination', 0, y, { width: W, align: 'center' });
    y += 24;
    doc.font('Helvetica-Bold').fontSize(19).fillColor(BLUE).text(title, 60, y, { width: W - 120, align: 'center' });
    y += 30;
    doc.font('Helvetica').fontSize(12).fillColor(MUTED)
      .text(detail || `${setName ? `${setName} · ` : ''}with a score of ${Number(percent).toFixed(1).replace(/\.0$/, '')}% on ${longDate(date)}`, 0, y, { width: W, align: 'center' });

    // Signature line and the company.
    const sy = H - 132;
    doc.moveTo(W / 2 - 130, sy).lineTo(W / 2 + 130, sy).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Human Resources Department', 0, sy + 8, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(LEGAL, 0, sy + 24, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#999999').text(`Certificate No. ${certificateNo}`, 0, H - 58, { width: W - 60, align: 'right' });
    doc.end();
  });
}

module.exports = { certificatePdf };
