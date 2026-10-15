import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';

// "Get the T1S app" -- offers the Android APK and the Windows installer that the server publishes
// from /opt/gsuite-downloads (GET /api/app-downloads lists what is actually there, so a build
// that was never uploaded is never offered). Shown in the Feed and on the login page; hidden
// inside the apps themselves, and on devices neither app runs on (iPhone, Mac).

const DISMISS_KEY = 't1s-get-app-dismissed';

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const inApp = Capacitor.isNativePlatform() || /Electron/i.test(ua);
const isAndroid = /Android/i.test(ua);
const isWindows = /Windows/i.test(ua);

const mb = (bytes) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;

function useAppDownloads() {
  const [files, setFiles] = useState(null);
  useEffect(() => {
    if (inApp || !(isAndroid || isWindows)) return undefined;
    let live = true;
    // Plain fetch, not the api client: this is unauthenticated (the login page uses it too), and a
    // stale token's 401 must not bounce the visitor to /login.
    fetch('/api/app-downloads')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => { if (live) setFiles(d); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (!files) return [];
  // A phone gets the APK only; a Windows PC gets the installer first and the APK for their phone.
  const list = [];
  if (isWindows && files.windows) list.push({ key: 'windows', label: 'Windows app', hint: `For this computer · ${mb(files.windows.size)}`, icon: '🖥️', ...files.windows });
  if (files.android) list.push({ key: 'android', label: 'Android app', hint: `${isAndroid ? 'For this phone' : 'For your phone'} · ${mb(files.android.size)}`, icon: '📱', ...files.android });
  return list;
}

const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } };

/**
 * variant="rail"   -- card in the Feed's left column (wide screens)
 * variant="banner" -- slim, dismissible strip above the composer (phones, narrow windows)
 */
export function GetTheAppCard({ variant = 'rail' }) {
  const list = useAppDownloads();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!list.length) return null;

  if (variant === 'banner') {
    if (dismissed) return null;
    const first = list[0];
    const dismiss = () => {
      setDismissed(true);
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* remembered for this visit only */ }
    };
    return (
      <div className="fb-card get-app-banner">
        <span className="get-app-banner-icon" aria-hidden="true">{first.icon}</span>
        <div className="get-app-banner-text">
          <strong>Use T1S as an app</strong>
          <span>Faster to open, right on your {first.key === 'android' ? 'home screen' : 'desktop'}.</span>
        </div>
        <a className="get-app-btn" href={first.url} download>Download</a>
        <button type="button" className="get-app-close" aria-label="Dismiss" onClick={dismiss}>✕</button>
      </div>
    );
  }

  return (
    <div className="get-app-card">
      <div className="fb-rail-sep" />
      <div className="get-app-card-title">Get the T1S app</div>
      <p>Open T1S straight from your desktop or phone, in its own window.</p>
      {list.map((f) => (
        <a key={f.key} className="get-app-row" href={f.url} download>
          <span className="fb-rail-icon" aria-hidden="true">{f.icon}</span>
          <span className="get-app-row-text">
            <span>{f.label}</span>
            <small>{f.hint}</small>
          </span>
          <span className="get-app-row-arrow" aria-hidden="true">⬇</span>
        </a>
      ))}
    </div>
  );
}

// One line under the Sign In button.
export function GetTheAppLink() {
  const list = useAppDownloads();
  if (!list.length) return null;
  return (
    <div className="get-app-login">
      Get the T1S app:{' '}
      <span className="get-app-login-links">
        {list.map((f, i) => (
          <span key={f.key}>
            {i > 0 && ' · '}
            <a href={f.url} download>{f.label.replace(' app', '')}</a>
          </span>
        ))}
      </span>
    </div>
  );
}
