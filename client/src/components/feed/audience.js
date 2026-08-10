// Audience options for a post. `key` matches the ENUM in feed_posts (see
// server/src/db/add-newsfeed.js); the server is what actually enforces visibility.
// Kept out of PostComposer.jsx so that file only exports its component and Vite's
// fast refresh keeps working.
export const AUDIENCES = [
  { key: 'public', icon: '🌐', label: 'Public', sub: 'Anyone in the company' },
  { key: 'department', icon: '👥', label: 'My department', sub: 'Only my department' },
  { key: 'private', icon: '🔒', label: 'Only me', sub: 'Visible to you alone' },
];

// Swaps the generic "My department" label for the real department name when we know it.
export function audienceMeta(key, groupName) {
  const a = AUDIENCES.find((x) => x.key === key) || AUDIENCES[0];
  if (key === 'department') {
    return { ...a, label: groupName ? groupName.replace(/^\w/, (c) => c.toUpperCase()) : a.label };
  }
  return a;
}
