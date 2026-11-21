import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayAuditTime } from '../../utils/dates';
import { ROUTE, peso, pct, date, scoreText, SHORT_FLAG, FLAG_LABELS, useStpMeta, apiError } from './stpUtils';
import { Kpi, StatusPill, ScoreChip, TierPill } from './StpBits';
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
    <div>
      <Link to={`/stp?fy=${t.fiscal_year}`} className="muted" style={{ fontSize: 13 }}>← Back to overview</Link>
      <div className="stp-head" style={{ marginTop: 8 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{t.name} <StatusPill status={t.status} /></h1>
          <p className="stp-sub">FY {t.fiscal_year} · Rep: {t.rep_name || 'Unassigned'}{t.coverage_area ? ` · ${t.coverage_area}` : ''}</p>
        </div>
        <div className="stp-actions">
          {can(ROUTE, 'can_add') && <button className="btn" onClick={() => setModal('assign')}>+ Assign account</button>}
          {can(ROUTE, 'can_edit') && <button className="btn btn-primary" onClick={() => setModal('edit')}>Edit territory</button>}
          {can(ROUTE, 'can_delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={t.accounts.length > 0}
              title={t.accounts.length ? 'Reassign its accounts to another territory first' : undefined}>Delete</button>
          )}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="stp-kpis">
        <Kpi label="Target" value={peso(t.target_amount)} hint={`${pct(t.target_vs_potential)} of potential`} />
        <Kpi label="Annual potential" value={peso(t.total_potential)} hint={`${t.account_count} accounts`} />
        <Kpi label="Current revenue" value={peso(t.current_revenue)} hint={`Invoiced in FY ${t.fiscal_year}`} />
        <Kpi label="Penetration" value={pct(t.penetration)} hint="Revenue ÷ potential" />
        <Kpi label="Average score" value={scoreText(t.average_score)}
          hint={`A ${t.tier_counts.A} · B ${t.tier_counts.B} · C ${t.tier_counts.C} · Prospect ${t.tier_counts.Prospect}`} />
      </div>

      <div className="card">
        <div className="stp-card-head"><h2>Accounts</h2></div>
        <div className="table-wrap">
          <table className="stp-table">
            <thead>
              <tr><th>Account</th><th>Owner</th><th>Segment</th><th className="stp-num">Potential</th><th>R</th><th>F</th><th>V</th><th>C</th>
                <th className="stp-num">Score</th><th>Tier</th><th>Next visit</th><th>Flag</th></tr>
            </thead>
            <tbody>
              {t.accounts.length === 0 && <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No accounts assigned yet.</td></tr>}
              {t.accounts.map((a) => (
                <tr key={a.id} className="stp-click" onClick={() => navigate(`/stp/accounts/${a.id}?fy=${t.fiscal_year}`)}>
                  <td><strong>{a.account_name}</strong></td>
                  <td>{a.owner_name || '—'}</td>
                  <td>{a.segment}</td>
                  <td className="stp-num">{peso(a.annual_potential)}</td>
                  <td><ScoreChip value={a.recency_score} /></td><td><ScoreChip value={a.frequency_score} /></td>
                  <td><ScoreChip value={a.volume_score} /></td><td><ScoreChip value={a.character_score} /></td>
                  <td className="stp-num"><strong>{scoreText(a.total_score)}</strong></td>
                  <td><TierPill tier={a.tier} prospect={a.is_prospect} short /></td>
                  <td style={{ whiteSpace: 'nowrap' }} className={a.visit_overdue ? 'stp-flag' : ''}>{a.next_visit_due ? date(a.next_visit_due) : <span className="muted">Not scheduled</span>}</td>
                  <td>{a.flags.map((f) => <div key={f} className="stp-flag" title={FLAG_LABELS[f]}>{SHORT_FLAG[f]}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stp-legend"><span>R = Recency · F = Frequency · V = Volume · C = Character (paying habits) · each scored 1–5</span></div>
      </div>

      {t.notes && <div className="card" style={{ marginTop: 16, whiteSpace: 'pre-wrap' }}>{t.notes}</div>}
      <div className="card" style={{ marginTop: 16 }}>
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
