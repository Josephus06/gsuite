import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';

// Floating chat widget, mounted once in Layout.jsx so it persists across navigation.
// Default mode is a small data-Q&A assistant (server/src/lib/chatbotIntents.js);
// typing "create ticket" switches the same conversation into a guided intake flow
// (department -> issue) that creates a real Ticket, after which further messages
// become replies on that ticket's own thread (server/src/routes/tickets.js), polled
// every 6s so a department head's reply shows up without a manual refresh -- mirrors
// the setInterval pattern already used in client/src/pages/AssignedJobOrderRun.jsx.
const GREETING = "Hi! Ask me things like \"how many estimates today\" or \"my weighted sales this month\" — or type \"create ticket\" to reach a department.";
const POLL_MS = 6000;

function formatTime(v) {
  return v ? new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
}

export default function ChatWidget() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [localMessages, setLocalMessages] = useState([{ sender: 'bot', text: GREETING, at: new Date().toISOString() }]);
  const [ticket, setTicket] = useState(null);
  const [ticketMessages, setTicketMessages] = useState([]);
  const [mode, setMode] = useState('chat'); // chat | awaiting_department | awaiting_issue | ticket_thread
  const [departments, setDepartments] = useState([]);
  const [pendingDepartmentId, setPendingDepartmentId] = useState(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (open && departments.length === 0) {
      api.get('/tickets/meta/departments').then(({ data }) => setDepartments(data)).catch(() => {});
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !ticket || mode !== 'ticket_thread') return undefined;
    const poll = () => api.get(`/tickets/${ticket.id}`).then(({ data }) => setTicketMessages(data.messages)).catch(() => {});
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [open, ticket, mode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [localMessages, ticketMessages, open]);

  function pushLocal(sender, text) {
    setLocalMessages((prev) => [...prev, { sender, text, at: new Date().toISOString() }]);
  }

  function findDepartment(text) {
    const q = text.trim().toLowerCase();
    return departments.find((d) => d.name.toLowerCase() === q)
      || departments.find((d) => d.name.toLowerCase().includes(q) || q.includes(d.name.toLowerCase()));
  }

  async function handleSend(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    try {
      if (mode === 'ticket_thread' && ticket) {
        await api.post(`/tickets/${ticket.id}/messages`, { message: text });
        const { data } = await api.get(`/tickets/${ticket.id}`);
        setTicketMessages(data.messages);
        return;
      }

      pushLocal('user', text);

      if (mode === 'chat') {
        const { data } = await api.post('/chatbot/ask', { message: text });
        pushLocal('bot', data.reply);
        if (data.isTicketTrigger) setMode('awaiting_department');
        return;
      }

      if (mode === 'awaiting_department') {
        const dept = findDepartment(text);
        if (!dept) {
          const names = departments.filter((d) => d.name !== 'System Admin').map((d) => d.name).join(', ');
          pushLocal('bot', `I couldn't match that to a department. Try one of: ${names}`);
          return;
        }
        setPendingDepartmentId(dept.id);
        pushLocal('bot', `Got it — ${dept.name}. Please describe the issue.`);
        setMode('awaiting_issue');
        return;
      }

      if (mode === 'awaiting_issue') {
        const { data: newTicket } = await api.post('/tickets', { department_id: pendingDepartmentId, description: text });
        pushLocal('bot', `Ticket ${newTicket.ticket_no} created. Someone from that department will reply here.`);
        setTicket(newTicket);
        setMode('ticket_thread');
      }
    } catch (err) {
      pushLocal('bot', err.response?.data?.error || 'Something went wrong — please try again.');
    } finally {
      setSending(false);
    }
  }

  const combined = [
    ...localMessages,
    ...ticketMessages.map((m) => ({
      sender: m.sender_user_id === user?.id ? 'user' : 'other',
      text: m.message, at: m.created_at,
      senderName: m.sender_user_id === user?.id ? null : m.sender_name,
    })),
  ];

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 200 }}>
      {open && (
        <div className="card" style={{ width: 320, height: 420, display: 'flex', flexDirection: 'column', marginBottom: 10, padding: 0, overflow: 'hidden', boxShadow: '0 8px 30px rgba(0,0,0,0.25)' }}>
          <div style={{ background: 'var(--accent)', color: '#fff', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14 }}>Support Chat{ticket ? ` · ${ticket.ticket_no}` : ''}</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {ticket && (
                <button type="button" onClick={() => navigate(`/tickets/${ticket.id}`)} title="Open full ticket" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13 }}>↗</button>
              )}
              <button type="button" onClick={() => setOpen(false)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16 }}>✕</button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {combined.map((m, i) => (
              <div key={i} style={{ alignSelf: m.sender === 'bot' || m.sender === 'other' ? 'flex-start' : 'flex-end', maxWidth: '80%' }}>
                <div style={{
                  background: m.sender === 'bot' || m.sender === 'other' ? 'var(--panel-2, #f3f4f6)' : 'var(--accent)',
                  color: m.sender === 'bot' || m.sender === 'other' ? 'var(--text)' : '#fff',
                  borderRadius: 12, padding: '6px 10px', fontSize: 13, whiteSpace: 'pre-wrap',
                }}
                >
                  {m.senderName && <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>{m.senderName}</div>}
                  {m.text}
                </div>
                <div className="muted" style={{ fontSize: 10, marginTop: 2, textAlign: m.sender === 'bot' || m.sender === 'other' ? 'left' : 'right' }}>{formatTime(m.at)}</div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={handleSend} style={{ display: 'flex', borderTop: '1px solid var(--border)' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              disabled={sending}
              style={{ flex: 1, border: 'none', padding: '10px 12px', fontSize: 13, outline: 'none' }}
            />
            <button type="submit" className="btn btn-primary" disabled={sending} style={{ borderRadius: 0 }}>Send</button>
          </form>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 52, height: 52, borderRadius: '50%', background: 'var(--accent)', color: '#fff',
          border: 'none', fontSize: 22, cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
        }}
        title="Support chat"
      >
        {open ? '✕' : '💬'}
      </button>
    </div>
  );
}
