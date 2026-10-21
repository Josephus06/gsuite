import { useEffect, useState } from 'react';
import api from '../../api/client';
import Modal from '../../components/Modal';

// A question's picture (2026-10-21), fetched on its own from `url` so lists and the exam stay light.
// Click to see it full size.
export default function QuestionImage({ url, src, maxHeight = 260 }) {
  const [data, setData] = useState(src || null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (src) { setData(src); return undefined; }
    let live = true;
    if (url) api.get(url).then(({ data: d }) => { if (live) setData(d.image || null); }).catch(() => {});
    return () => { live = false; };
  }, [url, src]);
  if (!data) return url ? <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>Loading picture…</div> : null;
  return (
    <>
      <img src={data} alt="Question" onClick={() => setBig(true)}
        style={{ maxWidth: '100%', maxHeight, borderRadius: 6, border: '1px solid var(--border, #e5e7eb)', cursor: 'zoom-in', display: 'block', margin: '8px 0' }} />
      {big && (
        <Modal title="Picture" onClose={() => setBig(false)} xl>
          <img src={data} alt="Question" style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} />
        </Modal>
      )}
    </>
  );
}
