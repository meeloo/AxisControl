// What this copy of the app is.
//
// Substituted at build time by esbuild's `define`, so it costs nothing at
// runtime and cannot drift from the bundle it describes. The fallback is what
// typecheck and any non-esbuild consumer see; it says "unknown" rather than a
// plausible number, because a wrong version is worse than an absent one when
// the question being asked is "should this be replaced?".

declare const __BUILD__: { version: string; commit: string } | undefined;

export interface BuildStamp {
  version: string;
  /** Short commit hash, with a trailing `+` when the tree was dirty. */
  commit: string;
}

export const BUILD: BuildStamp =
  typeof __BUILD__ === 'undefined' ? { version: '0.0.0', commit: 'unknown' } : __BUILD__;

/** A build made from uncommitted work. Never offer to publish one as an update. */
export function isDirtyBuild(stamp: BuildStamp = BUILD): boolean {
  return stamp.commit.endsWith('+') || stamp.commit === 'unknown';
}

export function describeBuild(stamp: BuildStamp): string {
  return `${stamp.version} (${stamp.commit})`;
}

/**
 * Compare two version strings the way releases are numbered.
 *
 * Returns >0 when `a` is newer. Non-numeric parts sort as 0, so `v1.2.0` and
 * `1.2.0` compare equal — a release tag is written both ways depending on who
 * set it up, and treating those as different versions would offer an update
 * that installs the same thing for ever.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v.replace(/^v/i, '').split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
