import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Avatar from '../components/Avatar';
import PostCard from '../components/feed/PostCard';
import PostComposer from '../components/feed/PostComposer';
import { fileToScaledDataUrl } from '../utils/image';
import { parseUtc } from '../utils/datetime';
import '../styles/feed.css';

function longDate(v) {
  const d = parseUtc(v);
  return d ? d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '';
}
// employees.date_hired is a DATE, so it has no time component to shift -- format it directly
// rather than through parseUtc, which would append a UTC time and can roll the day back.
function plainDate(v) {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return new Date(Number(y), Number(m) - 1, Number(d))
    .toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function AboutRow({ icon, children }) {
  return (
    <div className="fb-about-row">
      <span className="ico">{icon}</span>
      <span className="val">{children}</span>
    </div>
  );
}

function BioEditor({ initial, onSaved, onCancel }) {
  const [text, setText] = useState(initial || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.put('/profiles/me', { bio: text });
      onSaved(data.bio);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save your bio.');
      setBusy(false);
    }
  }

  return (
    <div className="fb-bio-editor">
      <textarea
        value={text}
        maxLength={500}
        autoFocus
        placeholder="Describe yourself…"
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ fontSize: 12, color: 'var(--fb-text-2)', textAlign: 'right' }}>{text.length}/500</div>
      {error && <div className="fb-error" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="fb-bio-actions">
        <button type="button" className="fb-btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="fb-post-btn" style={{ width: 'auto', padding: '8px 16px' }} onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

export default function Profile() {
  const { id } = useParams();
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState(null);
  const [postCount, setPostCount] = useState(0);
  const [posts, setPosts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingBio, setEditingBio] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [toast, setToast] = useState('');
  const coverRef = useRef(null);
  const busyRef = useRef(false);
  const sentinelRef = useRef(null);

  const loadPosts = useCallback(async (afterId) => {
    const { data } = await api.get(`/profiles/${id}/posts`, { params: afterId ? { cursor: afterId } : {} });
    setPosts((prev) => (afterId ? [...prev, ...data.posts] : data.posts));
    setCursor(data.next_cursor);
    setHasMore(Boolean(data.next_cursor));
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setPosts([]);
    setCursor(null);
    setHasMore(true);
    (async () => {
      try {
        const { data } = await api.get(`/profiles/${id}`);
        if (cancelled) return;
        setProfile(data.profile);
        setPostCount(data.post_count);
        await loadPosts(null);
      } catch (err) {
        if (!cancelled) setError(err.response?.status === 404 ? 'That user does not exist.' : 'Could not load this profile.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, loadPosts]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return undefined;
    const io = new IntersectionObserver(async (entries) => {
      if (!entries[0].isIntersecting || busyRef.current) return;
      busyRef.current = true;
      try { await loadPosts(cursor); } catch { setHasMore(false); } finally { busyRef.current = false; }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, hasMore, loading, loadPosts]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  async function pickCover(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const cover_data = await fileToScaledDataUrl(file, 1600, 0.82);
      await api.put('/profiles/me/cover', { cover_data });
      setProfile((p) => ({ ...p, cover_data }));
    } catch (err) {
      setToast(err.response?.data?.error || 'Could not update the cover photo.');
    }
  }

  async function submitPost(payload) {
    if (editingPost) {
      const { data } = await api.put(`/feed/${editingPost.id}`, payload);
      setPosts((prev) => prev.map((p) => (p.id === data.post.id ? data.post : p)));
      setEditingPost(null);
    } else {
      const { data } = await api.post('/feed', payload);
      setPosts((prev) => [data.post, ...prev]);
      setPostCount((n) => n + 1);
    }
  }

  if (loading) {
    return (
      <div className="fbfeed">
        <div className="fb-profile-head"><div className="fb-profile-inner"><div className="fb-skel" style={{ height: 260, borderRadius: 8 }} /></div></div>
        <div className="fb-profile-body"><div className="fb-card" style={{ height: 200 }} /><div className="fb-card" style={{ height: 300 }} /></div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="fbfeed">
        <div className="fb-profile-body" style={{ gridTemplateColumns: '1fr' }}>
          <div className="fb-card fb-empty">
            <div className="big">🙁</div>
            <div style={{ fontWeight: 600, color: 'var(--fb-text)' }}>{error || 'Profile unavailable'}</div>
            <button type="button" className="fb-btn-secondary" style={{ marginTop: 12 }} onClick={() => navigate('/dashboard')}>
              Back to feed
            </button>
          </div>
        </div>
      </div>
    );
  }

  const a = profile.about;
  const tagline = [a.position_title, a.group_name].filter(Boolean).join(' · ');
  const hasAbout = a.position_title || a.group_name || a.branch_name || a.email || a.phone || a.date_hired;

  return (
    <div className="fbfeed">
      <div className="fb-profile-head">
        <div className="fb-profile-inner">
          <div className="fb-cover">
            {profile.cover_data && <img src={profile.cover_data} alt="" />}
            {profile.is_self && (
              <>
                <button type="button" className="fb-cover-btn" onClick={() => coverRef.current?.click()}>
                  📷 {profile.cover_data ? 'Edit cover photo' : 'Add cover photo'}
                </button>
                <input
                  ref={coverRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={pickCover}
                  style={{ display: 'none' }}
                />
              </>
            )}
          </div>

          <div className="fb-profile-id">
            <div className="fb-profile-avatar" style={{ width: 168, height: 168 }}>
              {/* Only your own avatar is editable, matching the topbar/dashboard behaviour. */}
              <Avatar user={profile} size={160} editable={profile.is_self} />
              {profile.is_online && <span className="fb-profile-online" title="Online now" />}
            </div>
            <div className="fb-profile-nameblock">
              <div className="fb-profile-name">{profile.display_name}</div>
              {tagline && <div className="fb-profile-tagline">{tagline}</div>}
              {profile.bio && !editingBio && <div className="fb-profile-bio">{profile.bio}</div>}
              {!profile.is_active && (
                <div className="fb-profile-tagline" style={{ color: 'var(--fb-red)' }}>Deactivated account</div>
              )}
            </div>
            <div className="fb-profile-actions">
              {profile.is_self ? (
                <button type="button" className="fb-btn-secondary" onClick={() => setEditingBio((v) => !v)}>
                  ✏️ Edit bio
                </button>
              ) : (
                <button type="button" className="fb-btn-secondary" onClick={() => navigate('/dashboard')}>
                  ← Back to feed
                </button>
              )}
            </div>
          </div>

          <div className="fb-profile-tabs">
            <button type="button" className="fb-profile-tab active">Posts</button>
          </div>
        </div>
      </div>

      <div className="fb-profile-body">
        <aside>
          <div className="fb-card fb-about-card">
            <div className="fb-about-title">Intro</div>
            {editingBio ? (
              <BioEditor
                initial={profile.bio}
                onCancel={() => setEditingBio(false)}
                onSaved={(bio) => { setProfile((p) => ({ ...p, bio })); setEditingBio(false); refresh?.(); }}
              />
            ) : profile.bio ? (
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{profile.bio}</div>
            ) : (
              <div className="fb-about-empty">
                {profile.is_self ? 'Add a short bio so colleagues know what you do.' : 'No bio yet.'}
              </div>
            )}
          </div>

          <div className="fb-card fb-about-card">
            <div className="fb-about-title">About</div>
            {hasAbout ? (
              <>
                {a.position_title && <AboutRow icon="💼">Works as <strong>{a.position_title}</strong></AboutRow>}
                {a.group_name && <AboutRow icon="🏷️">{a.group_name} department</AboutRow>}
                {a.account_type && <AboutRow icon="🔑">{a.account_type}</AboutRow>}
                {a.branch_name && <AboutRow icon="📍">{a.branch_name}</AboutRow>}
                {a.email && <AboutRow icon="✉️">{a.email}</AboutRow>}
                {a.phone && <AboutRow icon="📞">{a.phone}</AboutRow>}
                {a.employee_code && <AboutRow icon="🆔">Employee {a.employee_code}</AboutRow>}
                {a.date_hired && <AboutRow icon="🎂">Joined the company on {plainDate(a.date_hired)}</AboutRow>}
                {a.member_since && <AboutRow icon="🕐">Using GSUITE since {longDate(a.member_since)}</AboutRow>}
              </>
            ) : (
              <div className="fb-about-empty">No profile details on file.</div>
            )}
          </div>
        </aside>

        <main>
          {toast && <div className="fb-error" style={{ background: 'var(--fb-blue)' }}>{toast}</div>}

          {profile.is_self && (
            <div className="fb-card fb-composer">
              <div className="fb-composer-top">
                <Avatar user={user} size={40} />
                <button
                  type="button"
                  className="fb-composer-trigger"
                  onClick={() => { setEditingPost(null); setComposerOpen(true); }}
                >
                  What&apos;s on your mind, {(user?.display_name || '').split(' ')[0]}?
                </button>
              </div>
            </div>
          )}

          {posts.length === 0 ? (
            <div className="fb-card fb-empty">
              <div className="big">📭</div>
              <div style={{ fontWeight: 600, color: 'var(--fb-text)' }}>No posts to show</div>
              <div>
                {profile.is_self
                  ? "You haven't posted anything yet."
                  : `${profile.display_name.split(' ')[0]} hasn't shared anything you can see.`}
              </div>
            </div>
          ) : (
            <>
              <div style={{ color: 'var(--fb-text-2)', fontWeight: 600, margin: '0 0 8px 4px' }}>
                {postCount} post{postCount === 1 ? '' : 's'}
              </div>
              {posts.map((p) => (
                <div key={p.id} id={`post-${p.id}`}>
                  <PostCard
                    post={p}
                    user={user}
                    viewer={{ group_name: p.author.group_name }}
                    onChanged={setToast}
                    onDeleted={(pid) => { setPosts((prev) => prev.filter((x) => x.id !== pid)); setPostCount((n) => Math.max(0, n - 1)); }}
                    onEdit={(post) => { setEditingPost(post); setComposerOpen(true); }}
                  />
                </div>
              ))}
            </>
          )}

          <div ref={sentinelRef} style={{ height: 1 }} />
        </main>
      </div>

      <PostComposer
        open={composerOpen}
        editing={editingPost}
        user={user}
        groupName={a.group_name}
        onClose={() => { setComposerOpen(false); setEditingPost(null); }}
        onSubmit={submitPost}
      />
    </div>
  );
}
