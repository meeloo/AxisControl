// Getting hold of the G-code index.
//
// One fetch per page, shared by the reference panel and by every box that
// completes G-code. Split out of the panel because completion happens in places
// the panel is not open — the console works whether or not anyone has ever
// looked at the reference.

import type { GcodeIndex } from './types.js';

let loading: Promise<GcodeIndex> | null = null;
let loaded: GcodeIndex | null = null;

export function loadIndex(): Promise<GcodeIndex> {
  loading ??= fetch(new URL('gcodes.json', document.baseURI).href)
    .then((res) => {
      if (!res.ok) throw new Error(`the reference is not on the machine (HTTP ${res.status})`);
      return res.json() as Promise<GcodeIndex>;
    })
    .then((index) => ((loaded = index), index))
    .catch((err) => {
      // Cleared so a retry is possible; a failed fetch cached for ever would
      // mean the panel never worked again without a reload.
      loading = null;
      throw err;
    });
  return loading;
}

/**
 * The index if it is already here, else null.
 *
 * For completion, which runs on a keystroke and cannot wait: no index yet means
 * no popup this time round, and the next keystroke will have it. Silence is the
 * right failure — a box that stalls between characters is worse than one that
 * does not suggest.
 */
export function peekIndex(): GcodeIndex | null {
  return loaded;
}
