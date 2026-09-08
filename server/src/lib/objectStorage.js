// Object storage for archive files that are too large to live in the database.
//
// WHY THIS EXISTS. Layout archives for large-format work run to tens of gigabytes. Three separate
// walls make the database impossible for those, and none of them is a setting that can be raised:
//
//   * a MySQL LONGBLOB tops out at 4 GB, so a 150 GB file cannot be stored in one at all;
//   * the droplet has ~55 GB of free disk, so one such file does not fit on the server;
//   * droplet and office are master-master replicated, so every byte written to one would be
//     shipped to the other, and mysqldump backups would become unusable.
//
// So the bytes go to S3-compatible object storage (DigitalOcean Spaces) and the database keeps
// only metadata and a key.
//
// THE BYTES NEVER PASS THROUGH THIS SERVER. The browser uploads straight to storage using
// presigned URLs. Proxying 150 GB through Node would tie up the process for hours and put the
// whole ERP at the mercy of one artist's upload.
//
// MULTIPART IS NOT OPTIONAL AT THIS SIZE. A single presigned PUT is capped at 5 GB by S3, so
// anything larger has to be split. Multipart also buys the thing that actually matters over a
// multi-hour upload: a failed part is retried on its own instead of restarting 150 GB.
const {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// 100 MB parts. S3 allows 5 MB to 5 GB and at most 10,000 parts, which sets the real ceiling:
// at 100 MB a part the maximum object is ~1 TB, and a 150 GB file becomes ~1,500 parts. Smaller
// parts would mean more round trips and more presign calls for no benefit; larger parts mean more
// to re-send when one fails.
const PART_SIZE = 100 * 1024 * 1024;
const MAX_PARTS = 10000;

// Presigned URLs are short-lived by design. An upload URL only has to survive one part, and a
// download URL only has to survive the click that follows it -- a long-lived URL is a copy of the
// file that anyone holding the link can fetch, with no permission check behind it.
const UPLOAD_URL_TTL = 60 * 60; // one hour, so a slow part on a bad line still completes
const DOWNLOAD_URL_TTL = 5 * 60;

function config() {
  const {
    SPACES_ENDPOINT, SPACES_REGION, SPACES_BUCKET, SPACES_KEY, SPACES_SECRET,
  } = process.env;
  if (!SPACES_ENDPOINT || !SPACES_BUCKET || !SPACES_KEY || !SPACES_SECRET) return null;
  return {
    endpoint: SPACES_ENDPOINT,
    region: SPACES_REGION || 'us-east-1', // Spaces ignores region but the SDK insists on one
    bucket: SPACES_BUCKET,
    credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
  };
}

function isConfigured() {
  return config() !== null;
}

let cachedClient = null;
let cachedFor = null;
function client() {
  const cfg = config();
  if (!cfg) {
    const err = new Error(
      'Large-file storage is not configured. Set SPACES_ENDPOINT, SPACES_BUCKET, SPACES_KEY and '
      + 'SPACES_SECRET to archive files larger than the in-database limit.',
    );
    err.status = 503;
    throw err;
  }
  // Rebuilt only when the settings change, so rotating a key takes effect without a restart.
  const fingerprint = `${cfg.endpoint}|${cfg.bucket}|${cfg.credentials.accessKeyId}`;
  if (!cachedClient || cachedFor !== fingerprint) {
    cachedClient = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: cfg.credentials,
      // Spaces uses path-style addressing; virtual-host style resolves to the wrong hostname.
      forcePathStyle: true,
    });
    cachedFor = fingerprint;
  }
  return { s3: cachedClient, cfg };
}

// How many parts a file of this size needs, and whether it can be stored at all.
function planUpload(sizeBytes) {
  const size = Number(sizeBytes) || 0;
  if (size <= 0) return { error: 'The file is empty.' };
  const partCount = Math.ceil(size / PART_SIZE);
  if (partCount > MAX_PARTS) {
    return { error: `That file is ${(size / 1024 ** 3).toFixed(1)}GB, which exceeds the ${((MAX_PARTS * PART_SIZE) / 1024 ** 4).toFixed(1)}TB maximum.` };
  }
  return { partSize: PART_SIZE, partCount, size };
}

// The storage key. Deliberately namespaced and given a random suffix rather than using the
// original filename: two artists archiving "final.zip" against different job orders must not
// collide, and a key that can be guessed from a job order number is a key that can be fetched by
// anyone who learns the bucket.
function buildKey({ jobOrderNo, fileName }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const random = Math.random().toString(36).slice(2, 10);
  const safeJo = String(jobOrderNo || 'misc').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  // Runs of dots are collapsed as well as slashes. Stripping slashes alone leaves ".." intact,
  // and while S3's namespace is flat -- so that is not a traversal in the bucket -- the moment
  // someone syncs the bucket to a local disk with rclone or s3cmd, a key containing ".." is
  // interpreted as a parent directory again.
  const safeName = String(fileName || 'archive.zip')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(-80);
  return `artist-archives/${stamp}/${safeJo}/${random}-${safeName}`;
}

async function createMultipartUpload(key, contentType = 'application/zip') {
  const { s3, cfg } = client();
  const out = await s3.send(new CreateMultipartUploadCommand({
    Bucket: cfg.bucket, Key: key, ContentType: contentType,
  }));
  return { uploadId: out.UploadId, bucket: cfg.bucket, key };
}

// One presigned URL for one part. Signed per part rather than all at once: 1,500 URLs would be a
// large response, and they expire -- a long upload asks for the next one when it gets there.
async function signPart(key, uploadId, partNumber) {
  const { s3, cfg } = client();
  return getSignedUrl(s3, new UploadPartCommand({
    Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber,
  }), { expiresIn: UPLOAD_URL_TTL });
}

// parts: [{ PartNumber, ETag }] in ascending order. S3 rejects the completion otherwise.
async function completeMultipartUpload(key, uploadId, parts) {
  const { s3, cfg } = client();
  const ordered = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  const out = await s3.send(new CompleteMultipartUploadCommand({
    Bucket: cfg.bucket, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: ordered },
  }));
  return { etag: out.ETag, location: out.Location };
}

// Called when an upload is cancelled or fails. Without this the uploaded parts sit in the bucket
// invisible and still billed -- abandoned multipart uploads are the classic way an S3 bill grows
// with nothing to show for it.
async function abortMultipartUpload(key, uploadId) {
  const { s3, cfg } = client();
  await s3.send(new AbortMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId }));
}

// The size storage actually recorded, used to verify the upload rather than trust the browser's
// claim about what it sent.
async function headObject(key) {
  const { s3, cfg } = client();
  const out = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return { size: Number(out.ContentLength) || 0, etag: out.ETag, contentType: out.ContentType };
}

async function deleteObject(key) {
  const { s3, cfg } = client();
  await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

// A short-lived download link. `fileName` sets what the browser saves it as, so the stored key --
// which carries a random suffix -- never becomes the filename the artist sees.
async function signDownload(key, fileName) {
  const { s3, cfg } = client();
  const safe = String(fileName || 'archive.zip').replace(/["\\]/g, '_');
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: cfg.bucket, Key: key,
    ResponseContentDisposition: `attachment; filename="${safe}"`,
  }), { expiresIn: DOWNLOAD_URL_TTL });
}

module.exports = {
  PART_SIZE,
  MAX_PARTS,
  DOWNLOAD_URL_TTL,
  isConfigured,
  planUpload,
  buildKey,
  createMultipartUpload,
  signPart,
  completeMultipartUpload,
  abortMultipartUpload,
  headObject,
  deleteObject,
  signDownload,
};
