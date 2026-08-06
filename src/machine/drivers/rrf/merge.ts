// Deep-merge for object-model patches.
//
// The per-tick `rr_model?flags=d99fn` response carries only frequently-changing
// values, laid over the same tree shape as the full model. Merging rather than
// replacing keeps the verbose fields (axis limits, tool names, board identity)
// that only arrive on a full per-key fetch.
//
// Arrays are merged element-wise because RRF reports live array members in
// place — `move.axes[1].machinePosition` arrives without the axis's `letter`
// or `min`/`max`. Replacing the array wholesale would blank those every tick.
//
// Two RRF-specific wrinkles, both settled against a real board rather than
// guessed at — see tools/merge-oracle.mjs, which checks this file against
// @duet3d/objectmodel, the implementation DWC ships.
//
// A shortened array means items were removed (a tool was deleted), so we
// truncate to the patch length.
//
// A `null` element means there is nothing at that index — an empty slot, not
// an unchanged one. This file used to claim the opposite, and it was wrong.
// A d99fn response carries every array element in full on every tick, so
// there is no "unchanged" placeholder for null to be: on this machine
// tools[0] is null because tools start at T1, and sensors.gpIn arrives as
// [null,null,null,null,null,null,{"value":1}]. Reading null as "keep what we
// had" only ever differed when an element went from present to absent — a
// tool or sensor deleted while connected — and there it kept a stale object
// on screen for the rest of the session.

export function mergeInto<T>(target: T, patch: unknown): T {
  if (patch === null || patch === undefined) return target;

  if (Array.isArray(patch)) {
    const base = Array.isArray(target) ? (target as unknown[]) : [];
    const out: unknown[] = base.slice(0, patch.length);
    for (let i = 0; i < patch.length; i++) {
      const item = patch[i];
      if (item === null) {
        // Nothing at this index. Overwrite rather than keep — see above.
        out[i] = null;
        continue;
      }
      out[i] = isPlainObject(item) || Array.isArray(item) ? mergeInto(out[i], item) : item;
    }
    return out as unknown as T;
  }

  if (isPlainObject(patch)) {
    const base: Record<string, unknown> = isPlainObject(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
    for (const [k, v] of Object.entries(patch)) {
      base[k] =
        isPlainObject(v) || Array.isArray(v) ? mergeInto(base[k], v) : v;
    }
    return base as unknown as T;
  }

  return patch as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
