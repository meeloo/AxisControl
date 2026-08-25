// Plugin domain storage, checked against a controller that really answers.
//
// The failures this module can have are all quiet ones. A debounce that does
// not coalesce still stores the right value — it just turns a plugin's slider
// into an HTTP POST per frame, on the machine that is supposed to be cutting.
// A merge that does not happen still writes a valid file — it just replaces
// what another browser saved. A cap that is not enforced does not fail until
// the card is full. None of that shows up in a unit test of the module's return
// values, so this one starts tools/mock-rrf.mjs, connects a real driver through
// core/store.js, and asks the questions that need a machine:
//
//   the bytes reach /plugins/data/<domain>.json and come back
//   a burst of writes is ONE upload, and it is the last value
//   the cap refuses rather than trims
//   two handles on one domain see each other's changes
//   nothing connected loses nothing, and the queue flushes on reconnect
//   a queued write MERGES with the card rather than replacing it
//   ownership is what registerDomains says, first claim wins
//
// Uploads are counted twice over, because "one upload" is the claim most worth
// being sure of: once on the client, by wrapping fetch and watching for
// rr_upload, and once on the mock, whose `seqs.volumes` the firmware bumps
// every time the card's contents change. The two have to agree.
//
// NOT COVERED, and it cannot be from Node: the IndexedDB half of `browser`
// scope. Node has no `indexedDB`, so what runs here is the in-memory fallback
// this module takes when a browser refuses to open a database (private mode,
// blocked site data, a full quota). That fallback IS exercised, and so is the
// routing decision — a `browser` domain must not put a single byte on the card,
// which is checked. The real object store, its key range, and surviving a
// reload need a browser: tools/prompt-browser.mjs is the harness pattern, and
// plugin-isolation-check is where that belongs.
//
// Run it with `npm run plugin-storage-check`.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = 8145;
const URL_ = `http://127.0.0.1:${PORT}`;

// The module graph reaches core/store.ts, which touches localStorage and the
// document at import time. The smallest shims that let it load; anything
// cleverer would start being a fake browser and hiding real behaviour.
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

// Counted before anything is imported, so no request can slip past. The client
// looks `fetch` up on the global at call time, which is what makes this work at
// all — and what would make a driver that captured it at module scope invisible
// here, so the count being plausible is itself worth a glance.
const uploads = [];
const downloads = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const href = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (href.includes('/rr_upload')) uploads.push(new URL(href).searchParams.get('name'));
  if (href.includes('/rr_download')) downloads.push(new URL(href).searchParams.get('name'));
  return realFetch(input, init);
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'pstore-'));
const out = join(dir, 's.mjs');
// One entry re-exporting both, so the bundle is a single file with one copy of
// the module graph — two bundles would each carry their own store singleton and
// the storage module would be talking to a driver this file cannot see.
const entry = join(dir, 'entry.ts');
await writeFile(
  entry,
  `export * as sto from ${JSON.stringify(join(root, 'src/plugins/storage.ts'))};\n` +
    `export * as st from ${JSON.stringify(join(root, 'src/core/store.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { sto, st } = await import(pathToFileURL(out).href);

const mock = spawn(process.execPath, [join(root, 'tools/mock-rrf.mjs'), String(PORT)], { stdio: 'ignore' });
const stopMock = () => { try { mock.kill(); } catch { /* already gone */ } };
process.on('exit', stopMock);
process.on('SIGINT', () => { stopMock(); process.exit(130); });
for (let i = 0; i < 50; i++) {
  try { await realFetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long enough for the debounce to have fired if it was going to. */
const settle = () => sleep(sto.WRITE_DEBOUNCE_MS * 3);

/** The mock's own record that the card changed: bumped by every rr_upload. */
const cardSeq = async () =>
  (await realFetch(`${URL_}/rr_model?key=seqs`).then((r) => r.json())).result.volumes;
const cardFile = async (domain) => {
  const res = await realFetch(`${URL_}/rr_download?name=${encodeURIComponent(sto.pathFor(domain))}`);
  return res.ok ? res.text() : null;
};
const record = (id, provides) => ({
  manifest: { id, name: id, version: '1.0.0', api: 1, permissions: [], provides, uses: [] },
  code: '', css: undefined, source: 'machine', hash: `${id}@1`, enabled: true,
});

// --- Ownership, which is what makes a schema possible at all ----------------

const TOOLS = 'org.axiscontrol.tools';
sto.registerDomains([
  record('org.axiscontrol.toolplugin', [{ domain: TOOLS, scope: 'machine' }]),
  // Claims the same domain, and disagrees about where it lives. Installing this
  // is host.ts's to refuse; storage's job is to be deterministic about it.
  record('net.meeloo.feeds', [{ domain: TOOLS, scope: 'browser' }]),
]);
ok(sto.ownerOf(TOOLS) === 'org.axiscontrol.toolplugin', 'a domain claimed twice keeps the first claim',
   String(sto.ownerOf(TOOLS)));
ok(sto.scopeOf(TOOLS) === 'machine', '  including its scope, not the second claimant\'s', sto.scopeOf(TOOLS));
ok(sto.ownerOf('org.nobody.declared') === null, 'a domain nobody declared has no owner');
ok(sto.scopeOf('org.nobody.declared') === 'browser',
   '  and falls back to the browser rather than littering the card', sto.scopeOf('org.nobody.declared'));

// Rebuilt from scratch every time, or a removed plugin keeps its domain forever.
sto.registerDomains([record('net.meeloo.feeds', [{ domain: TOOLS, scope: 'browser' }])]);
ok(sto.ownerOf(TOOLS) === 'net.meeloo.feeds', 'removing the owner hands the domain over on the next rebuild');

const BURST = 'org.axiscontrol.burst';
const SEEDED = 'org.axiscontrol.seeded';
const SHARED = 'org.axiscontrol.shared';
const CAPPED = 'org.axiscontrol.capped';
const OFFLINE = 'org.axiscontrol.offline';
const MERGED = 'org.axiscontrol.merged';
const PREFS = 'net.meeloo.prefs';
const ESCAPE = 'org.axiscontrol.escape';
sto.registerDomains([
  record('org.axiscontrol.toolplugin', [
    { domain: TOOLS, scope: 'machine' },
    { domain: BURST, scope: 'machine' },
    { domain: SEEDED, scope: 'machine' },
    { domain: SHARED, scope: 'machine' },
    { domain: CAPPED, scope: 'machine' },
    { domain: OFFLINE, scope: 'machine' },
    { domain: MERGED, scope: 'machine' },
    { domain: PREFS, scope: 'browser' },
    // Reverse-DNS is what a domain is; this is what a hostile manifest looks
    // like, and it must never become a path.
    { domain: '../../sys/config', scope: 'machine' },
    { domain: ESCAPE, scope: 'machine' },
  ]),
]);

ok(sto.scopeOf(PREFS) === 'browser' && sto.scopeOf(TOOLS) === 'machine',
   'scope is per domain, not per plugin');

// --- Live, against the mock -------------------------------------------------

st.controllerUrl.set(URL_);
try { await st.connect(URL_, 'rrf'); } catch (e) { console.log('connect threw:', e.message); }
const driver = st.activeDriver();
if (!driver) { console.log('could not connect a driver; aborting'); process.exit(2); }

// --- The card round trip ----------------------------------------------------

const tools = sto.openDomain(TOOLS);
ok((await tools.get('T1')) === undefined, 'a domain with no file on the card reads as empty, not as an error');

await tools.set('T1', { diameter: 6.35, flutes: 2, name: '1/4" flat' });
await tools.set('T2', { diameter: 3.175, flutes: 1 });
await sto.flushDomains();

const written = await cardFile(TOOLS);
ok(written !== null, `the file is at ${sto.pathFor(TOOLS)}`);
const parsed = written ? JSON.parse(written) : {};
ok(parsed.T1?.diameter === 6.35 && parsed.T2?.flutes === 1,
   '  and holds both values as JSON', written?.slice(0, 60) ?? '');
ok((await sto.domainUsage(TOOLS)) === Buffer.byteLength(written ?? '', 'utf8'),
   'domainUsage is the size of the file it writes, not an estimate',
   `${await sto.domainUsage(TOOLS)} vs ${Buffer.byteLength(written ?? '', 'utf8')}`);

// Read back through a second handle: same domain, same cache, no second read.
const beforeReads = downloads.filter((n) => n === sto.pathFor(TOOLS)).length;
const tools2 = sto.openDomain(TOOLS);
ok((await tools2.get('T1'))?.diameter === 6.35, 'a second handle on the domain sees what the first stored');
ok((await tools2.keys()).sort().join(',') === 'T1,T2', '  and lists its keys', (await tools2.keys()).join(','));
ok(downloads.filter((n) => n === sto.pathFor(TOOLS)).length === beforeReads,
   '  without going back to the card: the domain is read once and cached');

// The read path, which the cache would otherwise hide. Seeded behind the
// module's back, so the only way this can pass is by downloading the file.
await driver.writeFile(sto.pathFor(SEEDED), new TextEncoder().encode('{"fixture":{"x":12,"y":-4}}'));
const seeded = sto.openDomain(SEEDED);
ok((await seeded.get('fixture'))?.x === 12, 'a domain written by somebody else is read off the card',
   JSON.stringify(await seeded.get('fixture')));

// --- One upload for a burst, which is the whole point of the debounce -------

const burst = sto.openDomain(BURST);
await burst.get('x'); // take the initial read out of the measurement
const uploadsBefore = uploads.length;
const seqBefore = await cardSeq();
for (let i = 0; i < 50; i++) await burst.set('x', i);
ok(uploads.length === uploadsBefore,
   '50 writes in a row upload nothing while they are still arriving',
   `${uploads.length - uploadsBefore} uploads`);
await sto.flushDomains();
ok(uploads.length - uploadsBefore === 1, '  and coalesce into exactly one upload',
   `${uploads.length - uploadsBefore} uploads`);
ok((await cardSeq()) - seqBefore === 1, '  which the controller agrees was one write to the card',
   `${(await cardSeq()) - seqBefore} card changes`);
ok(JSON.parse(await cardFile(BURST)).x === 49, '  carrying the last value, not the first');

// And a write after the flush is a new upload, rather than the domain going
// quiet because it once had a timer.
await burst.set('x', 'later');
await settle();
ok(uploads.length - uploadsBefore === 2, 'a change after a flush schedules its own upload',
   `${uploads.length - uploadsBefore} uploads`);
ok(JSON.parse(await cardFile(BURST)).x === 'later', '  and the debounce fires on its own without a flush');

// --- The cap ----------------------------------------------------------------

const capped = sto.openDomain(CAPPED);
await capped.set('small', 'kept');
let capError = null;
try {
  await capped.set('huge', 'x'.repeat(sto.DOMAIN_BYTE_CAP));
} catch (e) { capError = e; }
ok(capError instanceof Error, 'a value over the cap is refused', capError?.message ?? 'no error');
ok(/org\.axiscontrol\.capped/.test(capError?.message ?? '') &&
   String(capError?.message).includes(String(sto.DOMAIN_BYTE_CAP)),
   '  naming the domain and the cap', capError?.message ?? '');
ok((await capped.keys()).join(',') === 'small' && (await capped.get('small')) === 'kept',
   '  and nothing is stored, silently trimmed, or lost from what was already there');
ok((await sto.domainUsage(CAPPED)) < 40, '  the domain is still its old size',
   String(await sto.domainUsage(CAPPED)));

// Just under, then the byte that tips it over: the check is on the whole
// domain, not on the one value.
const nearly = 'y'.repeat(sto.DOMAIN_BYTE_CAP - 100);
await capped.set('nearly', nearly);
let tipError = null;
try { await capped.set('tip', 'z'.repeat(200)); } catch (e) { tipError = e; }
ok(tipError instanceof Error, 'the cap counts the domain, not the value being written',
   tipError?.message ?? 'no error');
ok((await capped.get('nearly'))?.length === nearly.length, '  and the big value that fits is untouched');

// --- Subscribers, across handles -------------------------------------------

const a = sto.openDomain(SHARED);
const b = sto.openDomain(SHARED);
const seen = [];
const off = sto.subscribeDomain(SHARED, (k, v) => seen.push([k, v]));

// Not awaited yet: what is being checked is that the delivery does not happen
// inside the call. A subscriber that ran there would be re-entering `set` in
// the middle of its own byte accounting.
const writing = b.set('feed', 1200);
ok(seen.length === 0, 'a subscriber is not called synchronously from the write');
await writing;
await sleep(0);
ok(seen.length === 1 && seen[0][0] === 'feed' && seen[0][1] === 1200,
   'a write through one handle reaches a subscriber on the other', JSON.stringify(seen));
ok((await a.get('feed')) === 1200, '  and the value itself is there too');

await a.delete('feed');
await sleep(0);
ok(seen.length === 2 && seen[1][0] === 'feed' && seen[1][1] === undefined,
   'a delete is delivered as well, with no value', JSON.stringify(seen[1]));

// A subscriber that writes back is the re-entrancy this defends against: it
// must not run inside the write, and it must terminate.
const echo = sto.subscribeDomain(SHARED, (k, v) => { if (k === 'ping') void a.set('pong', v); });
await b.set('ping', 7);
await sleep(20);
ok((await a.get('pong')) === 7, 'a subscriber may write back without re-entering the write');
echo();

off();
seen.length = 0;
await b.set('feed', 900);
await sleep(0);
ok(seen.length === 0, 'unsubscribing stops the delivery');

// --- Nothing connected ------------------------------------------------------

// Seed a file the offline write must not destroy, then take the machine away.
await driver.writeFile(sto.pathFor(MERGED), new TextEncoder().encode('{"onTheCard":"survives"}'));
await sto.flushDomains();
await st.disconnect();

const offline = sto.openDomain(OFFLINE);
const uploadsOffline = uploads.length;
let offlineError = null;
try {
  ok((await offline.get('anything')) === undefined, 'with nothing connected a read is undefined, not a throw');
  await offline.set('queued', { pending: true });
  const merged = sto.openDomain(MERGED);
  await merged.set('addedOffline', true);
  await sto.flushDomains();
} catch (e) { offlineError = e; }
ok(offlineError === null, '  and a write neither throws nor waits for a machine',
   offlineError?.message ?? '');
ok(uploads.length === uploadsOffline, '  nothing was uploaded to a controller that is not there');
ok((await sto.openDomain(OFFLINE).get('queued'))?.pending === true,
   '  the value is readable straight back out of the queue');

await st.connect(URL_, 'rrf');
await sto.flushDomains();
ok(JSON.parse((await cardFile(OFFLINE)) ?? '{}').queued?.pending === true,
   'the queued write lands as soon as a driver appears', (await cardFile(OFFLINE)) ?? 'no file');

const mergedFile = JSON.parse((await cardFile(MERGED)) ?? '{}');
ok(mergedFile.addedOffline === true && mergedFile.onTheCard === 'survives',
   'and it MERGES with the file on the card rather than replacing it',
   JSON.stringify(mergedFile));

// --- browser scope ----------------------------------------------------------
//
// In Node this is the in-memory fallback, not IndexedDB — see the header. What
// is worth checking here is the half that is not IndexedDB's: that the scope
// decides the backend, and that everything else behaves the same.

const prefs = sto.openDomain(PREFS);
const uploadsBeforePrefs = uploads.length;
await prefs.set('units', 'mm');
await prefs.set('lastTab', 'jog');
ok((await prefs.get('units')) === 'mm', 'a browser-scoped domain stores and reads back');
ok((await prefs.keys()).sort().join(',') === 'lastTab,units', '  and lists its keys',
   (await prefs.keys()).join(','));
await sto.flushDomains();
ok(uploads.length === uploadsBeforePrefs,
   '  and does not put one byte on the operator\'s card', `${uploads.length - uploadsBeforePrefs} uploads`);
ok((await cardFile(PREFS)) === null, '  there is no file for it there at all');

const prefSeen = [];
const offPrefs = sto.subscribeDomain(PREFS, (k, v) => prefSeen.push([k, v]));
await sto.openDomain(PREFS).set('units', 'inch');
await sleep(0);
ok(prefSeen.length === 1 && prefSeen[0][1] === 'inch', 'subscribers work the same in browser scope');
offPrefs();

let prefCapError = null;
try { await prefs.set('big', 'x'.repeat(sto.DOMAIN_BYTE_CAP)); } catch (e) { prefCapError = e; }
ok(prefCapError instanceof Error, 'and so does the cap', prefCapError?.message ?? 'no error');

// --- A domain that is not a domain -----------------------------------------

let pathError = null;
try { sto.pathFor('../../sys/config'); } catch (e) { pathError = e; }
ok(pathError instanceof Error, 'a domain that is a path traversal is refused a path', pathError?.message ?? '');

const escape = sto.openDomain('../../sys/config');
const uploadsBeforeEscape = uploads.length;
const filesBefore = await realFetch(`${URL_}/_files`).then((r) => r.json());
await escape.set('gotcha', 'M112');
await settle();
ok(uploads.length === uploadsBeforeEscape,
   '  and never reaches the card, whatever the manifest said',
   uploads.slice(uploadsBeforeEscape).join(','));
// The whole card, before and after: `/plugins/data/../../sys/config.json` is
// the file this would have written, and it is the machine's own configuration.
const filesAfter = await realFetch(`${URL_}/_files`).then((r) => r.json());
ok(filesAfter.join('\n') === filesBefore.join('\n'),
   '  and not one file on the card changed',
   filesAfter.filter((p) => !filesBefore.includes(p)).join(','));

// --- Deleting a domain ------------------------------------------------------

await sto.deleteDomain(TOOLS);
ok((await cardFile(TOOLS)) === null, 'deleting a machine domain removes the file from the card');
ok((await sto.openDomain(TOOLS).keys()).length === 0, '  and empties the cache with it');

await sto.deleteDomain(PREFS);
ok((await sto.openDomain(PREFS).keys()).length === 0, 'deleting a browser domain empties it too');

// Deleting a domain that was never written is not a failure: there is nothing
// there, which is the state that was asked for.
let deleteError = null;
try { await sto.deleteDomain(ESCAPE); } catch (e) { deleteError = e; }
ok(deleteError === null, 'deleting a domain that has no data is not an error', deleteError?.message ?? '');

await sto.flushDomains();
await st.disconnect();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
