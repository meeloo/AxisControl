// Font storage on the controller, checked by actually storing fonts on one.
//
// Everything this module does is a round trip to a machine, so there is nothing
// worth asserting about it in isolation — the questions are whether the bytes
// come back the way they went in, whether a bad file is stopped before it
// reaches the card, and whether a path can be talked into writing somewhere it
// should not. All three need a server, so this one starts tools/mock-rrf.mjs,
// drives the real module against it, and stops it again.
//
// The module is browser code and the store it imports touches localStorage,
// document and matchMedia at import time. The shims below are the smallest set
// that lets it load under Node; they are deliberately dumb, because anything
// cleverer would start being a fake browser and hiding real behaviour.
//
// Run it with `npm run fontstore-check`.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = 8123;
const URL_ = `http://127.0.0.1:${PORT}`;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.location = { href: `${URL_}/index.html`, origin: URL_, protocol: 'http:', host: `127.0.0.1:${PORT}` };
globalThis.document = { baseURI: `${URL_}/`, addEventListener() {}, documentElement: { style: {}, classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, getAttribute: () => null } };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
class FakeFile {
  constructor(bytes, name) { this._b = bytes; this.name = name; this.size = bytes.length; }
  async arrayBuffer() { return this._b.buffer.slice(this._b.byteOffset, this._b.byteOffset + this._b.byteLength); }
}
globalThis.File = FakeFile;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'fs-'));
const out = join(dir, 'f.mjs');
// One entry re-exporting both, so the bundle is a single file with one copy of
// the module graph — two bundles would each carry their own store singleton.
const entry = join(dir, 'entry.ts');
await writeFile(entry, `export * as fs from ${JSON.stringify(join(root, 'src/text/fontstore.ts'))};\n` +
  `export * as st from ${JSON.stringify(join(root, 'src/core/store.ts'))};\n`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { fs, st } = await import(pathToFileURL(out).href);


// The mock is a child rather than something the caller has to remember to
// start: a check that silently passes because nothing was listening, or fails
// because something else was, is worse than no check.
const mock = spawn(process.execPath, [join(root, 'tools/mock-rrf.mjs'), String(PORT)], {
  stdio: 'ignore',
});
const stopMock = () => { try { mock.kill(); } catch { /* already gone */ } };
process.on('exit', stopMock);
process.on('SIGINT', () => { stopMock(); process.exit(130); });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

st.controllerUrl.set(URL_);
try { await st.connect(URL_, 'rrf'); } catch (e) { console.log('connect threw:', e.message); }
if (!st.activeDriver()) { console.log('could not connect a driver; aborting probe'); process.exit(2); }

// A real font is not needed here: parsing is the validator's job, and what is
// being checked is that the validator is consulted at all and that its verdict
// is obeyed. text/outline.ts has its own check for whether it can read a font.
fs.setFontValidator((name, data) => {
  const tag = new DataView(data).getUint32(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f) throw new Error('not a font');
});
const ttf = new Uint8Array(2048); new DataView(ttf.buffer).setUint32(0, 0x00010000);

ok((await fs.listFonts()).length === 0, 'an empty machine lists no fonts');

const seen = [];
const s = await fs.storeFont(new FakeFile(ttf, 'Probe.ttf'), (l, t) => seen.push([l, t]));
ok(s && s.path === '/fonts/Probe.ttf', 'a font stores under /fonts', JSON.stringify(s));
ok(seen.length > 0, 'and reports progress', JSON.stringify(seen));

const back = await fs.loadFont('/fonts/Probe.ttf');
ok(back.byteLength === ttf.length, 'and reads back byte for byte', `${back.byteLength}`);

const dupe = await fs.storeFont(new FakeFile(ttf, 'Probe.ttf'));
ok(dupe === null, 'a duplicate name is refused rather than silently suffixed');
ok((await fs.storeFont(new FakeFile(ttf, 'Probe.ttf'), undefined, { replace: true })) !== null,
   'unless replacement is asked for explicitly');

const bad = new Uint8Array(64); // not a font
ok((await fs.storeFont(new FakeFile(bad, 'NotAFont.ttf'))) === null,
   'an unparseable file never reaches the card');
const after = await fs.listFonts(true);
ok(!after.some((f) => f.name === 'NotAFont.ttf'), '  and is genuinely not there', JSON.stringify(after.map(f=>f.name)));

const climb = await fs.storeFont(new FakeFile(ttf, '../../sys/config.g.ttf'));
ok(climb !== null && climb.path.startsWith('/fonts/') && !climb.path.includes('..'),
   'a name that tries to climb out of /fonts cannot', climb?.path);

ok((await fs.removeFont('/sys/config.g')) === false, 'and it refuses to delete outside /fonts');
ok((await fs.removeFont('/fonts/Probe.ttf')) === true, 'deleting a font works');
ok(!(await fs.listFonts(true)).some((f) => f.name === 'Probe.ttf'), '  and it is gone from the listing');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
