// AI summary of a group chat's unread messages (asked 2026-10-13): open a group with a pile of
// unread and one click says what was talked about, what was decided, and what is asked of you.
// Same OpenAI account and model as Translate and the chatbot (routes/translate.js).
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const MAX_CHARS = 24000; // the newest messages are kept when a backlog is longer than this

// A few a minute per user: stops a stuck client from running up the OpenAI bill.
const WINDOW_MS = 60000;
const PER_WINDOW = 6;
const recent = new Map();
function allowed(userId) {
  const now = Date.now();
  const hits = (recent.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= PER_WINDOW) { recent.set(userId, hits); return false; }
  hits.push(now);
  recent.set(userId, hits);
  return true;
}

// Philippine time, as the chat shows it. created_at is stored in UTC.
const phTime = (v) => new Date(`${String(v).replace(' ', 'T')}Z`)
  .toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });

// rows: [{ sender_name, body, created_at, att_count }] oldest first. -> the transcript sent to the model.
function transcript(rows) {
  const lines = rows.map((m) => {
    const files = Number(m.att_count) ? ` [sent ${m.att_count} photo/file${Number(m.att_count) === 1 ? '' : 's'}]` : '';
    return `[${phTime(m.created_at)}] ${m.sender_name || 'Someone'}: ${String(m.body || '').replace(/\s+/g, ' ').trim()}${files}`;
  });
  const out = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    total += lines[i].length + 1;
    if (total > MAX_CHARS) break;
    out.unshift(lines[i]);
  }
  return { text: out.join('\n'), cut: out.length < lines.length };
}

async function summarize({ groupName, readerName, rows }) {
  const { text, cut } = transcript(rows);
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: [
            'You summarize the unread messages of a work group chat at a Philippine printing and signage company.',
            'Messages may be in English, Tagalog, Cebuano/Bisaya or a mix; write the summary in clear, simple English.',
            `The reader is ${readerName}. Write for them: they have not read these messages.`,
            'Format: 2 to 6 short bullet points ("- "), most important first. Cover what was discussed, any decision,',
            'and any question, request or deadline -- say who asked whom. If something is asked of or mentions the reader,',
            'put it first and start that bullet with "For you:". Keep names, document numbers (SO-, JO-, PO-, INV-),',
            'amounts, quantities and dates exactly as written. Do not invent anything that is not in the messages.',
            'If the messages are only greetings or small talk, say so in one bullet. No heading, no closing remark.',
          ].join(' '),
        },
        { role: 'user', content: `Group chat: ${groupName}\n${cut ? '(Older unread messages were left out; these are the newest.)\n' : ''}\n${text}` },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`OpenAI ${response.status}: ${detail.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

module.exports = { summarize, allowed };
