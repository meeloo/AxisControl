// Probe state, checked against the object model the firmware actually sends.
//
// This exists because of AxisControl issue #1: the diagnostics panel read
// `sensors.probes[].triggered`, a field that does not exist. Probes report a
// reading and a threshold; `triggered` is an ENDSTOP field. On real hardware
// every probe therefore read "open" forever, including while it was pressed —
// the one readout an operator checks before trusting a probing routine.
//
// It went unnoticed for as long as it did because tools/mock-rrf.mjs invented
// the field too, so the panel was right about the mock and wrong about every
// machine. So this checks two different things, and both matter:
//
//   the schema, against @duet3d/objectmodel, which is Duet's own description
//     of the object model and knows nothing about our mock
//   the behaviour, against the mock, which now reports probes the way a board
//     does — a reading against a threshold and nothing else
//
// Run it with `npm run probe-check`.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Probe, Endstop } from '@duet3d/objectmodel';

const PORT = 8127;
const URL_ = `http://127.0.0.1:${PORT}`;

const kv = new Map();
globalThis.localStorage = {
  getItem: (k) => (kv.has(k) ? kv.get(k) : null),
  setItem: (k, v) => kv.set(k, String(v)),
  removeItem: (k) => kv.delete(k),
  clear: () => kv.clear(),
};
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.location = { href: `${URL_}/index.html`, origin: URL_, protocol: 'http:', host: `127.0.0.1:${PORT}` };
globalThis.document = { hidden: false, baseURI: `${URL_}/`, addEventListener() {} };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'probe-'));
const out = join(dir, 'p.mjs');
const entry = join(dir, 'entry.ts');
await writeFile(
  entry,
  `export * as om from ${JSON.stringify(join(root, 'src/machine/drivers/rrf/om.ts'))};\n` +
    `export * as st from ${JSON.stringify(join(root, 'src/core/store.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { om, st } = await import(pathToFileURL(out).href);

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

// --- The schema, from Duet's own model ---------------------------------------

const probeFields = new Set(Object.keys(new Probe()));
const endstopFields = new Set(Object.keys(new Endstop()));

ok(!probeFields.has('triggered'), 'a probe has no `triggered` field — this is issue #1 itself');
ok(endstopFields.has('triggered'), 'an endstop does, which is where the mistake came from');
ok(probeFields.has('value') && probeFields.has('threshold'),
   'what a probe does report is a reading and a threshold');

// Every field we declare on OmProbe must be one the firmware sends. The
// interface is our written belief about the wire format; if it drifts, it
// drifts silently, and the panel reads a plausible `undefined`.
const src = await readFile(join(root, 'src/machine/drivers/rrf/om.ts'), 'utf8');
const block = /export interface OmProbe \{([^}]*)\}/.exec(src);
ok(block !== null, 'OmProbe is still declared where this check looks for it');
const declared = [...(block?.[1] ?? '').matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
ok(declared.length > 0, 'and it has fields to check', declared.join(', '));
const invented = declared.filter((f) => !probeFields.has(f));
ok(invented.length === 0, 'every field OmProbe declares exists on a real probe',
   invented.length ? `invented: ${invented.join(', ')}` : declared.join(', '));

// --- The derivation ----------------------------------------------------------

ok(om.probeTriggered({ value: [1000], threshold: 500 }) === true,
   'a digital probe reading 1000 against a threshold of 500 is triggered');
ok(om.probeTriggered({ value: [0], threshold: 500 }) === false, '  and reading 0 is open');
ok(om.probeTriggered({ value: [500], threshold: 500 }) === true,
   '  at the threshold it is triggered, the way the firmware compares it');
ok(om.probeTriggered({ value: [612], threshold: 400 }) === true,
   'an analog probe is the same comparison with different numbers');

// The unknowns, which must not come back as the reassuring answer.
ok(om.probeTriggered({ threshold: 500 }) === null, 'no reading is unknown, not open');
ok(om.probeTriggered({ value: [], threshold: 500 }) === null, 'an empty reading likewise');
ok(om.probeTriggered({ value: [0] }) === null, 'no threshold is unknown, not open');
ok(om.probeTriggered({ value: [0], threshold: 0 }) === null,
   'and a zero threshold, against which every reading would trigger, is unknown');

// --- Behaviour, against the mock ---------------------------------------------

const mock = spawn(process.execPath, [join(root, 'tools/mock-rrf.mjs'), String(PORT)], { stdio: 'ignore' });
const stopMock = () => { try { mock.kill(); } catch { /* already gone */ } };
process.on('exit', stopMock);
process.on('SIGINT', () => { stopMock(); process.exit(130); });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

// The mock must not report the field either. It reported it once, and that is
// the whole reason the bug survived to reach a user.
const model = await fetch(`${URL_}/rr_model?key=sensors&flags=v99d99`).then((r) => r.json());
const mockProbes = model.result?.probes ?? [];
ok(mockProbes.length > 0, 'the mock reports probes at all', String(mockProbes.length));
ok(mockProbes.every((p) => !('triggered' in p)),
   'and reports them without a `triggered` field, as a board does',
   JSON.stringify(mockProbes[0]));

st.controllerUrl.set(URL_);
try { await st.connect(URL_, 'rrf'); } catch (e) { console.log('connect threw:', e.message); }
const driver = st.activeDriver();
if (!driver) { console.log('could not connect a driver; aborting'); process.exit(2); }

const probeItems = async () => {
  const sections = await driver.diagnostics();
  return sections.find((s) => s.title === 'Probes')?.items ?? [];
};

const at_rest = await probeItems();
ok(at_rest.length === 2, 'the panel shows both probes', String(at_rest.length));
ok(at_rest[0]?.value === 'open' && at_rest[0]?.level === 'ok', 'a probe at rest reads open',
   JSON.stringify(at_rest[0]));

// M999 PROBE0 is the mock's test hook for pressing the probe.
await driver.send('M999 PROBE0');
for (let i = 0; i < 40; i++) {
  const items = await probeItems();
  if (items[0]?.value === 'TRIGGERED') break;
  await new Promise((r) => setTimeout(r, 50));
}
const pressed = await probeItems();
ok(pressed[0]?.value === 'TRIGGERED' && pressed[0]?.level === 'warn',
   'a pressed probe reads TRIGGERED — the readout issue #1 said never changed',
   JSON.stringify(pressed[0]));
ok(pressed[1]?.value === 'open', '  and the other one is unaffected', JSON.stringify(pressed[1]));
ok(/reading 1000/.test(pressed[0]?.detail ?? ''), '  with the raw reading shown beside it',
   pressed[0]?.detail ?? '');

await driver.send('M999 PROBE0');
for (let i = 0; i < 40; i++) {
  const items = await probeItems();
  if (items[0]?.value === 'open') break;
  await new Promise((r) => setTimeout(r, 50));
}
ok((await probeItems())[0]?.value === 'open', 'and it goes back to open when released');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
