// Fonts the operator has put on the machine, kept on the machine.
//
// A font dropped onto this app is a thing the workshop now owns, not a thing
// this browser now owns. It goes onto the controller's SD card, which means it
// survives a cleared browser profile, it is there on the tablet that somebody
// else picks up, and it can be put on the card with a card reader by anybody
// who would rather not use the app at all. That last case is the one that
// shapes most of what follows.
//
// This module is storage and nothing else. It does not know what a font
// contains, and deliberately cannot: parsing lives in text/outline.ts and
// arrives here through `setFontValidator`, so that a font this app cannot read
// is rejected before it is written without this file depending on the parser to
// compile.

import { activeDriver, appendLog, controllerUrl, run } from '../core/store.js';
import { basename, formatBytes, joinPath, parentPath } from '../core/util.js';
import type { FileEntry } from '../machine/types.js';

/**
 * Where fonts live on the card.
 *
 * The card root, and specifically *not* anywhere under `/www`. This is the one
 * decision in the file worth arguing about, because the obvious place is the
 * place that breaks.
 *
 * `/www/AxisControl` is this app's own install directory. The Install panel
 * writes every file the build manifest names into it on each update; as
 * machine/install.ts stands today it overwrites rather than deleting first, so
 * a font collection in there would survive an update — but it would survive by
 * luck rather than by design. The moment anyone adds a clean-out to the updater
 * (which is the natural fix for stale files left behind by an older build), the
 * operator's fonts leave with the old bundle. Losing somebody's font collection
 * to an app update is the kind of bug that ends trust in the app, and no amount
 * of apologising afterwards puts the fonts back.
 *
 * `/www` in general is the web root the firmware serves, which is also DWC's
 * home — machine/install.ts records that DWC ships a `fonts/` tree of its own
 * down there, so `/www/fonts` is a collision waiting for the next DWC release
 * rather than a home.
 *
 * `/fonts` at the root sits beside `/sys`, `/gcodes`, `/macros` and
 * `/filaments`: the operator's own data, in the place they will look for it
 * with the card in a reader. The firmware's `directories` key names only its
 * firmware, gcodes, macros, system and web directories, so nothing else on the
 * machine is claiming that name.
 */
export const FONTS_DIR = '/fonts';

/** The directory fonts are stored in, for a panel that wants to say so. */
export function fontsDir(): string {
  return FONTS_DIR;
}

/**
 * What this app can read back off the card, lower case, leading dot included.
 *
 * `.woff2` is missing on purpose, and the claim is checked rather than
 * inherited: the copy of opentype.js in this tree (2.0.0) dispatches on the
 * four-byte file signature in `dist/opentype.mjs`, and answers `wOF2` with
 *
 *   throw new Error("WOFF2 require an external decompressor library, …")
 *
 * A WOFF2 would therefore upload perfectly, sit on the card looking like a
 * font, and fail at the moment somebody tried to cut with it — which is the
 * worst place to find out. Refusing it at the door costs one clear sentence
 * instead. Plain `.woff` is fine; opentype.js inflates that itself.
 */
export const FONT_EXTENSIONS: readonly string[] = ['.ttf', '.otf', '.woff'];

/**
 * The largest file this will accept as a font.
 *
 * An upload is a single HTTP POST that the firmware answers only once the whole
 * body has landed on the SD card (see the RRF client's `uploadFile`), so a big
 * file is a long silence with no progress and nothing to cancel. 8MB is far
 * above any text face somebody means to engrave with, so a file bigger than
 * this is much more likely to be something that is not a font at all — and the
 * honest thing is to say so before the wait rather than after it.
 */
export const MAX_FONT_BYTES = 8 * 1024 * 1024;

/**
 * How long a stored file name may be.
 *
 * This module's own cap, not a firmware limit — what FatFs on a given board
 * will take is not something this code can ask about, and a name long enough
 * for it to matter is not a name anybody typed on purpose.
 */
const MAX_NAME_LENGTH = 64;

/** A font that is on the card. `name` is the file name, extension included. */
export interface StoredFont {
  /** Controller-absolute path, always inside FONTS_DIR. */
  path: string;
  name: string;
  size: number;
}

export interface StoreOptions {
  /**
   * Overwrite a font of the same name that is already there.
   *
   * Off by default; see `storeFont` for why a collision is refused rather than
   * resolved. This exists so a panel can offer "replace it" once it has told
   * the operator what they are about to lose.
   */
  replace?: boolean;
}

/**
 * Checks that the bytes really are a font, supplied from outside.
 *
 * A module-level registration rather than an argument to `storeFont`, and the
 * reason is which mistake each shape makes possible. Passed per call, the check
 * is only as good as the least careful call site: a panel grows a drag-and-drop
 * handler beside its file input, that one forgets the argument, and unparseable
 * files start reaching the card through one door while the other door is still
 * correct. Registered once, there is a single place where validation is either
 * on or off, and turning it off is a visible act rather than an omission.
 *
 * The cost is a module-level variable, which is why `storeFont` says so in the
 * console when nothing has been registered instead of quietly skipping the
 * check.
 *
 * The arguments are in this order — name first, then bytes — to match
 * text/outline.ts's `parseFont(id, data)`, so the parser can be registered as
 * itself rather than through a wrapper. A wrapper is one more line in which the
 * two arguments can be swapped, and a validator handed a name where it expected
 * bytes rejects every font there is.
 */
export type FontValidator = (name: string, data: ArrayBuffer) => void | Promise<void>;

let validator: FontValidator | null = null;

/** Register the parser that decides whether a file is really a font. */
export function setFontValidator(fn: FontValidator | null): void {
  validator = fn;
}

// --- Caches ---------------------------------------------------------------
//
// Two of them, and both exist for the same reason: the controller's HTTP server
// is a small board with an SD card behind it, and a chooser that re-downloaded
// 400KB every time the operator pressed the down arrow would be unusable on the
// machine it is meant to be used on.

let listing: StoredFont[] | null = null;
const contents = new Map<string, ArrayBuffer>();
/** The controller the caches were filled from. */
let cachedFrom: string | null = null;
/** The last failure reported for the listing, so it is not repeated per call. */
let lastListFailure: string | null = null;

/**
 * Throw the caches away when the app is pointed at a different machine.
 *
 * Paths are not unique across controllers: `/fonts/Roboto.ttf` on the machine
 * in the corner is a different file from `/fonts/Roboto.ttf` on the one by the
 * door, and serving one's bytes for the other's path would put the wrong
 * outlines on screen with nothing at all to show that it had happened.
 */
function cacheFor(url: string): void {
  if (url === cachedFrom) return;
  cachedFrom = url;
  listing = null;
  lastListFailure = null;
  contents.clear();
}

function byName(a: StoredFont, b: StoredFont): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** True when a file name is one this app could read back as a font. */
export function isFontFile(name: string): boolean {
  const lower = name.toLowerCase();
  return FONT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Every font on the card.
 *
 * Derived from the directory listing every time, with no manifest anywhere. A
 * manifest would be a second source of truth about a directory that a person
 * can edit directly — this is a machine with a card slot, and copying a font
 * onto the card by hand is a completely normal thing to do — so it would start
 * lying the first time somebody did that, and the fonts they had just installed
 * would be invisible to the app that is supposed to list them.
 *
 * Returns an empty list rather than throwing when there is nothing to list: not
 * connected yet, and a machine that has never had a font uploaded to it, are
 * both ordinary states and neither is news. `force` is for after the card may
 * have changed under us.
 */
export async function listFonts(force = false): Promise<StoredFont[]> {
  cacheFor(controllerUrl.peek());
  if (!force && listing) return listing;

  const driver = activeDriver();
  // The app starts disconnected and panels import their modules eagerly, so
  // being asked this before there is a machine is normal, not a failure.
  if (!driver) return [];

  let entries: FileEntry[];
  try {
    entries = await driver.listFiles(FONTS_DIR);
  } catch (err) {
    // A machine nobody has ever uploaded a font to has no /fonts directory, and
    // that is the state every machine starts in — an error line for it would be
    // wrong on every first run. The reason is still worth one quiet line,
    // because an unmounted card reports itself the same way and silence there
    // would be under-reporting. Nothing is cached, so the next call retries.
    const reason = (err as Error).message;
    if (reason !== lastListFailure) {
      lastListFailure = reason;
      appendLog({ level: 'info', text: `No fonts read from ${FONTS_DIR}: ${reason}`, time: new Date() });
    }
    return [];
  }

  lastListFailure = null;
  const fonts = entries
    .filter((e) => !e.directory && isFontFile(e.name))
    .map((e) => ({ path: e.path, name: e.name, size: e.size }))
    .sort(byName);

  // Drop cached bytes the listing has just contradicted. Somebody replacing a
  // font on the card by hand is the case this is for, and the size the firmware
  // reports is the only evidence available without downloading the file again.
  // It is not proof: a replacement of exactly the same length keeps the stale
  // bytes, and the way out of that is `listFonts(true)` after a reconnect, or
  // deleting and re-uploading through this module.
  const sizes = new Map(fonts.map((f) => [f.path, f.size] as const));
  for (const [path, data] of contents) {
    const size = sizes.get(path);
    if (size === undefined || size !== data.byteLength) contents.delete(path);
  }

  listing = fonts;
  return fonts;
}

/**
 * Read a font off the card.
 *
 * Throws when it cannot, rather than answering null: every caller of this is
 * about to hand the bytes to a parser, and there is no sensible way to carry on
 * without them. The reason is logged on the way past because that is where the
 * app's failures go, and re-thrown because a chooser needs something to put on
 * screen beside the font it could not open — `run` deliberately swallows the
 * error into `undefined`, which is right for a fire-and-forget action and wrong
 * here.
 *
 * The buffer that comes back is the cached one, shared with every other caller.
 * Read it, do not write it, and do not hand it to `postMessage` in a transfer
 * list: transferring detaches it, and the next caller gets a zero-length buffer
 * off the cache with nothing to say why. Copy it first if it has to leave.
 */
export async function loadFont(
  path: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<ArrayBuffer> {
  cacheFor(controllerUrl.peek());

  const cached = contents.get(path);
  if (cached) {
    // Answer the progress callback anyway, so a caller that showed a bar before
    // calling is not left with it stuck at zero on the one path that is instant.
    onProgress?.(cached.byteLength, cached.byteLength);
    return cached;
  }

  const driver = activeDriver();
  if (!driver) throw new Error('Not connected');

  try {
    const bytes = await driver.readFile(path, onProgress);
    const data = toArrayBuffer(bytes);
    contents.set(path, data);
    return data;
  } catch (err) {
    appendLog({ level: 'error', text: `load ${basename(path)}: ${(err as Error).message}`, time: new Date() });
    throw err;
  }
}

/**
 * Put a font on the card.
 *
 * Returns the stored font, or null when it was refused — every refusal says why
 * in the console first, so a caller can treat null as "already reported" and a
 * panel is free to show its own message as well.
 *
 * Order matters here. The free checks come first, then the file is read and
 * parsed locally, and only then does anything touch the machine: there is no
 * reason to spend a controller round trip on a file that was never a font.
 */
export async function storeFont(
  file: File,
  onProgress?: (loaded: number, total: number | null) => void,
  options: StoreOptions = {},
): Promise<StoredFont | null> {
  cacheFor(controllerUrl.peek());

  const name = safeName(file.name);
  if (!name) {
    reject(`"${file.name}" leaves nothing usable as a file name once it is made safe for the card.`);
    return null;
  }

  if (!isFontFile(name)) {
    // WOFF2 is worth naming, because it is the format a web font download is
    // most likely to be and "unsupported file type" would send somebody looking
    // for a fault that is not there.
    reject(
      name.toLowerCase().endsWith('.woff2')
        ? `${name} is WOFF2, which this app cannot read — its font parser needs an external Brotli decompressor. Convert it to ${FONT_EXTENSIONS.join(', ')} first.`
        : `${name} is not a font this app can read. Accepted: ${FONT_EXTENSIONS.join(', ')}.`,
    );
    return null;
  }

  if (file.size === 0) {
    reject(`${name} is empty.`);
    return null;
  }

  if (file.size > MAX_FONT_BYTES) {
    reject(
      `${name} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_FONT_BYTES)} limit. ` +
        'A font that size is almost certainly not a font, and uploading it to the controller ' +
        'would be a long wait with nothing to cancel.',
    );
    return null;
  }

  const driver = activeDriver();
  if (!driver) {
    reject('Not connected');
    return null;
  }

  // Progress starts here: writeFile has no progress callback of its own, so an
  // upload can only be reported as started and finished. A caller should show
  // an indeterminate bar in between rather than a stuck number.
  onProgress?.(0, file.size);

  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch (err) {
    reject(`${name} could not be read: ${(err as Error).message}`);
    return null;
  }

  if (validator) {
    try {
      await validator(name, data);
    } catch (err) {
      // A parser worth registering says which file it choked on, and
      // text/outline.ts does. Naming it again here would read as a stutter, so
      // the name is only added when the message does not already carry it —
      // which a barer validator's would not, and a rejection that does not say
      // which font was rejected is useless in a console of them.
      const why = (err as Error).message;
      reject(why.includes(name) ? why : `${name} could not be parsed as a font: ${why}`);
      return null;
    }
  } else {
    // Not an error — this module is allowed to run without a parser — but it is
    // the difference between "checked" and "hoped", and that belongs on screen
    // rather than in a comment nobody reads at the machine.
    appendLog({
      level: 'warning',
      text: `${name} is being stored without being parsed first: no font validator is registered.`,
      time: new Date(),
    });
  }

  const path = joinPath(FONTS_DIR, name);

  // Deliberately a forced re-read rather than the cached listing. The whole
  // point of the check is the file we do not know about — the one somebody
  // copied onto the card five minutes ago — and a cached listing is exactly the
  // thing that would not have it in it.
  const existing = (await listFonts(true)).find((f) => f.path === path);
  if (existing && !options.replace) {
    // Refused rather than suffixed, and the alternative was seriously
    // considered. Writing Roboto-1.ttf beside Roboto.ttf never destroys
    // anything, but it makes the chooser a list of near-identical names that
    // nobody can tell apart, and it turns the commonest case — uploading a font
    // that is already there, because you forgot — into a silently growing pile
    // of duplicates. Refusing loses nothing, says exactly what is in the way,
    // and the fix is one delete away. `replace` is there for when the operator
    // has been told what they are replacing and said yes.
    reject(
      `${name} is already in ${FONTS_DIR} (${formatBytes(existing.size)}). ` +
        'Delete it first, or rename the file, if this is a different font.',
    );
    return null;
  }

  // The directory may not exist yet, and RRF answers "make a directory that is
  // already there" with an error, so there is nothing useful to distinguish
  // here. Let the upload be the thing that reports a real problem.
  try {
    await driver.makeDirectory(FONTS_DIR);
  } catch {
    /* already there, or the controller does not need it */
  }

  const ok = await run(`upload ${name}`, async (d) => {
    await d.writeFile(path, new Uint8Array(data));
    return true;
  });
  if (!ok) return null;

  onProgress?.(file.size, file.size);

  const stored: StoredFont = { path, name, size: data.byteLength };
  // Keep the caches in step with what was just written, so the chooser that
  // triggered this can render the new font without another round trip — and so
  // previewing it does not download the bytes that are already in hand.
  contents.set(path, data);
  listing = [...(listing ?? []).filter((f) => f.path !== path), stored].sort(byName);
  appendLog({ level: 'info', text: `Stored ${path} (${formatBytes(stored.size)})`, time: new Date() });
  return stored;
}

/**
 * Delete a font from the card.
 *
 * Only inside FONTS_DIR. This is the fonts module's delete, not a general file
 * delete, and a path that came from somewhere other than `listFonts` — a stale
 * chooser selection, a hand-written call — must not be able to take a config
 * file with it.
 */
export async function removeFont(path: string): Promise<boolean> {
  cacheFor(controllerUrl.peek());

  if (parentPath(path) !== FONTS_DIR) {
    reject(`${path} is not in ${FONTS_DIR}, so this will not delete it.`);
    return false;
  }

  const ok = await run(`delete ${basename(path)}`, async (d) => {
    await d.deleteFile(path);
    return true;
  });
  if (!ok) return false;

  contents.delete(path);
  listing = (listing ?? []).filter((f) => f.path !== path);
  appendLog({ level: 'info', text: `Deleted ${path}`, time: new Date() });
  return true;
}

// --- Helpers --------------------------------------------------------------

function reject(message: string): void {
  appendLog({ level: 'error', text: message, time: new Date() });
}

/**
 * A file name that is safe to put in a controller path.
 *
 * Two separate problems. The first is `../`: a File's name is normally a bare
 * name, but a directory drop carries a relative path and a hand-written call
 * can carry anything, and a path that climbs out of `/fonts` is a write into
 * `/sys` that nobody asked for. Only the last component survives, and leading
 * dots go with it.
 *
 * The second is quoting. The RRF client puts the path in a query parameter, so
 * it is escaped there, but paths in this firmware also travel inside G-code as
 * `M98 P"..."` — a name with a quote in it ends the string early and the rest
 * of the name becomes parameters. Rather than work out which of those a given
 * name will meet, the character set is narrowed to what is unambiguous
 * everywhere: letters, digits, space, dot, dash, underscore and brackets.
 *
 * Returns an empty string when nothing usable is left, which the caller reports
 * rather than silently inventing a name.
 */
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9 ._()-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;

  // Truncate the stem, never the extension: the extension is what decides
  // whether the file can be read back at all.
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  return `${cleaned.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length))}${ext}`;
}

/**
 * The bytes as a plain ArrayBuffer, which is what font parsers take.
 *
 * A Uint8Array can be a window onto a larger buffer, and handing that buffer to
 * a parser would give it whatever else is in there as well — offsets inside a
 * font are from the start of the file, so the result is not a parse failure but
 * garbage read from the wrong place. Copy unless the view is the whole buffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
