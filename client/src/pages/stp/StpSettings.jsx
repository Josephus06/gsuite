import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import { displayAuditTime } from '../../utils/dates';
import { ROUTE, apiError } from './stpUtils';

// STP > Scoring settings (STP Admin): how Recency, Frequency, Volume and Character turn into a
// score and a tier. Saving recalculates every account's score straight away.

const FACTORS = [
  { key: 'recency', label: 'Recency', hint: 'Days since last invoice', dir: 'lower', unit: '' },
  { key: 'frequency', label: 'Frequency', hint: 'Orders in the window', dir: 'higher', unit: '' },
  { key: 'volume', label: 'Volume', hint: 'Net invoiced amount (₱)', dir: 'higher', unit: '₱' },
  { key: 'character', label: 'Character', hint: 'Avg days paid past the due date (credit terms)', dir: 'lower', unit: '', suffix: 'days late' },
  { key: 'character_overdue', label: 'Character — no payment dates', hint: 'Overdue balance as % of the window\'s purchases', dir: 'strict', unit: '', suffix: '%' },
];
const WEIGHTS = [['recency', 'Recency %'], ['frequency', 'Frequency %'], ['volume', 'Volume %'], ['character', 'Character %']];
const fmt = (n, unit) => `${unit}${Number(n).toLocaleString('en-US')}`;

// The text around each cut-off box: Score 5..2 each own one cut-off; Score 1 is what is left.
function cellText(f, c, i) {
  const n = c.map(Number);
  const sfx = f.suffix ? ` ${f.suffix}` : '';
  if (f.dir === 'lower') {
    if (i === 0) return { pre: '≤', post: sfx };
    if (i < 4) return { pre: `${fmt(n[i - 1] + 1, f.unit)} –`, post: sfx };
    return { text: `> ${fmt(n[3], f.unit)}${sfx}` };
  }
  if (f.dir === 'strict') {
    if (i === 0) return { pre: '<', post: sfx };
    if (i < 4) return { pre: `${fmt(n[i - 1], f.unit)} – <`, post: sfx };
    return { text: `≥ ${fmt(n[3], f.unit)}${sfx}` };
  }
  if (i === 0) return { pre: '≥', post: '' };
  if (i < 4) return { pre: '', post: `– ${fmt(n[i - 1] - 1, f.unit)}` };
  return { text: `< ${fmt(n[3], f.unit)}` };
}

export default function StpSettings() {
  const { can } = useAuth();
  const isAdmin = can(ROUTE, 'can_delete');
  const [form, setForm] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/stp/settings').then(({ data }) => {
      setForm(data.settings);
      setDefaults(data.defaults);
      setInfo({ updated_at: data.updated_at, updated_by: data.updated_by });
    }).catch((e) => setError(apiError(e, 'Could not load the scoring settings.')));
  }, []);

  if (!form) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;

  const setCut = (key, i, v) => setForm((f) => ({ ...f, [key]: f[key].map((x, j) => (j === i ? v : x)) }));
  const setWeight = (key, v) => setForm((f) => ({ ...f, weights: { ...f.weights, [key]: v } }));
  const weightTotal = WEIGHTS.reduce((s, [k]) => s + (Number(form.weights[k]) || 0), 0);

  async function save() {
    if (Math.abs(weightTotal - 100) > 0.001) { setError(`Weights must add up to 100% (they add up to ${weightTotal}%).`); return; }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { data } = await api.put('/stp/settings', form);
      setForm(data.settings);
      setNotice(`Saved. Scores recalculated for ${data.run.accounts} account(s) in ${(data.run.ms / 1000).toFixed(1)} s.`);
      setInfo((i) => ({ ...i, updated_at: null }));
    } catch (e) {
      setError(apiError(e, 'Could not save the settings.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stp-page">
      <div className="stp-head">
        <div>
          <h1>Scoring settings</h1>
          <p className="stp-sub">How Recency, Frequency, Volume and Character turn into a score and a tier. Suggested defaults: tune them to your data.</p>
        </div>
      </div>
      {isAdmin ? (
        <div className="stp-actions" style={{ marginBottom: 16 }}>
          <button className="btn" onClick={() => { setForm(defaults); setNotice('Defaults loaded — Save to apply them.'); }} disabled={saving}>Reset to defaults</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving and recalculating…' : 'Save and recalculate'}</button>
        </div>
      ) : <div className="card" style={{ marginBottom: 16 }}>Only an STP Admin can change these settings.</div>}
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 16 }}>{notice}</div>}

      <fieldset disabled={!isAdmin || saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="stp-card-head"><h3>Window and weights</h3></div>
          <p className="stp-sub" style={{ marginTop: -6 }}>
            Weights must add up to 100%.{' '}
            <span className={Math.abs(weightTotal - 100) > 0.001 ? 'stp-flag' : ''}>Currently {weightTotal}%.</span>
          </p>
          <div className="filter-grid" style={{ marginTop: 12 }}>
            <div className="field">
              <label htmlFor="stp-window">Window (months)</label>
              <input id="stp-window" type="number" min={1} max={60} value={form.window_months} onChange={(e) => setForm((f) => ({ ...f, window_months: e.target.value }))} />
            </div>
            {WEIGHTS.map(([k, label]) => (
              <div className="field" key={k}>
                <label htmlFor={`stp-w-${k}`}>{label}</label>
                <input id={`stp-w-${k}`} type="number" min={0} max={100} value={form.weights[k]} onChange={(e) => setWeight(k, e.target.value)} />
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="stp-card-head"><h3>Score thresholds</h3></div>
          <p className="stp-sub" style={{ marginTop: -6 }}>
            Character is scored on days paid past the due date once real payments are recorded; until then on the overdue
            balance (last row); customers with neither get a neutral 3.
          </p>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="stp-table stp-thresholds">
              <thead><tr><th>Factor</th>{[5, 4, 3, 2, 1].map((s) => <th key={s}>Score {s}</th>)}</tr></thead>
              <tbody>
                {FACTORS.map((f) => (
                  <tr key={f.key}>
                    <td><strong>{f.label}</strong><div className="muted">{f.hint}</div></td>
                    {[0, 1, 2, 3, 4].map((i) => {
                      const t = cellText(f, form[f.key], i);
                      if (t.text) return <td key={i} className="muted" style={{ whiteSpace: 'nowrap' }}>{t.text}</td>;
                      return (
                        <td key={i}>
                          <span className="stp-cut">
                            {t.pre && <span>{t.pre}</span>}
                            <input type="number" min={0} step="any" aria-label={`${f.label} score ${5 - i} cut-off`}
                              value={form[f.key][i]} onChange={(e) => setCut(f.key, i, e.target.value)} />
                            {t.post && <span>{t.post}</span>}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="stp-card-head"><h3>Tier cut-offs</h3></div>
          <div className="stp-actions" style={{ gap: 20 }}>
            <label className="stp-cut"><span className="stp-pill tier-A">Tier A</span> score at least
              <input type="number" min={1} max={5} step="0.05" value={form.tier_a_min} onChange={(e) => setForm((f) => ({ ...f, tier_a_min: e.target.value }))} />
            </label>
            <label className="stp-cut"><span className="stp-pill tier-B">Tier B</span> score at least
              <input type="number" min={1} max={5} step="0.05" value={form.tier_b_min} onChange={(e) => setForm((f) => ({ ...f, tier_b_min: e.target.value }))} />
            </label>
            <span className="stp-cut"><span className="stp-pill tier-C">Tier C</span> below {form.tier_b_min}</span>
          </div>
          <div className="field-checkbox" style={{ marginTop: 16 }}>
            <input id="stp-reason" type="checkbox" checked={!!form.require_override_reason}
              onChange={(e) => setForm((f) => ({ ...f, require_override_reason: e.target.checked }))} />
            <label htmlFor="stp-reason">Require a reason for manual tier overrides</label>
          </div>
        </div>
      </fieldset>
      {info?.updated_at && <p className="muted" style={{ marginTop: 12 }}>Last changed {displayAuditTime(info.updated_at)}{info.updated_by ? ` by ${info.updated_by}` : ''}.</p>}
    </div>
  );
}
