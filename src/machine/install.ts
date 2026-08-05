// Putting Axis Control on the machine.
//
// RepRapFirmware serves `/www` over HTTP, so a copy of this app written to
// `/www/AxisControl` is reachable at `http://<machine>/AxisControl/` — beside
// DWC rather than instead of it, which matters because DWC is the thing you
// fall back to when this app is the problem.
//
// Two things follow from being served by the machine, and both are the point:
//
//   - There is no CORS. The page and the `rr_*` API are the same origin, so
//     nothing depends on `M586 C"*"` and nothing is one browser upgrade away
//     from being blocked.
//   - There is no second computer. A tablet on the shop floor loads the app
//     from the machine it is driving, with nothing else switched on.
//
// Nothing here writes outside the install directory. `/www/AxisControl` is
// created if missing and only files named in the build manifest are written, so
// a mistake cannot take DWC with it.

import type { MachineDriver } from './driver.js';
import { BUILD, type BuildStamp } from '../core/build.js';

/** Where a copy lives on the SD card, and what URL that makes it. */
export const INSTALL_DIR = '/www/AxisControl';

/** The manifest a build writes about itself. */
export interface BuildManifest extends BuildStamp {
  builtAt: string;
  /** Every file that makes up a deployed copy, relative to the root. */
  files: string[];
}

export interface InstallProgress {
  /** Files written so far, and how many there are. */
  done: number;
  total: number;
  /** The file being written now. */
  file: string;
  /** Bytes written so far, across all files. */
  bytes: number;
}

export class InstallError extends Error {}

/** The URL this copy of the app was served from, with a trailing slash. */
export function ownOrigin(): string {
  return new URL('.', document.baseURI).href;
}

function isManifest(value: unknown): value is BuildManifest {
  const m = value as Partial<BuildManifest> | null;
  return !!m && typeof m.version === 'string' && Array.isArray(m.files) && m.files.length > 0;
}

/**
 * Read the manifest of the copy at `base`.
 *
 * Used three ways: on this copy, to know what would be installed; on the
 * machine, to know what is already there; and after an install, to confirm what
 * landed. Returns null rather than throwing when there is simply nothing there,
 * because "not installed yet" is the normal first answer.
 */
export async function readManifest(base: string): Promise<BuildManifest | null> {
  try {
    const res = await fetch(new URL('build.json', base).href, { cache: 'no-store' });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return isManifest(json) ? json : null;
  } catch {
    return null;
  }
}

/** Fetch every file a manifest names, from the copy that published it. */
export async function fetchBuild(
  base: string,
  manifest: BuildManifest,
  onFile?: (name: string, done: number, total: number) => void,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let done = 0;
  for (const name of manifest.files) {
    onFile?.(name, done, manifest.files.length);
    const res = await fetch(new URL(name, base).href, { cache: 'no-store' });
    if (!res.ok) {
      throw new InstallError(`${name} could not be read from this copy (HTTP ${res.status})`);
    }
    files.set(name, new Uint8Array(await res.arrayBuffer()));
    done++;
  }
  return files;
}

/**
 * Write a set of files into a directory on the machine.
 *
 * Directories are created before the files that need them, deepest last: RRF
 * will not create a parent implicitly, and an upload into a directory that does
 * not exist fails with an error code that says nothing about why.
 *
 * An existing file is simply overwritten. Nothing is deleted first — a
 * half-installed copy with the old files still in place is a working old copy,
 * whereas a wiped directory that then fails to upload is a machine serving a
 * blank page.
 */
export async function installBuild(
  driver: MachineDriver,
  dir: string,
  files: Map<string, Uint8Array>,
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  const names = [...files.keys()];

  const directories = new Set<string>([dir]);
  for (const name of names) {
    const parts = name.split('/').slice(0, -1);
    let at = dir;
    for (const part of parts) {
      at = `${at}/${part}`;
      directories.add(at);
    }
  }
  for (const path of [...directories].sort((a, b) => a.length - b.length)) {
    try {
      await driver.makeDirectory(path);
    } catch {
      // Already there. RRF reports that as an error and there is no way to ask
      // first, so the only distinction available is whether the uploads work.
    }
  }

  let done = 0;
  let bytes = 0;
  for (const name of names) {
    const data = files.get(name)!;
    onProgress?.({ done, total: names.length, file: name, bytes });
    await driver.writeFile(`${dir}/${name}`, data);
    done++;
    bytes += data.length;
    onProgress?.({ done, total: names.length, file: name, bytes });
  }
}

/**
 * Write the manifest last, once every file it names is on the machine.
 *
 * Deliberately not part of the upload above. The manifest is what says "a
 * complete copy of this version is installed", and writing it first would make
 * an install that died halfway claim to be finished — after which the update
 * check would see the right version and never repair it.
 */
export async function sealInstall(
  driver: MachineDriver,
  dir: string,
  manifest: BuildManifest,
): Promise<void> {
  const body = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await driver.writeFile(`${dir}/build.json`, body);
}

/** Total size of a fetched build, for the "this will upload N MB" line. */
export function totalBytes(files: Map<string, Uint8Array>): number {
  let n = 0;
  for (const data of files.values()) n += data.length;
  return n;
}

/**
 * The directory an install lives at, as a URL. Ends in a slash so it can be
 * used as a base for the files inside it.
 *
 * Built from the controller URL rather than assembled from a hostname, so a
 * machine on a non-standard port keeps it.
 *
 * This is NOT a URL to open. See `entryUrl`.
 */
export function installedUrl(controllerUrl: string, dir = INSTALL_DIR): string {
  const path = dir.replace(/^\/www/, '');
  try {
    return new URL(`${path}/`, controllerUrl).href;
  } catch {
    return `${controllerUrl.replace(/\/+$/, '')}${path}/`;
  }
}

/**
 * The URL to actually open, which names index.html explicitly.
 *
 * RepRapFirmware has no directory index. A request for `/AxisControl` or
 * `/AxisControl/` resolves to no file, and the firmware's answer to a path it
 * cannot resolve is to serve `/www/index.html` — which is DWC. DWC's router
 * then finds no such route and renders its own "404 page not found", inside its
 * own shell.
 *
 * That is a confusing symptom, because it is a 200 with a 404 drawn on it, from
 * an application that is not this one. It means the request never reached these
 * files, not that the files are missing.
 */
export function entryUrl(controllerUrl: string, dir = INSTALL_DIR): string {
  return `${installedUrl(controllerUrl, dir)}index.html`;
}

/**
 * A one-line page at `/www/<name>.html` that redirects to the real entry point.
 *
 * The only way to get a short URL out of a firmware with no directory index:
 * `/AxisControl.html` has an extension, so it resolves to a file, and that file
 * sends the browser on to `/AxisControl/index.html` where the relative asset
 * paths work.
 *
 * It is the one thing this writes outside the install directory, which is why
 * it is a choice rather than a default of the copying. It cannot collide with
 * DWC: DWC ships `index.html` and a `css/`, `js/` and `fonts/` tree, and no
 * top-level page named after this app.
 */
export function shortcutPath(dir = INSTALL_DIR): string {
  return `${dir}.html`;
}

export function shortcutUrl(controllerUrl: string, dir = INSTALL_DIR): string {
  const path = shortcutPath(dir).replace(/^\/www/, '');
  try {
    return new URL(path, controllerUrl).href;
  } catch {
    return `${controllerUrl.replace(/\/+$/, '')}${path}`;
  }
}

export async function writeShortcut(driver: MachineDriver, dir = INSTALL_DIR): Promise<void> {
  const target = `${dir.replace(/^\/www/, '')}/index.html`;
  // A meta refresh rather than a script: it works with scripting disabled, it
  // needs no framework, and it is understood by every browser this app claims
  // to support — including the iOS 12 iPad this project keeps in scope.
  const html =
    '<!doctype html>\n<meta charset="utf-8">\n' +
    `<meta http-equiv="refresh" content="0; url=${target}">\n` +
    '<title>Axis Control</title>\n' +
    `<p>Continue to <a href="${target}">Axis Control</a>.</p>\n`;
  await driver.writeFile(shortcutPath(dir), new TextEncoder().encode(html));
}

/**
 * Confirm the entry point serves this app rather than the one already there.
 *
 * The check that matters, and the one whose absence let a broken install look
 * finished: every file can upload successfully and the page can still be DWC,
 * because whether the firmware routes a URL to a file is a separate question
 * from whether the file exists.
 */
export async function entryServesUs(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return false;
    const html = await res.text();
    // Our own entry, by the bundle it loads. DWC's index names its own chunks
    // and never this.
    return /src="cnc\.js/.test(html);
  } catch {
    return false;
  }
}

/** True when this copy is the one already installed on the machine. */
export function isSameBuild(a: BuildStamp | null, b: BuildStamp | null): boolean {
  return !!a && !!b && a.version === b.version && a.commit === b.commit;
}

export { BUILD };
