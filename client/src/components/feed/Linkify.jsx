// Turns bare URLs typed into a post or comment into real links.
//
// Deliberately NOT dangerouslySetInnerHTML: the text is whatever a colleague typed, so it is
// split into plain strings and <a> elements and React escapes every non-URL part itself. Only
// http/https can ever match, so a "javascript:" or "data:" scheme stays inert text rather than
// becoming a clickable link.
//
// The ellipsis is excluded from the URL characters because PostCard folds long bodies by
// slicing the string and appending one -- without that, a link cut by the fold would carry the
// ellipsis into its href.
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>()…]+)/gi;
// Trailing punctuation belongs to the sentence, not the address: "visit https://x.ph/." and
// "(see https://x.ph)" must not carry the . or ) into the link. Parentheses are excluded from
// the pattern above for the same reason, which does mean a URL genuinely containing them is
// linked only up to the first bracket -- rare enough to be the better trade.
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

export default function Linkify({ text }) {
  // String.split with a capturing group interleaves the matches, so every odd index is a URL.
  const parts = String(text ?? '').split(URL_RE);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part;
        const trailing = part.match(TRAILING_PUNCTUATION)?.[0] || '';
        const url = trailing ? part.slice(0, -trailing.length) : part;
        // A bare "www.x.ph" without a scheme would otherwise resolve as a relative path.
        const href = /^www\./i.test(url) ? `https://${url}` : url;
        return (
          <span key={index}>
            <a className="fb-link" href={href} target="_blank" rel="noopener noreferrer">{url}</a>
            {trailing}
          </span>
        );
      })}
    </>
  );
}
