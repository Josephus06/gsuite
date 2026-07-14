import { useRef, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { fileToSquareDataUrl } from '../utils/image';

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[parts.length - 1]?.[0] || '')).toUpperCase();
}

// Circular profile photo, shared by the topnav and every dashboard's profile card.
// Pass `editable` to let the current user click it to upload a new one (resized
// client-side to a small square JPEG, then stored inline via PUT /auth/me/avatar).
export default function Avatar({ user, size = 40, editable = false, className = '' }) {
  const { refresh } = useAuth();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const dataUrl = await fileToSquareDataUrl(file);
      await api.put('/auth/me/avatar', { dataUrl });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  const photo = user?.avatar_data;

  return (
    <div className={`avatar-wrap ${className}`} style={{ width: size, height: size }}>
      {photo ? (
        <img src={photo} alt={user?.display_name || 'User'} className="avatar-img" style={{ width: size, height: size }} />
      ) : (
        <div className="avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.38 }}>
          {initials(user?.display_name)}
        </div>
      )}
      {editable && (
        <>
          <button
            type="button"
            className="avatar-edit-btn"
            title="Change profile picture"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {busy ? '…' : '✎'}
          </button>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFile} style={{ display: 'none' }} />
        </>
      )}
      {error && <div className="avatar-error">{error}</div>}
    </div>
  );
}
