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

import { normaliseControllerUrl } from '../core/util.js';
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
  return (await probeManifest(base)).manifest;
}

/**
 * Read a manifest and, when there isn't one, say why.
 *
 * readManifest collapses every failure into null, which is right for "is
 * anything installed here" and wrong immediately afterwards: an install that
 * cannot read its own work back needs to tell the operator whether the file was
 * missing, the board refused the request, or the browser never got an answer at
 * all. Those have nothing to do with each other, and guessing at one of them in
 * the error message sends people to check the wrong thing.
 */
export async function probeManifest(
  base: string,
): Promise<{ manifest: BuildManifest | null; reason: string | null }> {
  let url: string;
  try {
    url = new URL('build.json', base).href;
  } catch {
    // Reported rather than thrown. This is the failure the whole function
    // exists to describe, and a raw TypeError out of here lands in the panel as
    // a message about URL parsing with no hint that the address box is where
    // the fix is.
    return {
      manifest: null,
      reason: `"${base}" is not a usable address — it needs a scheme, as in http://${base.replace(/^\/+/, '')}`,
    };
  }
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    return { manifest: null, reason: `${url} could not be reached (${(err as Error).message})` };
  }
  if (!res.ok) {
    return { manifest: null, reason: `${url} answered HTTP ${res.status}` };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // RepRapFirmware answers a path it cannot resolve by serving /www/index.html
    // rather than a 404, so a missing file arrives as a page of HTML with a 200
    // on it. Saying "not JSON" here is what stops that looking like corruption.
    return { manifest: null, reason: `${url} did not return JSON — the file is probably not there` };
  }
  if (!isManifest(json)) {
    return { manifest: null, reason: `${url} is not a build manifest` };
  }
  return { manifest: json, reason: null };
}

/**
 * Read the manifest back off the card, through the driver.
 *
 * This is the check that says whether an install worked, and it deliberately
 * does not go near the machine's web server. The files were written with the
 * driver's own file API, so reading them back the same way asks exactly one
 * question — did the bytes land — over a channel already proven to work by the
 * twenty uploads that just went through it.
 *
 * The web server is a separate question with separate ways to fail: it needs a
 * usable address, it needs `/www` mapped, and from another computer it needs
 * CORS. Every one of those can be broken while the copy on the card is perfect,
 * and conflating them is what made a working install report itself as a failed
 * one. So whether the machine SERVES the copy is asked separately, and answered
 * as a caveat rather than as a failure.
 */
export async function verifyInstalled(
  driver: MachineDriver,
  dir = INSTALL_DIR,
): Promise<{ manifest: BuildManifest | null; reason: string | null }> {
  const path = `${dir}/build.json`;
  let text: string;
  try {
    text = new TextDecoder().decode(await driver.readFile(path));
  } catch (err) {
    return { manifest: null, reason: `${path} could not be read back (${(err as Error).message})` };
  }
  try {
    const json: unknown = JSON.parse(text);
    return isManifest(json)
      ? { manifest: json, reason: null }
      : { manifest: null, reason: `${path} is not a build manifest` };
  } catch {
    return { manifest: null, reason: `${path} came back as something that is not JSON` };
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
  // Normalised rather than trusted. The catch below used to hand back the
  // address with the path glued on, which for an address typed without a
  // scheme — `192.168.1.9`, the normal thing to type — is a string that is not
  // a URL at all. Everything downstream then failed inside `new URL`, a long
  // way from the address box, and the Install panel read that as the machine
  // refusing to serve files it had just accepted.
  const base = normaliseControllerUrl(controllerUrl);
  try {
    return new URL(`${path}/`, base).href;
  } catch {
    return `${base}${path}/`;
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
  const base = normaliseControllerUrl(controllerUrl);
  try {
    return new URL(path, base).href;
  } catch {
    return `${base}${path}`;
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
