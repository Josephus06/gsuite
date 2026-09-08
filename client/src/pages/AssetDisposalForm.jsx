import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { DISPOSAL_TYPE_LABELS, formatMoney } from '../utils/assetLabels';

function today() { return new Date().toISOString().slice(0, 10); }
const accountLabel = (a) => `${a.account_code} — ${a.account_name}`;

// Raising a disposal. The figures that matter -- cost, accumulated depreciation, book value -- are
// read off the register rather than typed, so the gain or loss is arithmetic rather than opinion.
export default function AssetDisposalForm() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [assets, setAssets] = useState([]);
  const [form, setForm] = useState({
    asset_id: '', disposal_date: today(), disposal_type: 'sale', proceeds: 0,
    proceeds_account_id: '', buyer_name: '', reason: '', memo: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const [{ data: m }, { data: list }] = await Promise.all([
        api.get('/asset-disposals/meta'),
        api.get('/asset-disposals/disposable-assets'),
      ]);
      setMeta(m);
      setAssets(list);
      if (id) {
        const { data: d } = await api.get(`/asset-disposals/${id}`);
        if (d.status !== 'draft') { navigate(`/asset-disposals/${id}`, { replace: true }); return; }
        setForm({
          asset_id: d.asset_id, disposal_date: String(d.disposal_date).slice(0, 10), disposal_type: d.disposal_type,
          proceeds: Number(d.proceeds), proceeds_account_id: d.proceeds_account_id || '',
          buyer_name: d.buyer_name || '', reason: d.reason || '', memo: d.memo || '',
        });
      } else {
        const assetId = searchParams.get('asset_id');
        if (assetId) setForm((f) => ({ ...f, asset_id: Number(assetId) }));
        if (m.defaults?.gain_loss_account_id) setForm((f) => ({ ...f }));
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const chosen = assets.find((a) => String(a.id) === String(form.asset_id));
  const nbv = chosen ? Number(chosen.net_book_value) : 0;
  const gainLoss = Number((Number(form.proceeds || 0) - nbv).toFixed(2));

  async function save() {
    setError('');
    if (!form.asset_id) { setError('Choose the asset being disposed of.'); return; }
    if (!form.disposal_date) { setError('A disposal date is required.'); return; }
    setSaving(true);
    try {
      const body = { ...form, proceeds: Number(form.proceeds || 0) };
      if (id) { await api.put(`/asset-disposals/${id}`, body); navigate(`/asset-disposals/${id}`); }
      else { const { data } = await api.post('/asset-disposals', body); navigate(`/asset-disposals/${data.id}`); }
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;
  const isSale = form.disposal_type === 'sale';

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Asset Disposals</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/asset-disposals')}>Back to Lists</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save Draft'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ margin: '0 0 2px', color: '#334155' }}>{id ? 'Edit Disposal' : 'New Disposal'}</h2>
        <div className="muted" style={{ marginBottom: 16 }}>
          Saving creates a draft. Posting is what removes the asset from the balance sheet and recognises the gain or loss.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Asset *</label>
            <EntityPicker
              label="Asset" items={assets} value={form.asset_id}
              getLabel={(a) => `${a.reference_no} — ${a.item_name}`}
              columns={[
                { key: 'reference_no', label: 'Reference No' }, { key: 'item_name', label: 'Asset' },
                { key: 'class_name', label: 'Class' }, { key: 'location_name', label: 'Location' },
                { key: 'net_book_value', label: 'Book Value', render: (a) => formatMoney(a.net_book_value) },
              ]}
              searchKeys={['reference_no', 'item_name', 'class_name', 'custodian_name']}
              placeholder="--Select asset--"
              onSelect={(a) => set({ asset_id: a?.id || '' })}
            />
          </div>

          <div className="field">
            <label>Disposal Date *</label>
            <input type="date" value={form.disposal_date} onChange={(e) => set({ disposal_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={form.disposal_type} onChange={(e) => set({ disposal_type: e.target.value, proceeds: e.target.value === 'sale' ? form.proceeds : 0 })}>
              {Object.entries(DISPOSAL_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Proceeds</label>
            <input type="number" step="0.01" value={form.proceeds} disabled={!isSale}
              onChange={(e) => set({ proceeds: e.target.value })} />
            {!isSale && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Only a sale brings in proceeds.</div>}
          </div>

          {isSale && (
            <>
              <div className="field">
                <label>Proceeds Received Into</label>
                <EntityPicker
                  label="Account" items={meta.cash_accounts} value={form.proceeds_account_id} getLabel={accountLabel}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }]}
                  searchKeys={['account_code', 'account_name']} placeholder="--Select--"
                  onSelect={(a) => set({ proceeds_account_id: a?.id || '' })}
                />
              </div>
              <div className="field">
                <label>Buyer</label>
                <input value={form.buyer_name} onChange={(e) => set({ buyer_name: e.target.value })} />
              </div>
            </>
          )}

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Reason</label>
            <input value={form.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="Replaced, beyond repair, sold to staff..." />
          </div>
        </div>
      </div>

      {chosen && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>What this disposal will record</h2>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr><td>Capitalised cost</td><td style={{ textAlign: 'right' }}>{formatMoney(chosen.capitalized_cost)}</td></tr>
                <tr><td>Less accumulated depreciation</td><td style={{ textAlign: 'right' }}>({formatMoney(chosen.accumulated_depreciation)})</td></tr>
                <tr><th>Net book value</th><th style={{ textAlign: 'right' }}>{formatMoney(nbv)}</th></tr>
                <tr><td>Proceeds</td><td style={{ textAlign: 'right' }}>{formatMoney(form.proceeds || 0)}</td></tr>
                <tr>
                  <th>{gainLoss < 0 ? 'Loss on disposal' : 'Gain on disposal'}</th>
                  <th style={{ textAlign: 'right' }}>{gainLoss < 0 ? `(${formatMoney(Math.abs(gainLoss))})` : formatMoney(gainLoss)}</th>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            These are live figures. They are frozen onto the document when it is posted, so a later depreciation run
            cannot restate a disposal that has already been recorded.
          </p>
        </div>
      )}
    </div>
  );
}
