import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayAuditTime } from '../../utils/dates';
import { ROUTE, peso, pct, scoreText, SHORT_FLAG, FLAG_LABELS, useStpMeta, apiError } from './stpUtils';
import { Icon, Avatar, Kpi, StatusPill, ScoreChip, TierPill, VisitStatus, Empty } from './StpBits';
import { TerritoryModal, AccountModal } from './StpForms';

// STP > Territory detail: one territory's figures and the accounts assigned to it.
export default function StpTerritoryView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [t, setT] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'edit' | 'assign'
  const { meta } = useStpMeta(t?.fiscal_year);

  const load = useCallback(() => {
    api.get(`/stp/territories/${id}`).then(({ data }) => { setT(data); setError(''); })
      .catch((e) => setError(apiError(e, 'Could not load the territory.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function remove() {
    if (!window.confirm(`Delete the territory ${t.name}?`)) return;
    try {
      await api.delete(`/stp/territories/${t.id}`);
      navigate(`/stp?fy=${t.fiscal_year}`);
    } catch (e) { setError(apiError(e, 'Could not delete the territory.')); }
  }

  if (error && !t) return <div className="error-banner">{error}</div>;
  if (!t) return <LoadingSpinner />;

  return (
    <div className="stp-page">
      <Link to={`/stp?fy=${t.fiscal_year}`} className="stp-back">← Back to overview</Link>
      <div className="stp-head">
        <div className="stp-title">
          <span className="stp-kpi-icon" style={{ width: 52, height: 52, borderRadius: 14 }}><Icon name="map" size={26} /></span>
          <div style={{ minWidth: 0 }}>
            <h1>{t.name} <StatusPill status={t.status} /></h1>
            <div className="stp-meta">
              <span className="stp-meta-chip"><Icon name="user" size={13} />{t.rep_name || 'Unassigned'}</span>
              {t.coverage_area && <span className="stp-meta-chip"><Icon name="visit" size={13} />{t.coverage_area}</span>}
              <span className="stp-meta-chip"><Icon name="calendar" size={13} />FY {t.fiscal_year}</span>
            </div>
          </div>
        </div>
        <div className="stp-actions">
          {can(ROUTE, 'can_add') && <button className="btn" onClick={() => setModal('assign')}><Icon name="plus" size={16} />Assign account</button>}
          {can(ROUTE, 'can_edit') && <button className="btn btn-primary" onClick={() => setModal('edit')}>Edit territory</button>}
          {can(ROUTE, 'can_delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={t.accounts.length > 0}
              title={t.accounts.length ? 'Reassign its accounts to another territory first' : undefined}>Delete</button>
          )}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="stp-kpis">
        <Kpi icon="target" label="Target" value={peso(t.target_amount)} hint={`${pct(t.target_vs_potential)} of potential`} />
        <Kpi icon="potential" label="Annual potential" value={peso(t.total_potential)} hint={`${t.account_count} accounts`} />
        <Kpi icon="revenue" tone="success" label="Current revenue" value={peso(t.current_revenue)} hint={`Invoiced in FY ${t.fiscal_year}`} />
        <Kpi icon="penetration" tone="neutral" label="Penetration" value={pct(t.penetration)} hint="Revenue ÷ potential" />
        <Kpi icon="volume" label="Average score" value={scoreText(t.average_score)}
          hint={`A ${t.tier_counts.A} · B ${t.tier_counts.B} · C ${t.tier_counts.C} · Prospect ${t.tier_counts.Prospect}`} />
      </div>

      <div className="card">
        <div className="stp-card-head"><h2><Icon name="user" />Accounts <span className="stp-count">{t.accounts.length}</span></h2></div>
        <div className="table-wrap">
          <table className="stp-table wide">
            <thead>
              <tr><th>Account</th><th>Owner</th><th>Segment</th><th className="stp-num">Potential</th><th>R</th><th>F</th><th>V</th><th>C</th>
                <th className="stp-num">Score</th><th>Tier</th><th>Next visit</th><th>Flag</th></tr>
            </thead>
            <tbody>
              {t.accounts.length === 0 && (
                <tr><td colSpan={12}>
                  <Empty icon="user" title="No accounts in this territory yet"
                    action={can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => setModal('assign')}><Icon name="plus" size={16} />Assign the first account</button>}>
                    Assign the customers, leads or prospects this territory's rep looks after.
                  </Empty>
                </td></tr>
              )}
              {t.accounts.map((a) => (
                <tr key={a.id} className="stp-click" onClick={() => navigate(`/stp/accounts/${a.id}?fy=${t.fiscal_year}`)}>
                  <td><span className="stp-who"><Avatar name={a.account_name} size={28} tone={a.tier === 'C' ? 'warning' : a.tier ? 'primary' : 'neutral'} /><span className="name">{a.account_name}</span></span></td>
                  <td>{a.owner_name || '—'}</td>
                  <td>{a.segment}</td>
                  <td className="stp-num">{peso(a.annual_potential)}</td>
                  <td><ScoreChip value={a.recency_score} /></td><td><ScoreChip value={a.frequency_score} /></td>
                  <td><ScoreChip value={a.volume_score} /></td><td><ScoreChip value={a.character_score} /></td>
                  <td className="stp-num"><strong>{scoreText(a.total_score)}</strong></td>
                  <td><TierPill tier={a.tier} prospect={a.is_prospect} short /></td>
                  <td><VisitStatus next={a.next_visit_due} overdue={a.visit_overdue} today={meta?.today || new Date().toISOString().slice(0, 10)} /></td>
                  <td>{a.flags.map((f) => <div key={f} className="stp-flag" title={FLAG_LABELS[f]}><Icon name="alert" size={13} />{SHORT_FLAG[f]}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stp-legend"><span>R = Recency · F = Frequency · V = Volume · C = Character (paying habits) · each scored 1–5</span></div>
      </div>

      {t.notes && <div className="card" style={{ marginTop: 16, whiteSpace: 'pre-wrap' }}>{t.notes}</div>}
      <div className="card stp-section">
        <h3>System Information</h3>
        <div className="field-row">
          <div className="field"><label>Created By</label><div>{t.created_by || '—'}</div></div>
          <div className="field"><label>Date Created</label><div>{displayAuditTime(t.created_at) || '—'}</div></div>
          <div className="field"><label>Last Updated By</label><div>{t.updated_by || '—'}</div></div>
          <div className="field"><label>Last Updated</label><div>{displayAuditTime(t.updated_at) || '—'}</div></div>
        </div>
      </div>

      {modal === 'edit' && <TerritoryModal territory={t} fy={t.fiscal_year} meta={meta} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'assign' && (
        <AccountModal fy={t.fiscal_year} meta={meta} territories={meta?.territories || [t]} defaultTerritoryId={t.id}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}
