import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Avatar from '../components/Avatar';
import PostCard from '../components/feed/PostCard';
import DashboardCarousel from '../components/feed/DashboardCarousel';
import PostComposer from '../components/feed/PostComposer';
import '../styles/feed.css';

// Left-rail shortcuts. These are the ERP's own modules dressed as FB's shortcut list --
// the rail is the natural place for them once the dashboard becomes a feed.
const SHORTCUTS = [
  { icon: '🧾', label: 'Sales Orders', to: '/sales-orders' },
  { icon: '🛠️', label: 'Job Orders', to: '/job-orders' },
  { icon: '👤', label: 'Customers', to: '/customers' },
  { icon: '🚚', label: 'Delivery Tickets', to: '/delivery-tickets' },
  { icon: '📦', label: 'Inventory', to: '/inventory' },
  { icon: '📊', label: 'Reports', to: '/reports/general-ledger' },
];

// The server counts someone online for 5 minutes after their last request, so polling a bit
// faster than that keeps the rail from showing people who have already gone.
const CONTACTS_POLL_MS = 60_000;

function PostSkeleton() {
  return (
    <div className="fb-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div className="fb-skel fb-skel-avatar" />
        <div style={{ flex: 1 }}>
          <div className="fb-skel fb-skel-line" style={{ width: '35%' }} />
          <div className="fb-skel fb-skel-line" style={{ width: '20%' }} />
        </div>
      </div>
      <div className="fb-skel fb-skel-line" style={{ width: '90%' }} />
      <div className="fb-skel fb-skel-line" style={{ width: '75%' }} />
      <div className="fb-skel" style={{ height: 180, marginTop: 12 }} />
    </div>
  );
}

export default function Feed() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [posts, setPosts] = useState([]);
  const [viewer, setViewer] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [highlight, setHighlight] = useState(null);

  const sentinelRef = useRef(null);
  // Guards the observer against firing a second page while one is already in flight.
  const busyRef = useRef(false);

  const loadPage = useCallback(async (afterId) => {
    const { data } = await api.get('/feed', { params: afterId ? { cursor: afterId } : {} });
    setViewer(data.viewer);
    setPosts((prev) => (afterId ? [...prev, ...data.posts] : data.posts));
    setCursor(data.next_cursor);
    setHasMore(Boolean(data.next_cursor));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadPage(null);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load the feed.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadPage]);

  // Contacts are a live "who's online" list, so they get their own poll rather than riding
  // the feed load -- someone signing in or out should appear/disappear without a refresh.
  useEffect(() => {
    let cancelled = false;
    const fetchContacts = () => api
      .get('/feed/contacts')
      .then((r) => { if (!cancelled) setContacts(r.data.contacts); })
      .catch(() => {});

    fetchContacts();
    const id = setInterval(fetchContacts, CONTACTS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return undefined;

    const io = new IntersectionObserver(async (entries) => {
      if (!entries[0].isIntersecting || busyRef.current) return;
      busyRef.current = true;
      setLoadingMore(true);
      try {
        await loadPage(cursor);
      } catch {
        setHasMore(false);
      } finally {
        busyRef.current = false;
        setLoadingMore(false);
      }
    }, { rootMargin: '400px' });

    io.observe(el);
    return () => io.disconnect();
  }, [cursor, hasMore, loading, loadPage]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // Arriving from a feed notification (/dashboard#post-123): scroll to that post and flash
  // it. The post may be further down than the first page, so keep pulling pages until it
  // shows up or the feed runs out -- otherwise older notifications would just sit at the top.
  const targetId = location.hash.startsWith('#post-') ? location.hash.slice(6) : null;
  useEffect(() => {
    if (!targetId || loading) return;
    const el = document.getElementById(`post-${targetId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlight(targetId);
      return;
    }
    if (hasMore && !busyRef.current) {
      busyRef.current = true;
      loadPage(cursor).finally(() => { busyRef.current = false; });
    }
  }, [targetId, posts, loading, hasMore, cursor, loadPage]);

  useEffect(() => {
    if (!highlight) return undefined;
    const id = setTimeout(() => setHighlight(null), 2400);
    return () => clearTimeout(id);
  }, [highlight]);

  async function submitPost(payload) {
    if (editing) {
      const { data } = await api.put(`/feed/${editing.id}`, payload);
      setPosts((prev) => prev.map((p) => (p.id === data.post.id ? data.post : p)));
      setEditing(null);
    } else {
      const { data } = await api.post('/feed', payload);
      setPosts((prev) => [data.post, ...prev]);
    }
  }

  const firstName = (user?.display_name || '').split(' ')[0];

  return (
    <div className="fbfeed">
      <div className="fb-shell">
        {/* ------------------------------------------------------------ left rail */}
        {/* Own column at the far left, outside the shortcuts rail: it is company notice
            material rather than navigation, and the space was empty anyway. */}
        <aside className="fb-rail fb-rail-far-left">
          <DashboardCarousel />
        </aside>

        <aside className="fb-rail fb-rail-left">
          <button type="button" className="fb-rail-item" onClick={() => navigate(`/profile/${user?.id}`)}>
            <Avatar user={user} size={36} />
            <span>{user?.display_name}</span>
          </button>
          <div className="fb-rail-sep" />
          <div className="fb-rail-title">Shortcuts</div>
          {SHORTCUTS.map((s) => (
            <button key={s.to} type="button" className="fb-rail-item" onClick={() => navigate(s.to)}>
              <span className="fb-rail-icon">{s.icon}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </aside>

        {/* ---------------------------------------------------------- center feed */}
        <main className="fb-center">
          {error && <div className="fb-error">{error}</div>}
          {toast && <div className="fb-error" style={{ background: 'var(--fb-blue)' }}>{toast}</div>}

          <div className="fb-card fb-composer">
            <div className="fb-composer-top">
              <Avatar user={user} size={40} />
              <button
                type="button"
                className="fb-composer-trigger"
                onClick={() => { setEditing(null); setComposerOpen(true); }}
              >
                What&apos;s on your mind, {firstName}?
              </button>
            </div>
            <div className="fb-composer-divider" />
            <div className="fb-composer-actions">
              <button type="button" className="fb-composer-action" onClick={() => { setEditing(null); setComposerOpen(true); }}>
                <span className="emoji">🖼️</span>Photo
              </button>
              <button type="button" className="fb-composer-action" onClick={() => { setEditing(null); setComposerOpen(true); }}>
                <span className="emoji">🏷️</span>Tag people
              </button>
              <button type="button" className="fb-composer-action" onClick={() => { setEditing(null); setComposerOpen(true); }}>
                <span className="emoji">😊</span>Feeling
              </button>
            </div>
          </div>

          {loading ? (
            <>
              <PostSkeleton />
              <PostSkeleton />
            </>
          ) : posts.length === 0 ? (
            <div className="fb-card fb-empty">
              <div className="big">📝</div>
              <div style={{ fontWeight: 600, color: 'var(--fb-text)' }}>No posts yet</div>
              <div>Be the first to share something with the team.</div>
            </div>
          ) : (
            posts.map((p) => (
              <div key={p.id} id={`post-${p.id}`} className={String(p.id) === highlight ? 'fb-highlight' : undefined}>
                <PostCard
                  post={p}
                  user={user}
                  viewer={viewer}
                  onChanged={setToast}
                  onDeleted={(id) => setPosts((prev) => prev.filter((x) => x.id !== id))}
                  onEdit={(post) => { setEditing(post); setComposerOpen(true); }}
                />
              </div>
            ))
          )}

          {loadingMore && <PostSkeleton />}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {!hasMore && posts.length > 0 && (
            <div className="fb-empty" style={{ padding: 20 }}>You&apos;re all caught up.</div>
          )}
        </main>

        {/* ----------------------------------------------------------- right rail */}
        <aside className="fb-rail fb-rail-right">
          <div className="fb-rail-title">
            Contacts
            {contacts.length > 0 && <span className="fb-rail-count">{contacts.length} online</span>}
          </div>
          {/* Everyone in this list is online by construction -- the server only returns users
              whose heartbeat is inside the window -- so the green dot is always accurate. */}
          {contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              className="fb-rail-item"
              title={c.group_name || c.account_type || ''}
              onClick={() => navigate(`/profile/${c.id}`)}
            >
              <span className="fb-rail-avatar-wrap">
                <Avatar user={c} size={36} />
                <span className="fb-online-dot" />
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.display_name}
              </span>
            </button>
          ))}
          {contacts.length === 0 && (
            <div style={{ padding: 8, color: 'var(--fb-text-2)', fontSize: 14 }}>No one else is online right now.</div>
          )}
        </aside>
      </div>

      <PostComposer
        open={composerOpen}
        editing={editing}
        user={user}
        groupName={viewer?.group_name}
        onClose={() => { setComposerOpen(false); setEditing(null); }}
        onSubmit={submitPost}
      />
    </div>
  );
}
