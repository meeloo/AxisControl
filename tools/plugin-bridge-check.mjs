// The one door, checked from the outside.
//
// plugins/bridge.ts is where a plugin's message becomes an action, and every
// failure it can have is silent in the same way: nothing throws, nothing is
// logged, and a plugin quietly does something nobody agreed to. A permission
// that is checked by name but not by argument still refuses the obvious call.
// A path guard that forgets the card is case-insensitive still refuses
// /www/index.html. A rate limiter that never refills still passes the first
// twenty. None of that shows up in a plugin that works.
//
// So this drives `dispatch` directly — the same function the frame calls, with
// the same arguments a frame would send — against tools/mock-rrf.mjs and a
// real driver from core/store.js. The lesson from issue #1 is the rule here:
// a permission denied in this file must be denied by the code that denies it
// in the app, not by a fake standing in for it.
//
// What it asks:
//
//   an unknown method is refused, including the ones on Object's prototype
//   every static permission is refused when absent and served when present
//   a refusal names the permission it wanted
//   a plugin's own storage domain costs no grant
//   a domain granted for reading refuses a write
//   .., a relative path, and any write under /www or /sys are refused
//   the rate limiter trips, says so, and refills
//   a command a plugin sends appears in the app's console log
//   what comes back survives structuredClone
//
// NOT COVERED, and it cannot be from Node: `createFrame`. It needs a document,
// an iframe and a real postMessage, and the thing worth proving about it —
// that the sandbox holds — is tools/plugin-isolation-check.mjs's job.
//
// Run it with `npm run plugin-bridge-check`.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = 8146;
const URL_ = `http://127.0.0.1:${PORT}`;

// core/store.ts touches localStorage and the document at import time. The
// smallest shims that let it load; anything cleverer would start being a fake
// browser and hiding real behaviour.
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
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'pbridge-'));
const out = join(dir, 'b.mjs');
// One entry re-exporting all three, so the bundle carries one copy of the
// module graph. Two bundles would each hold their own store singleton, and the
// bridge would be talking to a driver this file cannot see.
const entry = join(dir, 'entry.ts');
await writeFile(
  entry,
  `export * as br from ${JSON.stringify(join(root, 'src/plugins/bridge.ts'))};\n` +
    `export * as sto from ${JSON.stringify(join(root, 'src/plugins/storage.ts'))};\n` +
    `export * as st from ${JSON.stringify(join(root, 'src/core/store.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { br, sto, st } = await import(pathToFileURL(out).href);

const mock = spawn(process.execPath, [join(root, 'tools/mock-rrf.mjs'), String(PORT)], { stdio: 'ignore' });
const stopMock = () => { try { mock.kill(); } catch { /* already gone */ } };
process.on('exit', stopMock);
process.on('SIGINT', () => { stopMock(); process.exit(130); });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A plugin, as far as the bridge is concerned. */
const rec = (id, extra = {}) => ({
  manifest: { id, name: id, version: '1.0.0', api: 1, permissions: [], provides: [], uses: [], ...extra },
  code: '', css: undefined, source: 'machine', hash: `${id}@1`, enabled: true,
});

/** The refusal message, or null when the call went through. */
const denied = async (record, granted, method, args = []) => {
  try { await br.dispatch(record, granted, method, args); return null; }
  catch (e) { return e.message; }
};
/** { value } or { error }, so an unexpected refusal can be printed. */
const call = async (record, granted, method, args = []) => {
  try { return { value: await br.dispatch(record, granted, method, args) }; }
  catch (e) { return { error: e.message }; }
};

await st.connect(URL_, 'rrf');
if (!st.activeDriver()) { console.log('could not connect a driver; aborting'); process.exit(2); }

// --- An unknown method is refused, not passed on -----------------------------

const any = rec('net.example.any');
const unknown = await denied(any, ['machine.command'], 'machine.reboot');
ok(unknown !== null, 'a method the API does not have is refused', unknown ?? 'it was served');

// The gate is `hasOwnProperty`, not `in`. With `in`, every name on Object's
// prototype passes it — and a method that passes the gate arrives at a switch
// that never listed it.
for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
  const why = await denied(any, ['machine.command', 'files.write'], name, []);
  ok(why !== null, `  and so is "${name}", which is on every object's prototype`);
}

// --- Static permissions: absent refuses, present serves ----------------------

const STATIC = [
  ['machine.read', 'machine.state', []],
  ['machine.read', 'machine.capabilities', []],
  ['machine.motion', 'machine.jog', [{ X: 1 }, 600]],
  ['machine.motion', 'machine.home', [['X']]],
  ['machine.motion', 'machine.goToWorkOrigin', [{}]],
  ['machine.command', 'machine.send', ['G4 P1']],
  ['machine.command', 'machine.runMacro', ['/macros/hello.g']],
  ['machine.command', 'machine.stopSpindle', []],
  ['files.read', 'files.list', ['/gcodes']],
  ['files.read', 'files.read', ['/sys/config.g']],
  ['files.write', 'files.write', ['/gcodes/from-a-plugin.g', 'G4 P1\n']],
  ['files.write', 'files.delete', ['/gcodes/from-a-plugin.g']],
  ['ui.notify', 'ui.notify', ['a message', 'info']],
];

for (const [permission, method, args] of STATIC) {
  const plugin = rec(`net.example.${method}`);
  const why = await denied(plugin, [], method, args);
  ok(why !== null, `${method} without ${permission} is refused`);
  // The wording matters as much as the refusal: the log pane, the Plugins
  // panel and the plugin's own catch block all show this sentence, and a
  // refusal that does not name the permission leaves an author guessing.
  ok(why !== null && why.includes(permission), `  and the message names ${permission}`, why ?? '');
  const withIt = await call(plugin, [permission], method, args);
  ok(!withIt.error, `  and with ${permission} it goes through`, withIt.error ?? '');
}

// A permission is not a password: holding one does not open the next one along.
ok((await denied(any, ['machine.read'], 'machine.send', ['M3 S1000'])) !== null,
   'machine.read does not buy machine.command');
ok((await denied(any, ['machine.motion'], 'machine.send', ['M3 S1000'])) !== null,
   'machine.motion does not buy machine.command either');
ok((await denied(any, ['files.read'], 'files.write', ['/gcodes/x.g', 'G4 P1'])) !== null,
   'and files.read does not buy files.write');

// The free methods, which cost nothing because they tell the plugin about itself.
const version = await call(rec('net.example.free'), [], 'version', []);
ok(!version.error && typeof version.value?.api === 'number', 'version needs no permission at all',
   version.error ?? JSON.stringify(version.value));

// --- Storage domains ---------------------------------------------------------

const NOTES = 'net.example.notes';
const owner = rec('net.example.owner', { provides: [{ domain: NOTES, scope: 'browser' }] });
const reader = rec('net.example.reader', { uses: [{ domain: NOTES, access: 'read' }] });
const writer = rec('net.example.writer', { uses: [{ domain: NOTES, access: 'write' }] });
sto.registerDomains([owner, reader, writer]);

const write = await call(owner, [], 'storage.set', [NOTES, 'last-scan', { deviation: 0.04 }]);
ok(!write.error, 'a plugin writing to the domain it owns needs no grant at all', write.error ?? '');
const read = await call(owner, [], 'storage.get', [NOTES, 'last-scan']);
ok(read.value?.deviation === 0.04, '  and reads back what it stored', JSON.stringify(read.value));

const ungranted = await denied(reader, [], 'storage.get', [NOTES, 'last-scan']);
ok(ungranted !== null && ungranted.includes(`storage.${NOTES}`),
   "somebody else's domain without a grant is refused, by name", ungranted ?? 'it was served');

const GRANT = [`storage.${NOTES}`];
const shared = await call(reader, GRANT, 'storage.get', [NOTES, 'last-scan']);
ok(shared.value?.deviation === 0.04, 'with the grant, the reader sees the owner\'s data', shared.error ?? '');
const keys = await call(reader, GRANT, 'storage.keys', [NOTES]);
ok(Array.isArray(keys.value) && keys.value.includes('last-scan'), '  and can list its keys', keys.error ?? '');

// The grant is one permission per domain; `uses` is where read and write part
// company. A reader holding the grant must still not be able to rewrite the
// tool table it was only ever meant to consult.
const overwrite = await denied(reader, GRANT, 'storage.set', [NOTES, 'last-scan', { deviation: 9 }]);
ok(overwrite !== null, 'a domain declared "read" refuses a write even with the grant',
   overwrite ?? 'it was served');
ok(overwrite !== null && /read/.test(overwrite) && overwrite.includes(NOTES),
   '  and says which domain and which half of it', overwrite ?? '');
const removal = await denied(reader, GRANT, 'storage.delete', [NOTES, 'last-scan']);
ok(removal !== null, '  and refuses a delete for the same reason');
const still = await call(owner, [], 'storage.get', [NOTES, 'last-scan']);
ok(still.value?.deviation === 0.04, '  and nothing was changed on the way to the refusal');

const allowedWrite = await call(writer, GRANT, 'storage.set', [NOTES, 'from-writer', 1]);
ok(!allowedWrite.error, 'a domain declared "write" and granted goes through', allowedWrite.error ?? '');

// Claiming somebody else's domain in `provides` does not make it yours: the
// registry settled that at install, and the door reads the registry.
const squatter = rec('net.example.squatter', { provides: [{ domain: NOTES, scope: 'browser' }] });
const squat = await denied(squatter, [], 'storage.get', [NOTES, 'last-scan']);
ok(squat !== null, 'a second plugin claiming an owned domain still needs a grant', squat ?? 'it was served');

// --- Paths -------------------------------------------------------------------

const filer = rec('net.example.files');
const BOTH = ['files.read', 'files.write'];

const relative = await denied(filer, BOTH, 'files.read', ['gcodes/part.nc']);
ok(relative !== null && /absolute|starting with/.test(relative),
   'a relative path is refused: there is no working directory to resolve it against', relative ?? '');

for (const path of ['/gcodes/../sys/config.g', '/../etc/passwd', '/gcodes/..']) {
  const why = await denied(filer, BOTH, 'files.read', [path]);
  ok(why !== null && why.includes('..'), `"${path}" is refused for climbing`, why ?? 'it was served');
}

for (const path of ['/sys/config.g', '/sys', '/sys/macros/atc/pickup.g']) {
  const why = await denied(filer, BOTH, 'files.write', [path]);
  ok(why !== null && why.includes('/sys'), `writing "${path}" is refused`, why ?? 'it was served');
}
for (const path of ['/www/index.html', '/www', '/www/AxisControl/cnc.js']) {
  const why = await denied(filer, BOTH, 'files.write', [path]);
  ok(why !== null && why.includes('/www'), `writing "${path}" is refused`, why ?? 'it was served');
}

// The card is FAT and case-insensitive, so /WWW/index.html and /www/index.html
// are one file. A guard that only knew the lower-case spelling would have a
// spelling of its own that got round it.
for (const path of ['/WWW/index.html', '/Sys/config.g', '/SYS/config.g']) {
  const why = await denied(filer, BOTH, 'files.write', [path]);
  ok(why !== null, `writing "${path}" is refused too — the card does not care about case`,
     why ?? 'it was served');
}

// Reading is a different question: docs/plugins.md grants files.read over the
// configuration deliberately, and a plugin that cannot read /sys cannot tell
// you what your machine is set up to do.
const configRead = await call(filer, BOTH, 'files.read', ['/sys/config.g']);
ok(!configRead.error && configRead.value?.length > 0, 'reading /sys/config.g is allowed',
   configRead.error ?? '');
const sysList = await call(filer, BOTH, 'files.list', ['/sys']);
ok(Array.isArray(sysList.value) && sysList.value.length > 0, 'and so is listing /sys',
   sysList.error ?? '');

// A write that breaks no rule still has to work, or the guard above proves
// nothing about the guard and everything about the driver.
const wrote = await call(filer, BOTH, 'files.write', ['/gcodes/plugin-wrote-this.g', 'G4 P1\n']);
ok(!wrote.error, 'a write outside the protected directories goes through', wrote.error ?? '');
const back = await call(filer, BOTH, 'files.read', ['/gcodes/plugin-wrote-this.g']);
ok(new TextDecoder().decode(back.value ?? new Uint8Array()) === 'G4 P1\n', '  and the bytes are there');
await call(filer, BOTH, 'files.delete', ['/gcodes/plugin-wrote-this.g']);

// --- The rate limiter --------------------------------------------------------

const looper = rec('net.example.loop');
const CMD = ['machine.command'];
let passed = 0;
let firstRefusal = null;
for (let i = 0; i < br.RATE_LIMIT_CALLS + 5; i++) {
  const r = await call(looper, CMD, 'machine.send', [`G4 P${i}`]);
  if (r.error) firstRefusal ??= r.error;
  else passed++;
}
// One or two extra are allowed for: the bucket refills continuously and each
// call above is a real HTTP round trip, so a few milliseconds of credit accrue
// during the loop itself. What must not happen is all twenty-five going out.
ok(passed >= br.RATE_LIMIT_CALLS && passed <= br.RATE_LIMIT_CALLS + 2,
   `a plugin in a loop gets ${br.RATE_LIMIT_CALLS} commands and then stops`, `served ${passed}`);
ok(firstRefusal !== null && /rate limit/i.test(firstRefusal),
   '  and the refusal says it is a rate limit, not a permission', firstRefusal ?? 'nothing was refused');

const otherPlugin = await call(rec('net.example.innocent'), CMD, 'machine.send', ['G4 P1']);
ok(!otherPlugin.error, '  and the limit is per plugin: another one is unaffected', otherPlugin.error ?? '');

// It refills a token at a time rather than in a lump, so a plugin that waits
// gets going again without the app being reloaded.
await sleep(Math.ceil(br.RATE_LIMIT_WINDOW_MS / br.RATE_LIMIT_CALLS) + 150);
const recovered = await call(looper, CMD, 'machine.send', ['G4 P0']);
ok(!recovered.error, '  and one token comes back after one interval', recovered.error ?? '');
const immediately = await call(looper, CMD, 'machine.send', ['G4 P0']);
ok(immediately.error, '  but only one: the next call is refused again',
   immediately.error ? '' : 'a second one went through');

// Motion counts against the same allowance. Both reach the controller, and it
// is the controller — not the API surface — that is being protected.
const mover = rec('net.example.mover');
const MOTION = ['machine.motion', 'machine.command'];
for (let i = 0; i < br.RATE_LIMIT_CALLS; i++) await call(mover, MOTION, 'machine.jog', [{ X: 0.1 }, 600]);
const mixed = await call(mover, MOTION, 'machine.send', ['G4 P1']);
ok(mixed.error, 'motion and commands share one bucket', mixed.error ? '' : 'the send went through');

// --- The audit line ----------------------------------------------------------

const noisy = rec('net.example.audit');
const before = st.log.peek().length;
await call(noisy, ['machine.command'], 'machine.send', ['M3 S12345']);
const added = st.log.peek().slice(before);
const audit = added.find((l) => l.text.includes('M3 S12345'));
ok(!!audit, "a plugin's G-code appears in the app's own console log",
   added.map((l) => l.text).join(' | '));
ok(!!audit && audit.text.includes('net.example.audit'), '  with the plugin named in the line',
   audit?.text ?? '');
ok(!!audit && audit.level === 'command', '  at the level a typed command uses', audit?.level ?? '');

const quiet = st.log.peek().length;
await call(noisy, ['machine.read'], 'machine.state', []);
ok(st.log.peek().length === quiet, 'reading the machine is not an audit line — only what moves it is');

const notifier = rec('net.example.notifier');
const beforeNotify = st.log.peek().length;
await call(notifier, ['ui.notify'], 'ui.notify', ['something happened', 'warn']);
const notified = st.log.peek().slice(beforeNotify).find((l) => l.text.includes('something happened'));
ok(!!notified && notified.text.includes('net.example.notifier'),
   'ui.notify reaches the log with the plugin named', notified?.text ?? 'nothing was logged');

// --- What comes back has to survive postMessage ------------------------------

// `extras` is whatever the driver chose to surface, and the RRF driver's is the
// object model — class instances, with methods on them. postMessage clones,
// and a clone that throws does not fail the call: it happens while the host is
// posting the answer, so the plugin's promise is left pending for good.
class Awkward {
  constructor() {
    this.n = 1;
    this.when = new Date(1700000000000);
    this.method = () => 'not cloneable';
  }
  get computed() { return 'a prototype accessor'; }
}
const awkward = new Awkward();
awkward.self = awkward; // A cycle, which the object model has plenty of.
st.machine.set({ ...st.machine.peek(), extras: { om: awkward } });

const snapshot = await call(rec('net.example.clone'), ['machine.read'], 'machine.state', []);
let cloneError = null;
try { structuredClone(snapshot.value); } catch (e) { cloneError = e; }
ok(cloneError === null, 'a machine state carrying class instances still crosses postMessage',
   cloneError?.message ?? '');
ok(snapshot.value?.extras?.om?.n === 1, '  keeping the data properties');
ok(snapshot.value?.extras?.om?.when instanceof Date, '  keeping a Date as a Date');
ok(snapshot.value?.extras?.om?.method === undefined, '  and dropping the function that would throw');
ok(snapshot.value?.extras?.om?.self === snapshot.value?.extras?.om,
   '  while a cycle stays one object rather than looping forever');

const files = await call(filer, BOTH, 'files.list', ['/gcodes']);
let listClone = null;
try { structuredClone(files.value); } catch (e) { listClone = e; }
ok(listClone === null, 'and so does a file listing, Dates and all', listClone?.message ?? '');

// --- net.fetch, which is an origin at a time ---------------------------------

const fetcher = rec('net.example.fetcher');
const noGrant = await denied(fetcher, [], 'net.fetch', [`${URL_}/rr_model?key=state`, null]);
ok(noGrant !== null && noGrant.includes(`network.${URL_}`),
   'net.fetch names the exact origin it wanted', noGrant ?? 'it was served');

const elsewhere = await denied(fetcher, ['network.https://example.com'], 'net.fetch',
                               [`${URL_}/rr_model?key=state`, null]);
ok(elsewhere !== null, 'a grant for one origin is not a grant for another', elsewhere ?? 'it was served');

const opened = await call(fetcher, [`network.${URL_}`], 'net.fetch', [`${URL_}/rr_model?key=state`, null]);
ok(!opened.error && opened.value?.ok === true, 'the granted origin goes through', opened.error ?? '');
ok(opened.value?.body instanceof Uint8Array, '  and answers with plain data, not a Response');

const scheme = await denied(fetcher, ['network.file://'], 'net.fetch', ['file:///etc/passwd', null]);
ok(scheme !== null, 'net.fetch opens http and https and nothing else', scheme ?? 'it was served');

await sto.flushDomains();
await st.disconnect();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
