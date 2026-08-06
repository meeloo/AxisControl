// Adding what a configuration is missing.
//
// Editing a value in place is safe because the line already exists: it has a
// position, and that position is somebody's decision that this code does not
// have to make. Adding is the opposite problem. Where a line goes decides
// whether it does anything at all — M203 above the M584 that creates the axes
// is refused at boot, in silence — so the placement is the whole risk, and the
// value is the easy part.
//
// Two shapes only, both narrow on purpose:
//
//   1. A parameter missing from a line that exists. No placement decision at
//      all: it goes on the end of that line, before the comment. This is the
//      common one — an axis added to the machine long after the speeds were
//      written, so the file sets X, Y and Z and says nothing about U.
//
//   2. A whitelisted command that the configuration never runs. Placed beside
//      its siblings, and then checked: the proposed file is re-parsed and put
//      back through config/check.ts, and if the insertion produces a finding
//      that was not there before, it is refused rather than written.
//
// The value always comes from the machine, never from a default. This can say
// "your U axis is running at 8000 and the file never says so, shall I write
// that down" — which is a fact. It has no business inventing a number.

import { commentAt, parseConfig, type ConfigFile, type ConfigLine } from './parse.js';
import { liveValue } from './live.js';
import { checkConfig } from './check.js';
import type { Axis } from '../machine/types.js';
import type { GcodeIndex } from '../docs/types.js';

/** A value to add, and where it came from. */
export interface Addition {
  letter: string;
  /** As it will be written. */
  text: string;
}

/** Round the way the panel shows numbers, so what is written is what was seen. */
function format(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Axes the machine has that this line says nothing about.
 *
 * Only for commands whose values can be read back per axis, because the whole
 * point is to write down what the machine is already doing. A command this
 * cannot read has nothing to offer and returns nothing.
 */
export function missingAxes(line: ConfigLine, axes: Axis[]): Addition[] {
  if (line.kind !== 'command' || !line.command || line.expression || line.depth > 0) return [];
  const written = new Set(line.params.map((p) => p.letter));
  const out: Addition[] = [];
  for (const axis of axes) {
    if (written.has(axis.letter)) continue;
    const v = liveValue(line.command, axis);
    if (v === null) continue;
    out.push({ letter: axis.letter, text: format(v) });
  }
  return out;
}

/**
 * Put parameters on the end of a line, before its comment.
 *
 * Files written by hand line their comments up in a column, and a naive append
 * pushes one comment out of that column and leaves every other line as it was —
 * a diff that looks like damage. Where the padding before the comment is wide
 * enough to give back what the new parameters take, it does; where it is not,
 * the comment moves and the line stays correct, which is the right way round.
 */
export function appendParams(line: ConfigLine, additions: Addition[]): string {
  if (!additions.length) return line.raw;
  const added = additions.map((a) => ` ${a.letter}${a.text}`).join('');

  const cut = commentAt(line.raw);
  const lastEnd = line.params.length
    ? Math.max(...line.params.map((p) => p.end))
    : (cut < 0 ? line.raw.trimEnd().length : line.raw.slice(0, cut).trimEnd().length);

  if (cut < 0) {
    // No comment: anything after the parameters is trailing whitespace, and
    // trailing whitespace after an edit is noise nobody asked for.
    return line.raw.slice(0, lastEnd) + added + line.raw.slice(lastEnd).replace(/\s+$/, '');
  }

  const gap = line.raw.slice(lastEnd, cut);
  // Only reclaim padding that is padding — anything else here belongs to the
  // line and is not this function's to eat.
  const keep = /^ +$/.test(gap) ? Math.max(1, gap.length - added.length) : gap.length;
  return line.raw.slice(0, lastEnd) + added + ' '.repeat(keep) + line.raw.slice(cut);
}

// --- A command the configuration never runs ---------------------------------

export interface Placement {
  path: string;
  /** The line to put the new one after. */
  after: ConfigLine;
  text: string;
  /** Why here, in words, because the operator is the one accepting the risk. */
  because: string;
}

/** Commands that are peers: a new one belongs beside the others. */
function siblings(files: ConfigFile[], family: ReadonlySet<string>): Array<{ path: string; line: ConfigLine }> {
  const out: Array<{ path: string; line: ConfigLine }> = [];
  for (const file of files) {
    for (const line of file.lines) {
      if (line.kind === 'command' && line.command && family.has(line.command)) {
        out.push({ path: file.path, line });
      }
    }
  }
  return out;
}

/** Whitelisted commands that never run anywhere in this configuration. */
export function missingCommands(files: ConfigFile[], family: ReadonlySet<string>): string[] {
  const present = new Set(
    files.flatMap((f) => f.lines.filter((l) => l.kind === 'command').map((l) => l.command)),
  );
  return [...family].filter((c) => !present.has(c)).sort();
}

/**
 * The whole line to write for a command this machine has no line for.
 *
 * The comment column is taken from the file it is going into rather than
 * picked, so a new line looks like the ones around it instead of announcing
 * which lines a program wrote.
 */
export function lineFor(command: string, axes: Axis[], comment: string, column = 0): string | null {
  const parts: string[] = [];
  for (const axis of axes) {
    const v = liveValue(command, axis);
    if (v === null) continue;
    parts.push(`${axis.letter}${format(v)}`);
  }
  if (!parts.length) return null;
  const code = `${command} ${parts.join(' ')}`;
  const pad = Math.max(1, column - code.length);
  return `${code}${' '.repeat(pad)}; ${comment}`;
}

/** The column existing comments start in, so a new line can match them. */
export function commentColumn(file: ConfigFile): number {
  const columns = file.lines
    .filter((l) => l.kind === 'command' && l.comment !== null)
    .map((l) => commentAt(l.raw))
    .filter((c) => c > 0);
  if (!columns.length) return 0;
  // The most common column, not the mean: one long line should not drag every
  // new one out to meet it.
  const counts = new Map<number, number>();
  for (const c of columns) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

/**
 * Where a new command line can go, or why it cannot go anywhere.
 *
 * In the file where most of its siblings live, after the last of them. Both
 * halves matter, and the first was learned the hard way: "after the last
 * sibling anywhere" put a speed setting into config-axes-limits.g, because that
 * file runs later and its two M208s were the last axis commands in the whole
 * configuration. Technically valid, and not where anybody would look for it.
 * Files are organised by subject, so the file with the most of these lines is
 * the one that is about them.
 *
 * Within that file, the end of the group: those lines are in an order somebody
 * chose and the machine boots with, so after all of them cannot be earlier than
 * something the new line depends on. With no siblings at all there is no such
 * argument to make, and this refuses — putting an axis command into a file at a
 * guess is exactly the failure this whole panel exists to catch.
 */
export function placeFor(
  files: ConfigFile[],
  command: string,
  text: string,
  family: ReadonlySet<string>,
): Placement | { refused: string } {
  const peers = siblings(files, family);
  if (!peers.length) {
    return {
      refused:
        `Nothing in this configuration sets anything like ${command}, so there is no group to put ` +
        `it beside. Add the line by hand, after the M584 that creates the axes.`,
    };
  }
  const perFile = new Map<string, Array<{ path: string; line: ConfigLine }>>();
  for (const p of peers) perFile.set(p.path, [...(perFile.get(p.path) ?? []), p]);
  // Most siblings wins; a tie goes to the file that runs last, since a later
  // file cannot be depended on by an earlier one.
  const order = files.map((f) => f.path);
  const [, group] = [...perFile.entries()].sort(
    (a, b) => b[1].length - a[1].length || order.indexOf(b[0]) - order.indexOf(a[0]),
  )[0]!;
  const last = group[group.length - 1]!;
  return {
    path: last.path,
    after: last.line,
    text,
    because:
      `after line ${last.line.index + 1} of ${last.path}, the last of the ${group.length} ` +
      `line${group.length === 1 ? '' : 's'} like it there`,
  };
}

/**
 * Re-check the configuration as it would be with the line inserted.
 *
 * The checker already knows what makes a configuration wrong, so the insertion
 * is validated by the same rules that report on everything else rather than by
 * a second set written for this. Returns the findings the insertion would add;
 * an empty list means the placement is one the checker has no objection to.
 *
 * This is what makes the panel's free-text insert defensible, and there it
 * fires constantly: a second M203 that would silently overwrite the first, a
 * parameter for an axis the machine does not have, a line above the M584 that
 * creates the axes. For the lines this module places by itself it is belt and
 * braces — M584 is in the family, so "after the last sibling" is never above
 * it, and only commands absent everywhere are offered, so no duplicate can be
 * made. Both of those are properties of tables that will be edited again, and
 * neither announces itself when it stops holding.
 *
 * Comparing messages rather than counts: an insertion that removed one finding
 * and introduced another would net to zero and be waved through.
 */
export function findingsAdded(
  files: ConfigFile[],
  place: Placement,
  index: GcodeIndex | null,
  axes: string[],
): string[] {
  const before = new Set(checkConfig(files, index, axes).map((f) => `${f.path}:${f.message}`));
  const proposed = files.map((file) => {
    if (file.path !== place.path) return file;
    const lines = file.lines.map((l) => l.raw);
    lines.splice(place.after.index + 1, 0, place.text);
    return parseConfig(file.path, lines.join('\n'));
  });
  return checkConfig(proposed, index, axes)
    .filter((f) => !before.has(`${f.path}:${f.message}`))
    .map((f) => f.message);
}
