// Show a field's full value as a tooltip when the mouse rests on it -- for narrow grid columns
// (Process, Item, Location, ...) whose text gets cut off. Put it on a page's root element as
// onMouseOver: mouseover bubbles, so one handler covers every input, dropdown and cut-off
// label beneath it, including rows added later. The title is read at hover time, so it always
// matches what is typed now.
//
// An element that already carries its own title (one the page set, e.g. a button hint) is left
// alone; only titles this helper wrote (marked data-hover-title) are refreshed.
const SKIP_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden', 'image',
  'color', 'range', 'date', 'time', 'datetime-local', 'month', 'week', 'password',
]);

export function showFullValueOnHover(e) {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.title && !('hoverTitle' in el.dataset)) return;

  let text;
  if (el.tagName === 'SELECT') {
    text = el.selectedOptions?.[0]?.text;
  } else if (el.tagName === 'INPUT') {
    if (SKIP_INPUT_TYPES.has(el.type)) return;
    text = el.value;
  } else if (el.tagName === 'TEXTAREA') {
    text = el.value;
  } else if (el.childElementCount === 0 && el.scrollWidth > el.clientWidth) {
    // Plain text clipped by an ellipsis / overflow: hidden.
    text = el.textContent;
  } else {
    return;
  }

  el.title = (text || '').trim();
  el.dataset.hoverTitle = '';
}
