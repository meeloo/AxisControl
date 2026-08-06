// Our object-model merge, checked against Duet3D's own implementation.
//
// merge.ts is 50 lines reimplementing RepRapFirmware's patch semantics, and
// those semantics are subtle in exactly the way that produces a wrong number on
// screen rather than a crash: arrays keyed by position, elements that mean "no
// change", shortened arrays that mean "these were deleted".
//
// @duet3d/objectmodel is the implementation DWC ships, so it is the closest
// thing to a reference. It is used here as an ORACLE, not as a dependency — it
// is installed for the test and never enters the bundle. Where the two
// disagree, one of them is wrong, and the one that is not shipped by the people
// who define the protocol is the likelier candidate.
//
// Comparison is restricted to the paths the patches actually touch. ObjectModel
// is a fully typed tree with a default for every field RRF can emit; comparing
// whole trees would drown the real differences in fields nobody sent.
//
// Run it with `npm run merge-oracle`. It compiles merge.ts itself, so there is
// nothing to keep in step by hand.

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from '@duet3d/objectmodel';

const { ObjectModel } = pkg;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'merge-oracle-'));
const out = join(dir, 'merge.mjs');
await build({
  entryPoints: [join(root, 'src/machine/drivers/rrf/merge.ts')],
  bundle: true, format: 'esm', outfile: out, logLevel: 'error',
});
const { mergeInto } = await import(pathToFileURL(out).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`);
  if (!c) fails.push(w);
};

// Divergences that are known and deliberately not resolved here.
//
// Leaving one on the list is a real cost — it is how a test quietly stops
// testing — so each needs the evidence that would settle it, and anything NOT
// on the list still fails loudly.
const KNOWN = new Set(['a null array element']);
const known = (name, diffs) => {
  console.log(`KNOWN ${name}`);
  for (const d of diffs.slice(0, 2)) console.log(`      ${d}`);
};

/** Every leaf path in a patch, as arrays of keys/indices. */
function paths(patch, prefix = []) {
  if (patch === null || typeof patch !== 'object') return [prefix];
  if (Array.isArray(patch)) {
    return patch.flatMap((v, i) => paths(v, [...prefix, i]));
  }
  return Object.entries(patch).flatMap(([k, v]) => paths(v, [...prefix, k]));
}

function at(tree, path) {
  let cur = tree;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Plain JSON view of an ObjectModel node, so values compare like for like. */
function plain(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

/**
 * Run one sequence through both implementations.
 *
 * The first patch is the full model — that is how a session starts, and both
 * sides need the same starting tree or nothing after it is comparable.
 */
function compare(name, patches) {
  let ours = {};
  const theirs = new ObjectModel();
  for (const patch of patches) {
    ours = mergeInto(ours, patch);
    theirs.update(patch);
  }

  const touched = paths(patches[patches.length - 1]);
  const diffs = [];
  for (const path of touched) {
    const a = plain(at(ours, path));
    const b = plain(at(theirs, path));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`${path.join('.')}: ours=${JSON.stringify(a)} theirs=${JSON.stringify(b)}`);
    }
  }
  if (diffs.length && KNOWN.has(name)) known(name, diffs);
  else ok(diffs.length === 0, name, diffs.slice(0, 4).join(' | '));
  return diffs;
}

// A model shaped like the one the driver actually holds, trimmed to the keys
// the patches below touch.
const full = {
  state: { status: 'idle', currentTool: 1, machineMode: 'CNC', upTime: 10 },
  move: {
    axes: [
      { letter: 'X', machinePosition: 0, userPosition: 0, homed: true, min: 0, max: 750, visible: true },
      { letter: 'Y', machinePosition: 0, userPosition: 0, homed: true, min: 0, max: 1500, visible: true },
      { letter: 'Z', machinePosition: 100, userPosition: 100, homed: true, min: 0, max: 135, visible: true },
      { letter: 'U', machinePosition: 50, userPosition: 30, homed: true, min: 0, max: 70, visible: true },
    ],
    workplaceNumber: 0,
  },
  tools: [
    { number: 1, name: 'Spindle tool 1', offsets: [0, 0, -12.5] },
    { number: 2, name: 'Spindle tool 2', offsets: [0, 0, 0] },
  ],
};

// --- The everyday case: a live patch carrying only what changed -------------
compare('a live patch updates positions without blanking the verbose fields', [
  full,
  { move: { axes: [{ machinePosition: 12.5 }, { machinePosition: 3 }, {}, {}] } },
]);

// --- The wrinkle merge.ts documents: a null element ------------------------
//
// KNOWN DIVERGENCE, and the only one.
//
//   ours   — "null element = no change to this element", keep what we had.
//   theirs — null replaces the item: there is nothing at this index now.
//
// Neither reading is documented. docs.duet3d.com describes seqs and per-key
// fetches but says nothing about what a null array element means in a patch,
// and the object model reference only uses "null if unknown" about scalar
// fields.
//
// What settles it is one look at the real machine, which the mock cannot
// answer because the mock is ours:
//
//   open  http://sebscnc.local/rr_model?flags=d99fn  twice with nothing moving
//
// If unchanged array items come back as {} then null must mean "absent", ours
// is wrong, and the fix is to drop the null branch in merge.ts so a null
// overwrites. If they come back as null, ours is right and theirs would blank
// every axis on every tick.
//
// The impact either way is narrow, which is why this is not being changed on a
// guess: a permanently-absent element (tools[0] on a machine whose tools start
// at T1) is set to null by the first full fetch and stays null under both
// readings — see the case below. Only an element that goes from present to
// null diverges, which is a tool or sensor being deleted while connected.
compare('a null array element', [
  full,
  { move: { axes: [{ machinePosition: 1 }, null, null, null] } },
]);

// The boundary of that divergence: an element that is null from the start
// agrees under both readings, which is the common case on this machine.
compare('an element that was never there stays null', [
  { ...full, tools: [null, { number: 1, name: 'Spindle tool 1' }] },
  { tools: [null, { name: 'Renamed' }] },
]);

// --- A shortened array means items were removed ----------------------------
compare('a shortened array removes the tools that are gone', [
  full,
  { tools: [{ number: 1 }] },
]);

// --- A longer array adds them ----------------------------------------------
compare('a longer array adds one', [
  full,
  { tools: [{ number: 1 }, { number: 2 }, { number: 3, name: 'New', offsets: [0, 0, 0] }] },
]);

// --- Arrays of plain numbers, which are a different code path --------------
compare('an array of numbers is replaced, not merged element-wise', [
  full,
  { tools: [{ number: 1, offsets: [1, 2, 3] }, {}] },
]);

// --- Nested object, partially specified ------------------------------------
compare('a nested object keeps the siblings the patch did not mention', [
  full,
  { state: { status: 'busy' } },
]);

// --- Several patches in a row, as a session actually runs -------------------
compare('a run of patches', [
  full,
  { move: { axes: [{ machinePosition: 5 }, {}, {}, {}] } },
  { state: { status: 'busy' } },
  { move: { axes: [{ machinePosition: 10 }, { machinePosition: 20 }, {}, {}] } },
  { state: { status: 'idle' }, move: { axes: [{ homed: false }, {}, {}, {}] } },
]);

console.log(fails.length ? `\n${fails.length} DIVERGED: ${fails.join(", ")}` : "\nno divergence beyond the known one");
process.exit(fails.length ? 1 : 0);
