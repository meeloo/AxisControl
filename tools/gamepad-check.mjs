// Reading a physical stick, checked against a fake one.
//
// Everything here is a convention that is invisible until a machine moves the
// wrong way, and then obvious:
//
//   the Gamepad API's Y axis is positive TOWARD the operator, because it
//     describes screen space — so pushing the stick away gives −1 and the sign
//     has to be flipped for a table where away is Y+
//   the deadman has to be satisfied by the buttons a hand actually rests on,
//     and by nothing else — a deadman answered by the A button is not a deadman
//   an unplugged pad has to arrive as an event, not as silence, because a
//     caller that only ever hears readings would go on holding the last one
//
// None of that can be seen by reading the code with confidence, and none of it
// needs a browser to check: the API is a function returning an array, so a fake
// one exercises the real module. What this does NOT cover is the browser's own
// driver layer or the panel's use of it — see the note at the end.
//
// Run it with `npm run gamepad-check`.

import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- The fake pad, installed before the module loads ------------------------
// padSupported is decided at import time, so this has to be in place first.

let attached = null;
const kv = new Map();
globalThis.localStorage = {
  getItem: (k) => (kv.has(k) ? kv.get(k) : null),
  setItem: (k, v) => kv.set(k, String(v)),
  removeItem: (k) => kv.delete(k),
  clear: () => kv.clear(),
};
// defineProperty, not assignment: Node has its own `navigator` and exposes it
// through a getter only, so `globalThis.navigator = …` throws.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  // The real API returns a sparse array with nulls in the empty slots, which is
  // the shape the module has to survive.
  value: { getGamepads: () => (attached ? [attached] : [null]) },
});
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.location = { href: 'http://x/', origin: 'http://x', protocol: 'http:', host: 'x' };
globalThis.document = { hidden: false, baseURI: 'http://x/', addEventListener() {} };

// A hand-driven animation clock, so the poll loop runs exactly when asked.
let frames = [];
let frameId = 0;
const cancelled = new Set();
globalThis.requestAnimationFrame = (cb) => { const id = ++frameId; frames.push([id, cb]); return id; };
globalThis.cancelAnimationFrame = (id) => cancelled.add(id);
const step = () => {
  const due = frames;
  frames = [];
  for (const [id, cb] of due) if (!cancelled.has(id)) cb();
};

const pad = (axes = [0, 0, 0, 0], buttons = []) => ({
  id: 'Fake Pad (STANDARD GAMEPAD)',
  index: 0,
  axes,
  buttons: Array.from({ length: 8 }, (_, i) => ({ pressed: buttons.includes(i) })),
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'pad-'));
const out = join(dir, 'p.mjs');
const entry = join(dir, 'entry.ts');
await writeFile(entry, `export * from ${JSON.stringify(join(root, 'src/core/gamepad.ts'))};\n`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { watchPad, padName, padSupported } = await import(pathToFileURL(out).href);

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

ok(padSupported, 'a browser with the API is recognised as supporting pads');

let last;
const stop = watchPad((r) => { last = r; });

// --- Nothing attached -------------------------------------------------------

step();
ok(last === null, 'no pad reads as null rather than as a centred stick');
ok(padName.peek() === null, '  and nothing is named');

// --- Axis conventions -------------------------------------------------------

// Pushed AWAY from the operator. The API calls that −1; the table calls it Y+.
attached = pad([0, -1, 0, 0]);
step();
ok(last && last.y === 1, 'pushing the left stick away is Y+, not Y−', `y=${last?.y}`);
ok(last.x === 0, '  with nothing on X', `x=${last?.x}`);

attached = pad([0, 1, 0, 0]);
step();
ok(last.y === -1, 'and pulling it back is Y−', `y=${last?.y}`);

attached = pad([1, 0, 0, 0]);
step();
ok(last.x === 1 && last.y === 0, 'right on the left stick is X+', `x=${last?.x}`);

// The right stick's vertical drives Z, and up is up.
attached = pad([0, 0, 0, -1]);
step();
ok(last.z === 1, 'pushing the right stick away is Z+', `z=${last?.z}`);
attached = pad([0, 0, 1, 0]);
step();
ok(last.z === 0, "and the right stick's horizontal drives nothing", `z=${last?.z}`);

// --- Deadzone ---------------------------------------------------------------

// A worn stick does not return to exactly zero, and this feeds a machine.
attached = pad([0.04, -0.05, 0, 0.03]);
step();
ok(last.x === 0 && last.y === 0 && last.z === 0 && !last.deflected,
   'a stick resting slightly off centre reads as centred', JSON.stringify([last.x, last.y, last.z]));

attached = pad([0.5, 0, 0, 0]);
step();
ok(last.deflected, 'and a real push is reported as deflected');

// --- The deadman ------------------------------------------------------------

attached = pad([0, -1, 0, 0]);
step();
ok(last.live === false, 'a deflected stick with no button held is not live');

for (const b of [4, 5, 6, 7]) {
  attached = pad([0, -1, 0, 0], [b]);
  step();
  ok(last.live === true, `  button ${b} — a shoulder or trigger — satisfies the deadman`);
}

// The point of choosing the shoulders: they are held, not tapped. A deadman
// answered by a face button is one that gets pressed while picking the pad up.
for (const b of [0, 1, 2, 3]) {
  attached = pad([0, -1, 0, 0], [b]);
  step();
  ok(last.live === false, `  button ${b} — a face button — does not`);
}

// Deflection is still reported when it may not drive anything, so a panel can
// show the stick and say why nothing is moving.
attached = pad([0, -1, 0, 0]);
step();
ok(last.deflected && !last.live,
   'a stick held with no deadman still reports where it is, so the reason can be shown');

// --- Unplugged --------------------------------------------------------------

attached = pad([0, -1, 0, 0], [4]);
step();
ok(last.live && last.y === 1, 'a pad mid-jog reads as driving');
attached = null;
step();
ok(last === null, 'and unplugging arrives as null, not as the last reading held forever');

// --- Stopping ---------------------------------------------------------------

attached = pad([1, 0, 0, 0], [4]);
stop();
last = 'untouched';
step();
step();
ok(last === 'untouched', 'stopping the watch really stops it', String(last));
ok(padName.peek() === null, '  and forgets the pad');

console.log(
  '\nNot covered here: the browser\'s own mapping of a real controller, and the panel\'s use of\n' +
  'this — whether the deadman gates the vector, and whether the knob follows the stick. Those\n' +
  'need a browser and a pad.',
);
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
