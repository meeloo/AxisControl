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

import type { GcodeEntry, GcodeParam } from './types.js';

export interface Suggestion {
  /** What gets inserted. */
  insert: string;
  /**
   * Where the caret lands within `insert`, when the end is the wrong place.
   *
   * `P"pin_name"` is inserted as `P""` with the caret between the quotes: the
   * quotes are part of the syntax, not part of the value, and leaving them to
   * be typed is leaving the commonest RRF typo to be made by hand.
   */
  caret?: number;
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
  // The negative lookahead matters for T, whose number is optional: without it
  // the t of "there" is a tool change and every prose line has a command on it.
  const match = /(?:^|\s)([GgMmTt])\s*(\d+(?:\.\d+)?)?(?![A-Za-z])/.exec(code);
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

/** Anything that can start a parameter's value, which is what makes a letter a parameter. */
const VALUE_AHEAD = /[-+.\d"{[]/;

/**
 * Walk a line's parameters: the letter, and where it sits.
 *
 * Strings and braced expressions are stepped over whole. `M98 P"homez.g"` has
 * one parameter, not one parameter and an `h`, and `S{move.axes[2].max}` has
 * one, not one plus whatever letters the expression happens to contain.
 */
function scanParams(line: string, stop = line.length): Array<{ letter: string; at: number }> {
  const out: Array<{ letter: string; at: number }> = [];
  let i = 0;
  let first = true;

  while (i < line.length && i < stop) {
    const ch = line[i];
    if (ch === ';') break;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '{') {
      let depth = 0;
      while (i < line.length) {
        if (line[i] === '{') depth++;
        else if (line[i] === '}' && --depth === 0) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // The command itself is not a parameter of itself.
    const command = first ? /^[GgMmTt]\d+(?:\.\d+)?/.exec(line.slice(i)) : null;
    if (command) {
      i += command[0].length;
      first = false;
      continue;
    }
    first = false;
    if (/[A-Za-z]/.test(ch) && i + 1 < line.length && VALUE_AHEAD.test(line[i + 1])) {
      out.push({ letter: ch.toUpperCase(), at: i });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Parameters already given a value on this line.
 *
 * A letter with nothing after it is not counted, because that is the one being
 * typed — offering X while you are in the middle of typing X would be the
 * completion refusing to complete itself.
 */
export function usedParams(line: string): Set<string> {
  return new Set(scanParams(line).map((p) => p.letter));
}

/** How a documented parameter should be inserted. */
function insertionFor(param: GcodeParam): { insert: string; caret?: number } {
  const letter = paramLetter(param.letter);
  // The docs write a quoted value into the name itself: P"pin_name", P"expression".
  if (/^[A-Za-z]"/.test(param.letter)) return { insert: `${letter}""`, caret: letter.length + 1 };
  return { insert: letter };
}

/**
 * One suggestion per letter.
 *
 * M308 documents Y nine times, once per sensor type, and each description is
 * worth having in the reference — but a completion list that offers Y nine
 * times is a list you scroll past. The first is the general one.
 */
function byLetter(params: GcodeParam[]): GcodeParam[] {
  const seen = new Set<string>();
  return params.filter((p) => {
    const letter = paramLetter(p.letter);
    if (seen.has(letter)) return false;
    seen.add(letter);
    return true;
  });
}

function asSuggestion(param: GcodeParam): Suggestion {
  return {
    ...insertionFor(param),
    label: param.letter,
    detail: param.text,
    kind: 'param' as const,
  };
}

export interface Signature {
  entry: GcodeEntry;
  /** The parameter the caret is in or just after, if the line has reached one. */
  active: GcodeParam | null;
  /** Which parameters already have a value, so the hint can show what is left. */
  used: Set<string>;
}

/**
 * What the line being typed is about.
 *
 * This is the half of the reference that autocomplete cannot give you: once the
 * popup has closed and you are typing values, nothing on screen says what
 * M574's S means or which of its parameters you have not filled in yet. Reading
 * it off a hint at the caret is the whole point.
 */
export function signature(codes: GcodeEntry[], line: string, cursor: number): Signature | null {
  if (/;/.test(line.slice(0, cursor))) return null;
  const command = commandOnLine(line, cursor);
  const entry = command ? codes.find((c) => c.code === command) : null;
  if (!entry) return null;

  // The last parameter at or before the caret — typing "S1" keeps S current
  // while the value is being typed, which is when its description is wanted.
  const seen = scanParams(line, cursor);
  const last = seen.length ? seen[seen.length - 1] : null;
  const active = last ? entry.params.find((p) => paramLetter(p.letter) === last.letter) ?? null : null;

  return { entry, active, used: new Set(seen.map((p) => p.letter)) };
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

  // A parameter, when the command is known and the token is a bare letter.
  // "M574 X" completes X; "M574 M" would too, which is right — M is a parameter
  // letter on plenty of commands.
  //
  // Bare, strictly: once a value has been typed the question has been answered,
  // and suggesting X over "X10" would offer to delete the 10. A suggestion that
  // destroys what you just typed is worse than no suggestion at all.
  if (entry && /^[A-Za-z]$/.test(token.text)) {
    const head = token.text.toUpperCase();
    const items = byLetter(entry.params)
      .filter((p) => paramLetter(p.letter) === head)
      .slice(0, limit)
      .map(asSuggestion);
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
  //
  // Minus the ones that already have a value. Offering X again on a line that
  // reads "G1 X10 " is offering to write it twice, and on a command with a
  // dozen parameters the ones left are exactly what you want to see.
  if (entry && !token.text) {
    const used = usedParams(line);
    const all = byLetter(entry.params);
    const left = all.filter((p) => !used.has(paramLetter(p.letter)));
    const items = (left.length ? left : all).slice(0, limit).map(asSuggestion);
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
  return { line: next, cursor: range.from + (item.caret ?? item.insert.length) };
}
