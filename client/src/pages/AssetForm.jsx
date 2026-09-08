import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { CONDITION_LABELS, STATUS_LABELS } from '../utils/assetLabels';

function today() { return new Date().toISOString().slice(0, 10); }

const EMPTY = {
  reference_no: '', asset_item_id: '', parent_asset_id: '', serial_no: '', tag_no: '',
  brand: '', model: '', specification: '',
  location_id: '', custodian_employee_id: '', assigned_location_id: '', owning_department_id: '', status: 'active',
  asset_condition: 'good', acquired_date: today(), acquisition_cost: '', remarks: '',
  asset_class_id: '', in_service_date: '', useful_life_months: '', salvage_value: 0,
};

// Register one unit, or correct its record.
//
// The form has one rule worth knowing: an asset is EITHER standalone (it sits at a location, held
// by a custodian) OR attached to a host asset, in which case it has no location of its own and the
// location fields go away entirely. Leaving them on screen, greyed out, would suggest they still
// mean something -- they do not, and the register deliberately does not store them.
//
// Moving equipment between people is NOT done here: that needs both custodians to agree, which is
// what an Asset Transfer is for. This form only edits what the asset IS.
export default function AssetForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [hosts, setHosts] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [original, setOriginal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data: m } = await api.get('/assets/meta');
      setMeta(m);
      const { data: h } = await api.get('/assets/hosts', { params: id ? { exclude_id: id } : {} });
      setHosts(h);
      if (id) {
        const { data: a } = await api.get(`/assets/${id}`);
        setOriginal(a);
        setForm({
          reference_no: a.reference_no || '', asset_item_id: a.asset_item_id || '', parent_asset_id: a.parent_asset_id || '',
          serial_no: a.serial_no || '', tag_no: a.tag_no || '',
          // The asset's OWN values, not the resolved ones -- the form edits the override, and
          // pre-filling it with the inherited value would silently turn inheritance into a copy.
          brand: a.own_brand || '', model: a.own_model || '', specification: a.own_specification || '',
          location_id: a.effective_location_id || '', custodian_employee_id: a.effective_custodian_employee_id || '',
          assigned_location_id: a.assigned_location_id || '', owning_department_id: a.own_owning_department_id || '',
          status: a.status || 'active', asset_condition: a.asset_condition || 'good',
          acquired_date: a.acquired_date ? String(a.acquired_date).slice(0, 10) : '',
          acquisition_cost: a.acquisition_cost ?? '', remarks: a.remarks || '',
          asset_class_id: a.asset_class_id || '', salvage_value: a.salvage_value ?? 0,
          useful_life_months: a.useful_life_months || '',
          in_service_date: a.in_service_date ? String(a.in_service_date).slice(0, 10) : '',
        });
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const isAttached = !!form.parent_asset_id;
  const selectedType = (meta?.items || []).find((x) => String(x.id) === String(form.asset_item_id));
  const inheritsAny = !form.brand || !form.model || !form.specification;
  // Detaching an asset that WAS attached has to say where it now stands on its own -- the server
  // refuses it otherwise, so the form asks for it rather than letting the save fail.
  const detaching = !!original?.parent_asset_id && !isAttached;

  async function save() {
    setError('');
    if (!form.reference_no.trim()) { setError('Reference number is required.'); return; }
    if (!form.asset_item_id) { setError('Asset type is required.'); return; }
    if (!isAttached && !form.location_id) { setError('A location is required unless the asset is attached to another asset.'); return; }
    setSaving(true);
    try {
      const body = {
        ...form,
        parent_asset_id: form.parent_asset_id || null,
        brand: form.brand.trim() || null,
        model: form.model.trim() || null,
        specification: form.specification.trim() || null,
        acquisition_cost: form.acquisition_cost === '' ? null : Number(form.acquisition_cost),
        acquired_date: form.acquired_date || null,
        asset_class_id: form.asset_class_id || null,
        assigned_location_id: form.assigned_location_id || null,
        owning_department_id: form.owning_department_id || null,
        in_service_date: form.in_service_date || null,
        useful_life_months: form.useful_life_months === '' ? null : Number(form.useful_life_months),
        salvage_value: form.salvage_value === '' ? 0 : Number(form.salvage_value),
      };
      if (id) { await api.put(`/assets/${id}`, body); navigate(`/assets/${id}`); }
      else { const { data } = await api.post('/assets', body); navigate(`/assets/${data.id}`); }
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;

  const hostLabel = (h) => `${h.item_name} · ${h.reference_no}${h.location_name ? ` (${h.location_name})` : ''}`;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Assets</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(id ? `/assets/${id}` : '/assets')}>Back</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ margin: '0 0 2px', color: '#334155' }}>{id ? form.reference_no : 'New Asset'}</h2>
        <div className="muted" style={{ marginBottom: 16 }}>
          {id ? 'Editing the asset record. Use a transfer to change who holds it.' : 'Register one unit under an asset type.'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, alignItems: 'start' }}>
          <div className="field">
            <label>Reference No *</label>
            <input value={form.reference_no} onChange={(e) => set({ reference_no: e.target.value })} placeholder="1542" />
          </div>
          <div className="field">
            <label>Asset Type *</label>
            <EntityPicker
              label="Asset Type" items={meta.items} value={form.asset_item_id}
              getLabel={(x) => `${x.item_code} — ${x.display_name}`}
              columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Asset Type' }, { key: 'category', label: 'Category' }, { key: 'brand', label: 'Brand' }]}
              searchKeys={['item_code', 'display_name', 'category', 'brand', 'model']}
              placeholder="--Select asset type--"
              onSelect={(x) => set({ asset_item_id: x?.id || '' })}
            />
          </div>
          <div className="field">
            <label>Serial No</label>
            <input value={form.serial_no} onChange={(e) => set({ serial_no: e.target.value })} />
          </div>

          <div className="field">
            <label>Tag No</label>
            <input value={form.tag_no} onChange={(e) => set({ tag_no: e.target.value })} />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Condition</label>
            <select value={form.asset_condition} onChange={(e) => set({ asset_condition: e.target.value })}>
              {Object.entries(CONDITION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>

          {/* Brand, model and specification belong to THIS unit -- two aircons registered under the
              same type can be a Carrier and a Panasonic. Left blank they inherit the type's value,
              which is what the placeholder shows, so nothing has to be retyped for the common case. */}
          <div className="field">
            <label>Brand</label>
            <input value={form.brand} onChange={(e) => set({ brand: e.target.value })}
              placeholder={selectedType?.brand ? `${selectedType.brand} (from type)` : 'e.g. Carrier'} />
          </div>
          <div className="field">
            <label>Model</label>
            <input value={form.model} onChange={(e) => set({ model: e.target.value })}
              placeholder={selectedType?.model ? `${selectedType.model} (from type)` : 'e.g. 2HP Inverter'} />
          </div>
          <div className="field">
            <label>Specification</label>
            <input value={form.specification} onChange={(e) => set({ specification: e.target.value })}
              placeholder={selectedType?.specification ? `${selectedType.specification} (from type)` : 'e.g. 2HP, split type'} />
          </div>
        </div>

        {inheritsAny && (
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Blank fields above inherit from the asset type
            {selectedType ? ` "${selectedType.display_name}"` : ''}. Fill one in to record what this
            particular unit is. Category is set on the asset type and applies to every unit of it.
          </p>
        )}

        {/* Who owns the equipment, which is what decides who may see and touch it. Normally set
            once on the asset type -- UPS to IT, Aircon to Building & Maintenance -- so this is
            only filled in for the exception. */}
        <h3 style={{ margin: '22px 0 8px', fontSize: 14, color: '#334155' }}>Owned by</h3>
        <div className="field" style={{ maxWidth: 520 }}>
          <label>Owning Department</label>
          <select value={form.owning_department_id} onChange={(e) => set({ owning_department_id: e.target.value })}>
            <option value="">
              {selectedType?.owning_department_name
                ? `${selectedType.owning_department_name} (from type)`
                : '--Inherit from asset type--'}
            </option>
            {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {selectedType?.owning_department_name
              ? `Leave as inherited so this unit follows "${selectedType.display_name}". Only that department sees it, and only its head can transfer or dispose of it.`
              : 'This asset type has no owning department set. Set one at Assets → Asset Types, or pick one here for this unit alone.'}
          </div>
        </div>

        <h3 style={{ margin: '22px 0 8px', fontSize: 14, color: '#334155' }}>Where it is</h3>
        <div className="field" style={{ maxWidth: 520 }}>
          <label>Attached To (host asset)</label>
          <EntityPicker
            label="Host Asset" items={hosts} value={form.parent_asset_id}
            getLabel={hostLabel}
            columns={[{ key: 'reference_no', label: 'Reference No' }, { key: 'item_name', label: 'Asset Type' }, { key: 'location_name', label: 'Location' }, { key: 'custodian_name', label: 'Custodian' }]}
            searchKeys={['reference_no', 'item_name', 'serial_no', 'location_name', 'custodian_name']}
            placeholder="--Standalone asset--"
            onSelect={(x) => set({ parent_asset_id: x?.id || '' })}
            onClear={() => set({ parent_asset_id: '' })}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Leave empty for a standalone asset. Attach a UPS or RAM to the system unit it belongs to, and it will
            always be reported wherever that host is.
          </div>
        </div>

        {isAttached ? (
          <p className="muted" style={{ marginTop: 12 }}>
            This asset is attached, so it takes its location, custodian and department from its host. Transfer the
            host to move it, or detach it here to give it a place of its own.
          </p>
        ) : (
          <>
            {detaching && (
              <div className="error-banner" style={{ marginTop: 12 }}>
                You are detaching this asset from its host. Give it a location and custodian of its own below.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 12 }}>
              <div className="field">
                <label>Location *</label>
                <select value={form.location_id} onChange={(e) => set({ location_id: e.target.value })}>
                  <option value="">--Select--</option>
                  {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
                </select>
                {id && !detaching && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Changing this here does not move the asset — raise a transfer for that.
                  </div>
                )}
              </div>
              <div className="field">
                <label>Custodian</label>
                <EntityPicker
                  label="Custodian" items={meta.employees} value={form.custodian_employee_id}
                  getLabel={(x) => x.name}
                  columns={[{ key: 'name', label: 'Name' }, { key: 'employee_code', label: 'Code' }, { key: 'department_name', label: 'Department' }]}
                  searchKeys={['name', 'employee_code', 'department_name']}
                  placeholder="--Select--"
                  onSelect={(x) => set({ custodian_employee_id: x?.id || '' })}
                  onClear={() => set({ custodian_employee_id: '' })}
                />
              </div>
              <div className="field">
                <label>Assigned Location</label>
                <select value={form.assigned_location_id} onChange={(e) => set({ assigned_location_id: e.target.value })}>
                  <option value="">--Select--</option>
                  {(meta.assigned_locations || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  The precise spot within the location. Maintained at Lookups &gt; Asset Assigned Locations.
                </div>
              </div>
            </div>
          </>
        )}

        <h3 style={{ margin: '22px 0 8px', fontSize: 14, color: '#334155' }}>Acquisition</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div className="field">
            <label>Date Acquired</label>
            <input type="date" value={form.acquired_date} onChange={(e) => set({ acquired_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Acquisition Cost</label>
            <input type="number" step="0.01" value={form.acquisition_cost} onChange={(e) => set({ acquisition_cost: e.target.value })} />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Remarks</label>
            <textarea rows={2} value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />
          </div>
        </div>

        {/* Recording these does NOT capitalise the asset -- that is done from the Accounting tab,
            because putting something on the balance sheet is accounting's call, not the tagger's. */}
        {meta.accounting_enabled && (
          <>
            <h3 style={{ margin: '22px 0 8px', fontSize: 14, color: '#334155' }}>Accounting</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              <div className="field">
                <label>Asset Class</label>
                <select value={form.asset_class_id} onChange={(e) => {
                  const cls = (meta.asset_classes || []).find((c) => String(c.id) === e.target.value);
                  set({ asset_class_id: e.target.value, useful_life_months: form.useful_life_months || cls?.default_useful_life_months || '' });
                }}>
                  <option value="">--None--</option>
                  {(meta.asset_classes || []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.is_depreciable ? '' : ' (not depreciated)'}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>In-Service Date</label>
                <input type="date" value={form.in_service_date} onChange={(e) => set({ in_service_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Useful Life (months)</label>
                <input type="number" value={form.useful_life_months} onChange={(e) => set({ useful_life_months: e.target.value })} />
              </div>
              <div className="field">
                <label>Salvage Value</label>
                <input type="number" step="0.01" value={form.salvage_value} onChange={(e) => set({ salvage_value: e.target.value })} />
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              {original?.is_capitalized
                ? 'This asset is capitalised. Useful life and salvage value may be revised — the change is spread over the remaining life. Class and in-service date are fixed once depreciation has posted.'
                : 'Recording these does not capitalise the asset. Capitalise it from the Accounting tab once it is ready to go on the balance sheet.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
