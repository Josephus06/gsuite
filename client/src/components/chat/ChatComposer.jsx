import { useEffect, useRef, useState } from 'react';

// The message field of a chat box, Messenger-style (2026-10-13): photos / files, an emoji picker,
// the message being replied to, and Send -- or a 👍 when there is nothing typed. Photos are shrunk
// (longest side 1600 px, JPEG) before sending, so a phone picture does not cost the database 8 MB.
//   onSend({ body, attachments, reply_to_id }) -> Promise
//   onTyping()  called as the user types (the box throttles what it tells the server)
const EMOJI = {
  Smileys: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖',
  Gestures: '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🫶 👀 🧠',
  Hearts: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 🎉 🎊 🎈 🎁 🏆 🥇',
  Things: '☕ 🍵 🍔 🍕 🍟 🌭 🍿 🍩 🍪 🎂 🍰 🍫 🍺 🍻 🥂 🍷 🍹 🍜 🍚 🍗 📷 📱 💻 🖨️ 📄 📎 📌 📅 ⏰ ✅ ❌ ⚠️ ❓ ❗ 🚗 🚚 🏠 🏢 🌧️ ☀️ 🌙',
};
const MAX_FILES = 6;

// A photo, shrunk and re-encoded; anything else read as it is. -> { file_name, mime_type, data, preview }
function readFile(file) {
  return new Promise((resolve, reject) => {
    const asDataUrl = (blob) => new Promise((res2, rej2) => { const r = new FileReader(); r.onload = () => res2(r.result); r.onerror = rej2; r.readAsDataURL(blob); });
    if (!/^image\/(jpeg|png|webp|bmp)$/.test(file.type)) {
      asDataUrl(file).then((data) => resolve({ file_name: file.name, mime_type: file.type || 'application/octet-stream', data, preview: file.type.startsWith('image/') ? data : null })).catch(reject);
      return;
    }
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(src);
      const data = c.toDataURL('image/jpeg', 0.85);
      resolve({ file_name: file.name.replace(/\.\w+$/, '') + '.jpg', mime_type: 'image/jpeg', data, preview: data });
    };
    img.onerror = () => { URL.revokeObjectURL(src); asDataUrl(file).then((data) => resolve({ file_name: file.name, mime_type: file.type, data, preview: null })).catch(reject); };
    img.src = src;
  });
}

export default function ChatComposer({ onSend, onTyping, replyTo, onCancelReply, focusKey }) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, [focusKey, replyTo]);

  async function pick(list) {
    setError('');
    const chosen = [...list].slice(0, MAX_FILES - files.length);
    try {
      const read = await Promise.all(chosen.map(readFile));
      setFiles((f) => [...f, ...read]);
    } catch { setError('Could not read that file.'); }
  }

  async function send(bodyOverride) {
    const body = (bodyOverride ?? draft).trim();
    if ((!body && !files.length) || sending) return;
    setSending(true); setError('');
    try {
      await onSend({ body, attachments: files.map(({ file_name, mime_type, data }) => ({ file_name, mime_type, data })), reply_to_id: replyTo?.id || null });
      setDraft(''); setFiles([]); setEmojiOpen(false);
    } catch (e) { setError(e.response?.data?.error || 'Not sent.'); }
    setSending(false);
    inputRef.current?.focus();
  }

  const empty = !draft.trim() && !files.length;
  return (
    <div className="cc-wrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) pick(e.dataTransfer.files); }}>
      {replyTo && (
        <div className="cc-reply">
          <div><strong>Replying to {replyTo.who}</strong><span>{replyTo.preview}</span></div>
          <button type="button" onClick={onCancelReply} title="Cancel reply">×</button>
        </div>
      )}
      {files.length > 0 && (
        <div className="cc-files">
          {files.map((f, i) => (
            <div key={i} className="cc-file">
              {f.preview ? <img src={f.preview} alt={f.file_name} /> : <span className="cc-file-name">📄 {f.file_name}</span>}
              <button type="button" onClick={() => setFiles((x) => x.filter((_, n) => n !== i))} title="Remove">×</button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
      <div className="cc-bar">
        <button type="button" className="cc-icon" title="Attach a photo or file" onClick={() => fileRef.current?.click()}>🖼️</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
        <div className="cc-input">
          <textarea ref={inputRef} rows={1} value={draft} placeholder="Aa" maxLength={4000}
            onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim()) onTyping?.(); }}
            onPaste={(e) => { const imgs = [...(e.clipboardData?.files || [])]; if (imgs.length) { e.preventDefault(); pick(imgs); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button type="button" className="cc-icon cc-emoji-btn" title="Emoji" onClick={() => setEmojiOpen((o) => !o)}>😊</button>
        </div>
        {empty ? (
          <button type="button" className="cc-icon cc-like" title="Send a like" disabled={sending} onClick={() => send('👍')}>👍</button>
        ) : (
          <button type="button" className="cc-send" title="Send" disabled={sending} onClick={() => send()}>➤</button>
        )}
      </div>
      {emojiOpen && (
        <div className="cc-emoji">
          {Object.entries(EMOJI).map(([group, list]) => (
            <div key={group}>
              <div className="cc-emoji-group">{group}</div>
              <div className="cc-emoji-grid">
                {list.split(' ').map((e) => (
                  <button type="button" key={e} onClick={() => { setDraft((d) => d + e); inputRef.current?.focus(); }}>{e}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
