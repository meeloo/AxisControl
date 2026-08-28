// Velocity jogging, checked against a machine that behaves like the real one.
//
// Almost nothing here can be verified by reading the code, because the whole
// feature is about time. A stop that is sent but overtaken looks identical to
// one that worked. A host that stops resending looks, for 250ms, exactly like
// one that is working fine. A speed that the firmware quietly halves reports
// success. So this starts tools/mock-rrf.mjs — which implements M700 including
// its watchdog and its silent clamping — drives the real modules against it,
// and asks the board afterwards what actually happened.
//
// The four properties worth the trouble, in order of how much they would cost
// to get wrong:
//
//   releasing stops the machine PROMPTLY, and stops it because we said so
//     rather than because the watchdog eventually noticed — the mock records
//     which, so this cannot pass for the wrong reason
//   going quiet stops the machine anyway, so a dead host is not a runaway
//   a commanded speed above the axis ceiling is clamped, not refused, and the
//     ceiling this app computes agrees with the one the firmware applies
//   an axis that reaches its soft limit stops while the others carry on
//
// The browser shims below are the smallest set that lets this browser code load
// under Node. Deliberately dumb: anything cleverer starts being a fake browser
// and hiding real behaviour.
//
// Run it with `npm run velocity-check`.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = 8124;
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
const dir = await mkdtemp(join(tmpdir(), 'vjog-'));
const out = join(dir, 'v.mjs');
// One entry re-exporting all three, so the bundle carries a single copy of the
// module graph. Three bundles would each get their own store singleton, and the
// driver the store connected would not be the one velocity.ts sends through.
const entry = join(dir, 'entry.ts');
await writeFile(
  entry,
  `export * as v from ${JSON.stringify(join(root, 'src/core/velocity.ts'))};\n` +
    `export * as st from ${JSON.stringify(join(root, 'src/core/store.ts'))};\n` +
    `export * as rrf from ${JSON.stringify(join(root, 'src/machine/drivers/rrf/driver.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { v, st, rrf } = await import(pathToFileURL(out).href);

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
const jogState = () => fetch(`${URL_}/__jog`).then((r) => r.json());
const raw = (g) => fetch(`${URL_}/rr_gcode?gcode=${encodeURIComponent(g)}`).then((r) => r.json());
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// --- Input shaping, which is pure and can be reasoned about ----------------

const S = { maxSpeed: 20, deadzone: 0.1, expo: 2 };

ok(v.shapeStick(0.05, 0.05, S).x === 0, 'inside the deadzone the pad commands nothing');

// Radial, not per-axis. A diagonal nudge of 0.09 on each axis is 0.127 from
// centre, which is outside a 0.1 deadzone — a per-axis test would swallow it
// and leave a square hole in the middle of a round pad.
ok(v.shapeStick(0.09, 0.09, S).x !== 0, 'and the deadzone is radial, not a square hole');

const edge = v.shapeStick(0.101, 0, S);
ok(edge.x > 0 && edge.x < S.maxSpeed * 0.05,
   'just past the deadzone the machine eases off, it does not jump',
   `${edge.x.toFixed(4)} mm/s`);

const full = v.shapeStick(1, 0, S);
ok(near(full.x, S.maxSpeed, 1e-9), 'full deflection is exactly the chosen speed', `${full.x}`);

const past = v.shapeStick(3, 0, S);
ok(near(past.x, S.maxSpeed, 1e-9), 'and a pointer dragged off the pad is not faster than full', `${past.x}`);

// The property the response curve is easiest to break: curving each axis on its
// own bends the direction as well as the magnitude, so a 45° push comes out at
// some other angle and the machine does not go where the thumb points.
const diag = v.shapeStick(0.6, 0.6, S);
ok(near(diag.x, diag.y, 1e-9), 'a 45° push stays at 45° whatever the response curve',
   `${diag.x.toFixed(3)}, ${diag.y.toFixed(3)}`);

// And unlike the distance rose — where a diagonal is deliberately the full step
// on BOTH axes — a diagonal here is the commanded SPEED, shared between them.
// Both of these are full deflection, one into a corner and one straight up, so
// they must be the same speed: a stick in its corner must not travel √2 times
// faster than one pushed north, which is what per-axis scaling would give.
const corner = v.shapeStick(Math.SQRT1_2, Math.SQRT1_2, S);
ok(near(Math.hypot(corner.x, corner.y), v.shapeStick(0, 1, S).y, 1e-9),
   'a diagonal is the same speed as a straight push, shared between the axes',
   `${Math.hypot(corner.x, corner.y).toFixed(3)} vs ${v.shapeStick(0, 1, S).y.toFixed(3)} mm/s`);

// --- Reading the firmware's status line ------------------------------------

const doc = rrf.parseJogStatus('Jogging active, chunk 15ms, timeout 250ms, queue 8, speeds X10.0 Y-5.0');
ok(doc !== null && doc.active && doc.chunkMs === 15 && doc.watchdogMs === 250 && doc.queueDepth === 8
   && doc.speeds.X === 10 && doc.speeds.Y === -5,
   'the documented status line parses', JSON.stringify(doc));

// The line grew a clause between the queue and the speeds when M700 learned to
// clamp at M203. A parser counting fields, or expecting `speeds` right after
// `queue N,`, breaks here — this one hunts for named fields, which is why it
// did not.
const clamped = rrf.parseJogStatus(
  'Jogging active, chunk 15ms, timeout 250ms, queue 8, clamped to axis maximum: Y100.0, speeds Y100.0');
ok(clamped !== null && clamped.active && clamped.chunkMs === 15 && clamped.queueDepth === 8
   && clamped.speeds.Y === 100 && Object.keys(clamped.speeds).length === 1,
   '  and so does one carrying a clamp clause before the speeds', JSON.stringify(clamped));
// Same shape with the word "speed" inside the new clause, which is the version
// that would move the tail if this looked for the first match rather than the
// field.
const reworded = rrf.parseJogStatus(
  'Jogging active, chunk 15ms, timeout 250ms, queue 8, clamped to axis maximum speed: Y100.0, speeds Y100.0');
ok(reworded !== null && reworded.speeds.Y === 100 && Object.keys(reworded.speeds).length === 1,
   '  and a reworded one that puts the word "speed" in that clause', JSON.stringify(reworded));

// "inactive" contains "active". Getting this backwards would have the panel
// show motion on a machine standing still.
const idle = rrf.parseJogStatus('Jogging inactive, chunk 20ms, timeout 250ms, queue 2, speeds none');
ok(idle !== null && idle.active === false, 'and an inactive machine does not read as active');

// Null is the answer that matters: it is how a board without M700 is told apart
// from one that has it, and everything downstream hides itself on null.
ok(rrf.parseJogStatus('Error: unsupported command: M700') === null, 'an unsupported command reads as no support');
ok(rrf.parseJogStatus('Error: Insufficient axes homed') === null, 'so does a refusal');
ok(rrf.parseJogStatus('') === null, 'so does silence');
ok(rrf.parseJogStatus('ok') === null, 'and so does an answer about something else');

// --- Live, against the mock ------------------------------------------------

st.controllerUrl.set(URL_);
try { await st.connect(URL_, 'rrf'); } catch (e) { console.log('connect threw:', e.message); }
if (!st.activeDriver()) { console.log('could not connect a driver; aborting'); process.exit(2); }

ok(await v.probeSupport(), 'the board is asked whether it has M700, and says yes');

// The ceiling this app computes has to be the one the firmware applies, or
// every number on the panel is decoration. It is M203 now and nothing else:
// the firmware ramps toward the commanded velocity instead of planning chunks
// that each stop within themselves, so acceleration and chunk time no longer
// cap the speed. X in the mock has M203 6000, which is 100 mm/s.
const ceilX = v.axisSpeedCeiling('X');
ok(near(ceilX, 100, 1e-9), 'the speed ceiling is the axis maximum, M203', `${ceilX} mm/s`);
ok(near(v.speedCeiling(['X', 'Y']), 100, 1e-9),
   '  and a combined move is held to the lowest of them', `${v.speedCeiling(['X', 'Y'])} mm/s`);
// The old rule would have said 2 x 250 x 0.020 = 10 mm/s here, which is what
// made the speed control useless on a machine that traverses at 100.
ok(ceilX > 10 + 1e-9, '  rather than the 2 x acceleration x chunk figure it used to be');

// Bringing a vector under the ceilings must not turn it into a different
// vector. In the mock, X and Y cap at 10 mm/s and Z at 4: a push mostly north
// with a little Z in it, clamped axis by axis, comes back out as a diagonal.
// The machine would be moving, at a sensible speed, in the wrong direction —
// which is the one thing a jog pad exists not to do.
// Z caps lower than X and Y (M203 Z2000 = 33.3 mm/s), so a push with Z in it
// is still the interesting case.
const asked = { X: 40, Y: 200, Z: 20 };
const fitted = v.fitToCeilings(asked);
ok(near(fitted.Y, 100, 1e-9), 'fitting to the ceilings brings the fastest axis down to it',
   `Y ${fitted.Y}`);
ok(near(fitted.X / fitted.Y, asked.X / asked.Y, 1e-9) && near(fitted.Z / fitted.Y, asked.Z / asked.Y, 1e-9),
   '  and keeps the heading, rather than clamping each axis on its own',
   JSON.stringify(fitted));
ok(Math.abs(fitted.Z) <= v.axisSpeedCeiling('Z') + 1e-9,
   '  leaving every axis under its own ceiling', `Z ${fitted.Z} vs ${v.axisSpeedCeiling('Z')}`);
ok(v.fitToCeilings({ X: 3, Y: 4 }) !== undefined
   && near(v.fitToCeilings({ X: 3, Y: 4 }).X, 3, 1e-9),
   '  and a vector already under them is left exactly alone');

// Ask for twenty times the ceiling. The firmware does not refuse it — that is
// the whole trap — so the check is that it ran at the ceiling and said so.
await raw('G53 G1 X260 Y600 Z115');
await sleep(150);
const before = (await jogState()).positions;
// An owner is required, so the checks name themselves like a panel would.
const pad = v.jogOwnerFor('check');
v.setJogVector({ X: 200 }, pad);
await sleep(500);
const during = await jogState();
ok(during.active, 'a vector set through the app makes the machine move');

// The status says NOTHING about a jog. The firmware used to report "busy" while
// jogging and no longer does, so `idle` here is correct and a host cannot use
// the status to tell whether a jog is running.
ok(st.machine.peek().status === 'idle',
   '  and the machine still reports itself idle, because a jog does not change the status',
   st.machine.peek().status);

// Which makes this the only authority on it, and it has to be the app's own.
ok(v.jogRunning.peek(), '  so the app has to know from its own state that a jog is running');
ok((await jogState()).active, '  and the board really is jogging', 'per /__jog');

// The app must not consult the status either way. Checked from both sides: it
// keeps sending here, and — further down — it still refuses while a program
// runs. 500ms at 30Hz is fifteen commands.
ok(v.canVelocityJog().ok, '  and nothing about the status stops it sending',
   v.canVelocityJog().why || 'allowed');
ok((await jogState()).commands > 5,
   '  so commands keep arriving throughout', `${(await jogState()).commands} sent`);

// An ordinary move DOES still report busy, which is what keeps a running macro
// or print distinguishable — and a jog beginning while one is finishing must
// still be allowed.
await raw('G53 G1 X261 F1000');
await sleep(600);
ok(st.machine.peek().status === 'busy',
   '  while an ordinary move still reports busy, so a macro stays distinguishable',
   st.machine.peek().status);
ok(v.canVelocityJog().ok, '  and jogging is allowed during one anyway',
   v.canVelocityJog().why || 'allowed');
ok(v.jogRunning.peek(), '  with the jog uninterrupted by it');
// The ceiling is M203 and nothing else now. Commanding twice it is not refused
// — the board clamps and says so in its status line, which is what a host has
// to be able to rely on, since a refusal mid-jog would be a stop.
ok(near(during.speeds.X, 100, 1e-6) && near(during.commanded.X, 200, 1e-6),
   '  and 200 mm/s is silently clamped to the M203 ceiling, not refused',
   `asked ${during.commanded.X}, running ${during.speeds.X}`);
ok(during.speeds.X > 10 + 1e-6,
   '    which is ten times what the old 2 x acceleration x chunk rule allowed',
   `${during.speeds.X} mm/s`);
// Nothing this app sends may carry P, D or R.
//
// The board's defaults are measured and they move — they were D2 P20 and are
// now D8 P15 — and a host that pins the old pair runs at about half the speed
// it asks for. There is nothing to gain by sending them either, now that P
// buys stopping distance rather than speed. So the wire is checked directly:
// every M700 that left this app, against the parameters it must not carry.
const everySent = (await fetch(`${URL_}/__sent`).then((r) => r.json())).sent.filter((c) => /^M700/.test(c));
const tuned = everySent.filter((c) => /\b[PDR]\d/.test(c));
ok(everySent.length > 5, 'M700 commands went out', `${everySent.length} of them`);
ok(tuned.length === 0, '  and not one of them tried to tune P, D or R',
   tuned.slice(0, 3).join(' | ') || 'none did');

ok(during.positions.X > before.X + 2,
   '  and the axis really travelled', `${(during.positions.X - before.X).toFixed(2)}mm`);

// --- One machine, more than one panel --------------------------------------
//
// Two Jog panels can be alive at once: two dock groups on a page, or one page
// hidden behind another, which stays mounted because pages are hidden with
// display:none rather than taken apart. Both compute a vector, both from the
// same gamepad. Without a claim they take turns at 30Hz and letting go of
// either stops the machine.

const alice = v.jogOwnerFor('page-1/jog');
const bob = v.jogOwnerFor('page-2/jog');

// From a standing start: the claim is held until it is let go, so the previous
// section's jog has to be over before this one means anything.
v.stopJog();
await sleep(200);
v.setJogVector({ X: 5 }, alice);
await sleep(150);
ok(v.jogHeldBy(alice) && v.jogOwner.peek() === 'page-1/jog',
   'the first panel to ask for motion gets the machine', String(v.jogOwner.peek()));

// The second panel's stick is centred, so it sends an empty vector on every
// frame. That must not stop the jog the first one is holding.
v.setJogVector({}, bob);
await sleep(150);
ok(v.jogRunning.peek() && (await jogState()).active,
   '  and a second panel letting go of nothing does not stop it');

// Nor may it take over mid-jog.
v.setJogVector({ Y: -5 }, bob);
await sleep(200);
const owned = await jogState();
ok(v.jogHeldBy(alice) && owned.speeds.X && !owned.speeds.Y,
   '  nor take it over while the first is still driving', JSON.stringify(owned.speeds));

// The holder letting go frees it, and then the other may have it.
v.setJogVector({}, alice);
await sleep(200);
ok(!v.jogRunning.peek() && v.jogOwner.peek() === null, '  the holder letting go frees the machine');
v.setJogVector({ Y: -5 }, bob);
await sleep(200);
ok(v.jogHeldBy(bob) && (await jogState()).speeds.Y, '  and the other panel can then take it',
   JSON.stringify((await jogState()).speeds));

// releaseJog is scoped; stopJog is not. A Stop button on the panel that is NOT
// driving still has to stop the machine.
v.releaseJog(alice);
await sleep(150);
ok(v.jogRunning.peek(), 'releaseJog from a non-holder does nothing');
v.stopJog('stop button');
await sleep(200);
ok(!v.jogRunning.peek() && !(await jogState()).active,
   '  but stopJog stops it whoever presses it');
ok(v.jogOwner.peek() === null, '  and leaves the machine free for whoever reaches for it next');

// Back to a single owner for the rest of this file.
v.stopJog();
await sleep(150);
await raw('G53 G1 X260 Y600 Z115');
await sleep(200);

// Releasing. Both halves matter: that it stopped, and that OUR stop is what
// stopped it. Without the second half this passes on a host that sends nothing
// at all and lets the watchdog clean up 250ms later.
v.stopJog();
await sleep(120);
const stopped = await jogState();
ok(!stopped.active, 'releasing stops the machine');
ok(stopped.stoppedBy === 'commanded',
   '  because the stop was sent, not because the watchdog fired', String(stopped.stoppedBy));

// The backstop, checked by being a host that dies: one command straight to the
// board, then nothing. Nothing is resending, so this is purely the firmware's
// watchdog — and it has to fire, because it is what stands between a crashed
// tab and a machine that keeps going.
await raw('M700 X5');
await sleep(80);
ok((await jogState()).active, 'a raw M700 with no follow-up starts moving');
await sleep(400);
const dead = await jogState();
ok(!dead.active && dead.stoppedBy === 'watchdog',
   '  and a host that goes quiet is stopped by the watchdog', String(dead.stoppedBy));

// An axis at its soft limit stops while the others carry on. Correct firmware
// behaviour, invisible unless someone says so — the panel marks it, and this is
// the behaviour it is marking.
await raw('G53 G1 X523 Y600');
await sleep(150);
v.setJogVector({ X: 50, Y: 50 }, pad);
await sleep(500);
const split = await jogState();
ok(near(split.positions.X, 524, 0.001), 'an axis that reaches its limit stops there',
   `X ${split.positions.X.toFixed(3)}`);
ok(split.positions.Y > 601, '  while the others carry on at their commanded speed',
   `Y ${split.positions.Y.toFixed(3)}`);
v.stopJog();
await sleep(120);

// A jog cannot be started while a program is running. The refusal comes back as
// console text long after `rr_gcode` returned success, so nothing throws and
// nothing rejects — the only evidence is that the machine did not move. That is
// exactly why the app watches the log for these strings instead of the return
// value, and it is what makes this worth checking rather than assuming.
await raw('M32 "/gcodes/anything.nc"');
// Long enough for a poll to land: the app learns the machine's status from its
// own poll loop, not from the command it just sent.
await sleep(800);
await raw('M700 X5');
await sleep(200);
const busy = await jogState();
ok(!busy.active && busy.stoppedBy === 'printing', 'a jog is refused while a program is running',
   String(busy.stoppedBy));

// The other half of the same distinction: relaxing "busy" must not have relaxed
// this. A program running is something else owning the machine, and the app has
// to refuse before the firmware does.
ok(!v.canVelocityJog().ok, '  and the app refuses it too, without waiting to be told',
   `${st.machine.peek().status}: ${v.canVelocityJog().why || 'allowed'}`);
await raw('M0');
await sleep(800);
ok(v.canVelocityJog().ok, '  and allows it again once the program ends', v.canVelocityJog().why || 'allowed');

// --- A connection that comes back ------------------------------------------

// The pad has to work again afterwards. Losing the connection sets support back
// to 'unknown' — the firmware did not change, the link did — but nothing used
// to ask again, and anything other than 'yes' reads as "not yet", so the pad
// stayed disabled for the rest of the session and the operator reloaded the
// page. On this machine the blip is not hypothetical: something as ordinary as
// the board pausing for longer than the poll's patience produces it.
ok(v.canVelocityJog().ok, 'the pad works before the connection blips', v.canVelocityJog().why || 'allowed');
await st.disconnect();
await sleep(300);
ok(!v.canVelocityJog().ok, '  and stops while there is no connection', v.canVelocityJog().why);
try { await st.connect(URL_, 'rrf'); } catch (e) { console.log('reconnect threw:', e.message); }
for (let i = 0; i < 40 && !v.canVelocityJog().ok; i++) await sleep(100);
ok(v.canVelocityJog().ok, '  and comes back by itself when it returns — no Re-check, no reload',
   v.canVelocityJog().why || 'allowed');

// Everything this suite sent, now that it has done its stopping. A bare M700
// is a status request, so a stop that went out as one would leave the machine
// running while the panel showed it stopped — the one case where the shape of
// the command is the difference between stopped and not.
const allM700 = (await fetch(`${URL_}/__sent`).then((r) => r.json())).sent.filter((c) => /^M700/.test(c));
ok(allM700.some((c) => /^M700 S0$/.test(c)), 'the stop goes out as an explicit S0',
   allM700.filter((c) => /S0/.test(c)).length + ' of them');
// A bare M700 does appear, and should: it is how probeSupport asks the board
// whether it has the command at all. What matters is that no *stop* went out
// that way — with no parameters M700 reports status and moves nothing, so a
// stop shaped like one would leave the machine running while the panel showed
// it stopped.
ok(allM700.filter((c) => /^M700$/.test(c)).length <= 4,
   '  with bare M700 used only to ask for status, not to stop',
   `${allM700.filter((c) => /^M700$/.test(c)).length} status requests`);
ok(!allM700.some((c) => /\b[PDR]\d/.test(c)), '  and nothing ever pinned P, D or R');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
