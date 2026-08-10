// The 7 reactions, in Facebook's bar order. `key` matches the ENUM in feed_posts /
// feed_comments (see server/src/db/add-newsfeed.js) -- keep the two in sync.
export const REACTIONS = [
  { key: 'like',  emoji: '👍', label: 'Like',  color: '#1877f2' },
  { key: 'love',  emoji: '❤️', label: 'Love',  color: '#f3425f' },
  { key: 'care',  emoji: '🤗', label: 'Care',  color: '#f7b125' },
  { key: 'haha',  emoji: '😆', label: 'Haha',  color: '#f7b125' },
  { key: 'wow',   emoji: '😮', label: 'Wow',   color: '#f7b125' },
  { key: 'sad',   emoji: '😢', label: 'Sad',   color: '#f7b125' },
  { key: 'angry', emoji: '😡', label: 'Angry', color: '#e9710f' },
];

export const REACTION_BY_KEY = Object.fromEntries(REACTIONS.map((r) => [r.key, r]));

// The 3 most-used reactions on a post, biggest first -- these are the stacked bubbles FB
// shows to the left of the count.
export function topReactionKeys(tallies, limit = 3) {
  return Object.entries(tallies || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

// "You and 3 others" / "Ana Cruz and 12 others" / "Ana Cruz, Ben Diaz and Cy Uy"
export function reactionSummary(total, names, myReaction) {
  if (!total) return '';
  const others = myReaction ? total - 1 : total;
  if (myReaction && others === 0) return 'You';
  if (myReaction) return others === 1 ? 'You and 1 other' : `You and ${others} others`;

  const shown = (names || []).slice(0, 2);
  if (!shown.length) return String(total);
  const rest = total - shown.length;
  if (rest <= 0) return shown.length === 1 ? shown[0] : `${shown[0]} and ${shown[1]}`;
  return `${shown[0]} and ${rest + (shown.length - 1)} others`;
}
