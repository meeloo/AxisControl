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
  searchArchives: boolean,
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
  if (!searchArchives || !outstanding().length) return found;

  // Anything still missing may be inside a combined archive. These run to
  // seventeen megabytes, so this only happens when the caller has decided the
  // download is worth it — see planUpdate.
  const archives = release.assets.filter(
    // DuetWebControl-SD.zip is in every release and holds the web interface,
    // never firmware. Downloading it to look for a board image is pure waste.
    (a) => /\.zip$/i.test(a.name) && !/DuetWebControl/i.test(a.name),
  );
  for (const asset of archives) {
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
  opts: {
    /** Filenames already sitting in the firmware directory on the card. */
    present?: Set<string>;
    onProgress?: (what: string, loaded: number, total: number | null) => void;
  } = {},
): Promise<FirmwarePlan> {
  const { present = new Set<string>(), onProgress } = opts;
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

  // Whether to pay for the combined archive.
  //
  // Duet3D do not publish the IAP as a loose asset — 3.6.1 carries it only
  // inside a seventeen-megabyte Duet2and3Firmware zip, and 3.7.0-beta.2 does
  // not ship one at all. The archive is worth downloading to get the *image*,
  // and not worth downloading to get a programmer the board already has.
  const iapOnCard = !main.iapFile || present.has(main.iapFile);
  const imageIsLoose = release.assets.some((a) => matchesBoardFile(main.firmwareFile!, a.name));
  const fetched = await candidates(release, need, !imageIsLoose || !iapOnCard, onProgress);

  const image = fetched.get(main.firmwareFile);
  if (!image) {
    throw new FirmwareError(
      `${release.tag} contains no ${main.firmwareFile}. That release may not cover this board — check it on GitHub before going further.`,
    );
  }

  // The IAP is a precondition of flashing, not of the release.
  //
  // It changes rarely, so most releases do not carry it, and the copy already
  // on the card from a previous update is the one RepRapFirmware will use.
  // Refusing because *this* release lacks one would make nearly every real
  // release uninstallable, which is exactly what it did.
  const notes: string[] = [];
  if (main.iapFile && !fetched.has(main.iapFile)) {
    if (!present.has(main.iapFile)) {
      throw new FirmwareError(
        `${release.tag} contains no ${main.iapFile}, and there is none on the card either. That is the programmer the board uses to rewrite its own flash, and M997 without it fails partway. Install a release that ships one first — the combined Duet2and3Firmware zip usually does.`,
      );
    }
    notes.push(`reusing the ${main.iapFile} already on the card — this release does not ship one`);
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
  found.push(...notes);

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

// --- A file the operator chose themselves ---------------------------------
//
// The reason this exists is the reason it is dangerous. Someone running a
// firmware they built — this machine runs a fork of RepRapFirmware for M700 and
// M604 — has no release to point at, and the alternative is DWC or a card
// reader. So the same procedure is offered for a local file, with the same
// discipline: the board still names the file it will look for, the image is
// still saved under that name, and the IAP is still a precondition.
//
// What is different is that nothing upstream has vouched for the bytes. A
// release at least came from Duet3D's repository; this came from a file picker.
// So this checks what can actually be checked — that a .uf2 is a well-formed
// UF2, that the size is not absurd, that the name is the one the board asked
// for — and refuses rather than improvises when it is not, with one deliberate
// override for the case the operator genuinely knows better.

/**
 * The same question as `matchesBoardFile`, asked strictly enough for a file
 * nobody curated.
 *
 * DWC's rule turns `Duet3Firmware_MB6HC.uf2` into `Duet3Firmware_MB6HC(.*)\.uf2`
 * so that a version in the name still matches. That is right for a release,
 * where the archive was assembled by the people who build the firmware — but
 * the same rule also matches `Duet3Firmware_MB6HC_SBC.uf2`, which is a
 * different image for the same board: the build that expects a Raspberry Pi to
 * be driving it. Flashed onto a standalone board it comes up unable to talk
 * over HTTP, which is indistinguishable from a brick to anyone without a card
 * reader.
 *
 * Out of a file picker that is not a hypothetical, it is the likeliest single
 * mistake available. So here the infix has to look like a version — a
 * separator and then a digit — and anything else is refused with the override
 * offered. `Duet3Firmware_MB6HC-3.7.0-velocity-jog.uf2` passes; `_SBC` does not.
 */
export function matchesBoardFileStrictly(wanted: string, candidate: string): boolean {
  const base = candidate.split('/').pop() ?? candidate;
  if (base.toLowerCase() === wanted.toLowerCase()) return true;
  const dot = wanted.lastIndexOf('.');
  if (dot <= 0) return false;
  const stem = wanted.slice(0, dot);
  const ext = wanted.slice(dot);
  const pattern = new RegExp(
    `^${escapeRegExp(stem)}[-_.]\\d[^/]*${escapeRegExp(ext)}$`,
    'i',
  );
  return pattern.test(base);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A file handed over by the operator rather than fetched from a release. */
export interface LocalFirmwareFile {
  name: string;
  bytes: Uint8Array;
}

export interface ImageCheck {
  kind: 'uf2' | 'binary' | 'zip';
  /** One line for the operator, describing what was actually found. */
  summary: string;
  /** UF2 only: the family the image declares, when it declares one. */
  familyId: number | null;
}

/**
 * The smallest plausible board image.
 *
 * RepRapFirmware for a Duet 3 is around a megabyte; the IAP is tens of
 * kilobytes. Sixteen kilobytes is well under anything real and well over an
 * error page or a truncated download, which is the failure this catches: a
 * half-written file flashed into a board is a board that no longer boots.
 */
const MIN_IMAGE_BYTES = 16 * 1024;

/** Past this, it is not a board image and something has gone wrong. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const UF2_BLOCK = 512;
const UF2_FLAG_FAMILY_ID = 0x00002000;

/**
 * Look at the bytes and say what they are, or refuse them.
 *
 * A `.uf2` can be checked properly: it is a sequence of 512-byte blocks, each
 * carrying two magic words at the front and one at the back, and each declaring
 * which block it is out of how many. A file that fails those checks is not a
 * UF2 whatever it is named, and writing it to the board's firmware directory
 * under the board's own filename is how the next M997 bricks the machine.
 *
 * A raw `.bin` carries no magic and no structure — nothing can be checked
 * beyond its size, and this says so rather than implying an inspection that did
 * not happen.
 */
export function inspectImage(name: string, bytes: Uint8Array): ImageCheck {
  if (looksLikeZip(bytes)) {
    return { kind: 'zip', summary: `zip archive, ${describeSize(bytes.length)}`, familyId: null };
  }
  if (bytes.length < MIN_IMAGE_BYTES) {
    throw new FirmwareError(
      `${name} is only ${describeSize(bytes.length)}. No board image is that small — this is most ` +
        'likely a truncated download or the wrong file, and flashing it would leave the board unable to boot.',
    );
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new FirmwareError(
      `${name} is ${describeSize(bytes.length)}, which is far larger than any board image. ` +
        'Check that this is firmware and not something else.',
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startsLikeUf2 =
    bytes.length >= UF2_BLOCK &&
    view.getUint32(0, true) === UF2_MAGIC_START0 &&
    view.getUint32(4, true) === UF2_MAGIC_START1;

  if (!startsLikeUf2) {
    if (/\.uf2$/i.test(name)) {
      throw new FirmwareError(
        `${name} is named .uf2 but does not begin with the UF2 magic numbers, so it is not a UF2 ` +
          'file. Something has repackaged or corrupted it.',
      );
    }
    return {
      kind: 'binary',
      summary: `raw binary, ${describeSize(bytes.length)} — nothing in a .bin identifies which board it is for`,
      familyId: null,
    };
  }

  if (bytes.length % UF2_BLOCK !== 0) {
    throw new FirmwareError(
      `${name} is ${bytes.length} bytes, which is not a whole number of 512-byte UF2 blocks. ` +
        'The file is truncated.',
    );
  }

  const blocks = bytes.length / UF2_BLOCK;
  let familyId: number | null = null;
  let payload = 0;
  for (let i = 0; i < blocks; i++) {
    const at = i * UF2_BLOCK;
    if (
      view.getUint32(at, true) !== UF2_MAGIC_START0 ||
      view.getUint32(at + 4, true) !== UF2_MAGIC_START1 ||
      view.getUint32(at + UF2_BLOCK - 4, true) !== UF2_MAGIC_END
    ) {
      throw new FirmwareError(
        `${name} fails the UF2 block check at block ${i} of ${blocks}. Every block carries magic ` +
          'numbers front and back, and one that does not means the file is damaged.',
      );
    }
    const flags = view.getUint32(at + 8, true);
    const size = view.getUint32(at + 16, true);
    const total = view.getUint32(at + 24, true);
    if (total !== blocks) {
      throw new FirmwareError(
        `${name} says it has ${total} blocks but the file holds ${blocks}. It is incomplete.`,
      );
    }
    payload += size;
    if (flags & UF2_FLAG_FAMILY_ID) {
      const declared = view.getUint32(at + 28, true);
      if (familyId === null) familyId = declared;
      else if (familyId !== declared) {
        throw new FirmwareError(
          `${name} declares more than one board family (0x${familyId.toString(16)} and ` +
            `0x${declared.toString(16)}). That is two different boards' firmware in one file.`,
        );
      }
    }
  }

  const family = familyId === null ? '' : `, family 0x${familyId.toString(16)}`;
  return {
    kind: 'uf2',
    summary: `UF2, ${blocks} blocks, ${describeSize(payload)} of firmware${family}`,
    familyId,
  };
}

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Work out what to write for a file the operator chose, or explain why not.
 *
 * Unlike a release, this only ever updates the main board. A release carries an
 * image for every board on the bus; one file carries one, and issuing
 * `M997 B<n>` after staging a single image would tell an expansion board to
 * flash itself from whatever happens to be on the card. The panel says so.
 */
export async function planLocalUpdate(
  file: LocalFirmwareFile,
  boards: FirmwareInfo[],
  opts: {
    present?: Set<string>;
    /**
     * Proceed even though the file is not named what the board asked for.
     *
     * The escape hatch for a legitimately renamed build. It is not a
     * formality: the name is the only evidence a single .bin offers about
     * which board it belongs to, so turning this on is the operator saying
     * they have checked by some other means.
     */
    acceptMismatchedName?: boolean;
  } = {},
): Promise<FirmwarePlan> {
  const { present = new Set<string>(), acceptMismatchedName = false } = opts;
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
      `${main.boardName} does not report a firmware file name. Without it there is no way to know ` +
        'whether this file belongs to this board, and guessing is how the wrong one gets written.',
    );
  }

  const files = new Map<string, Uint8Array>();
  const found: string[] = [];
  const check = inspectImage(file.name, file.bytes);

  if (check.kind === 'zip') {
    // The same archive Duet3D ship, or one somebody built the same way.
    let entries;
    try {
      entries = await unzip(file.bytes);
    } catch (err) {
      throw new FirmwareError(`${file.name} could not be read as a zip: ${(err as Error).message}`);
    }
    const image = entries.find((e) => matchesBoardFileStrictly(main.firmwareFile!, e.name));
    if (!image) {
      // A near miss is worth naming, because the commonest one is a variant of
      // this very board rather than a different board altogether.
      const nearly = entries.find((e) => matchesBoardFile(main.firmwareFile!, e.name));
      if (nearly) {
        throw new FirmwareError(
          `${file.name} has no plain ${main.firmwareFile}. The closest it holds is ${nearly.name}, ` +
            'which is a different build of the same board rather than the one this machine runs — ' +
            '`_SBC` in particular is the image for a board driven by a Raspberry Pi. If that really ' +
            'is the one you want, extract it and choose it directly.',
        );
      }
      const listing = entries
        .slice(0, 12)
        .map((e) => e.name)
        .join(', ');
      throw new FirmwareError(
        `${file.name} contains no ${main.firmwareFile}, which is the image ${main.boardName} asks ` +
          `for. It holds: ${listing}${entries.length > 12 ? `, and ${entries.length - 12} more` : ''}.`,
      );
    }
    inspectImage(image.name, image.bytes);
    files.set(join(main.directory, main.firmwareFile), image.bytes);
    found.push(`${image.name} (${describeSize(image.bytes.length)}) from ${file.name}`);

    const iap = main.iapFile
      ? entries.find((e) => matchesBoardFileStrictly(main.iapFile!, e.name))
      : undefined;
    if (iap) {
      files.set(join(main.directory, main.iapFile!), iap.bytes);
      found.push(`${iap.name} (${describeSize(iap.bytes.length)}) from ${file.name}`);
    }
  } else {
    const matches = matchesBoardFileStrictly(main.firmwareFile, file.name);
    if (!matches && !acceptMismatchedName) {
      const variant = matchesBoardFile(main.firmwareFile, file.name);
      throw new FirmwareError(
        variant
          ? `${file.name} is a variant of ${main.firmwareFile} rather than the file itself — ` +
            '`_SBC` is the build for a board driven by a Raspberry Pi, and flashing it onto a ' +
            'standalone board leaves it unable to answer over the network. If you are certain ' +
            'this is the right image, say so explicitly.'
          : `${main.boardName} loads its firmware from ${main.firmwareFile}, and this file is ` +
            `called ${file.name}. If that is the right image under a different name, say so ` +
            'explicitly — the name is the only thing that connects a file to a board, and writing ' +
            'the wrong board’s image is the way to make this one stop booting.',
      );
    }
    files.set(join(main.directory, main.firmwareFile), file.bytes);
    found.push(
      `${file.name} — ${check.summary} — saved as ${main.firmwareFile}` +
        (matches ? '' : ', though it is not the name the board asked for'),
    );
  }

  // Same rule as a release: the programmer has to exist, and the copy already
  // on the card is usually the one that will do the work.
  if (main.iapFile && !files.has(join(main.directory, main.iapFile)) && !present.has(main.iapFile)) {
    throw new FirmwareError(
      `There is no ${main.iapFile} on the card, and this file does not carry one. That is the ` +
        'programmer the board copies into RAM to rewrite its own flash, and M997 without it fails ' +
        'partway. Install a full release once — the combined Duet2and3Firmware zip ships one — and ' +
        'this file will flash cleanly afterwards.',
    );
  }
  if (main.iapFile && !files.has(join(main.directory, main.iapFile))) {
    found.push(`reusing the ${main.iapFile} already on the card`);
  }

  // Main board only. See the note on this function.
  return { info: main, files, found, commands: ['M997 S0'] };
}
