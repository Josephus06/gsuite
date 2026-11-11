import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAuth } from '../../context/useAuth';
import { displayDate } from '../../utils/dates';
import { API, StatusBadge, WorkChip, errorOf, personName, resourceName, timeText } from './common';

const ROLE_LABEL = { installer: 'Installer', subcon: 'Subcon', driver: 'Driver', vehicle: 'Vehicle' };

// A project read only (asked 2026-11-10): what the Dashboard's calendar opens for the Account Officers,
// SBUs, Marketing, Sales Managers and General Managers who read it -- the JO, customer, site, dates,
// status, team and crew schedule. The Job Order itself opens from here for anyone who may view it.
export default function ProjectSummaryModal({ projectId, onClose }) {
  const { can } = useAuth();
  const [p, setP] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`${API}/projects/${projectId}/summary`).then(({ data }) => setP(data)).catch((err) => setError(errorOf(err)));
  }, [projectId]);

  const row = (label, value) => (value ? (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0' }}>
      <div className="muted" style={{ width: 130, flex: 'none' }}>{label}</div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{value}</div>
    </div>
  ) : null);
  const names = (list) => list.map(personName).filter(Boolean).join(', ');
  const range = p && `${displayDate(String(p.date_from || '').slice(0, 10))}${p.date_to && p.date_to !== p.date_from ? ` – ${displayDate(String(p.date_to).slice(0, 10))}` : ''}`;

  return (
    <Modal title={p ? `${p.job_order_no || p.project_no} · ${p.title}` : 'Installation project'} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      {!p && !error && <LoadingSpinner />}
      {p && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <StatusBadge status={p.status} /> <span className="muted">{p.progress}% done</span>
            {p.job_order_id && can('/job-orders', 'can_view') && (
              <Link className="btn btn-sm" to={`/job-orders/${p.job_order_id}`} onClick={onClose} style={{ marginLeft: 'auto' }}>Open Job Order</Link>
            )}
          </div>
          {row('Project #', p.project_no)}
          {row('Job Order', p.job_order_no)}
          {row('Customer', p.customer_name)}
          {row('Category', p.category_name)}
          {row('Schedule', range)}
          {row('Site', p.site_address)}
          {row('Description', p.description || p.job_order_description)}
          {row('Installers', names(p.installers))}
          {row('Subcons', names(p.subcons))}
          {row('Driver', p.driver_name)}

          {(p.phases || []).length > 0 && (
            <>
              <h4 style={{ margin: '16px 0 6px' }}>Work Phases</h4>
              <div style={{ display: 'grid', gap: 4 }}>
                {p.phases.map((x) => (
                  <div key={x.id}><WorkChip name={x.work_type} color={x.work_color} /> {displayDate(String(x.date_from).slice(0, 10))} – {displayDate(String(x.date_to).slice(0, 10))}</div>
                ))}
              </div>
            </>
          )}
          <h4 style={{ margin: '16px 0 6px' }}>Crew &amp; Vehicle Schedule</h4>
          {p.crew_slots.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Time</th><th>As</th><th>Who / Vehicle</th><th>Work</th><th>Note</th></tr></thead>
                <tbody>
                  {p.crew_slots.map((s) => (
                    <tr key={s.id}>
                      <td>{displayDate(String(s.work_date).slice(0, 10))}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{timeText(s.start_time)} – {timeText(s.end_time)}</td>
                      <td>{ROLE_LABEL[s.role] || s.role}</td>
                      <td>{resourceName(s)}</td>
                      <td><WorkChip name={s.work_type} color={s.work_color} /></td>
                      <td>{s.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="muted">No one is booked on this project yet.</div>}
        </>
      )}
    </Modal>
  );
}
