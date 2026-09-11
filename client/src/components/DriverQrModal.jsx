import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import Modal from './Modal';

// The driver's run link as a QR code, for scanning off the dispatcher's screen or the printed
// run sheet.
//
// Better than sending a link: there is no message to forward, no address to mistype, and nothing
// sitting in a chat thread afterwards. The driver points a camera at the sheet and is in.
//
// The QR encodes the same tokenised URL, so everything about it is unchanged -- one run, dead a
// week after the run date, revoked by issuing a new one. A QR is not a second credential, it is
// the same one in a shape a phone camera can read.
export default function DriverQrModal({ url, itineraryNo, driverName, onClose }) {
  const [png, setPng] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Generated in the browser: the URL never travels anywhere to be turned into an image, and
    // there is no QR service to depend on or leak the token to.
    //
    // Error-correction level M and a wide margin, because this gets printed and scanned off paper
    // under warehouse lighting, not off a clean screen.
    QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      .then(setPng)
      .catch(() => setError('Could not draw the QR code.'));
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard needs a secure context; on the plain-HTTP installs it simply refuses. The URL
      // is on screen to copy by hand, which is why it is shown in full rather than truncated.
      setError('Could not copy — select the address below instead.');
    }
  }

  return (
    <Modal title="Driver Link" onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}

      <div style={{ textAlign: 'center' }}>
        <p className="muted" style={{ marginTop: 0 }}>
          Have the driver scan this. It opens {itineraryNo}
          {driverName ? ` for ${driverName}` : ''} — no login needed.
        </p>

        {png ? (
          <img
            src={png}
            alt={`QR code for ${itineraryNo}`}
            style={{ width: 260, height: 260, background: '#fff', padding: 8, borderRadius: 10 }}
          />
        ) : <div style={{ height: 260 }} className="muted">Drawing…</div>}

        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => window.print()}>Print</button>
        </div>

        {/* Shown in full and selectable: a driver whose camera will not focus needs to be able to
            read it out, and the clipboard refuses on the plain-HTTP installs. */}
        <div
          style={{
            marginTop: 12, padding: 8, borderRadius: 8, fontSize: 11, wordBreak: 'break-all',
            background: 'var(--bg, #f1f5f9)', userSelect: 'all',
          }}
        >
          {url}
        </div>

        <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          Anyone holding this can see the run&apos;s stops, addresses and contacts. It stops working
          a week after the run date, and generating a new one kills this one.
        </p>
      </div>
    </Modal>
  );
}
