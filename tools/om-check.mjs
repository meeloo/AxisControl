// What we believe about RepRapFirmware, checked against Duet's own model.
//
// Issue #1 was a probe field that does not exist: the panel read
// `sensors.probes[].triggered`, the firmware never sent it, and every probe
// read "open" forever. The field was invented in this codebase and nothing
// disagreed, because the mock invented it too.
//
// The lesson generalises past probes. Anywhere this app writes down what the
// object model contains — a field name, an enum's numbering — it is a belief
// that nothing checks at runtime: a wrong one reads `undefined` or maps to the
// wrong case, and the UI shows a confident, constant, wrong answer. So this
// checks the beliefs against @duet3d/objectmodel, which is Duet's own
// description of the model and knows nothing about this app:
//
//   every field our Om* interfaces declare exists on the class Duet ships
//   every subtree we poll exists at the top level
//   M291's mode numbers are MessageBoxMode, not a reading of the docs
//   the derived readouts (probe trigger state) match what the model reports
//
// Plus the one thing no schema can check: that the probing macros aim at the
// material. Run it with `npm run om-check`.

import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as OM from '@duet3d/objectmodel';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'om-'));
const out = join(dir, 'om.mjs');
const entry = join(dir, 'entry.ts');
await writeFile(
  entry,
  `export * as om from ${JSON.stringify(join(root, 'src/machine/drivers/rrf/om.ts'))};\n` +
    `export * as probing from ${JSON.stringify(join(root, 'src/probing/rrf.ts'))};\n` +
    `export * as wcs from ${JSON.stringify(join(root, 'src/wcs/names.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { om, probing, wcs } = await import(pathToFileURL(out).href);

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

// --- Every field we declare, against the class Duet ships --------------------

const src = await readFile(join(root, 'src/machine/drivers/rrf/om.ts'), 'utf8');
// Our interface name minus "Om" is the class name, except where Duet's own
// name differs. `null` means there is no class to check against.
const CLASS_OF = { OmSeqs: null, OmRange: null };

let checked = 0;
for (const m of src.matchAll(/export interface (Om\w+) \{([\s\S]*?)\n\}/g)) {
  const [, name, body] = m;
  const cls = name in CLASS_OF ? CLASS_OF[name] : name.slice(2);
  if (cls === null) continue;
  if (!(cls in OM)) { ok(false, `${name}: no class named ${cls} in @duet3d/objectmodel`); continue; }
  let real;
  try { real = new OM[cls](); } catch (e) { ok(false, `${name}: ${cls} would not instantiate`, e.message); continue; }
  const have = new Set(Object.keys(real));
  const declared = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]);
  const invented = declared.filter((f) => !have.has(f));
  ok(invented.length === 0, `${name} declares only fields ${cls} really has`,
     invented.length ? `invented: ${invented.join(', ')}` : `${declared.length} fields`);
  checked += declared.length;
}
ok(checked > 40, 'and enough of them to be worth calling a check', `${checked} fields`);

const top = new Set(Object.keys(new OM.ObjectModel()));
const tracked = om.TRACKED_KEYS.filter((k) => !top.has(k));
ok(tracked.length === 0, 'every subtree we poll exists at the top level', tracked.join(', '));

// --- M291, whose mode numbers are an enum and not a guess -------------------

// This is the mapping that was wrong: 4 was read as the integer box, which
// slid every later mode along by one, so a float question got a text box and
// was answered with a quoted string the firmware refuses.
const EXPECT = {
  [OM.MessageBoxMode.noButtons]: 'none',
  [OM.MessageBoxMode.closeOnly]: 'close',
  [OM.MessageBoxMode.okOnly]: 'ok',
  [OM.MessageBoxMode.okCancel]: 'ok-cancel',
  [OM.MessageBoxMode.multipleChoice]: 'choice',
  [OM.MessageBoxMode.intInput]: 'input-int',
  [OM.MessageBoxMode.floatInput]: 'input-float',
  [OM.MessageBoxMode.stringInput]: 'input-string',
};
for (const [mode, want] of Object.entries(EXPECT)) {
  const got = om.mapPromptMode(Number(mode));
  ok(got === want, `M291 S${mode} is ${want}`, got === want ? '' : `got ${got}`);
}
ok(Object.keys(EXPECT).length === Object.keys(OM.MessageBoxMode).length / 2,
   'and every mode the firmware has is covered');

// The fields an input box carries. Every one of these was dropped before, so
// prompts opened blank, unbounded and with no way out.
const boxFields = new Set(Object.keys(new OM.MessageBox()));
for (const f of ['default', 'choices', 'cancelButton', 'min', 'max']) {
  ok(boxFields.has(f) && new RegExp(`^\\s{2}${f}\\??:`, 'm').test(src),
     `a message box's \`${f}\` is both real and declared`);
}

// --- Probe trigger state, derived rather than read from a missing field -----

ok(!('triggered' in new OM.Probe()), 'a probe still has no `triggered` field (issue #1)');
ok('triggered' in new OM.Endstop(), 'an endstop still does');
ok(om.probeTriggered({ value: [1000], threshold: 500 }) === true, 'reading 1000 over threshold 500 is triggered');
ok(om.probeTriggered({ value: [0], threshold: 500 }) === false, '  and reading 0 is open');
ok(om.probeTriggered({ value: [0] }) === null, '  and no threshold is unknown, not open');

// --- The work coordinate systems, which do not run G54..G62 -----------------

ok(wcs.wcsCode(6) === 'G59' && wcs.wcsCode(7) === 'G59.1' && wcs.wcsCode(9) === 'G59.3',
   'G59.1-.3 are named as themselves, not as G60-G62',
   [7, 8, 9].map(wcs.wcsCode).join(' '));
const strayLabels = [];
for (const f of ['src/probing/rrf.ts', 'src/ui/capture.ts', 'src/job/preflight.ts']) {
  if (/G\$\{53 \+ /.test(await readFile(join(root, f), 'utf8'))) strayLabels.push(f);
}
ok(strayLabels.length === 0, 'and nothing rebuilds that rule by hand', strayLabels.join(', '));

// --- Boss probing, which no schema can check --------------------------------

const P = { probeIndex: 1, tipDiameter: 3, feedFast: 400, feedSlow: 60, maxTravel: 30,
            backoff: 2, safeZ: 5, wcs: 2, nominalDiameter: 40, probeDepth: 5 };
const boss = probing.probeBore({ ...P, outside: true }).gcode;
const bore = probing.probeBore({ ...P, outside: false }).gcode;

// Walk the macro the way the firmware would, tracking where the probe is and
// which way each G38.2 points, against a boss of the nominal size.
const CENTRE = 100, RADIUS = P.nominalDiameter / 2, TIP = P.tipDiameter / 2;
function simulate(gcode) {
  let x = CENTRE, y = CENTRE, z = 50, rel = false;
  const start = { x: CENTRE, y: CENTRE, z: 50 };
  const vars = {};
  const misses = [], plunges = [];
  const sub = (e) => e.replace(/var\.(\w+)/g, (_, v) => String(vars[v] ?? NaN))
                      .replace(/move\.axes\[0\]\.machinePosition/g, String(x))
                      .replace(/move\.axes\[1\]\.machinePosition/g, String(y))
                      .replace(/move\.axes\[2\]\.machinePosition/g, String(z));
  // `{...}` is RRF's expression delimiter, not a JS block.
  const evaluate = (e) => {
    const body = /^\{[\s\S]*\}$/.test(e.trim()) ? e.trim().slice(1, -1) : e;
    try { return Function(`"use strict";return (${sub(body)})`)(); } catch { return NaN; }
  };
  const at = (a) => (a === 'X' ? x : a === 'Y' ? y : z);
  const set = (a, v) => { if (a === 'X') x = v; else if (a === 'Y') y = v; else z = v; };

  for (const raw of gcode.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('(') || line.startsWith('echo') || line.startsWith('M291')) continue;
    let m;
    if ((m = /^var (\w+) = (.+)$/.exec(line))) { vars[m[1]] = evaluate(m[2]); continue; }
    if (line === 'G91') { rel = true; continue; }
    if (line === 'G90') { rel = false; continue; }
    const machine = /(^|\s)G53(\s|$)/.test(line);
    if ((m = /^G38\.2 K\d+ ([XYZ])(\{[^}]*\}|-?[\d.]+)/.exec(line))) {
      const [, axis, arg] = m;
      const dist = arg.startsWith('{') ? evaluate(arg.slice(1, -1)) : Number(arg);
      if (axis === 'Z') continue;
      const from = at(axis);
      // Trigger where the stylus touches the wall, approaching from outside.
      const wall = from < CENTRE ? CENTRE - RADIUS - TIP : CENTRE + RADIUS + TIP;
      const travel = wall - from;
      if (Math.sign(travel) !== Math.sign(dist) || Math.abs(travel) > Math.abs(dist)) {
        misses.push(`${axis} probe from ${from.toFixed(1)} by ${dist} never reaches the wall at ${wall.toFixed(1)}`);
      } else set(axis, wall);
      continue;
    }
    if (/^G5[03] ?G[01]|^G[01] /.test(line)) {
      const before = { x, y, z };
      for (const w of line.matchAll(/([XYZ])(\{[^}]*\}|-?[\d.]+)/g)) {
        const v = w[2].startsWith('{') ? evaluate(w[2].slice(1, -1)) : Number(w[2]);
        set(w[1], rel && !machine ? at(w[1]) + v : v);
      }
      // Descending: is the probe clear of the boss in plan?
      if (z < before.z) {
        const r = Math.hypot(x - CENTRE, y - CENTRE);
        if (r < RADIUS + TIP) plunges.push(`plunge to Z${z.toFixed(1)} at ${r.toFixed(1)}mm from centre — inside the boss`);
      }
    }
  }
  return { vars, misses, plunges, end: { x, y, z }, start };
}

const sim = simulate(boss);
ok(sim.misses.length === 0, 'every boss probe travels toward the material', sim.misses[0] ?? '');
ok(sim.plunges.length === 0, 'and never descends over the boss itself', sim.plunges[0] ?? '');
ok(Math.abs(sim.vars.xCentre - CENTRE) < 1e-9 && Math.abs(sim.vars.yCentre - CENTRE) < 1e-9,
   'the centre it computes is the centre of the boss',
   `X${sim.vars.xCentre} Y${sim.vars.yCentre}`);
ok(Math.abs(Math.abs(sim.vars.xPlus - sim.vars.xMinus) - P.tipDiameter - P.nominalDiameter) < 1e-9,
   'and the measured size subtracts the tip, because the touches are outside the boss',
   `${Math.abs(sim.vars.xPlus - sim.vars.xMinus)} between touch centres`);
ok(/- 3\}/.test(boss) && !/\+ 3\}/.test(boss), '  which is what the macro echoes');
ok(/\+ 3\}/.test(bore), 'while a bore still adds it');
ok(/ABOVE the centre/.test(boss), 'the boss macro asks for the probe above the centre');
ok(/inside the bore/.test(bore) && !/ABOVE/.test(bore), 'and the bore macro is left as it was');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
