// Who moves the dust shoe, checked at the two places it matters.
//
// The decision this covers is a single G-code word — whether `G10 L1
// Z{var.newOffset}` also carries `U{-var.newOffset}` — and getting it wrong is
// silent in both directions, which is the whole reason for a harness:
//
//   emit it under M604 and nothing breaks; the file simply claims to be doing
//     something it is not, and the next person to read it believes the claim
//   omit it without M604 and the shoe sits at the wrong height for every tool
//     but the one it was set with — no error, no warning, a valid macro, and a
//     brush dragging on the work or hanging in the air
//
// Two generators make that decision independently — the ATC installer's
// atcProbeZ.g and the Probing panel's standalone macro — and they have to agree,
// because they do the same job on the same machine. So both are checked, and so
// is the resolution they share.
//
// Run it with `npm run dustshoe-check`.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = 8125;
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
const dir = await mkdtemp(join(tmpdir(), 'shoe-'));
const out = join(dir, 's.mjs');
const entry = join(dir, 'entry.ts');
// One entry, one module graph — otherwise each bundle gets its own copy of the
// signals in core/dustshoe.ts and the probe would populate one while the
// resolver read another.
await writeFile(
  entry,
  `export * as shoe from ${JSON.stringify(join(root, 'src/core/dustshoe.ts'))};\n` +
    `export * as st from ${JSON.stringify(join(root, 'src/core/store.ts'))};\n` +
    `export * as rrf from ${JSON.stringify(join(root, 'src/machine/drivers/rrf/driver.ts'))};\n` +
    `export * as files from ${JSON.stringify(join(root, 'src/atc/files.ts'))};\n` +
    `export * as cfg from ${JSON.stringify(join(root, 'src/atc/config.ts'))};\n` +
    `export * as check from ${JSON.stringify(join(root, 'src/atc/check.ts'))};\n` +
    `export * as probing from ${JSON.stringify(join(root, 'src/probing/rrf.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { shoe, st, rrf, files, cfg, check, probing } = await import(pathToFileURL(out).href);

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
const raw = (g) => fetch(`${URL_}/rr_gcode?gcode=${encodeURIComponent(g)}`).then((r) => r.json());
const followState = () => fetch(`${URL_}/__follow`).then((r) => r.json());

// --- Reading M604's report -------------------------------------------------

const doc = rrf.parseAxisFollow('U follows Z as -1.000 * Z + 70.000, engaged');
ok(doc && doc.follower === 'U' && doc.leader === 'Z' && doc.scale === -1 && doc.offset === 70 && doc.engaged,
   'the documented M604 report parses', JSON.stringify(doc));

// "disengaged" contains "engaged". The word boundary handles the spelling
// above on its own; the rewordings below defeat it, and this parser is built on
// the premise that a fork's debug output gets reworded. Reading any of them as
// engaged would report tracking that is not happening.
for (const wording of ['disengaged', 'dis engaged', 'not engaged', 'engaged: no']) {
  const off = rrf.parseAxisFollow(`U follows Z as -1.000 * Z + 70.000, ${wording}`);
  ok(off && off.engaged === false, `"${wording}" does not read as engaged`);
}
ok(rrf.parseJogStatus('Jogging not active, chunk 20ms, timeout 250ms, queue 2, speeds none')?.active === false,
   'and the same rewording of M700 does not read as jogging');

const neg = rrf.parseAxisFollow('U follows Z as -1.000 * Z - 12.500, engaged');
ok(neg && neg.offset === -12.5, 'a negative offset keeps its sign', String(neg?.offset));

const none = rrf.parseAxisFollow('No axis following configured');
ok(none !== null && none.follower === null,
   'a firmware with the feature but nothing set up is supported, not missing');

// Null is the load-bearing return: everything downstream falls back to the
// offset term on null, which is the safe direction.
ok(rrf.parseAxisFollow('Error: unsupported command: M604') === null, 'an unsupported command reads as no support');
ok(rrf.parseAxisFollow('') === null, 'so does silence');
ok(rrf.parseAxisFollow('ok') === null, 'and so does an answer about something else');

// --- What the two generators emit ------------------------------------------

const withShoe = { ...cfg.defaultAtcConfig(), dustShoe: true };
const macroText = (o) => files.atcFiles(withShoe, o).find((f) => f.name === 'atcProbeZ.g').content;

ok(macroText({}).includes('U{-var.newOffset}'),
   'atcProbeZ.g carries the offset term by default');
ok(!macroText({ dustShoeFollowsInFirmware: true }).includes('U{-var.newOffset}'),
   '  and drops it when the firmware follows Z');
ok(macroText({ dustShoeFollowsInFirmware: true }).includes('M604'),
   '  saying so in the file, since an absent term looks like a machine with no shoe');
ok(macroText({ dustShoeFollowsInFirmware: false }).includes('U{-var.newOffset}'),
   '  and an explicit false is still the offset term');

// A machine with no shoe must not gain a U term from either setting — the
// firmware flag is about WHO moves it, not whether there is one.
const noShoe = { ...cfg.defaultAtcConfig(), dustShoe: false };
const noShoeText = (o) => files.atcFiles(noShoe, o).find((f) => f.name === 'atcProbeZ.g').content;
ok(!noShoeText({}).includes('U{-var.newOffset}') && !noShoeText({ dustShoeFollowsInFirmware: true }).includes('U{-var.newOffset}'),
   'a machine with no dust shoe never gets a U term');

// The standalone probing macro makes the same decision and must land the same
// way — these two run on the same machine and would otherwise disagree about
// who moves the shoe depending on which button was pressed.
const toolLength = (o) => probing.probeToolLength({
  probeIndex: 0, tipDiameter: 3, feedFast: 400, feedSlow: 60, maxTravel: 30, backoff: 2, safeZ: 5, wcs: 1,
  probeX: 3, probeY: 1260, probeZ: 41.3, retractZ: 135, dustShoeAxis: 'U', ...o,
}).gcode;

ok(toolLength({ dustShoeFollowsInFirmware: false }).includes('U{-var.newOffset}'),
   'the standalone tool-length macro carries the term without firmware tracking');
ok(!toolLength({ dustShoeFollowsInFirmware: true }).includes('U{-var.newOffset}'),
   '  and drops it with it, exactly like atcProbeZ.g');
ok(!probing.probeToolLength({
     probeIndex: 0, tipDiameter: 3, feedFast: 400, feedSlow: 60, maxTravel: 30, backoff: 2, safeZ: 5, wcs: 1,
     probeX: 3, probeY: 1260, probeZ: 41.3, retractZ: 135,
     dustShoeAxis: null, dustShoeFollowsInFirmware: false,
   }).gcode.includes('U{'),
   '  and a machine with no shoe axis gets nothing either way');

// --- Resolving the setting -------------------------------------------------

// Nothing asked yet. This is the state the app is in for the first second of
// every session, and it has to resolve to the safe answer rather than to
// whatever the eventual reply will be.
ok(shoe.resolveDustShoeTracking('auto').firmware === false,
   'before the board is asked, auto means the offset term');
ok(shoe.resolveDustShoeTracking('firmware').firmware === true, 'forcing firmware tracking works unasked');
ok(shoe.resolveDustShoeTracking('macro').firmware === false, 'and so does forcing the offset term');

st.controllerUrl.set(URL_);
try { await st.connect(URL_, 'rrf'); } catch (e) { console.log('connect threw:', e.message); }
if (!st.activeDriver()) { console.log('could not connect a driver; aborting'); process.exit(2); }

ok(await shoe.probeAxisFollowing(), 'the board is asked whether it can follow one axis with another');
ok(shoe.resolveDustShoeTracking('auto').firmware === true,
   '  and auto then drops the offset term', shoe.resolveDustShoeTracking('auto').why);
ok(shoe.resolveDustShoeTracking('macro').firmware === false,
   '  while an explicit choice of the offset term still wins');
ok(shoe.resolveDustShoeTracking('macro').conflict === false,
   '  and is not flagged as a conflict — it is a legitimate choice');

// The one combination that must be shouted about: told to trust firmware
// tracking on a board that has not confirmed it. The generated macro is valid
// G-code either way, so nothing else in the app would notice.
const axes = [{ letter: 'U', min: 0, max: 70, machine: 30, work: 30, homed: true, maxFeed: 8000, acceleration: 500, jerk: 1000, stepsPerMm: 800, current: 1500, visible: false, workOffsets: [], babystep: 0 }];
const conflicted = check.checkAtc(withShoe, axes, { dustShoeTracking: { firmware: true, conflict: true } });
ok(conflicted.some((i) => i.level === 'bad' && /M604/.test(i.text)),
   'trusting firmware tracking on a board without it is a blocking issue',
   conflicted.filter((i) => i.level === 'bad').map((i) => i.text.slice(0, 40)).join(' | ') || 'none raised');
ok(!check.checkAtc(withShoe, axes, { dustShoeTracking: { firmware: true, conflict: false } })
     .some((i) => i.level === 'bad' && /M604/.test(i.text)),
   '  and agreeing raises nothing');
ok(!check.checkAtc(withShoe, axes).some((i) => /M604/.test(i.text)),
   '  as does calling the check with no machine attached at all');

// --- Against the live board ------------------------------------------------

// Engaging CAPTURES the current separation rather than taking a target, which
// is why the engage macro has to position the axis first. Checked by putting U
// somewhere deliberate and reading back the rule that results.
await raw('G53 G1 Z100 U40');
await sleep(150);
await raw('M604 A"U" B"Z" E1');
await sleep(150);
const engaged = await followState();
ok(engaged.engaged && engaged.follower === 'U' && engaged.leader === 'Z',
   'engaging captures U following Z', JSON.stringify({ scale: engaged.scale, offset: engaged.offset }));
ok(Math.abs(engaged.offset - (40 - -1 * 100)) < 1e-6,
   '  from where the axes actually were, not from an absolute target', String(engaged.offset));

// The property the whole exercise was for: U arrives with Z, not after it.
await raw('G53 G1 Z90');
await sleep(150);
const moved = await followState();
ok(Math.abs(moved.positions.U - 50) < 1e-6,
   'Z moving 10 down moves U 10 up, in the same command',
   `U ${moved.positions.U}`);

// Saturation. U has 70mm and Z has 135, so the shoe runs out first and rests on
// its stop while Z carries on — which is correct, and is what the old daemon
// had to be taught to do.
await raw('G53 G1 Z10');
await sleep(150);
const saturated = await followState();
ok(saturated.positions.U === 70 && saturated.positions.Z === 10,
   'the follower stops at its limit while the leader carries on',
   `U ${saturated.positions.U}, Z ${saturated.positions.Z}`);

await raw('M604 E0');
await sleep(150);
const released = await followState();
ok(!released.engaged, 'disengaging stops the tracking');
await raw('G53 G1 Z60');
await sleep(150);
ok((await followState()).positions.U === 70, '  and U then stays where it was left');

// Read back through the driver, which is the path the app actually uses.
ok((await shoe.probeAxisFollowing(true)) === true, 're-asking finds the feature still there');
ok(shoe.axisFollow.peek()?.engaged === false,
   '  and reports it as disengaged, which is what the board now says',
   JSON.stringify(shoe.axisFollow.peek()));

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
