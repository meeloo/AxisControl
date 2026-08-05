// The G-code reference, as the app consumes it.
//
// Built at build time by tools/build-gcode-index.mjs and shipped in the bundle
// as `gcodes.json`, which means it installs onto the machine with everything
// else and works with no network at all. That is not a convenience: a workshop
// machine is often not on the internet, and a reference that needs a round trip
// to answer "what does M574 P mean" is a reference that is missing exactly when
// the spindle is running.
//
// It cannot be fetched at runtime in any case. docs.duet3d.com is wiki.js
// behind a CDN and sends no Access-Control-Allow-Origin, so a page served from
// the Duet cannot read it — the same wall the camera ran into, with the same
// refusal to stand up a proxy to get around it.

/** One documented parameter of one code. */
export interface GcodeParam {
  /** The letter, as written in the docs — "Tnn", "P\"expression\"", "R". */
  letter: string;
  /** What it does. */
  text: string;
  required: boolean;
}

export interface GcodeEntry {
  /** Canonical form, including any fraction: "M581.1". */
  code: string;
  letter: string;
  number: number;
  /** Sub-code after the dot, or null. M581 and M581.1 are separate entries. */
  fraction: number | null;
  /** The heading, without the code itself: "Configure external trigger on expression". */
  title: string;
  /** "Supported in RRF 3.7 and later", when the page says so. */
  support: string | null;
  params: GcodeParam[];
  /** Example lines, comments included — they are half of what makes them useful. */
  examples: string[];
  /** Prose after the parameters: the notes list, flattened to paragraphs. */
  notes: string[];
  /** Deep link back to the section on docs.duet3d.com. */
  url: string | null;
}

export interface GcodeIndex {
  builtAt: string;
  /** Where it was read from, for the "this may be out of date" line. */
  source: string;
  codes: GcodeEntry[];
}

/**
 * Split a search term into the code it might be naming.
 *
 * Typing is the whole interaction, so this takes what an operator would
 * actually type rather than a canonical form: `m581`, `M 581`, `581.1` and
 * `m581.1` all mean the same thing, and none of them is what the index calls
 * it.
 */
export function parseCodeQuery(query: string): { letter: string | null; number: number; fraction: number | null } | null {
  const match = /^\s*([gmtGMT])?\s*(\d+)(?:\.(\d+))?\s*$/.exec(query);
  if (!match) return null;
  return {
    letter: match[1] ? match[1].toUpperCase() : null,
    number: Number(match[2]),
    fraction: match[3] !== undefined ? Number(match[3]) : null,
  };
}

/**
 * Rank entries against a query.
 *
 * An exact code match always wins, because someone typing "M574" wants M574
 * and not the twelve codes whose description mentions endstops. Everything
 * else is a substring match over the title and the parameter text, which is
 * what makes the other direction work — typing "endstop" to find out that
 * M574 is the code you wanted.
 */
export function searchCodes(codes: GcodeEntry[], query: string, limit = 60): GcodeEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return codes.slice(0, limit);

  const asCode = parseCodeQuery(trimmed);
  const needle = trimmed.toLowerCase();

  const scored: Array<{ entry: GcodeEntry; score: number }> = [];
  for (const entry of codes) {
    let score = 0;

    if (asCode && entry.number === asCode.number && (!asCode.letter || entry.letter === asCode.letter)) {
      // "M581" should list M581 first and M581.1 just under it, not bury the
      // plain one among its own sub-codes.
      score = asCode.fraction === entry.fraction ? 1000 : 900 - (entry.fraction ?? 0);
    } else if (entry.code.toLowerCase() === needle) {
      score = 1000;
    } else if (entry.code.toLowerCase().startsWith(needle)) {
      score = 500;
    } else if (entry.title.toLowerCase().includes(needle)) {
      // Earlier in the title means more likely to be what it is about.
      score = 300 - Math.min(entry.title.toLowerCase().indexOf(needle), 200);
    } else if (entry.params.some((p) => p.text.toLowerCase().includes(needle))) {
      score = 60;
    } else if (entry.notes.some((n) => n.toLowerCase().includes(needle))) {
      score = 40;
    } else if (entry.examples.some((e) => e.toLowerCase().includes(needle))) {
      score = 30;
    }

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.letter.localeCompare(b.entry.letter) ||
      a.entry.number - b.entry.number ||
      (a.entry.fraction ?? -1) - (b.entry.fraction ?? -1),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}
