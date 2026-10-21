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
const MARK = path.join(ASSETS, 'brand', 'graphicstar-mark.png');
const FONT = {
  sans: path.join(ASSETS, 'fonts', 'Montserrat-400.ttf'),
  sansBold: path.join(ASSETS, 'fonts', 'Montserrat-600.ttf'),
  serif: path.join(ASSETS, 'fonts', 'Cormorant-400-normal.ttf'),
  serifItalic: path.join(ASSETS, 'fonts', 'Cormorant-400-italic.ttf'),
  serifItalicMed: path.join(ASSETS, 'fonts', 'Cormorant-500-italic.ttf'),
  serifSemi: path.join(ASSETS, 'fonts', 'Cormorant-600-normal.ttf'),
  serifBold: path.join(ASSETS, 'fonts', 'Cormorant-700-normal.ttf'),
  script: path.join(ASSETS, 'fonts', 'GreatVibes-Regular.ttf'),
};
const PAPER = '#faf6ef';
const BLUE = '#0b3d9a';
const ORANGE = '#e8912d';
const BRONZE = '#b5651d';
const INK = '#2f3640';
const MUTED = '#5f6672';
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
//
// The design (second version, asked 2026-10-21): cream paper, a blue frame with an orange inner
// rule and orange diamonds at its corners, the GraphicStar mark faint behind the text, CERTIFICATE
// in spaced serif capitals, "OF COMPLETION" between two orange rules, the name in script over a
// fading orange line, the title in serif, a round "GRAPHICSTAR · CERTIFIED" seal with the number.
async function certificatePdf({ name, title, heading, date, certificateNo }) {
  const sign = await signatories();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate - ${name} - ${title}` } });
    const chunks = [];
    doc.on('data', (x) => chunks.push(x));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Object.entries(FONT).forEach(([k, file]) => doc.registerFont(k, file));
    const W = doc.page.width;
    const H = doc.page.height;
    const center = (text, y, opts = {}) => doc.text(text, 0, y, { width: W, align: 'center', lineBreak: false, ...opts });

    doc.rect(0, 0, W, H).fill(PAPER);
    // Frame: blue outside, orange inside, a diamond on each inner corner.
    doc.rect(24, 24, W - 48, H - 48).lineWidth(1.4).strokeColor(BLUE).stroke();
    doc.rect(32, 32, W - 64, H - 64).lineWidth(0.6).strokeColor(ORANGE).stroke();
    for (const [x, y] of [[32, 32], [W - 32, 32], [32, H - 32], [W - 32, H - 32]]) {
      doc.save().translate(x, y).rotate(45).rect(-4, -4, 8, 8).fill(ORANGE).restore();
    }
    // The mark, faint, behind everything.
    if (fs.existsSync(MARK)) { doc.save().opacity(0.07).image(MARK, W / 2 - 140, H / 2 - 150, { fit: [280, 280], align: 'center', valign: 'center' }).restore(); }

    let y = 56;
    if (fs.existsSync(LOGO)) { const lw = 196; doc.image(LOGO, (W - lw) / 2, y, { width: lw }); y += lw * (148 / 900) + 16; }

    doc.font('serif').fontSize(46).fillColor(BLUE);
    center('CERTIFICATE', y, { characterSpacing: 7 });
    y += 58;
    // OF COMPLETION between two orange rules.
    doc.font('sansBold').fontSize(9).fillColor(BRONZE);
    const label = 'OF COMPLETION';
    const lwid = doc.widthOfString(label, { characterSpacing: 3.6 });
    center(label, y, { characterSpacing: 3.6 });
    doc.moveTo(W / 2 - lwid / 2 - 82, y + 5).lineTo(W / 2 - lwid / 2 - 16, y + 5).lineWidth(0.7).strokeColor(ORANGE).stroke();
    doc.moveTo(W / 2 + lwid / 2 + 16, y + 5).lineTo(W / 2 + lwid / 2 + 82, y + 5).stroke();
    y += 30;

    doc.font('serifItalic').fontSize(17).fillColor(MUTED);
    center('This is to certify that', y);
    y += 20;
    let ns = 52;
    doc.font('script');
    while (ns > 28 && doc.fontSize(ns).widthOfString(name) > W - 300) ns -= 2;
    doc.fillColor(BLUE).fontSize(ns);
    center(name, y + (52 - ns) / 2);
    y += 66;
    // A line fading out to both ends.
    const fade = doc.linearGradient(W / 2 - 230, 0, W / 2 + 230, 0);
    fade.stop(0, ORANGE, 0).stop(0.5, ORANGE, 0.9).stop(1, ORANGE, 0);
    doc.rect(W / 2 - 230, y, 460, 1.2).fill(fade);
    y += 14;

    doc.font('serifItalic').fontSize(15).fillColor(MUTED);
    center(heading || 'has successfully completed the', y);
    y += 22;
    doc.font('serifSemi').fontSize(25).fillColor(BLUE);
    doc.text(String(title), 110, y, { width: W - 220, align: 'center', characterSpacing: 0.5 });
    y = doc.y + 6;
    doc.font('sans').fontSize(8.6).fillColor(MUTED);
    center(`Cebu Graphicstar Imaging Corp.  ·  ${givenOn(date).replace(/^given/, 'Given')}`, y, { characterSpacing: 0.6 });

    // The seal: orange ring, blue disc, "GRAPHICSTAR · CERTIFIED ·" round it, a thin orange ring and a check.
    const cx = W / 2;
    const cy = H - 112;
    doc.circle(cx, cy, 40).lineWidth(1.4).strokeColor(ORANGE).stroke();
    doc.circle(cx, cy, 36).fill(BLUE);
    doc.circle(cx, cy, 19).lineWidth(0.8).strokeColor(ORANGE).stroke();
    // Once round, each letter given its own width of the circle so the spacing is even.
    const ring = [...'GRAPHICSTAR \u00B7 CERTIFIED \u00B7 '];
    doc.font('sansBold').fontSize(6.6).fillColor('#ffffff');
    const r = 27.3;
    const widths = ring.map((ch) => doc.widthOfString(ch) + 1.1);
    const scale = 360 / widths.reduce((m, w) => m + w, 0);
    let at = -90;
    ring.forEach((ch, i) => {
      const ang = at + (widths[i] * scale) / 2;
      at += widths[i] * scale;
      const rad = (ang * Math.PI) / 180;
      doc.save().translate(cx + r * Math.cos(rad), cy + r * Math.sin(rad)).rotate(ang + 90)
        .text(ch, -4, -3.1, { width: 8, align: 'center', lineBreak: false }).restore();
    });
    doc.moveTo(cx - 8, cy + 0.5).lineTo(cx - 2.5, cy + 6).lineTo(cx + 8.5, cy - 6).lineWidth(2.6).lineCap('round').lineJoin('round').strokeColor('#ffffff').stroke();
    doc.font('sansBold').fontSize(8).fillColor('#4b5563');
    center(`NO. ${certificateNo}`, cy + 49, { characterSpacing: 1.2 });

    // Signatories: the e-signature above the line, the name in serif, the position in small capitals.
    const lineY = H - 120;
    const signatory = (sg, x) => {
      const half = 120;
      const img = dataImage(sg.signature);
      if (img) { try { doc.image(img, x - 70, lineY - 46, { fit: [140, 42], align: 'center', valign: 'bottom' }); } catch { /* unreadable signature: leave the line blank */ } }
      doc.moveTo(x - half, lineY).lineTo(x + half, lineY).lineWidth(0.8).strokeColor('#4b5563').stroke();
      doc.font('serifBold').fontSize(15).fillColor('#1f2937').text(sg.name || ' ', x - half, lineY + 6, { width: half * 2, align: 'center', lineBreak: false });
      doc.font('sans').fontSize(7.8).fillColor(MUTED).text(String(sg.title || ' ').toUpperCase(), x - half, lineY + 26, { width: half * 2, align: 'center', characterSpacing: 1.2, lineBreak: false });
    };
    signatory(sign.left, 205);
    signatory(sign.right, W - 205);
    doc.end();
  });
}

module.exports = { certificatePdf, signatories, SETTING_KEYS };
