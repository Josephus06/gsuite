// Performance Evaluation (2026-10-23): shared by My Performance, the evaluation and HR's page.
export const STATUS_BADGE = {
  open: 'badge-info', self_rating: 'badge-warning', supervisor_rating: 'badge-warning', discussion: 'badge-warning',
  dept_head_review: 'badge-info', hr_review: 'badge-info', gm_approval: 'badge-info', approved: 'badge-success',
};
export const STEPS = [
  ['open', 'Quarter (remarks)'], ['self_rating', 'Self rating'], ['supervisor_rating', "Supervisor's rating"], ['discussion', 'Discussion & conforme'],
  ['dept_head_review', 'Dept head'], ['hr_review', 'HR'], ['gm_approval', 'GM'], ['approved', 'Approved'],
];
export const RATINGS = [
  [4, 'Excellent', 'EXCEEDED target -- 100% or more of the target / standard', 'All behaviors are shown all the time. A model of the core value'],
  [3, 'Meets requirements', 'ACHIEVED target -- 80% to below 100%', 'Most behaviors are shown most of the time'],
  [2, 'Needs improvement', 'BELOW target -- 75% to below 80%', 'Some behaviors are shown'],
  [1, 'Fail', 'UNSATISFACTORY -- below 75% of target / standard', 'Many behaviors are not demonstrated'],
];
export const ratingLabel = (v) => (RATINGS.find((r) => r[0] === Math.min(4, Math.max(1, Math.round(Number(v))))) || [])[1] || '';
export const fmtScore = (v) => (v == null ? '—' : Number(v).toFixed(2));
export const pts = (rating, weight) => (rating ? Number(rating) * (Number(weight) / 100) : null);
