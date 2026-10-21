const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const pool = require('../db');

// Certificate of Completion (2026-10-21) -- for a passed exam (routes/exams.js, examAdmin.js) and a
// completed training course (routes/training.js). One landscape A4 page in the company's design
// (asked 2026-10-21): blue and orange bands, the GraphicStar logo, CERTIFICATE / OF COMPLETION,
// the name in script, the title in orange, "given this 21st day of October, 2026", a seal with the
// certificate number, and two signatories.
//
// SIGNATORIES are HR's to set (Examinations > Certificate Signatories; app_settings cert_*): each a
// user -- their name, and their e-signature drawn above the line when they have one -- and a
// position. Until set: the HRD department head, and the General Manager.
const ASSETS = path.join(__dirname, '..', 'assets');
const LOGO = path.join(ASSETS, 'brand', 'graphicstar-letterhead.png');
const FONT = {
  regular: path.join(ASSETS, 'fonts', 'Montserrat-400.ttf'),
  semibold: path.join(ASSETS, 'fonts', 'Montserrat-600.ttf'),
  bold: path.join(ASSETS, 'fonts', 'Montserrat-700.ttf'),
  black: path.join(ASSETS, 'fonts', 'Montserrat-800.ttf'),
  script: path.join(ASSETS, 'fonts', 'GreatVibes-Regular.ttf'),
};
const BLUE = '#0b3d9a';
const ORANGE = '#ec7601';
const INK = '#333333';
const MUTED = '#6b7280';
const COMPANY = 'Cebu Graphicstar Imaging Corp.';

const SETTING_KEYS = ['cert_left_user_id', 'cert_left_title', 'cert_right_user_id', 'cert_right_title'];

// { left: { user_id, name, title, signature }, right: {...} } -- the settings, else the defaults.
async function signatories() {
  const [rows] = await pool.query('SELECT name, value FROM app_settings WHERE name IN (?)', [SETTING_KEYS]).catch(() => [[]]);
  const s = Object.fromEntries(rows.map((r) => [r.name, r.value]));
  let leftId = Number(s.cert_left_user_id) || null;
  let rightId = Number(s.cert_right_user_id) || null;
  if (!leftId) {
    const [[d]] = await pool.query("SELECT head_user_id FROM departments WHERE is_active = 1 AND head_user_id IS NOT NULL AND (name = 'HRD' OR name LIKE 'Human Resource%') ORDER BY name = 'HRD' DESC LIMIT 1");
    leftId = d?.head_user_id || null;
  }
  if (!rightId) {
    const [[gm]] = await pool.query(
      `SELECT u.id FROM users u WHERE u.is_active = 1 AND (u.account_type = 'General Manager'
          OR u.id IN (SELECT user_id FROM general_managers)) ORDER BY u.id LIMIT 1`).catch(() => [[null]]);
    rightId = gm?.id || null;
  }
  const ids = [leftId, rightId].filter(Boolean);
  const [users] = ids.length ? await pool.query('SELECT id, display_name, signature_data FROM users WHERE id IN (?)', [ids]) : [[]];
  const one = (id, title, fallback) => {
    const u = users.find((x) => Number(x.id) === Number(id));
    return { user_id: id, name: u?.display_name || '', title: title || fallback, signature: u?.signature_data || null };
  };
  return {
    left: one(leftId, s.cert_left_title, 'HR Department Head'),
    right: one(rightId, s.cert_right_title, 'General Manager'),
  };
}

const ordinal = (n) => {
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
};
// "given this 21st day of October, 2026"
const givenOn = (ymd) => {
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00`);
  return `given this ${ordinal(d.getDate())} day of ${d.toLocaleDateString('en-US', { month: 'long' })}, ${d.getFullYear()}`;
};

// A data-URL picture (an e-signature) as a Buffer, or null.
const dataImage = (v) => {
  const m = String(v || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  return m ? Buffer.from(m[2], 'base64') : null;
};

// { name, title, heading?, date (YYYY-MM-DD), certificateNo } -> Buffer. `heading` is the line before
// the title: an exam "has successfully completed the", a course "has successfully read, understood
// and completed the".
async function certificatePdf({ name, title, heading, date, certificateNo }) {
  const sign = await signatories();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate - ${name} - ${title}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Object.entries(FONT).forEach(([k, f]) => doc.registerFont(k, f));
    const W = doc.page.width;
    const H = doc.page.height;
    const center = (text, y, opts = {}) => doc.text(text, 0, y, { width: W, align: 'center', ...opts });

    // Bands top and bottom: blue with an orange rule.
    doc.rect(0, 0, W, 12).fill(BLUE);
    doc.rect(0, 12, W, 3.5).fill(ORANGE);
    doc.rect(0, H - 15.5, W, 3.5).fill(ORANGE);
    doc.rect(0, H - 12, W, 12).fill(BLUE);
    // Frame: blue outside, orange inside.
    doc.roundedRect(30, 36, W - 60, H - 72, 5).lineWidth(1.6).strokeColor(BLUE).stroke();
    doc.rect(38, 44, W - 76, H - 88).lineWidth(0.7).strokeColor(ORANGE).stroke();

    // Logo, then a blue-to-orange rule.
    let y = 64;
    if (fs.existsSync(LOGO)) { const lw = 230; doc.image(LOGO, (W - lw) / 2, y, { width: lw }); y += lw * (148 / 900) + 12; }
    const grad = doc.linearGradient(W / 2 - 150, 0, W / 2 + 150, 0);
    grad.stop(0, BLUE).stop(1, ORANGE);
    doc.rect(W / 2 - 150, y, 300, 2.6).fill(grad);
    y += 12;

    doc.font('black').fontSize(40).fillColor(BLUE);
    center('CERTIFICATE', y, { characterSpacing: 1.5 });
    y += 50;
    // The orange pill.
    const pw = 180;
    doc.roundedRect((W - pw) / 2, y, pw, 25, 12.5).fill(ORANGE);
    doc.font('bold').fontSize(9.5).fillColor('#ffffff');
    center('OF COMPLETION', y + 8, { characterSpacing: 3.2 });
    y += 40;

    doc.font('regular').fontSize(12).fillColor(INK);
    center('This certifies that', y);
    y += 14;
    // The name in script, shrunk to fit a long one.
    let ns = 46;
    doc.font('script');
    while (ns > 26 && doc.fontSize(ns).widthOfString(name) > W - 260) ns -= 2;
    doc.fillColor(BLUE).fontSize(ns);
    center(name, y + (46 - ns) / 2);
    y += 62;
    doc.moveTo(W / 2 - 175, y).lineTo(W / 2 + 175, y).lineWidth(0.7).strokeColor('#b8bcc8').stroke();
    y += 14;

    doc.font('regular').fontSize(11.5).fillColor(INK);
    center(heading || 'has successfully completed the', y);
    y += 20;
    doc.font('bold').fontSize(18).fillColor(ORANGE);
    doc.text(String(title).toUpperCase(), 100, y, { width: W - 200, align: 'center' });
    y = doc.y + 6;
    doc.font('regular').fontSize(9.5).fillColor(MUTED);
    center(`of ${COMPANY}, ${givenOn(date)}.`, y);

    // The seal: an orange ring round a blue disc with a rosette and check.
    const cx = W / 2;
    const cy = H - 128;
    doc.circle(cx, cy, 37).lineWidth(1.6).strokeColor(ORANGE).stroke();
    doc.circle(cx, cy, 32).fill(BLUE);
    doc.lineWidth(1.8).strokeColor('#ffffff').lineJoin('round').lineCap('round');
    doc.circle(cx, cy - 4, 9).stroke();
    doc.moveTo(cx - 4, cy - 4).lineTo(cx - 1, cy - 1).lineTo(cx + 4.5, cy - 7).stroke();
    doc.moveTo(cx - 6, cy + 3.5).lineTo(cx - 8, cy + 14).lineTo(cx - 4, cy + 11.5).lineTo(cx - 1.5, cy + 14.5).lineTo(cx - 0.5, cy + 5).stroke();
    doc.moveTo(cx + 6, cy + 3.5).lineTo(cx + 8, cy + 14).lineTo(cx + 4, cy + 11.5).lineTo(cx + 1.5, cy + 14.5).lineTo(cx + 0.5, cy + 5).stroke();
    doc.font('bold').fontSize(8.5).fillColor('#4b5563');
    center(`CERT. NO. ${certificateNo}`, cy + 46, { characterSpacing: 1 });

    // Signatories: the e-signature above the line (when they have one), then name and position.
    const lineY = H - 132;
    const signatory = (s, x) => {
      const half = 115;
      const img = dataImage(s.signature);
      if (img) { try { doc.image(img, x - 70, lineY - 46, { fit: [140, 42], align: 'center', valign: 'bottom' }); } catch { /* unreadable signature: leave the line blank */ } }
      doc.moveTo(x - half, lineY).lineTo(x + half, lineY).lineWidth(0.8).strokeColor('#6b7280').stroke();
      doc.font('bold').fontSize(10.5).fillColor('#111827').text(s.name || ' ', x - half, lineY + 8, { width: half * 2, align: 'center' });
      doc.font('regular').fontSize(8.5).fillColor(MUTED).text(s.title || ' ', x - half, lineY + 23, { width: half * 2, align: 'center' });
    };
    signatory(sign.left, 190);
    signatory(sign.right, W - 190);
    doc.end();
  });
}

module.exports = { certificatePdf, signatories, SETTING_KEYS };
