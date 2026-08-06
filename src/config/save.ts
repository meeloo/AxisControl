// Writing a settled value back into the line it came from.
//
// This is the only code in the app that changes /sys, and it is written to be
// boring. Four rules, none of which are negotiable:
//
//   1. Re-read the file first. Whatever the panel is showing was read minutes
//      or hours ago, and in between somebody may have used DWC, run ./tools/put,
//      or edited the SD card. Editing from a stale copy is how a config file
//      gets a value written into the wrong line.
//   2. Refuse if the line has changed. Not "merge", not "best effort" — refuse,
//      say which line, and let the operator re-read and look at it.
//   3. Back the file up before the first change of the session, so there is
//      always a copy of what it said before this app touched it.
//   4. Read it back and compare. An upload that half-succeeded leaves a config
//      file truncated, which is a machine that will not boot; finding that out
//      now beats finding it out at the next M999.
//
// What it deliberately does not do: reformat, reorder, normalise numbers,
// remove the commented-out previous values, or touch a single character outside
// the value being changed. A config file people hand-edit has to still look like
// theirs afterwards, or they stop trusting the thing that wrote it.

import { rewriteLine, type ConfigFile, type ConfigLine } from './parse.js';
import type { MachineDriver } from '../machine/driver.js';

/**
 * One change to make to a file.
 *
 * `set` replaces named values inside a line and touches nothing else. `replace`
 * puts a whole new text in a line's place — used where the line grows, such as
 * a parameter appended to the end of it. `insert` puts a new line after an
 * existing one. All three name the ConfigLine they were built from, so all
 * three get the same guard: the file must still read the way it was parsed.
 */
export type FileOp =
  | { kind: 'set'; line: ConfigLine; values: Map<string, string> }
  | { kind: 'replace'; line: ConfigLine; text: string }
  | { kind: 'insert'; after: ConfigLine; text: string }
  | { kind: 'delete'; line: ConfigLine };

/** The line each op is anchored to — the one that has to still be as parsed. */
const anchor = (op: FileOp): ConfigLine => (op.kind === 'insert' ? op.after : op.line);

export interface SaveReport {
  path: string;
  /** Where the previous contents were kept, or null if this session already had one. */
  backup: string | null;
  /** Line numbers as an operator counts them, 1-based. */
  lines: number[];
  /** Lines added rather than changed, by the number they end up at. */
  added: number[];
  /** Lines removed, by the number they had. */
  removed: number[];
}

/**
 * Files already backed up in this session, so a tuning loop keeps the original.
 *
 * Saving twice in a row is normal — try 3500, save, decide 3200 was better,
 * save again — and backing up each time would make the second save overwrite
 * the only copy of what the file said before any of this started. Reloading the
 * page starts a new session and takes a fresh copy, which is the right moment:
 * by then the previous save is what the machine has been running.
 */
const backedUp = new Set<string>();

/**
 * The backup's name.
 *
 * Beside the original rather than in a folder of its own: one less thing to
 * create, and it shows up next to the file it belongs to in any file listing.
 * It does not end in `.g`, so nothing will ever run it by accident.
 */
export function backupPath(path: string): string {
  return `${path}.bak`;
}

/**
 * Split text into lines and the separators between them.
 *
 * Rejoining `parts` reproduces the input exactly, whatever mixture of CRLF and
 * LF it uses and whether or not it ends with a newline. Splitting on /\r?\n/ and
 * joining with '\n' would quietly convert a whole file's line endings on the
 * first save, which is a diff nobody asked for.
 *
 * The separator has to be the same one parseConfig splits on, down to the lone
 * `\r` it deliberately does not treat as a line break. A splitter that is even
 * slightly more generous than the parser numbers the lines differently, and
 * "line 8" would then mean two things in the one function that has to compare
 * them.
 */
function splitKeeping(text: string): string[] {
  return text.split(/(\r?\n)/);
}

const lineAt = (parts: string[], index: number): string | undefined => parts[index * 2];

/**
 * Apply edits to one file on the controller.
 *
 * `file` is what the panel parsed; it is used for the line numbers and the
 * parameter offsets, never for the contents being written. Those come from the
 * fresh read, and the two have to agree or nothing is written.
 */
export async function saveFile(
  driver: MachineDriver,
  file: ConfigFile,
  ops: FileOp[],
): Promise<SaveReport> {
  if (!ops.length) throw new Error(`nothing to save in ${file.path}`);

  const originalBytes = await driver.readFile(file.path);
  const original = new TextDecoder().decode(originalBytes);
  const parts = splitKeeping(original);

  // Rule 2, before anything is written anywhere. Checked for every line first
  // so that a file with one stale line is refused whole, rather than half saved.
  for (const op of ops) {
    const line = anchor(op);
    const current = lineAt(parts, line.index);
    if (current === undefined) {
      throw new Error(
        `${file.path} is now shorter than when it was read — line ${line.index + 1} is gone. Re-read and try again.`,
      );
    }
    if (current !== line.raw) {
      throw new Error(
        `${file.path} line ${line.index + 1} has changed since it was read. Re-read and try again.`,
      );
    }
  }

  // Changes to existing lines first: they do not move anything, so every index
  // still means what it meant when the file was parsed.
  for (const op of ops) {
    if (op.kind === 'set') parts[op.line.index * 2] = rewriteLine(op.line, op.values);
    else if (op.kind === 'replace') parts[op.line.index * 2] = op.text;
  }

  // Then the ones that move lines, from the bottom up, so that each is applied
  // before anything above it has shifted. Insertions and deletions together and
  // in one order: done in two passes they would each be correct against the
  // original numbering and wrong against each other's.
  const moving = ops
    .filter((o): o is Extract<FileOp, { kind: 'insert' | 'delete' }> =>
      o.kind === 'insert' || o.kind === 'delete')
    .sort((a, b) => anchor(b).index - anchor(a).index);
  const added: number[] = [];
  const removed: number[] = [];
  const separator = /\r\n/.test(original) ? '\r\n' : '\n';
  for (const op of moving) {
    const at = anchor(op).index * 2;
    if (op.kind === 'insert') {
      if (parts[at + 1] !== undefined) {
        // The line has a newline after it: reuse it, and give the new line one
        // of the same kind so a CRLF file stays a CRLF file.
        parts.splice(at + 2, 0, op.text, parts[at + 1]!);
      } else {
        // Inserting after the file's last line, which has no newline of its own.
        parts.push(separator, op.text);
      }
      added.push(anchor(op).index + 2);
    } else {
      // Take the line and the newline that ended it. On the last line there is
      // no newline after, so the one before it goes instead — otherwise the
      // file would end with a blank line that was not there before.
      if (parts[at + 1] !== undefined) parts.splice(at, 2);
      else parts.splice(Math.max(0, at - 1), 2);
      removed.push(anchor(op).index + 1);
    }
  }

  const updated = parts.join('');
  if (updated === original) throw new Error(`${file.path} is already what you are saving`);

  let backup: string | null = null;
  if (!backedUp.has(file.path)) {
    backup = backupPath(file.path);
    await driver.writeFile(backup, originalBytes);
    backedUp.add(file.path);
  }

  const bytes = new TextEncoder().encode(updated);
  await driver.writeFile(file.path, bytes);

  // Rule 4. Compare the text rather than the bytes: what matters is that the
  // controller now holds this file, not that it stored it in the same encoding.
  const readBack = new TextDecoder().decode(await driver.readFile(file.path));
  if (readBack !== updated) {
    throw new Error(
      `${file.path} did not read back as written — ${readBack.length} characters instead of ${updated.length}. ` +
        (backup ? `The previous contents are in ${backup}.` : 'Check the file before restarting.'),
    );
  }

  return {
    path: file.path,
    backup,
    lines: ops
      .filter((o) => o.kind === 'set' || o.kind === 'replace')
      .map((o) => anchor(o).index + 1),
    added: added.sort((a, b) => a - b),
    removed: removed.sort((a, b) => a - b),
  };
}
