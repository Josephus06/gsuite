// Audible notifications: a short chime, then the headline read aloud.
//
// Both are generated in the browser -- a WebAudio tone rather than a bundled mp3, and the
// platform's own speech synthesiser rather than a TTS service. Nothing to ship, nothing to
// pay for, and no request leaves the machine to announce a ticket.

const PREF_KEY = 'notifications.sound';

export function soundEnabled() {
  // Defaults ON: someone who has not chosen wants to be told. The toggle in the bell menu
  // writes 'off' the moment they decide otherwise.
  return localStorage.getItem(PREF_KEY) !== 'off';
}

export function setSoundEnabled(on) {
  localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
}

// Browsers refuse to start audio until the user has interacted with the page, so the context
// is created lazily and resumed on the first interaction. Without this the very first
// notification of a session is silently swallowed on a freshly-loaded tab.
let ctx = null;
function audioContext() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  if (ctx.state === 'suspended') {
    const resume = () => {
      ctx.resume();
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }
  return ctx;
}

// Two quick notes, a fifth apart -- recognisable as "something arrived" without being the
// kind of alarm that makes an office look up.
export function chime() {
  const audio = audioContext();
  if (!audio || audio.state === 'suspended') return;
  const now = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Shaped rather than switched: an abrupt start and stop on a sine wave clicks.
    gain.gain.setValueAtTime(0, now + i * 0.16);
    gain.gain.linearRampToValueAtTime(0.16, now + i * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.16 + 0.28);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + i * 0.16);
    osc.stop(now + i * 0.16 + 0.3);
  });
}

// "TICKET-141" is read as "ticket dash one four one" or worse; splitting the hyphen and
// spacing the digits gets "ticket one forty one", which is how someone would say it.
function speakable(text) {
  return String(text || '')
    .replace(/--/g, ',')
    .replace(/([A-Za-z]+)-(\d+)/g, '$1 $2')
    // A job order number is JO-63697-1-1; left alone the tail is read as "dash one dash
    // one", so the separators between digits become spaces too.
    .replace(/(\d)-(?=\d)/g, '$1 ')
    .replace(/\bNSTDJO\b/gi, 'N S T D J O')
    .replace(/\bJO\b/g, 'J O')
    .trim();
}

// Voices load asynchronously. getVoices() returns [] on the first call in Chrome, and
// speaking before they arrive is the usual reason nothing is heard while the API reports no
// error at all. Resolves either when the list arrives or after a short wait, since some
// browsers populate it synchronously and never fire the event.
function voicesReady() {
  const synth = window.speechSynthesis;
  if (synth.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    synth.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, 1000);
  });
}

export async function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  const say = speakable(text);
  if (!say) return;

  await voicesReady();

  // Only cancel when something is actually queued. Calling cancel() on an idle synthesiser
  // and then speaking immediately leaves Chrome's queue in a state where the utterance is
  // accepted and never spoken -- which is exactly a chime with no voice after it.
  if (synth.speaking || synth.pending) {
    synth.cancel();
    await new Promise((r) => { setTimeout(r, 120); });
  }

  const utterance = new SpeechSynthesisUtterance(say);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.lang = 'en-US';
  const voice = synth.getVoices().find((v) => /^en(-|_|$)/i.test(v.lang));
  if (voice) utterance.voice = voice;
  synth.speak(utterance);

  // Chrome can hand back a synthesiser that is paused from an earlier tab switch; resume is
  // a no-op when it is already running.
  if (synth.paused) synth.resume();
}

// A desktop notification -- the OS-level popup that shows even when this tab is in the
// background or the window is minimised. It cannot fire when the browser itself is closed:
// that needs a service worker and Web Push, which is a different mechanism (see the note in
// NotificationBell).
export function desktopNotify({ title, body, onClick }) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Only when the page is not being looked at. Duplicating an on-screen toast into an OS
  // popup while the user is staring at the page is just noise.
  if (document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body: body || '', tag: `gsuite-${title}`, icon: '/favicon.ico' });
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
  } catch {
    // Some browsers throw when constructing one outside a service worker; the in-page toast
    // and the voice have already done the job, so there is nothing to recover from.
  }
}

// Asked for once, and only from a real click -- browsers ignore (or permanently block) a
// permission request that is not tied to a user gesture.
export function requestDesktopPermission() {
  if (!('Notification' in window)) return Promise.resolve('unsupported');
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return Notification.requestPermission();
}

// The pair, for a batch of new notifications. Only the newest is read: reading five in a row
// takes half a minute, during which nobody can hear the next one.
export function announce(titles) {
  if (!soundEnabled() || !titles.length) return;
  chime();
  const [first] = titles;
  const rest = titles.length - 1;
  setTimeout(() => speak(rest > 0 ? `${first}. And ${rest} more notification${rest === 1 ? '' : 's'}.` : first), 450);
}
