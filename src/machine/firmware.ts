// Updating the controller's own firmware, from Duet3D's GitHub releases.
//
// This writes the flash of the board that moves the machine, so the procedure
// is not invented here. It follows Duet Web Control's, which is the reference
// implementation against this firmware — `UploadBtn.vue` in Duet3D/DuetWebControl
// — and the two things worth copying from it are the two that are not obvious:
//
//   1. **The board names its own files.** `boards[].firmwareFileName` and
//      `boards[].iapFileNameSD` are what RepRapFirmware will look for when it
//      is told to flash itself. A release carries images for a dozen boards and
//      picking by any other rule can write the wrong one.
//
//   2. **The file is renamed on the way in.** A release ships the image as
//      `Duet3Firmware_MB6HC.uf2`, but zips and forks routinely carry a version
//      in the name — `Duet3Firmware_MB6HC-3.6.1.uf2`. DWC matches with the
//      board's name turned into a pattern that allows an infix, and then saves
//      it under the plain name the firmware looks for. Requiring an exact match
//      would refuse perfectly good releases; saving under the downloaded name
//      would upload a file the firmware never opens.
//
// The IAP is not optional. It is the small program the board copies into RAM to
// rewrite its own flash, and `M997` without it fails — safely, but only after
// the operator has been told the update is under way.
//
// Expansion boards go first, one `M997 B<address>` each, then the main board.
// That is DWC's order and it matters: updating the main board reboots it, and
// anything queued behind that reboot never runs.

import { unzip, looksLikeZip } from '../core/zip.js';
import { fetchAsset, fetchReleases, type GhAsset, type GhRelease } from '../core/github.js';
import { compareVersions } from '../core/build.js';
import { loadSetting } from '../core/store.js';
import type { FirmwareInfo } from './types.js';

/** Where Duet3D publishes firmware. */
export const FIRMWARE_REPO = 'Duet3D/RepRapFirmware';

export class FirmwareError extends Error {}

export interface FirmwareSource {
  repo: string;
  api?: string;
}

export function firmwareSource(): FirmwareSource {
  const stored = loadSetting<Partial<FirmwareSource>>('firmwareSource', {});
  return {
    repo: stored.repo?.trim() || FIRMWARE_REPO,
    api: stored.api?.trim().replace(/\/+$/, '') || undefined,
  };
}

export async function listFirmware(source: FirmwareSource = firmwareSource()): Promise<GhRelease[]> {
  return fetchReleases(source.repo, source.api, 25);
}

/**
 * Match a filename against the name the board asked for, allowing a version
 * infix before the extension.
 *
 * Exactly DWC's rule: `Duet3Firmware_MB6HC.uf2` becomes
 * `Duet3Firmware_MB6HC(.*)\.uf2`, so `Duet3Firmware_MB6HC-3.6.1.uf2` matches
 * and `Duet3Firmware_MB6HC_SBC.uf2` — a different image — matches too, which is
 * why the *directory* the file lands in and the name it is saved under both
 * come from the board rather than from the archive.
 */
export function matchesBoardFile(wanted: string, candidate: string): boolean {
  const base = candidate.split('/').pop() ?? candidate;
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const ext of ['.uf2', '.bin']) {
    if (wanted.toLowerCase().endsWith(ext)) {
      const stem = escape(wanted.slice(0, -ext.length));
      return new RegExp(`^${stem}(.*)${escape(ext)}$`, 'i').test(base);
    }
  }
  return base.toLowerCase() === wanted.toLowerCase();
}

/** What has to be written for one board, and under what names. */
export interface FirmwarePlan {
  info: FirmwareInfo;
  /** Destination path → the bytes to write there. */
  files: Map<string, Uint8Array>;
  /** Human summary of what was found and where it came from. */
  found: string[];
  /** `M997` arguments, in the order DWC issues them. */
  commands: string[];
}

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/**
 * Everything in a release that could hold a board image: the loose assets, plus
 * the contents of any zip among them.
 *
 * Duet3D publish both shapes and have changed which over time — loose `.uf2`
 * files in some releases, one combined `Duet2and3Firmware-x.y.z.zip` in others.
 * Looking in both means this does not break on the next release that changes
 * its mind.
 */
async function candidates(
  release: GhRelease,
  need: string[],
  onProgress?: (what: string, loaded: number, total: number | null) => void,
): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  const outstanding = () => need.filter((w) => !found.has(w));

  const loose = (wanted: string): GhAsset | undefined =>
    release.assets.find((a) => matchesBoardFile(wanted, a.name));

  for (const wanted of need) {
    const asset = loose(wanted);
    if (!asset) continue;
    onProgress?.(asset.name, 0, asset.size || null);
    found.set(
      wanted,
      await fetchAsset(asset.url, asset.size || null, (l, t) => onProgress?.(asset.name, l, t)),
    );
  }
  if (!outstanding().length) return found;

  // Anything still missing may be inside a combined archive. Only download one
  // if something is actually missing — these run to tens of megabytes.
  for (const asset of release.assets.filter((a) => /\.zip$/i.test(a.name))) {
    if (!outstanding().length) break;
    onProgress?.(asset.name, 0, asset.size || null);
    const bytes = await fetchAsset(asset.url, asset.size || null, (l, t) =>
      onProgress?.(asset.name, l, t),
    );
    if (!looksLikeZip(bytes)) continue;
    let entries;
    try {
      entries = await unzip(bytes);
    } catch {
      continue;
    }
    for (const wanted of outstanding()) {
      const entry = entries.find((e) => matchesBoardFile(wanted, e.name));
      if (entry) found.set(wanted, entry.bytes);
    }
  }
  return found;
}

/**
 * Work out what to write for a release, or explain why it cannot be done.
 *
 * Refuses rather than improvises. An update that proceeds without the image the
 * board named, or without the programmer that writes it, is one that leaves a
 * board halfway through rewriting its own flash.
 */
export async function planUpdate(
  release: GhRelease,
  boards: FirmwareInfo[],
  onProgress?: (what: string, loaded: number, total: number | null) => void,
): Promise<FirmwarePlan> {
  const main = boards.find((b) => b.canAddress === 0) ?? boards[0];
  if (!main) throw new FirmwareError('The controller has not said what board it is.');
  if (main.sbc) {
    throw new FirmwareError(
      'This machine runs from a Single Board Computer, where firmware is updated through the Pi’s package manager rather than by writing to the SD card. Use DWC or apt for this one.',
    );
  }
  if (!main.directory) {
    throw new FirmwareError(
      'The controller has not said where firmware files belong, so there is nowhere safe to put them.',
    );
  }
  if (!main.firmwareFile) {
    throw new FirmwareError(
      `${main.boardName} does not report a firmware file name. Without it there is no way to know which of the release’s images belongs to this board, and guessing is how the wrong one gets written.`,
    );
  }

  const need = [main.firmwareFile, ...(main.iapFile ? [main.iapFile] : [])];
  const fetched = await candidates(release, need, onProgress);

  const image = fetched.get(main.firmwareFile);
  if (!image) {
    throw new FirmwareError(
      `${release.tag} contains no ${main.firmwareFile}. That release may not cover this board — check it on GitHub before going further.`,
    );
  }
  if (main.iapFile && !fetched.get(main.iapFile)) {
    throw new FirmwareError(
      `${release.tag} contains no ${main.iapFile}. That is the programmer the board uses to rewrite its own flash, and M997 without it fails partway.`,
    );
  }

  // Saved under the name the board stated, not the name it was downloaded as.
  const files = new Map<string, Uint8Array>();
  const found: string[] = [];
  for (const wanted of need) {
    const bytes = fetched.get(wanted);
    if (!bytes) continue;
    files.set(join(main.directory, wanted), bytes);
    found.push(`${wanted} (${Math.round(bytes.length / 1024)}KB)`);
  }

  // DWC's order: every expansion board first, each awaited, then the main
  // board — whose update reboots it, ending anything queued behind it.
  const commands = [
    ...boards.filter((b) => b.canAddress > 0).map((b) => `M997 B${b.canAddress}`),
    'M997 S0',
  ];

  return { info: main, files, found, commands };
}

/** True when the release is a later version than what the board is running. */
export function isNewerFirmware(release: GhRelease, info: FirmwareInfo): boolean {
  if (!info.version) return false;
  return compareVersions(release.tag, info.version) > 0;
}

/** True when installing this release would move the board backwards. */
export function isDowngrade(release: GhRelease, info: FirmwareInfo): boolean {
  if (!info.version) return false;
  return compareVersions(release.tag, info.version) < 0;
}
