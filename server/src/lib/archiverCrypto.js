// Encryption for the Archiver's stored secrets.
//
// AES-256-GCM, from Node's built-in crypto -- no dependency, and GCM is authenticated, which is
// the property that matters here: it does not merely hide the secret, it detects tampering. A
// plain CBC ciphertext can be altered in the database and will decrypt to different plaintext
// without complaint. GCM's tag makes that fail loudly instead.
//
// WHAT THIS PROTECTS AGAINST, stated plainly so nobody assumes more:
//   * a leaked database dump or backup file -- the ciphertext is useless without the key, and the
//     key is never in the database;
//   * anyone reading the tables directly, including staff with database access;
//   * a secret being logged, echoed in a list response, or shoulder-surfed from a grid.
//
// WHAT IT DOES NOT PROTECT AGAINST: someone who can read the server's environment. The
// application must be able to decrypt to show a secret, so the key is on the box. That is the
// deliberate trade for a COMPANY vault, where credentials have to survive the person who created
// them leaving. Zero-knowledge encryption would close that gap and lose the recovery.
//
// THE KEY MUST BE THE SAME ON THE DROPLET AND THE OFFICE BOX -- they are master-master
// replicated, so a row encrypted on one is read on the other.
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32; // 256 bits
const KEY_VERSION = 1;

// Read at call time rather than at module load. A missing key must be reportable through the API
// ("the vault is not configured") rather than crashing the whole server at boot -- the rest of the
// ERP has no business going down because one module is unconfigured.
function readKey() {
  const raw = process.env.ARCHIVER_KEY;
  if (!raw) return null;

  // Accept base64 or hex, because whoever sets this will paste whichever their generator produced.
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    key = Buffer.from(raw.trim(), 'hex');
  } else {
    try {
      const buf = Buffer.from(raw.trim(), 'base64');
      if (buf.length === KEY_BYTES) key = buf;
    } catch { key = null; }
  }
  return key && key.length === KEY_BYTES ? key : null;
}

function isConfigured() {
  return readKey() !== null;
}

// Why the key is not simply hashed into shape: accepting any string and running it through SHA-256
// would make every short, guessable passphrase silently "valid" as a 256-bit key. Refusing
// anything that is not genuinely 32 bytes of random forces a real key to be generated.
function assertConfigured() {
  if (!isConfigured()) {
    const err = new Error(
      'The Archiver is not configured: ARCHIVER_KEY is missing or is not a 32-byte key. '
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" '
      + 'and set the SAME value on every server that shares this database.',
    );
    err.status = 503;
    throw err;
  }
}

// Returns the three parts the row stores. A fresh random IV per encryption is not optional with
// GCM -- reusing one against the same key is the failure that breaks the cipher outright.
function encryptSecret(plaintext) {
  assertConfigured();
  if (plaintext == null || plaintext === '') return null;

  const key = readKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

// Throws if the row was encrypted under a different key, or if any of the three parts has been
// altered. Both are worth failing on rather than papering over: silently returning nothing would
// look like an empty password, which is far more dangerous than an error.
function decryptSecret({ ciphertext, iv, tag }) {
  assertConfigured();
  if (!ciphertext || !iv || !tag) return null;

  const key = readKey();
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv));
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    const err = new Error(
      'This secret could not be decrypted. Either ARCHIVER_KEY differs from the key it was '
      + 'stored with, or the stored value has been altered.',
    );
    err.status = 500;
    throw err;
  }
}

// --- Step-up verification codes ---------------------------------------------------------------

const CODE_DIGITS = 6;

// randomInt, not Math.random: this is a security token, and Math.random is predictable.
// Zero-padded so every code is six characters -- a leading zero being dropped would make some
// codes five digits and confuse whoever is typing it in.
function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

// Codes are stored hashed. The verifications table would otherwise be a place where anyone with
// database read access could pick up a live code and use it -- which would defeat the entire
// point of asking for one.
//
// SHA-256 rather than bcrypt is right HERE and wrong for passwords: a six-digit code lives for
// five minutes, is single-use, and is rate-limited to a handful of attempts, so the slow-hash
// property bcrypt provides buys nothing while costing latency on every check. The salt keeps two
// identical codes from sharing a hash.
function hashCode(code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

// Salt and hash travel together in the single code_hash column as "salt$hash". Keeping the format
// here rather than in the route means there is one place that knows it, so a reader cannot end up
// hashing with one layout and comparing against another.
function hashCodeForStorage(code) {
  const salt = crypto.randomBytes(12).toString('hex');
  return `${salt}$${hashCode(code, salt)}`;
}

// Constant-time compare, so a wrong code cannot be narrowed down by how long the check took.
function codeMatchesStored(code, stored) {
  const [salt, expected] = String(stored || '').split('$');
  if (!salt || !expected) return false;
  const candidate = Buffer.from(hashCode(code, salt));
  const target = Buffer.from(expected);
  if (candidate.length !== target.length) return false;
  return crypto.timingSafeEqual(candidate, target);
}

module.exports = {
  KEY_VERSION,
  CODE_DIGITS,
  isConfigured,
  assertConfigured,
  encryptSecret,
  decryptSecret,
  generateCode,
  hashCodeForStorage,
  codeMatchesStored,
};
