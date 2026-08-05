// The completion popup, for any box that takes G-code.
//
// The thinking is in docs/complete.ts; this is the part you look at. It binds
// to an <input> or a <textarea> and needs nothing from the panel around it, so
// the console, the file editor and whatever grows a G-code box next all get the
// same behaviour for one call.
//
// Two decisions worth stating, because both are about not getting in the way:
//
// Nothing is preselected. The popup opens with no item highlighted, so Enter in
// the console still sends the line — it only accepts a suggestion once you have
// deliberately arrowed onto one. Tab accepts the first. An autocomplete that
// eats the Enter you meant for the machine is an autocomplete that gets turned
// off.
//
// Keys are taken in the capture phase at the document, not on the element. Lit
// binds the panel's own @keydown to the element itself, and at the target
// listeners run in registration order regardless of the capture flag — so the
// console's history handler would see ArrowUp before we could stop it. One
// listener above the target, stopping propagation, is what actually wins.

import { suggest, applySuggestion, type Suggestion } from '../docs/complete.js';
import { loadIndex, peekIndex } from '../docs/load.js';

type Box = HTMLInputElement | HTMLTextAreaElement;

interface Open {
  box: Box;
  items: Suggestion[];
  range: { from: number; to: number };
  /** -1 until the operator arrows onto something. See the note above. */
  active: number;
}

const enabled = new WeakSet<Box>();
let popup: HTMLDivElement | null = null;
let open: Open | null = null;
let listening = false;

/** Turn on G-code completion for a box. Idempotent — call it from updated(). */
export function enableGcodeComplete(box: Box): void {
  if (enabled.has(box)) return;
  enabled.add(box);

  // Warm the index so the first keystroke has something to say. Failure is
  // silence: a machine without the reference file simply does not complete.
  void loadIndex().catch(() => {});

  box.addEventListener('input', () => refresh(box));
  box.addEventListener('click', () => refresh(box));
  box.addEventListener('blur', () => close());
  box.addEventListener('scroll', () => close());

  if (!listening) {
    listening = true;
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', () => close());
    // Capture: a panel scrolling under the popup moves the box, and a popup
    // left behind pointing at nothing is worse than one that shuts.
    window.addEventListener('scroll', () => close(), true);
  }
}

function refresh(box: Box): void {
  const index = peekIndex();
  if (!index || box.disabled || box.readOnly) return close();

  const caret = box.selectionStart;
  if (caret === null || caret !== box.selectionEnd) return close();

  // Only the line the caret is on: a textarea holds a whole file, and the
  // engine reasons about one line at a time.
  const start = box.value.lastIndexOf('\n', caret - 1) + 1;
  const lineEnd = box.value.indexOf('\n', caret);
  const line = box.value.slice(start, lineEnd === -1 ? undefined : lineEnd);

  const found = suggest(index.codes, line, caret - start);
  if (!found.items.length) return close();

  open = {
    box,
    items: found.items,
    range: { from: found.from + start, to: found.to + start },
    active: -1,
  };
  draw();
}

function close(): void {
  open = null;
  if (popup) popup.style.display = 'none';
}

function onKeyDown(e: KeyboardEvent): void {
  if (!open || e.target !== open.box) return;

  const stop = () => {
    e.preventDefault();
    // Stops the event reaching the box's own listeners — the console's history
    // keys and the panel's Enter-to-send.
    e.stopPropagation();
  };

  switch (e.key) {
    case 'Escape':
      stop();
      close();
      return;
    case 'ArrowDown':
      stop();
      open.active = (open.active + 1) % open.items.length;
      draw();
      return;
    case 'ArrowUp':
      stop();
      open.active = open.active <= 0 ? open.items.length - 1 : open.active - 1;
      draw();
      return;
    case 'Tab':
      stop();
      accept(open.active < 0 ? 0 : open.active);
      return;
    case 'Enter':
      // Only when something is deliberately selected; otherwise this Enter
      // belongs to the console.
      if (open.active < 0) return close();
      stop();
      accept(open.active);
      return;
    default:
      return;
  }
}

function accept(which: number): void {
  if (!open) return;
  const { box, range, items } = open;
  const item = items[which];
  if (!item) return close();

  const applied = applySuggestion(box.value, range, item);
  box.value = applied.line;
  box.setSelectionRange(applied.cursor, applied.cursor);

  // The panels hold the text themselves and re-render from it, so a value set
  // behind their back has to be announced or the next render puts it back.
  box.dispatchEvent(new Event('input', { bubbles: true }));

  close();
  // A command accepted is a question about its parameters, so offer them
  // straight away rather than making the operator type a space to ask.
  if (item.kind === 'code') refresh(box);
}

function ensurePopup(): HTMLDivElement {
  if (popup) return popup;
  popup = document.createElement('div');
  popup.className = 'gc-complete';
  // Keeps the box focused when an item is clicked: without this the mousedown
  // blurs the box, which closes the popup before the click ever lands.
  popup.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(popup);
  return popup;
}

function draw(): void {
  if (!open) return;
  const el = ensurePopup();
  el.replaceChildren();

  open.items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = i === open!.active ? 'gc-c-item active' : 'gc-c-item';
    const label = document.createElement('span');
    label.className = 'gc-c-label';
    label.textContent = item.label;
    const detail = document.createElement('span');
    detail.className = 'gc-c-detail';
    detail.textContent = item.detail;
    row.append(label, detail);
    row.addEventListener('click', () => accept(i));
    el.appendChild(row);
  });

  el.style.display = 'block';
  place(el, open.box, open.range.from);
}

/**
 * Put the popup at the caret.
 *
 * Fixed position on the body, so it is not clipped by whichever panel the box
 * happens to live in — panels scroll and overflow-hidden, and a suggestion list
 * cut off at the panel edge is useless.
 */
function place(el: HTMLDivElement, box: Box, index: number): void {
  const at = caretPoint(box, index);
  const rect = box.getBoundingClientRect();
  const size = el.getBoundingClientRect();
  const margin = 8;
  const gap = 2;

  let left = at.left;
  if (left + size.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - margin - size.width);
  }

  // Clear of the caret's line, but of the whole box when the box has only one
  // line: a popup that stops at the text baseline still lies over the input's
  // padding and border, which just looks like it missed.
  const single = box instanceof HTMLInputElement;
  const lineTop = single ? rect.top : at.top;
  const lineBottom = single ? rect.bottom : at.bottom;

  // Below by preference, above when the bottom of the window is in the way —
  // the normal case for the console, whose input sits at the foot of the panel.
  const below = lineBottom + gap;
  const above = lineTop - size.height - gap;
  const top = below + size.height > window.innerHeight - margin && above > margin ? above : below;

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/**
 * Where a character index sits on screen.
 *
 * There is no API for this, so it is the usual mirror: a div styled exactly
 * like the box, holding the text up to the caret and a marker span, measured
 * and thrown away. Copying the metrics is the whole job — miss the padding or
 * the letter spacing and the popup lands a few characters off, which reads as a
 * bug even though the list is right.
 */
function caretPoint(box: Box, index: number): { left: number; top: number; bottom: number } {
  const rect = box.getBoundingClientRect();
  const style = getComputedStyle(box);

  const mirror = document.createElement('div');
  const copy = [
    'boxSizing',
    'width',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'wordSpacing',
    'textTransform',
    'textIndent',
    'lineHeight',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
  ] as const;
  for (const prop of copy) mirror.style[prop] = style[prop];

  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  // An input never wraps however long the text is; a textarea wraps the way it
  // is told to.
  mirror.style.whiteSpace = box instanceof HTMLInputElement ? 'pre' : 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.height = 'auto';

  mirror.textContent = box.value.slice(0, index);
  const marker = document.createElement('span');
  // Zero-width, so it takes a position without taking any room.
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const left = rect.left + marker.offsetLeft - box.scrollLeft;
  const top = rect.top + marker.offsetTop - box.scrollTop;
  const lineHeight = marker.offsetHeight || parseFloat(style.lineHeight) || 16;
  mirror.remove();

  // Clamped to the box: with a long line scrolled sideways the caret can
  // compute to somewhere off the element, and the popup should stay put.
  return {
    left: Math.min(Math.max(left, rect.left), rect.right),
    top: Math.min(Math.max(top, rect.top), rect.bottom),
    bottom: Math.min(Math.max(top + lineHeight, rect.top), rect.bottom + lineHeight),
  };
}
