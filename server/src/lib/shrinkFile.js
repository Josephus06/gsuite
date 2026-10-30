const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Attachments live in the database, so every megabyte is carried by every nightly backup and
// every replica (asked 2026-10-30: "convert all attachments size to smaller, change the
// extension"). This turns a file into a smaller one of a type that still opens everywhere:
//
//   JPG / JPEG / PNG    -> JPG, at most 2400 px on the long side, quality 82 (EXIF rotation
//                          applied, transparency flattened onto white)
//   PDF  (opt-in)       -> PDF re-written by Ghostscript at /printer (300 dpi images), still vector
//   EPS  (opt-in)       -> PDF by Ghostscript -- vector, and opens in Illustrator
//
// A result is used only when it is at least MIN_SAVING smaller; otherwise null, and the original
// stays. Anything else (RAR, ZIP, AI, Office files, BMP, which sharp cannot read) returns null.
const MAX_SIDE = 2400;
const JPEG_QUALITY = 82;
const MIN_SAVING = 0.15;

let sharp = null;
try { sharp = require('sharp'); } catch { /* not installed: images are left as they are */ }

const extOf = (name) => (String(name || '').match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
const renameTo = (name, ext) => (/\.[^.]+$/.test(name) ? String(name).replace(/\.[^.]+$/, `.${ext}`) : `${name}.${ext}`);
const worthIt = (from, to) => to && to.length > 0 && to.length <= from.length * (1 - MIN_SAVING);

async function shrinkImage(buf) {
  if (!sharp) return null;
  const img = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return null;
  return img
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

let gsPath;
function ghostscript() {
  if (gsPath !== undefined) return gsPath;
  gsPath = ['gs', 'gswin64c'].find((c) => {
    try { require('child_process').execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
  }) || null;
  return gsPath;
}

function runGs(buf, inExt, extraArgs) {
  const gs = ghostscript();
  if (!gs) return Promise.resolve(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-'));
  const inFile = path.join(dir, `in.${inExt}`);
  const outFile = path.join(dir, 'out.pdf');
  fs.writeFileSync(inFile, buf);
  return new Promise((resolve) => {
    execFile(gs, ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER',
      ...extraArgs, `-sOutputFile=${outFile}`, inFile], { timeout: 120000 }, (err) => {
      let out = null;
      if (!err && fs.existsSync(outFile)) out = fs.readFileSync(outFile);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(out);
    });
  });
}

// opts.pdf / opts.eps opt in to the Ghostscript conversions.
async function shrinkFile(buf, fileName, opts = {}) {
  const ext = extOf(fileName);
  try {
    if (['jpg', 'jpeg', 'png'].includes(ext)) {
      const out = await shrinkImage(buf);
      return worthIt(buf, out) ? { buf: out, fileName: renameTo(fileName, 'jpg'), mime: 'image/jpeg' } : null;
    }
    if (ext === 'pdf' && opts.pdf) {
      const out = await runGs(buf, 'pdf', ['-dPDFSETTINGS=/printer']);
      return worthIt(buf, out) ? { buf: out, fileName, mime: 'application/pdf' } : null;
    }
    if (ext === 'eps' && opts.eps) {
      const out = await runGs(buf, 'eps', ['-dEPSCrop', '-dPDFSETTINGS=/printer']);
      return worthIt(buf, out) ? { buf: out, fileName: renameTo(fileName, 'pdf'), mime: 'application/pdf' } : null;
    }
  } catch { /* an unreadable file is left exactly as uploaded */ }
  return null;
}

module.exports = { shrinkFile, ghostscript, hasSharp: () => !!sharp };
