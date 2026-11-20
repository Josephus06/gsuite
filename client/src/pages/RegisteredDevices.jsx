import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

// Master Lists > Registered Devices (2026-11-20): the device gate (server lib/deviceGate.js).
// T1S opens on any device on an office network, and elsewhere only on a registered device -- for any
// other device it is unreachable (a bare 404). Only an admin registers a device: on the device itself,
// on the office network, at /register-device, signing in with their admin account.
// The gate is OFF until "Restrict access" is ticked and saved -- and the server refuses to switch it on
// from a place that would lock out the admin doing it.

const STATUS = {
  pending: { label: 'Pending', color: '#b45309', bg: '#fef3c7' },
  approved: { label: 'Registered', color: '#15803d', bg: '#dcfce7' },
  rejected: { label: 'Rejected', color: '#b91c1c', bg: '#fee2e2' },
  revoked: { label: 'Removed', color: '#475569', bg: '#e2e8f0' },
};
const when = (v) => (v ? new Date(v).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const kind = (ua) => {
  const s = String(ua || '');
  if (/Electron|T1S/i.test(s)) return 'T1S Windows app';
  if (/; wv\)|Capacitor/i.test(s)) return 'T1S Android app';
  if (/Android/i.test(s)) return 'Android browser';
  if (/iPhone|iPad/i.test(s)) return 'iPhone / iPad';
  if (/Windows/i.test(s)) return 'Windows browser';
  if (/Mac OS X/i.test(s)) return 'Mac browser';
  return s ? 'Browser' : '—';
};
const REASON = {
  office: 'you are on an office network',
  device: 'this device is approved',
  blocked: 'this device is NOT approved and you are not on an office network',
};

export default function RegisteredDevices() {
  const { can } = useAuth();
  const R = '/registered-devices';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [networks, setNetworks] = useState('');
  const [filter, setFilter] = useState('all');

  async function load() {
    try {
      const { data: d } = await api.get('/registered-devices');
      setData(d);
      setEnabled(d.enabled);
      setNetworks(d.networks.join('\n'));
    } catch (e) { setError(e.response?.data?.error || 'Could not load the devices.'); }
  }
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => (data ? data.devices.filter((d) => filter === 'all' || d.status === filter) : []), [data, filter]);

  async function saveSettings() {
    setBusy(true); setError(''); setMsg('');
    try {
      await api.put('/registered-devices/settings', { enabled, networks: networks.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) });
      setMsg('Saved.');
      await load();
    } catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
    setBusy(false);
  }
  async function act(d, action) {
    if (action === 'delete' && !window.confirm(`Delete "${d.device_name}"? It will have to ask again.`)) return;
    if (action === 'revoke' && !window.confirm(`Remove access for "${d.device_name}"? Off the office network it will be blocked within a minute.`)) return;
    setError(''); setMsg('');
    try {
      if (action === 'delete') await api.delete(`/registered-devices/${d.id}`);
      else await api.post(`/registered-devices/${d.id}/${action}`);
      await load();
    } catch (e) { setError(e.response?.data?.error || 'Could not update the device.'); }
  }
  async function rename(d) {
    const name = window.prompt('Device name', d.device_name);
    if (!name || name.trim() === d.device_name) return;
    try { await api.put(`/registered-devices/${d.id}`, { device_name: name.trim() }); await load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not rename.'); }
  }
  function addMine() {
    const list = networks.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!list.includes(data.your_ip)) setNetworks([...list, data.your_ip].join('\n'));
  }

  if (!data && !error) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Registered Devices</h1>
        <a className="btn" style={{ whiteSpace: 'nowrap' }} href="/register-device" title="Open the registration page on THIS device">Register this device</a>
      </div>
      <p className="muted" style={{ marginTop: -6 }}>
        To register a phone or PC: on the office network, open <code>{window.location.origin}/register-device</code> <strong>on that device</strong> (in the browser
        or app the person will use) and sign in with your admin account. It is registered at once and appears below.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="card" style={{ color: '#15803d', padding: '8px 14px' }}>{msg}</div>}

      {data && (<>
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Access rule</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            When restricted, T1S opens on <strong>any device on an office network</strong>, and anywhere else (mobile data, home Wi-Fi) <strong>only on a registered device</strong> &mdash;
            in a browser, the Android app or the Windows app. For any other device the link is unreachable: no login page, just &ldquo;page not found&rdquo;.
            Every account, admins included. Delivery drivers&rsquo; links and the website&rsquo;s forms are not affected.
          </p>
          {data.forced_off && <div className="error-banner">DEVICE_GATE=off is set on this server, so the restriction is off here whatever is saved below.</div>}
          {/* The master switch: off, T1S is open everywhere as before; on, the rule above applies. */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, margin: '8px 0 4px', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto', flex: 'none', margin: 0 }} checked={enabled} disabled={!can(R, 'can_edit')} onChange={(e) => setEnabled(e.target.checked)} />
            Restrict access to office networks and registered devices
            <span style={{ fontWeight: 400, fontSize: 12, padding: '2px 8px', borderRadius: 10, background: data.enabled ? '#dcfce7' : '#e2e8f0', color: data.enabled ? '#15803d' : '#475569' }}>
              {data.enabled ? 'ON now' : 'OFF now'}
            </span>
          </label>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 14px 24px' }}>
            Untick and Save to open T1S to every device again (e.g. if the office&rsquo;s internet address changes). Register devices first, then switch this on.
            {enabled !== data.enabled && <strong style={{ color: '#b45309' }}> Not saved yet &mdash; click Save.</strong>}
          </div>

          <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Office networks</label>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            One per line: the office&rsquo;s public internet address (e.g. 14.1.64.248) or a range (e.g. 192.168.0.0/16 for the office server&rsquo;s own network).
            If the office changes internet provider, its address changes too &mdash; add the new one here.
          </div>
          <textarea rows={4} value={networks} disabled={!can(R, 'can_edit')} onChange={(e) => setNetworks(e.target.value)}
            style={{ width: '100%', maxWidth: 420, fontFamily: 'monospace', padding: 8 }} />
          <div style={{ fontSize: 13, margin: '6px 0 12px' }}>
            Your address now: <code>{data.your_ip}</code> &mdash; with the restriction on, you would get in because {REASON[data.you_would_be] || data.you_would_be}.
            {can(R, 'can_edit') && data.you_would_be !== 'office' && <> <button type="button" className="btn btn-sm" onClick={addMine}>Add my address as an office network</button></>}
          </div>
          {can(R, 'can_edit') && <button className="btn btn-primary" disabled={busy} onClick={saveSettings}>{busy ? 'Saving…' : 'Save'}</button>}
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Devices</h3>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
              <option value="all">All</option>
              {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
            </select>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Device</th><th>Status</th><th>Registered by</th><th>Registered</th><th>Last used</th><th /></tr>
              </thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No devices{filter !== 'all' ? ` ${STATUS[filter].label.toLowerCase()}` : ''} yet.</td></tr>}
                {shown.map((d) => {
                  const s = STATUS[d.status];
                  return (
                    <tr key={d.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{d.device_name}</div>
                        <div className="muted" style={{ fontSize: 12 }} title={d.user_agent || ''}>{kind(d.user_agent)}</div>
                      </td>
                      <td>
                        <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, color: s.color, background: s.bg }}>{s.label}</span>
                        {d.status === 'revoked' && d.decided_by_name && <div className="muted" style={{ fontSize: 11 }}>by {d.decided_by_name}</div>}
                      </td>
                      <td>{d.requested_by_name || '—'}<div className="muted" style={{ fontSize: 11 }}>{d.requested_ip}</div></td>
                      <td>{when(d.requested_at)}</td>
                      <td>{when(d.last_seen_at)}{d.last_seen_ip && <div className="muted" style={{ fontSize: 11 }}>{d.last_seen_ip}</div>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {can(R, 'can_approve') && d.status !== 'approved' && <button className="btn btn-sm btn-primary" onClick={() => act(d, 'approve')}>Restore access</button>}{' '}
                        {can(R, 'can_approve') && d.status === 'approved' && <button className="btn btn-sm" onClick={() => act(d, 'revoke')}>Remove access</button>}{' '}
                        {can(R, 'can_edit') && <button className="btn btn-sm" onClick={() => rename(d)}>Rename</button>}{' '}
                        {can(R, 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => act(d, 'delete')}>Delete</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </>)}
    </div>
  );
}
