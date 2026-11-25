import { useEffect, useState } from 'react';
import api from '../api/client';

// Sales > 3D Studio (2026-11-25): goes straight into the Signage Studio, signed in as this user.
// T1S hands over a one-time sign-in link (valid two minutes); the studio decides the menu --
// System Admins get everything, everyone else Dashboard, New Design, LED Studio, Production Drawings.
export default function StudioLauncher() {
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.post('/studio/open')
      .then(({ data }) => { if (!cancelled) window.location.replace(data.url); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'Could not open the 3D Studio.'); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="card" style={{ maxWidth: 520, margin: '60px auto', textAlign: 'center' }}>
      {error ? <div className="error-banner">{error}</div> : <p>Opening the 3D Studio...</p>}
    </div>
  );
}
