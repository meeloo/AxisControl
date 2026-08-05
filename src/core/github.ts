// Reading releases off GitHub, from a browser, with no proxy and no token.
//
// Two facts make this possible and neither is obvious:
//
//   - `api.github.com` sends `Access-Control-Allow-Origin: *` on public
//     endpoints, so any page may read the release list.
//   - An asset's `browser_download_url` redirects to
//     `objects.githubusercontent.com`, which sends the same header, so the
//     bytes are readable too.
//
// And a page served over plain HTTP may fetch HTTPS freely — mixed content is
// the other direction — so the copy of this app running on the Duet can do all
// of it without anything else being switched on.
//
// Unauthenticated calls are limited to 60 an hour per address, shared with
// everything else on that network. One call lists twenty releases, so asking
// occasionally is fine and asking on every render is not.

export const GITHUB_API = 'https://api.github.com';

export class GitHubError extends Error {}

export interface GhAsset {
  name: string;
  url: string;
  size: number;
}

export interface GhRelease {
  /** The tag, as published — `3.6.1` or `v3.6.1`, depending on the project. */
  tag: string;
  name: string;
  prerelease: boolean;
  publishedAt: string;
  notes: string;
  htmlUrl: string;
  assets: GhAsset[];
}

function asset(raw: Record<string, unknown>): GhAsset | null {
  const name = typeof raw?.name === 'string' ? raw.name : '';
  const url = typeof raw?.browser_download_url === 'string' ? raw.browser_download_url : '';
  if (!name || !url) return null;
  return { name, url, size: typeof raw.size === 'number' ? raw.size : 0 };
}

/**
 * Releases for a repository, newest first, drafts dropped.
 *
 * `/releases` rather than `/releases/latest`: latest excludes prereleases, and
 * a prerelease is exactly what someone tracking a beta is looking for. Drafts
 * are visible only to the repository's own maintainers and are not something
 * anybody else can install.
 */
export async function fetchReleases(
  repo: string,
  api: string = GITHUB_API,
  perPage = 20,
): Promise<GhRelease[]> {
  let res: Response;
  try {
    res = await fetch(`${api}/repos/${repo}/releases?per_page=${perPage}`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
  } catch (err) {
    throw new GitHubError(`GitHub could not be reached: ${(err as Error).message}`);
  }
  if (res.status === 403 || res.status === 429) {
    throw new GitHubError(
      'GitHub is rate-limiting this address (60 requests an hour, unauthenticated). Try again later.',
    );
  }
  if (res.status === 404) throw new GitHubError(`No such repository: ${repo}`);
  if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}`);

  const json: unknown = await res.json();
  if (!Array.isArray(json)) throw new GitHubError('GitHub returned something unexpected');

  const out: GhRelease[] = [];
  for (const raw of json as Array<Record<string, unknown>>) {
    if (!raw || raw.draft === true) continue;
    const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
    if (!tag) continue;
    out.push({
      tag,
      name: typeof raw.name === 'string' && raw.name ? raw.name : tag,
      prerelease: raw.prerelease === true,
      publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
      notes: typeof raw.body === 'string' ? raw.body : '',
      htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
      assets: Array.isArray(raw.assets)
        ? (raw.assets as Array<Record<string, unknown>>).map(asset).filter((a): a is GhAsset => a !== null)
        : [],
    });
  }
  return out;
}

/** Download an asset, reporting progress when the length is known. */
export async function fetchAsset(
  url: string,
  expected: number | null = null,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new GitHubError(`The download could not be started: ${(err as Error).message}`);
  }
  if (!res.ok) throw new GitHubError(`The download answered ${res.status}`);

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
