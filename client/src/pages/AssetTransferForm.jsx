import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

function today() { return new Date().toISOString().slice(0, 10); }

// Picks the assets to move. Only offers things that can actually be handed over -- the server
// filters out anything retired, disposed, or already named on a transfer that has not finished,
// so two documents can never promise the same UPS to two different offices.
function AssetPickerModal({ fromLocationId, fromCustodianId, chosenIds, onClose, onAdd }) {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (fromLocationId) params.location_id = fromLocationId;
    if (fromCustodianId) params.custodian_employee_id = fromCustodianId;
    if (search) params.search = search;
    const { data } = await api.get('/asset-transfers/available-assets', { params });
    setRows(data.filter((r) => !chosenIds.includes(String(r.id))));
    setLoading(false);
  }, [fromLocationId, fromCustodianId, search, chosenIds]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id) {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  return (
    <Modal title="Add Assets" onClose={onClose} xl>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input style={{ flex: 1 }} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="Reference no, serial or asset type..." />
        <button type="button" className="btn btn-primary" onClick={load}>Search</button>
      </div>
      {loading ? <LoadingSpinner /> : (
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr><th /><th>Reference No</th><th>Asset Type</th><th>Serial</th><th>Location</th><th>Custodian</th><th>Attached</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transferable assets match.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} onClick={() => toggle(r.id)} style={{ cursor: 'pointer' }}>
                  <td><input type="checkbox" checked={picked.has(r.id)} readOnly /></td>
                  <td>{r.reference_no}</td>
                  <td>{r.item_name}</td>
                  <td>{r.serial_no || '—'}</td>
                  <td>{r.location_name || '—'}</td>
                  <td>{r.custodian_name?.trim() || '—'}</td>
                  <td>
                    {r.parent_asset_id ? <span title="Naming this on a transfer detaches it from its host">In {r.parent_reference_no}</span> : null}
                    {Number(r.attached_count) > 0 ? `${r.attached_count} attached` : null}
                    {!r.parent_asset_id && !Number(r.attached_count) ? '—' : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!picked.size} onClick={() => onAdd(rows.filter((r) => picked.has(r.id)))}>
          Add {picked.size || ''} Asset{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </Modal>
  );
}

// Raise or edit a transfer. Only a DRAFT can be edited -- once it is out for signature, changing
// what is on it would alter what the releasing custodian was asked to agree to, after they were
// asked. The view page enforces that too; this form just refuses to open on a non-draft.
export default function AssetTransferForm() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [header, setHeader] = useState({
    date_created: today(), date_needed: '', from_location_id: '', from_custodian_employee_id: '',
    to_location_id: '', to_custodian_employee_id: '', to_department_id: '', reason: '', memo: '',
  });
  const [lines, setLines] = useState([]);
  const [transferNo, setTransferNo] = useState('New');
  const [showPicker, setShowPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data: m } = await api.get('/asset-transfers/meta');
      setMeta(m);
      if (id) {
        const { data: t } = await api.get(`/asset-transfers/${id}`);
        if (t.status !== 'draft') { navigate(`/asset-transfers/${id}`, { replace: true }); return; }
        setTransferNo(t.transfer_no);
        setHeader({
          date_created: String(t.date_created).slice(0, 10),
          date_needed: t.date_needed ? String(t.date_needed).slice(0, 10) : '',
          from_location_id: t.from_location_id || '', from_custodian_employee_id: t.from_custodian_employee_id || '',
          to_location_id: t.to_location_id || '', to_custodian_employee_id: t.to_custodian_employee_id || '',
          to_department_id: t.to_department_id || '', reason: t.reason || '', memo: t.memo || '',
        });
        setLines((t.lines || []).map((l) => ({
          asset_id: l.asset_id, reference_no: l.reference_no, item_name: l.item_name, serial_no: l.serial_no,
          from_location_name: l.from_location_name, from_custodian_name: l.from_custodian_name,
          attached_count: l.attached_count, remarks: l.remarks || '',
        })));
      } else {
        // Arriving from an asset's own page with "Transfer" -- start the document with that asset
        // on it and the source side already filled in from where it currently is.
        const assetId = searchParams.get('asset_id');
        if (assetId) {
          const { data: a } = await api.get(`/assets/${assetId}`);
          setHeader((h) => ({ ...h, from_location_id: a.effective_location_id || '', from_custodian_employee_id: a.effective_custodian_employee_id || '' }));
          setLines([{
            asset_id: a.id, reference_no: a.reference_no, item_name: a.item_name, serial_no: a.serial_no,
            from_location_name: a.location_name, from_custodian_name: a.custodian_name,
            attached_count: (a.attached_assets || []).length, remarks: '',
          }]);
        }
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));

  function addAssets(picked) {
    setLines((ls) => [...ls, ...picked.map((r) => ({
      asset_id: r.id, reference_no: r.reference_no, item_name: r.item_name, serial_no: r.serial_no,
      from_location_name: r.location_name, from_custodian_name: r.custodian_name,
      attached_count: r.attached_count, remarks: '',
    }))]);
    setShowPicker(false);
  }

  async function save(thenSubmit) {
    setError('');
    if (!header.to_location_id) { setError('A destination location is required.'); return; }
    if (!lines.length) { setError('Add at least one asset.'); return; }
    setSaving(true);
    try {
      const body = { ...header, lines: lines.map((l) => ({ asset_id: l.asset_id, remarks: l.remarks })) };
      let transferId = id;
      if (id) await api.put(`/asset-transfers/${id}`, body);
      else { const { data } = await api.post('/asset-transfers', body); transferId = data.id; }
      if (thenSubmit) await api.post(`/asset-transfers/${transferId}/submit`);
      navigate(`/asset-transfers/${transferId}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;

  const carried = lines.reduce((n, l) => n + Number(l.attached_count || 0), 0);

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Asset Transfers</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/asset-transfers')}>Back to Lists</button>
          <button className="btn btn-sm" disabled={saving} onClick={() => save(false)}>{saving ? 'Saving...' : 'Save Draft'}</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => save(true)}>Save &amp; Submit for Approval</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ margin: '0 0 2px', color: '#334155' }}>{transferNo}</h2>
        <div className="muted" style={{ marginBottom: 16 }}>
          Submitting sends this to the releasing custodian first, then to the receiving custodian. Nothing moves
          until both have approved and IT completes it.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          <div className="field"><label>Date</label><input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} /></div>
          <div className="field"><label>Date Needed</label><input type="date" value={header.date_needed} onChange={(e) => setH({ date_needed: e.target.value })} /></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24, marginTop: 16 }}>
          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#334155' }}>Releasing (from)</h3>
            <div className="field">
              <label>Location</label>
              <select value={header.from_location_id} onChange={(e) => setH({ from_location_id: e.target.value })}>
                <option value="">--Any--</option>
                {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Custodian (approves the release)</label>
              <select value={header.from_custodian_employee_id} onChange={(e) => setH({ from_custodian_employee_id: e.target.value })}>
                <option value="">--None--</option>
                {meta.employees.map((e2) => <option key={e2.id} value={e2.id}>{e2.name}{e2.user_id ? '' : ' (no login)'}</option>)}
              </select>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                This person signs the release. If they have no login, an approver can sign on their behalf.
              </div>
            </div>
          </div>

          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#334155' }}>Receiving (to)</h3>
            <div className="field">
              <label>Location *</label>
              <select value={header.to_location_id} onChange={(e) => setH({ to_location_id: e.target.value })}>
                <option value="">--Select--</option>
                {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Custodian (approves the receipt)</label>
              <select
                value={header.to_custodian_employee_id}
                onChange={(e) => {
                  const emp = meta.employees.find((x) => String(x.id) === e.target.value);
                  setH({ to_custodian_employee_id: e.target.value, to_department_id: emp?.department_id || header.to_department_id });
                }}
              >
                <option value="">--None--</option>
                {meta.employees.map((e2) => <option key={e2.id} value={e2.id}>{e2.name}{e2.user_id ? '' : ' (no login)'}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Department</label>
              <select value={header.to_department_id} onChange={(e) => setH({ to_department_id: e.target.value })}>
                <option value="">--None--</option>
                {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginTop: 8 }}>
          <div className="field"><label>Reason</label><input value={header.reason} onChange={(e) => setH({ reason: e.target.value })} placeholder="Desk move, replacement, repair return..." /></div>
          <div className="field"><label>Memo</label><input value={header.memo} onChange={(e) => setH({ memo: e.target.value })} /></div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Assets ({lines.length})</h2>
          <button className="btn btn-sm btn-primary" onClick={() => setShowPicker(true)}>Add Assets</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Reference No</th><th>Asset Type</th><th>Serial</th><th>Currently At</th><th>Currently Held By</th><th>Remarks</th><th /></tr>
            </thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No assets on this transfer yet.</td></tr>}
              {lines.map((l, i) => (
                <tr key={l.asset_id}>
                  <td>{i + 1}</td>
                  <td>{l.reference_no}</td>
                  <td>{l.item_name}{Number(l.attached_count) > 0 ? <span className="muted"> (+{l.attached_count} attached)</span> : null}</td>
                  <td>{l.serial_no || '—'}</td>
                  <td>{l.from_location_name || '—'}</td>
                  <td>{l.from_custodian_name?.trim() || '—'}</td>
                  <td><input value={l.remarks} onChange={(e) => setLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, remarks: e.target.value } : x)))} /></td>
                  <td><button className="btn btn-sm btn-warning" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {carried > 0 && (
          <p className="muted" style={{ marginTop: 12 }}>
            {carried} attached asset{carried === 1 ? '' : 's'} will move along with the units listed above, and each will get its own history entry.
          </p>
        )}
      </div>

      {showPicker && (
        <AssetPickerModal
          fromLocationId={header.from_location_id}
          fromCustodianId={header.from_custodian_employee_id}
          chosenIds={lines.map((l) => String(l.asset_id))}
          onClose={() => setShowPicker(false)}
          onAdd={addAssets}
        />
      )}
    </div>
  );
}
