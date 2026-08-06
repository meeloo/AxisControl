// Things wrong with a configuration that the machine will not tell you about.
//
// RRF runs config.g top to bottom and mostly does not complain. Set the same
// maximum speed twice and the second wins, silently. Set an axis limit before
// the axis exists and the line is refused at boot, when nobody is watching the
// console. Misspell a parameter and it is ignored. Every one of these leaves a
// machine that runs, behaves differently from what the file appears to say, and
// gives no clue why.
//
// So this looks for the three kinds the file itself can reveal:
//
//   conflict — a later line silently overwrites an earlier one
//   order    — a line depends on something configured after it
//   unknown  — a parameter the documented command does not take
//
// Each finding names the file and line, because "somewhere in your config" is
// not a diagnosis. And each is conservative: this reports what it can show, not
// everything that could conceivably be wrong. A checker that cries wolf is one
// people learn to scroll past.

import { runsFile, type ConfigFile, type ConfigLine } from './parse.js';
import { resolveInclude } from './load.js';
import type { GcodeIndex } from '../docs/types.js';

export type Severity = 'conflict' | 'order' | 'unknown';

export interface Finding {
  severity: Severity;
  path: string;
  line: ConfigLine;
  /** What is wrong, in one sentence. */
  message: string;
  /** The other line involved, when there is one. */
  other?: { path: string; line: ConfigLine };
}

/**
 * Parameters that pick WHICH thing a command configures.
 *
 * Without these every `M563 P1` and `M563 P2` would look like the same command
 * setting the same thing twice. With them, two lines only conflict when they
 * address the same tool, driver, probe or pin.
 */
const SELECTOR: Record<string, string[]> = {
  G10: ['P', 'L'],
  M558: ['K'],
  M563: ['P'],
  M569: ['P'],
  M574: ['X', 'Y', 'Z', 'U', 'V', 'W', 'A', 'B', 'C'],
  M581: ['T'],
  M586: ['P'],
  M591: ['D'],
  M950: ['P', 'F', 'H', 'J', 'S', 'R'],
  M208: ['S'],
  // P names the file, so two M98s are two different calls, not a conflict.
  M98: ['P'],
};

/**
 * "A must come before B", where getting it the other way round is known to
 * break rather than merely to look odd.
 *
 * Deliberately short. M584 creates axes, so everything that configures an axis
 * has to follow it — that one is documented and unambiguous. Anything less
 * certain than that is left out: a false rule here sends somebody rearranging a
 * working config.
 */
const BEFORE: Array<{ first: string; then: string[]; why: string }> = [
  {
    first: 'M584',
    then: ['M92', 'M201', 'M203', 'M208', 'M350', 'M566', 'M906', 'M574'],
    why: 'M584 creates the axes; a command that configures one before it exists is refused at boot',
  },
  {
    first: 'M950',
    then: ['M563'],
    why: 'a tool can only be given a spindle that M950 has already created',
  },
];

/** Axis letters are valid on many commands whose documentation lists only X. */
const AXIS_LETTERS = new Set(['X', 'Y', 'Z', 'U', 'V', 'W', 'A', 'B', 'C', 'D']);

/**
 * Commands whose axis-letter parameters name an axis that has to exist.
 *
 * Which lets the live machine answer a question the file cannot: "M201 W3" on a
 * machine with X, Y, Z and U is configuring an axis nobody built, and RRF
 * discards it without a word. Only checked when connected — with no axis list
 * there is nothing to check against, and guessing would flag every axis on a
 * machine that happens to be offline.
 */
const PER_AXIS = new Set(['M92', 'M201', 'M203', 'M208', 'M350', 'M566', 'M906', 'M574', 'M584']);

/** Parameter letters the reference documents for a command. */
function documented(index: GcodeIndex | null, command: string): Set<string> | null {
  const entry = index?.codes.find((c) => c.code === command);
  if (!entry || !entry.params.length) return null;
  const out = new Set<string>();
  for (const p of entry.params) {
    // The reference writes a parameter's letter with its value shape attached,
    // and not consistently: "Xnnn", "Snn", "Dn", 'P"nnn"'. The first character
    // is the only reliable part of it.
    const first = p.letter.trim()[0];
    if (first && /[A-Z]/.test(first)) out.add(first);
    // Some entries list several letters in one line — M584's "Unnn Vnnn, Wnnn,
    // Annn, ..." and M950's "or Snn" — so the alternatives are read out of the
    // start of the description too.
    for (const m of `${p.letter} ${p.text.slice(0, 60)}`.matchAll(/\b([A-Z])(?:n{1,3}\b|"nnn")/g)) {
      out.add(m[1]!);
    }
  }
  return out.size ? out : null;
}

function key(line: ConfigLine): string {
  const sel = SELECTOR[line.command ?? ''] ?? [];
  const parts = sel
    .map((letter) => {
      const p = line.params.find((x) => x.letter === letter);
      return p ? `${letter}${p.text}` : '';
    })
    .filter(Boolean);
  return `${line.command}|${parts.join(',')}`;
}

/**
 * Every live command line, in the order the machine actually runs them.
 *
 * Not file after file. RRF stops at an M98, runs the whole of the named file,
 * and carries on with the next line — so config.g's own tail runs AFTER every
 * fragment it called, and this has to step into each include where the call is.
 *
 * Concatenating the loaded files instead put all of config.g first, which got
 * both of the cross-file questions backwards: a setting made in config.g after
 * the includes was reported as being overwritten by a fragment when it is the
 * one that wins, and a command in that tail was reported as running before the
 * M584 that it in fact runs after.
 *
 * A file called twice is walked once, matching what loadConfig reads. Running
 * it twice is legal and rare, and the second run cannot change what the text
 * says about itself.
 */
function executionOrder(files: ConfigFile[]): Array<{ path: string; line: ConfigLine }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: Array<{ path: string; line: ConfigLine }> = [];
  const walked = new Set<string>();

  const walk = (file: ConfigFile): void => {
    if (walked.has(file.path)) return;
    walked.add(file.path);
    for (const line of file.lines) {
      if (line.kind !== 'command' || !line.command) continue;
      out.push({ path: file.path, line });
      const runs = runsFile(line);
      const target = runs ? byPath.get(resolveInclude(runs)) : undefined;
      if (target) walk(target);
    }
  };

  // loadConfig puts the entry first, and everything else is reached from it.
  if (files[0]) walk(files[0]);
  // Anything not reachable from the entry is still checked rather than quietly
  // left out — a file loaded but never called is a question in itself, and
  // dropping its lines would make the checker's silence mean two things.
  for (const file of files) walk(file);
  return out;
}

export function checkConfig(
  files: ConfigFile[],
  index: GcodeIndex | null,
  /** Axis letters the machine actually has, empty when not connected. */
  axes: readonly string[] = [],
): Finding[] {
  const findings: Finding[] = [];
  const run = executionOrder(files);

  // --- Silent overwrites ----------------------------------------------------
  const seen = new Map<string, { path: string; line: ConfigLine }>();
  for (const here of run) {
    // A conditional line may not run at all, so it cannot be said to overwrite
    // anything with certainty.
    if (here.line.depth > 0) continue;
    const k = key(here.line);
    const sel = new Set(SELECTOR[here.line.command ?? ''] ?? []);
    const before = seen.get(k);
    if (before) {
      const shared = here.line.params
        .map((p) => p.letter)
        .filter((l) => !sel.has(l) && before.line.params.some((p) => p.letter === l));
      if (shared.length) {
        findings.push({
          severity: 'conflict',
          path: here.path,
          line: here.line,
          other: before,
          message:
            `${here.line.command} sets ${shared.join('/')} again — this line wins and the ` +
            `earlier one in ${before.path.split('/').pop()} line ${before.line.index + 1} does nothing`,
        });
      }
    }
    seen.set(k, here);
  }

  // --- Order ---------------------------------------------------------------
  for (const rule of BEFORE) {
    const firstAt = run.findIndex((r) => r.line.command === rule.first);
    if (firstAt < 0) continue;
    for (let i = 0; i < firstAt; i++) {
      const here = run[i]!;
      if (!rule.then.includes(here.line.command ?? '')) continue;
      findings.push({
        severity: 'order',
        path: here.path,
        line: here.line,
        other: run[firstAt],
        message: `${here.line.command} runs before ${rule.first} — ${rule.why}`,
      });
    }
  }

  // --- An axis that does not exist -----------------------------------------
  const present = new Set(axes.map((a) => a.toUpperCase()));
  if (present.size) {
    for (const here of run) {
      if (!PER_AXIS.has(here.line.command ?? '')) continue;
      for (const p of here.line.params) {
        if (!AXIS_LETTERS.has(p.letter) || present.has(p.letter)) continue;
        findings.push({
          severity: 'unknown',
          path: here.path,
          line: here.line,
          message:
            `${here.line.command} configures a ${p.letter} axis, and this machine has ` +
            `${[...present].join(', ')} — RRF discards the setting`,
        });
      }
    }
  }

  // --- Parameters the command does not take --------------------------------
  for (const here of run) {
    const known = documented(index, here.line.command ?? '');
    if (!known) continue;
    for (const p of here.line.params) {
      if (known.has(p.letter) || AXIS_LETTERS.has(p.letter)) continue;
      findings.push({
        severity: 'unknown',
        path: here.path,
        line: here.line,
        message: `${here.line.command} has no documented ${p.letter} parameter — RRF ignores what it does not recognise`,
      });
    }
  }

  return findings;
}
