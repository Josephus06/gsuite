// Display labels and small formatters for the Archiver, kept out of the pages so a list and the
// detail view it links to cannot drift into naming the same thing differently.

export const ENTRY_TYPE_LABELS = {
  subscription: 'Subscription',
  licence: 'Licence',
  account: 'Account',
  api_key: 'API Key',
  certificate: 'Certificate',
  other: 'Other',
};

export const ARCHIVE_STATUS_LABELS = {
  active: 'Active',
  expired: 'Expired',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

export const BILLING_CYCLE_LABELS = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semi_annual: 'Semi-annual',
  annual: 'Annual',
  perpetual: 'Perpetual',
  one_time: 'One-time',
};

// What the access log records. Phrased as what a person did, because this list is read by someone
// asking "who opened this and when" -- not by a developer reading event names.
export const ACCESS_ACTION_LABELS = {
  created: 'Created the entry',
  updated: 'Edited the entry',
  secret_updated: 'Changed the password',
  request_code: 'Requested a code',
  reveal: 'Attempted a reveal',
  revealed: 'Revealed the password',
  share_granted: 'Granted access',
  share_revoked: 'Removed access',
  deleted: 'Deleted the entry',
};

export const ACCESS_OUTCOME_LABELS = {
  success: 'OK',
  failed: 'Failed',
  denied: 'Denied',
  rate_limited: 'Rate limited',
};

// Parsed from the string rather than through new Date(value) so a date-only value cannot shift a
// day in a timezone ahead of UTC -- the same trap that put dateStrings:true in the server's db.js.
export function formatDate(v) {
  if (!v) return '—';
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

export function formatDateTime(v) {
  return v ? new Date(v).toLocaleString() : '—';
}

// ---- Files ------------------------------------------------------------------------------------

export const FILE_STATUS_LABELS = {
  active: 'Active',
  superseded: 'Superseded',
  expired: 'Expired',
  archived: 'Archived',
};

export const FILE_ACTION_LABELS = {
  created: 'Uploaded the document',
  updated: 'Edited the details',
  version_added: 'Uploaded a new version',
  downloaded: 'Downloaded',
  share_granted: 'Granted access',
  share_revoked: 'Removed access',
  deleted: 'Deleted the document',
};

// Binary units, since that is what a file manager reports and what people compare against.
export function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// A short label for the file type, from the MIME type. Showing
// "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" in a table helps nobody.
export function fileKind(mime) {
  if (!mime) return 'File';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('image/')) return 'Image';
  if (mime.includes('spreadsheet') || mime.includes('ms-excel')) return 'Excel';
  if (mime.includes('wordprocessing') || mime.includes('msword')) return 'Word';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'PowerPoint';
  if (mime === 'text/csv') return 'CSV';
  if (mime.startsWith('text/')) return 'Text';
  if (mime.includes('zip')) return 'ZIP';
  return 'File';
}
