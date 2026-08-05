// Checking GitHub for a newer Axis Control, and fetching it.
//
// Both halves work from a browser without a proxy, which is not obvious and is
// the reason this is possible at all:
//
//   - `api.github.com` sends `Access-Control-Allow-Origin: *` on public
//     endpoints, so the release list is readable from any page.
//   - A release asset's download URL redirects to `objects.githubusercontent.com`,
//     which sends the same header, so the zip itself is readable too.
//
// And a page served over plain HTTP from the machine may fetch HTTPS freely —
// mixed content is the other direction. So a copy of the app running on the
// Duet can update itself, which is the case that matters: that copy has no
// developer's laptop behind it.
//
// The rate limit is 60 requests an hour for an unauthenticated caller, shared
// by everything on that IP. A check is one request, so a daily check has room
// to spare and a check-on-every-load would not.

import { unzip, looksLikeZip } from '../core/zip.js';
import { loadSetting } from '../core/store.js';
import { compareVersions, BUILD, type BuildStamp } from '../core/build.js';
import type { BuildManifest } from './install.js';

/** Where releases come from. */
export const REPO = 'meeloo/AxisControl';

const API = 'https://api.github.com';

export interface UpdateSource {
  /** owner/name. */
  repo: string;
  /** API root, without a trailing slash. */
  api: string;
}

/**
 * Which repository to take updates from.
 *
 * Settable because a fork is a normal thing to be running — someone with their
 * own machine-specific changes should get their own releases, not this one's,
 * and hard-coding the repository is what forces them to give the feature up.
 */
export function updateSource(): UpdateSource {
  const stored = loadSetting<Partial<UpdateSource>>('updateSource', {});
  return {
    repo: stored.repo?.trim() || REPO,
    api: stored.api?.trim().replace(/\/+$/, '') || API,
  };
}

/** Don't ask GitHub more than this often. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class UpdateError extends Error {}

export interface Release {
  /** The tag, as published — `v1.2.0` or `1.2.0`. */
  tag: string;
  name: string;
  prerelease: boolean;
  publishedAt: string;
  notes: string;
  /** Direct download for the build zip, or null when the release has none. */
  zipUrl: string | null;
  zipBytes: number;
  htmlUrl: string;
}

interface GhAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GhRelease {
  tag_name?: unknown;
  name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  published_at?: unknown;
  body?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

/**
 * The build zip out of a release's assets.
 *
 * By extension rather than by exact name, so renaming the artefact in the
 * workflow does not strand every installed copy on the version before the
 * rename — the one update that could never be delivered.
 *
 * GitHub's own auto-generated source archives are excluded: they are not in
 * `assets` at all, which is what makes this safe. A source zip installed as if
 * it were a build would put `src/` on the machine and serve nothing.
 */
function zipAsset(assets: unknown): { url: string; size: number } | null {
  if (!Array.isArray(assets)) return null;
  for (const raw of assets as GhAsset[]) {
    const name = typeof raw?.name === 'string' ? raw.name : '';
    const url = typeof raw?.browser_download_url === 'string' ? raw.browser_download_url : '';
    if (url && /\.zip$/i.test(name)) {
      return { url, size: typeof raw.size === 'number' ? raw.size : 0 };
    }
  }
  return null;
}

function toRelease(raw: GhRelease): Release | null {
  const tag = typeof raw?.tag_name === 'string' ? raw.tag_name : '';
  if (!tag) return null;
  const zip = zipAsset(raw.assets);
  return {
    tag,
    name: typeof raw.name === 'string' && raw.name ? raw.name : tag,
    prerelease: raw.prerelease === true,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    notes: typeof raw.body === 'string' ? raw.body : '',
    zipUrl: zip?.url ?? null,
    zipBytes: zip?.size ?? 0,
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${REPO}/releases`,
  };
}

/**
 * Published releases, newest first.
 *
 * `/releases` rather than `/releases/latest`, because `latest` excludes
 * prereleases and this app is the sort of thing that lives on a beta for
 * months. Drafts are dropped — they are visible only to the repository owner
 * and are not something to install.
 */
export async function listReleases(source: UpdateSource = updateSource()): Promise<Release[]> {
  const { repo, api } = source;
  let res: Response;
  try {
    res = await fetch(`${api}/repos/${repo}/releases?per_page=20`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
  } catch (err) {
    throw new UpdateError(`GitHub could not be reached: ${(err as Error).message}`);
  }
  if (res.status === 403 || res.status === 429) {
    throw new UpdateError(
      'GitHub is rate-limiting this address (60 requests an hour, unauthenticated). Try again later.',
    );
  }
  if (res.status === 404) throw new UpdateError(`No such repository: ${repo}`);
  if (!res.ok) throw new UpdateError(`GitHub answered ${res.status}`);

  const json: unknown = await res.json();
  if (!Array.isArray(json)) throw new UpdateError('GitHub returned something unexpected');
  return (json as GhRelease[])
    .filter((r) => r?.draft !== true)
    .map(toRelease)
    .filter((r): r is Release => r !== null);
}

/**
 * The newest release worth offering, or null.
 *
 * `stable` skips prereleases. Releases with no build zip are skipped whatever
 * the setting: a tag with nothing attached cannot be installed, and offering it
 * would be an update button that fails every time it is pressed.
 */
export function newestInstallable(releases: Release[], includeBetas: boolean): Release | null {
  const usable = releases.filter((r) => r.zipUrl && (includeBetas || !r.prerelease));
  if (!usable.length) return null;
  return usable.reduce((best, r) => (compareVersions(r.tag, best.tag) > 0 ? r : best));
}

/**
 * Whether `release` is a later version than `current`.
 *
 * A plain version comparison, with no opinion about how `current` was built.
 * The dirty-build state deliberately does not suppress this: what this question
 * is asked about is the copy on the machine, and a machine running something
 * built from uncommitted work is exactly the case where being able to put a
 * published release back matters most.
 */
export function isNewer(release: Release, current: BuildStamp = BUILD): boolean {
  return compareVersions(release.tag, current.version) > 0;
}

/**
 * Download a release zip and unpack it into the same shape `installBuild` takes.
 *
 * The zip is expected to hold the contents of `dist` — with or without a
 * wrapping directory, since whether a zip has one depends on how it was made
 * and getting that wrong installs a copy one level down that serves nothing.
 * The manifest inside it is authoritative about which files belong.
 */
export async function fetchRelease(
  release: Release,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<{ manifest: BuildManifest; files: Map<string, Uint8Array> }> {
  if (!release.zipUrl) throw new UpdateError(`${release.tag} has no build attached to it`);

  let res: Response;
  try {
    res = await fetch(release.zipUrl, { cache: 'no-store' });
  } catch (err) {
    throw new UpdateError(`The download could not be started: ${(err as Error).message}`);
  }
  if (!res.ok) throw new UpdateError(`The download answered ${res.status}`);

  const bytes = await readAll(res, release.zipBytes || null, onProgress);
  if (!looksLikeZip(bytes)) {
    throw new UpdateError(`${release.tag}'s attachment is not a zip`);
  }

  const entries = await unzip(bytes);
  // Strip a single common leading directory, if every entry shares one.
  const root = commonPrefix(entries.map((e) => e.name));
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const name = entry.name.slice(root.length);
    // Directory records, and anything that tries to climb out of the target.
    if (!name || name.endsWith('/') || name.includes('..')) continue;
    files.set(name, entry.bytes);
  }

  const manifestBytes = files.get('build.json');
  if (!manifestBytes) {
    throw new UpdateError(
      `${release.tag}'s zip has no build.json, so there is no way to know what it contains`,
    );
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BuildManifest;
  files.delete('build.json');

  const missing = manifest.files.filter((f) => !files.has(f));
  if (missing.length) {
    throw new UpdateError(
      `${release.tag}'s zip is missing ${missing.length} file(s) its own manifest names: ${missing.slice(0, 3).join(', ')}`,
    );
  }
  // Only what the manifest names, so a stray file in the archive is not served.
  for (const name of [...files.keys()]) {
    if (!manifest.files.includes(name)) files.delete(name);
  }

  return { manifest, files };
}

/** The directory prefix every name shares, or '' — `dist/` on most zips. */
function commonPrefix(names: string[]): string {
  if (!names.length) return '';
  const first = names[0];
  const slash = first.indexOf('/');
  if (slash < 0) return '';
  const candidate = first.slice(0, slash + 1);
  return names.every((n) => n.startsWith(candidate)) ? candidate : '';
}

async function readAll(
  res: Response,
  expected: number | null,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : expected;

  if (!res.body) {
    const buffer = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buffer.length, total);
    return buffer;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
