import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';
import { COST_TYPE_LABELS, DISPOSAL_STATUS_LABELS, formatMoney, formatMonth } from '../utils/assetLabels';

// The accounting half of an asset: what it cost, what it has depreciated, what it is worth.
//
// Capitalising is offered here rather than on the asset form because it is a different decision
// made by different people -- registering a monitor is IT's job, deciding it belongs on the balance
// sheet is accounting's.
function CapitalizeModal({ asset, meta, onClose, onDone }) {
  const [form, setForm] = useState({
    asset_class_id: asset.asset_class_id || '',
    in_service_date: asset.in_service_date ? String(asset.in_service_date).slice(0, 10) : (asset.acquired_date ? String(asset.acquired_date).slice(0, 10) : ''),
    amount: asset.acquisition_cost ?? '',
    useful_life_months: asset.useful_life_months || '',
    salvage_value: asset.salvage_value || 0,
    override_threshold: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [needsOverride, setNeedsOverride] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const chosenClass = (meta.asset_classes || []).find((c) => String(c.id) === String(form.asset_class_id));
  // Pre-fill the life from the class the moment one is chosen -- that default is the reason the
  // class carries one.
  useEffect(() => {
    if (chosenClass?.default_useful_life_months && !form.useful_life_months) {
      set({ useful_life_months: chosenClass.default_useful_life_months });
    }
  }, [form.asset_class_id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setError(''); setSaving(true);
    try { await api.post(`/assets/${asset.id}/capitalize`, form); onDone(); }
    catch (e) {
      const data = e.response?.data;
      setError(data?.error || 'Could not capitalise this asset.');
      if (data?.can_override) setNeedsOverride(true);
      setSaving(false);
    }
  }

  return (
    <Modal title={`Capitalise ${asset.reference_no}`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        Capitalising puts this asset on the balance sheet and starts depreciating it from the month it was placed
        in service.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        <div className="field">
          <label>Asset Class *</label>
          <select value={form.asset_class_id} onChange={(e) => set({ asset_class_id: e.target.value })}>
            <option value="">--Select--</option>
            {(meta.asset_classes || []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.is_depreciable ? '' : ' (not depreciated)'}</option>
            ))}
          </select>
          {chosenClass && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Posts to {chosenClass.cost_account_code}
              {chosenClass.is_depreciable ? ` / ${chosenClass.accumulated_account_code}` : ''}
            </div>
          )}
        </div>
        <div className="field">
          <label>In-Service Date *</label>
          <input type="date" value={form.in_service_date} onChange={(e) => set({ in_service_date: e.target.value })} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Depreciation starts in this month.</div>
        </div>
        <div className="field">
          <label>Cost</label>
          <input type="number" step="0.01" value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Freight and installation are added afterwards as further cost lines.</div>
        </div>
        <div className="field">
          <label>Salvage Value</label>
          <input type="number" step="0.01" value={form.salvage_value} onChange={(e) => set({ salvage_value: e.target.value })} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>What it is expected to be worth at the end of its life.</div>
        </div>
        {chosenClass?.is_depreciable !== false && (
          <div className="field">
            <label>Useful Life (months) *</label>
            <input type="number" value={form.useful_life_months} onChange={(e) => set({ useful_life_months: e.target.value })} />
          </div>
        )}
      </div>
      {needsOverride && (
        <div className="field" style={{ marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.override_threshold} onChange={(e) => set({ override_threshold: e.target.checked })} />
            Capitalise anyway, below the threshold
          </label>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Capitalise'}</button>
      </div>
    </Modal>
  );
}

function CostLineModal({ asset, onClose, onDone }) {
  const [form, setForm] = useState({ cost_type: 'improvement', amount: '', description: '', incurred_date: new Date().toISOString().slice(0, 10) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!form.amount || Number(form.amount) <= 0) { setError('An amount greater than zero is required.'); return; }
    setError(''); setSaving(true);
    try { await api.post(`/assets/${asset.id}/cost-lines`, form); onDone(); }
    catch (e) { setError(e.response?.data?.error || 'Could not add the cost.'); setSaving(false); }
  }

  return (
    <Modal title={`Add cost — ${asset.reference_no}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        Costs incurred to put the asset in place are capitalised. An improvement added after it is in service raises
        the depreciable base, and the extra is spread over the remaining life — no catch-up entry.
      </p>
      <div className="field">
        <label>Type</label>
        <select value={form.cost_type} onChange={(e) => setForm({ ...form, cost_type: e.target.value })}>
          {Object.entries(COST_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Amount *</label>
        <input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
      </div>
      <div className="field">
        <label>Date Incurred</label>
        <input type="date" value={form.incurred_date} onChange={(e) => setForm({ ...form, incurred_date: e.target.value })} />
      </div>
      <div className="field">
        <label>Description</label>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Add Cost'}</button>
      </div>
    </Modal>
  );
}

export default function AssetAccountingPanel({ asset, meta, onChanged }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [val, setVal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCapitalize, setShowCapitalize] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get(`/assets/${asset.id}/valuation`); setVal(data); }
    catch { setVal(null); }
    setLoading(false);
  }, [asset.id]);

  useEffect(() => { load(); }, [load]);

  async function act(fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true); setError('');
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setError(e.response?.data?.error || 'Action failed.'); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="card"><LoadingSpinner /></div>;

  // The accounting migration may not have run on this install yet; the custody register still works.
  if (!meta?.accounting_enabled) {
    return <div className="card"><p className="muted" style={{ margin: 0 }}>Fixed-asset accounting is not set up on this installation.</p></div>;
  }

  const canManage = can('/assets', 'can_approve');
  const disposal = val?.disposal;

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Valuation</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            {!asset.is_capitalized && canManage && !asset.parent_asset_id && (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setShowCapitalize(true)}>Capitalise</button>
            )}
            {asset.is_capitalized && canManage && (
              <button className="btn btn-sm" disabled={busy} onClick={() => setShowCost(true)}>Add Cost</button>
            )}
            {asset.is_capitalized && canManage && !disposal && (
              <button className="btn btn-sm" disabled={busy}
                onClick={() => act(() => api.post(`/assets/${asset.id}/decapitalize`), 'Reverse the capitalisation of this asset?')}>Reverse Capitalisation</button>
            )}
            {can('/asset-disposals', 'can_add') && !disposal && asset.status !== 'disposed' && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate(`/asset-disposals/new?asset_id=${asset.id}`)}>Dispose</button>
            )}
          </div>
        </div>

        {!asset.is_capitalized ? (
          <p className="muted" style={{ margin: 0 }}>
            This asset is not capitalised — it is tracked for custody only and was expensed when purchased.
            {asset.acquisition_cost ? ` Its recorded purchase price is ${formatMoney(asset.acquisition_cost)}.` : ''}
          </p>
        ) : (
          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div>Capitalised cost : <span className="hi">{formatMoney(val?.capitalized_cost)}</span></div>
            <div>Accumulated depreciation : <span className="hi">{formatMoney(val?.accumulated_depreciation)}</span></div>
            <div>Net book value : <span className="hi">{formatMoney(val?.net_book_value)}</span></div>
            <div>Salvage value : <span className="hi">{formatMoney(asset.salvage_value)}</span></div>
            <div>Class : <span className="hi">{(meta.asset_classes || []).find((c) => String(c.id) === String(asset.asset_class_id))?.name || '—'}</span></div>
            <div>In service : <span className="hi">{asset.in_service_date ? String(asset.in_service_date).slice(0, 10) : '—'}</span></div>
            <div>Useful life : <span className="hi">{asset.useful_life_months ? `${asset.useful_life_months} months` : '—'}</span></div>
            <div>Method : <span className="hi">Straight line</span></div>
          </div>
        )}

        {disposal && (
          <div className="error-banner" style={{ marginTop: 12 }}>
            Disposed by{' '}
            <button type="button" className="link-btn" onClick={() => navigate(`/asset-disposals/${disposal.id}`)}>{disposal.disposal_no}</button>
            {' '}on {String(disposal.disposal_date).slice(0, 10)} ({DISPOSAL_STATUS_LABELS[disposal.status] || disposal.status}),
            {Number(disposal.gain_loss) < 0 ? ' loss of ' : ' gain of '}
            {formatMoney(Math.abs(Number(disposal.gain_loss)))}.
          </div>
        )}
      </div>

      {asset.is_capitalized && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Cost ledger</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Type</th><th>Description</th><th>Incurred</th><th style={{ textAlign: 'right' }}>Amount</th><th>Added By</th><th /></tr></thead>
              <tbody>
                {(val?.cost_lines || []).length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No cost lines.</td></tr>}
                {(val?.cost_lines || []).map((l) => (
                  <tr key={l.id}>
                    <td>{l.line_no}</td>
                    <td>{COST_TYPE_LABELS[l.cost_type] || l.cost_type}</td>
                    <td>{l.description || '—'}</td>
                    <td>{l.incurred_date ? String(l.incurred_date).slice(0, 10) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(l.amount)}</td>
                    <td>{l.created_by_name || '—'}</td>
                    <td>
                      {canManage && !(val?.depreciation_history || []).length && (
                        <button className="btn btn-sm btn-warning" disabled={busy}
                          onClick={() => act(() => api.delete(`/assets/${asset.id}/cost-lines/${l.id}`), 'Remove this cost line?')}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={4} style={{ textAlign: 'right' }}>Capitalised cost</th>
                  <th style={{ textAlign: 'right' }}>{formatMoney(val?.capitalized_cost)}</th>
                  <th colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {asset.is_capitalized && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Depreciation history</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Period</th><th>Run</th><th style={{ textAlign: 'right' }}>Opening</th><th style={{ textAlign: 'right' }}>Charge</th><th style={{ textAlign: 'right' }}>Closing</th></tr></thead>
              <tbody>
                {(val?.depreciation_history || []).length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing depreciated yet.</td></tr>
                )}
                {(val?.depreciation_history || []).map((h) => (
                  <tr key={h.run_no}>
                    <td>{formatMonth(h.period_month)}</td>
                    <td>{h.run_no}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(h.opening_accumulated)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(h.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(h.closing_accumulated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCapitalize && <CapitalizeModal asset={asset} meta={meta} onClose={() => setShowCapitalize(false)} onDone={() => { setShowCapitalize(false); load(); onChanged?.(); }} />}
      {showCost && <CostLineModal asset={asset} onClose={() => setShowCost(false)} onDone={() => { setShowCost(false); load(); onChanged?.(); }} />}
    </>
  );
}
