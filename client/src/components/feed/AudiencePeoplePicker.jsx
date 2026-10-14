import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import Avatar from '../Avatar';

// "Specific people" for a post (2026-10-14; server GET /feed/audience-options). Pick people one by
// one, or add a whole group chat's members at once. value / onChange: an array of user ids.
let optionsCache = null;

export default function AudiencePeoplePicker({ value, onChange }) {
  const [opts, setOpts] = useState(optionsCache);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (optionsCache) return;
    api.get('/feed/audience-options')
      .then(({ data }) => { optionsCache = data; setOpts(data); })
      .catch(() => setOpts({ users: [], groups: [] }));
  }, []);

  const chosen = useMemo(() => new Set(value.map(Number)), [value]);
  const byId = useMemo(() => new Map((opts?.users || []).map((u) => [Number(u.id), u])), [opts]);
  const terms = q.trim().toLowerCase();
  const matches = !terms ? [] : (opts?.users || [])
    .filter((u) => !chosen.has(Number(u.id)) && String(u.display_name || '').toLowerCase().includes(terms))
    .slice(0, 8);

  const add = (ids) => onChange([...new Set([...value.map(Number), ...ids.map(Number)])].filter((id) => byId.has(id)));
  const remove = (id) => onChange(value.filter((x) => Number(x) !== Number(id)));

  if (!opts) return <div className="fb-people-picker muted">Loading people…</div>;
  return (
    <div className="fb-people-picker">
      <div className="fb-people-head">
        <strong>Who can see this post</strong>
        <span className="muted">{value.length} {value.length === 1 ? 'person' : 'people'} + you</span>
      </div>
      {value.length > 0 && (
        <div className="fb-people-chips">
          {value.map((id) => {
            const u = byId.get(Number(id));
            return u ? (
              <span key={id} className="fb-people-chip">
                {u.display_name}
                <button type="button" onClick={() => remove(id)} aria-label={`Remove ${u.display_name}`}>✕</button>
              </span>
            ) : null;
          })}
          <button type="button" className="fb-people-clear" onClick={() => onChange([])}>Clear all</button>
        </div>
      )}
      <input className="fb-people-search" placeholder="Add people — type a name" value={q} onChange={(e) => setQ(e.target.value)} />
      {matches.length > 0 && (
        <div className="fb-people-results">
          {matches.map((u) => (
            <button key={u.id} type="button" className="fb-people-result" onClick={() => { add([u.id]); setQ(''); }}>
              <Avatar user={u} size={24} /> {u.display_name}
            </button>
          ))}
        </div>
      )}
      {opts.groups.length > 0 && (
        <div className="fb-people-groups">
          <span className="muted">Add a group:</span>
          {opts.groups.map((g) => (
            <button key={g.id} type="button" className="fb-people-group" title={`Add the ${g.member_ids.length} members of ${g.name}`}
              onClick={() => add(g.member_ids)}>
              👥 {g.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
