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
