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

export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const say = speakable(text);
  if (!say) return;
  // Cancel anything still being read: three notifications in a row should announce the
  // newest, not queue a backlog the listener has already seen on screen.
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(say);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  const voice = window.speechSynthesis.getVoices().find((v) => /^en(-|_|$)/i.test(v.lang));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
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
