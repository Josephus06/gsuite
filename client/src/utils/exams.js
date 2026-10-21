import { parseUtc } from './datetime';

// HRD > Examinations (2026-10-21; server lib/exams.js). Shared by My Exams, the exam itself, the
// Question Bank and HR's pages.
export const TYPE_LABELS = {
  true_false: 'True or False',
  multiple_choice: 'Multiple Choice',
  multiple_select: 'Multiple Select',
  identification: 'Identification',
  essay: 'Essay',
};
export const TYPES = Object.keys(TYPE_LABELS);
export const CHOICE_TYPES = ['multiple_choice', 'multiple_select'];
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const STATUS_LABELS = { assigned: 'Not Started', in_progress: 'In Progress', submitted: 'Submitted', missed: 'Missed' };
export const STATUS_BADGE = { assigned: 'badge-warning', in_progress: 'badge-info', submitted: 'badge-success', missed: 'badge-danger' };
export const ORIENTATION_LABELS = { recommended: 'Recommended', scheduled: 'Scheduled', attended: 'Attended', dismissed: 'Dismissed' };
export const ORIENTATION_BADGE = { recommended: 'badge-warning', scheduled: 'badge-info', attended: 'badge-success', dismissed: 'badge-muted' };

export const fmtDay = (v) => {
  if (!v) return '';
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
export const fmtWhen = (v) => (v ? parseUtc(v).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');
export const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1).replace(/\.0$/, '')}%`);

// An answer as words: choices by their text (in the order the reader was shown), T/F, text.
export function answerText(type, value, choices) {
  if (value == null || value === '') return '';
  if (type === 'true_false') return value === true || value === 'true' ? 'True' : 'False';
  if (type === 'multiple_choice') return (choices || []).find((c) => Number(c.i) === Number(value))?.text ?? '';
  if (type === 'multiple_select') return (choices || []).filter((c) => (value || []).map(Number).includes(Number(c.i))).map((c) => c.text).join('; ');
  if (type === 'identification' && Array.isArray(value)) return value.join(' | ');
  if (type === 'essay' && typeof value === 'object') return value.guide || '';
  return String(value);
}

// A bank question's choices as the { i, text } list answerText reads.
export const indexed = (choices) => (choices || []).map((text, i) => ({ i, text }));
