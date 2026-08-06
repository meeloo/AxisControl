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

/** New values for one line, keyed by parameter letter. */
export type LineEdit = { line: ConfigLine; values: Map<string, string> };

export interface SaveReport {
  path: string;
  /** Where the previous contents were kept, or null if this session already had one. */
  backup: string | null;
  /** Line numbers as an operator counts them, 1-based. */
  lines: number[];
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
 */
function splitKeeping(text: string): string[] {
  return text.split(/(\r\n|\n|\r)/);
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
  edits: LineEdit[],
): Promise<SaveReport> {
  if (!edits.length) throw new Error(`nothing to save in ${file.path}`);

  const originalBytes = await driver.readFile(file.path);
  const original = new TextDecoder().decode(originalBytes);
  const parts = splitKeeping(original);

  // Rule 2, before anything is written anywhere. Checked for every line first
  // so that a file with one stale line is refused whole, rather than half saved.
  for (const { line } of edits) {
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

  for (const { line, values } of edits) {
    parts[line.index * 2] = rewriteLine(line, values);
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

  return { path: file.path, backup, lines: edits.map((e) => e.line.index + 1) };
}
