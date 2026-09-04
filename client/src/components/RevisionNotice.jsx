import {
  REVISION_DELIVERY_DATE, REVISION_REASON_LABELS, DATE_CHANGE_REASON_LABELS,
} from '../utils/salesRevision';

const day = (v) => (v ? String(v).slice(0, 10) : '');

// What Production asked for when it sent this job order back, shown on both the Sales and the
// Production view of it. Rendered from the job order's own columns rather than from the audit
// log, so it reads the same on either screen and survives however the page was reached.
//
// Only drawn while the job order is actually in revision: once it goes back to Production the
// columns are last-time's answer, and showing them beside a job that is moving again would
// read as a live request.
export default function RevisionNotice({ jo }) {
  if (!jo || jo.production_stage !== 'for_revision' || !jo.revision_reason) return null;

  const isDate = jo.revision_reason === REVISION_DELIVERY_DATE;
  const suggested = day(jo.revision_suggested_delivery_date);
  const current = day(jo.delivery_date);

  return (
    <div style={{
      marginTop: 12,
      padding: '10px 12px',
      borderRadius: 6,
      background: 'rgba(245, 159, 0, 0.18)',
      border: '1px solid rgba(245, 159, 0, 0.45)',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        Sent back for revision — {REVISION_REASON_LABELS[jo.revision_reason] || jo.revision_reason}
      </div>
      {isDate && (
        <div>
          Suggested Delivery Date : <span className="hi">{suggested || '—'}</span>
          {current && <> (currently promised for <span className="hi">{current}</span>)</>}
        </div>
      )}
      {/* Why the date has to move. The label falls back to the stored code so a reason added
          to the server's list but not yet to this one still reads as something. */}
      {isDate && jo.revision_date_reason && (
        <div>
          Reason : <span className="hi">
            {DATE_CHANGE_REASON_LABELS[jo.revision_date_reason] || jo.revision_date_reason}
          </span>
        </div>
      )}
      {!isDate && <div>Sales may change this Job Order’s materials and processes.</div>}
      {jo.revision_note && <div>Remarks : <span className="hi">{jo.revision_note}</span></div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {jo.revision_requested_by_name ? `Requested by ${jo.revision_requested_by_name}` : 'Requested by Production'}
        {jo.revision_requested_at ? ` on ${String(jo.revision_requested_at).slice(0, 16).replace('T', ' ')}` : ''}
      </div>
    </div>
  );
}
