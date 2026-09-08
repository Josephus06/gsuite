// Display labels for the Assets Monitoring module, kept out of the page components so a list and
// the detail view it links to can never drift into calling the same state two different things.

export const STATUS_LABELS = {
  active: 'Active',
  for_repair: 'For Repair',
  retired: 'Retired',
  disposed: 'Disposed',
  missing: 'Missing',
};

export const CONDITION_LABELS = { good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged' };

// The transfer's own progress. pending_release / pending_receipt are spelled out rather than
// shortened, because "Pending" alone would not say WHICH of the two signatures is outstanding --
// the one thing anyone opening the document wants to know.
export const TRANSFER_STATUS_LABELS = {
  draft: 'Draft',
  pending_release: 'Pending Release Approval',
  pending_receipt: 'Pending Receipt Approval',
  approved: 'Approved',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const AUDIT_STATUS_LABELS = { open: 'Open', completed: 'Completed', cancelled: 'Cancelled' };

export const AUDIT_RESULT_LABELS = {
  pending: 'Not counted',
  verified: 'Verified',
  wrong_location: 'Wrong location',
  not_found: 'Not found',
  damaged: 'Damaged',
};

export const MOVEMENT_LABELS = {
  registered: 'Registered',
  transfer: 'Transfer',
  carried: 'Carried with host',
  attached: 'Attached',
  detached: 'Detached',
  correction: 'Correction',
  audit_correction: 'Audit correction',
  status_change: 'Status change',
};

// ---- Fixed-asset accounting -----------------------------------------------------------------

export const DEPRECIATION_STATUS_LABELS = { draft: 'Draft', posted: 'Posted', voided: 'Voided' };

export const DISPOSAL_STATUS_LABELS = { draft: 'Draft', posted: 'Posted', voided: 'Voided' };

export const DISPOSAL_TYPE_LABELS = {
  sale: 'Sale', scrap: 'Scrapped', donation: 'Donated', write_off: 'Written Off',
};

export const COST_TYPE_LABELS = {
  purchase: 'Purchase', freight: 'Freight', installation: 'Installation',
  improvement: 'Improvement', other: 'Other',
};

// Two decimals always, thousands separated -- these are ledger figures, and a depreciation charge
// rendered as 266.7 rather than 266.67 reads as a different number.
export function formatMoney(v) {
  if (v == null || v === '') return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Periods are stored as the first of the month; parsed explicitly rather than via new Date(string)
// so a UTC-parsed date cannot render as the previous month in a timezone ahead of UTC.
export function formatMonth(v) {
  if (!v) return '—';
  const [y, m] = String(v).slice(0, 7).split('-').map(Number);
  if (!y || !m) return '—';
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
