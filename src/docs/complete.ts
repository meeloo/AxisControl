// Completing a line of G-code from the reference.
//
// Pure: a line, a cursor, and the index in, suggestions out. No DOM, because
// the same logic has to serve a one-line console input, a file editor, and
// whatever else grows a G-code box later — and because this is the part worth
// testing, while the popup is the part worth looking at.
//
// Two questions, decided by where the cursor is:
//
//   "M57"      → which commands start like that
//   "M574 P"   → which parameters M574 takes
//
// The second is the one that saves real time. Remembering that M574 exists is
// easy; remembering whether the pin goes in P or S is not, and that is exactly
// what sends someone to a browser mid-job.

import type { GcodeEntry } from './types.js';

export interface Suggestion {
  /** What gets inserted. */
  insert: string;
  /** What is shown, when it differs — "M574" for a code, "P" for a parameter. */
  label: string;
  /** The one-line description beside it. */
  detail: string;
  kind: 'code' | 'param';
}

/** The word being typed, and where it starts. */
function tokenAt(line: string, cursor: number): { text: string; start: number } {
  const upto = line.slice(0, cursor);
  const match = /[^\s]*$/.exec(upto);
  const text = match ? match[0] : '';
  return { text, start: cursor - text.length };
}

/**
 * The command this line is about, if it has named one before the cursor.
 *
 * Only what precedes the cursor counts. Completing a parameter halfway along a
 * line should offer the parameters of the command at the start of it, not of
 * something typed later — and a line being edited in the middle is the normal
 * case in a file editor.
 */
export function commandOnLine(line: string, cursor: number): string | null {
  const before = line.slice(0, cursor);
  // Strip a comment: everything after ; is prose, and RRF also takes ( ).
  const code = before.replace(/;.*$/, '');
  const match = /(?:^|\s)([GgMmTt])\s*(\d+(?:\.\d+)?)?/.exec(code);
  if (!match) return null;
  const letter = match[1].toUpperCase();
  if (letter === 'T') return 'T';
  return match[2] ? `${letter}${Number(match[2])}${/\.\d/.test(match[2]) ? `.${match[2].split('.')[1]}` : ''}` : null;
}

/** Normalise a documented parameter name to the letter actually typed. */
export function paramLetter(documented: string): string {
  // The docs write "Xnnn", "P\"pin_name\"", "Tnn" — the letter is the head, and
  // everything after it is a description of the value, not part of what you
  // type.
  const match = /^([A-Za-z])/.exec(documented);
  return match ? match[1].toUpperCase() : documented.toUpperCase();
}

export function suggest(
  codes: GcodeEntry[],
  line: string,
  cursor: number,
  limit = 12,
): { items: Suggestion[]; from: number; to: number } {
  const token = tokenAt(line, cursor);
  const empty = { items: [] as Suggestion[], from: cursor, to: cursor };

  // Inside a comment there is nothing to complete.
  if (/;/.test(line.slice(0, cursor))) return empty;

  const command = commandOnLine(line, token.start);
  const entry = command ? codes.find((c) => c.code === command) : null;

  // A parameter, when the command is known and the token is not itself a
  // command. "M574 X" completes X; "M574 M" would too, which is right — M is
  // a parameter letter on plenty of commands.
  if (entry && token.text && !/^[GgMmTt]\d/.test(token.text)) {
    const head = token.text.slice(0, 1).toUpperCase();
    const items = entry.params
      .filter((p) => paramLetter(p.letter).startsWith(head))
      .slice(0, limit)
      .map((p) => ({
        insert: paramLetter(p.letter),
        label: p.letter,
        detail: p.text,
        kind: 'param' as const,
      }));
    if (items.length) return { items, from: token.start, to: cursor };
  }

  // Otherwise a command, when what is being typed looks like the start of one.
  if (/^[GgMmTt]\d*(\.\d*)?$/.test(token.text)) {
    const needle = token.text.toUpperCase();
    const items = codes
      .filter((c) => c.code.startsWith(needle))
      .slice(0, limit)
      .map((c) => ({ insert: c.code, label: c.code, detail: c.title, kind: 'code' as const }));
    if (items.length) return { items, from: token.start, to: cursor };
  }

  // An empty command position offers the parameters of the command already on
  // the line — "M574 " with a trailing space is a question about M574.
  if (entry && !token.text) {
    const items = entry.params.slice(0, limit).map((p) => ({
      insert: paramLetter(p.letter),
      label: p.letter,
      detail: p.text,
      kind: 'param' as const,
    }));
    if (items.length) return { items, from: cursor, to: cursor };
  }

  return empty;
}

/** Apply a suggestion to a line, returning the new line and cursor. */
export function applySuggestion(
  line: string,
  range: { from: number; to: number },
  item: Suggestion,
): { line: string; cursor: number } {
  const next = `${line.slice(0, range.from)}${item.insert}${line.slice(range.to)}`;
  return { line: next, cursor: range.from + item.insert.length };
}
