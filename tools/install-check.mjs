// Installing over DWC, checked against a machine that has DWC on it.
//
// Every other install this app does is additive: it writes into a directory of
// its own and the worst case is a directory of files nobody reads. This one
// takes `/`, which is the address someone types to reach the machine, and the
// thing it displaces is how firmware gets updated and how the network gets
// configured. So the property that matters is not "did the files arrive" — that
// is the same code as always — it is:
//
//   DWC's front page is copied somewhere reachable BEFORE anything is written
//   a second install does not overwrite that copy with our own page, which
//     would destroy the only way back on the machine that most needs one
//   the paths and URLs that were written for a subdirectory still mean
//     something when the directory is the web root itself
//
// Run it with `npm run install-check`.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = 8126;
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
const dir = await mkdtemp(join(tmpdir(), 'inst-'));
const out = join(dir, 'i.mjs');
const entry = join(dir, 'entry.ts');
await writeFile(
  entry,
  `export * as inst from ${JSON.stringify(join(root, 'src/machine/install.ts'))};\n` +
    `export * as st from ${JSON.stringify(join(root, 'src/core/store.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { inst, st } = await import(pathToFileURL(out).href);

const mock = spawn(process.execPath, [join(root, 'tools/mock-rrf.mjs'), String(PORT)], { stdio: 'ignore' });
const stopMock = () => { try { mock.kill(); } catch { /* already gone */ } };
process.on('exit', stopMock);
process.on('SIGINT', () => { stopMock(); process.exit(130); });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };
const text = (b) => new TextDecoder().decode(b);

// --- The URLs, which were all written for a subdirectory --------------------

const base = 'http://sebscnc.local';
ok(inst.targetDir('beside') === '/www/AxisControl' && inst.targetDir('replace') === '/www',
   'the two targets name the two directories');
ok(inst.isRootInstall('/www') && !inst.isRootInstall('/www/AxisControl'),
   'and a root install is recognised as one');

ok(inst.installedUrl(base, '/www') === `${base}/`,
   'a root install lives at the machine address itself', inst.installedUrl(base, '/www'));
ok(inst.entryUrl(base, '/www') === `${base}/index.html`,
   '  and its entry point is /index.html', inst.entryUrl(base, '/www'));
ok(inst.installedUrl(base, '/www/AxisControl') === `${base}/AxisControl/`,
   'while a subdirectory install is unchanged', inst.installedUrl(base, '/www/AxisControl'));
ok(inst.dwcFallbackUrl(base) === `${base}/dwc.html`, 'DWC ends up at /dwc.html',
   inst.dwcFallbackUrl(base));

// --- Live, against a machine with DWC on it ---------------------------------

st.controllerUrl.set(URL_);
try { await st.connect(URL_, 'rrf'); } catch (e) { console.log('connect threw:', e.message); }
const driver = st.activeDriver();
if (!driver) { console.log('could not connect a driver; aborting'); process.exit(2); }

const before = text(await driver.readFile('/www/index.html'));
ok(/Duet Web Control/.test(before), 'the machine starts with DWC at /www/index.html');

// The one that matters. Nothing has been written yet — this runs first.
const saved = await inst.preserveDwc(driver);
ok(saved.kind === 'saved' && saved.at === '/www/dwc.html',
   'DWC is copied aside before anything is written', JSON.stringify(saved));
ok(text(await driver.readFile('/www/dwc.html')) === before,
   '  byte for byte, so the copy is the page and not a description of it');

// Now do what an install does to /www/index.html.
const ours = '<!doctype html><html><head><script src="cnc.js"></script></head></html>';
await driver.writeFile('/www/index.html', new TextEncoder().encode(ours));
ok(text(await driver.readFile('/www/index.html')) === ours, 'and then / is this app');

// A second install must not save OUR page over the only copy of DWC's. This is
// the case that would destroy the way back, and it is the normal case — every
// update after the first one runs against a machine where / is already us.
const again = await inst.preserveDwc(driver);
ok(again.kind === 'kept', 'a second install keeps the copy it already made', JSON.stringify(again));
ok(text(await driver.readFile('/www/dwc.html')) === before,
   '  and the copy is still DWC, not the page that replaced it');

// The served answer, which is a different question from what is on the card.
const servedRoot = await fetch(`${URL_}/index.html`, { cache: 'no-store' }).then((r) => r.text());
ok(servedRoot === ours, 'the machine serves the uploaded page at /, not the one it shipped with',
   servedRoot.slice(0, 40));
const servedDwc = await fetch(`${URL_}/dwc.html`, { cache: 'no-store' }).then((r) => r.text());
ok(servedDwc === before, 'and DWC is still reachable at /dwc.html');

// --- The machine that never had DWC -----------------------------------------

await fetch(`${URL_}/__reset_files`);
await driver.writeFile('/www/index.html', new TextEncoder().encode(ours));
try { await driver.deleteFile('/www/dwc.html'); } catch { /* may not exist */ }
const none = await inst.preserveDwc(driver);
ok(none.kind === 'none', 'nothing is invented when / is already this app and no copy exists',
   JSON.stringify(none));

// --- What must never happen -------------------------------------------------

// A root install has no short URL to write — it already answers the bare
// address — and shortcutPath('/www') would name /www.html, a file BESIDE the
// web root rather than in it. Refused loudly rather than skipped quietly.
let threw = null;
try { await inst.writeShortcut(driver, '/www'); } catch (e) { threw = e; }
ok(threw !== null, 'writing a shortcut for a root install is refused', threw?.message ?? 'no error');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
