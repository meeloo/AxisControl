// V-carving, checked against the arithmetic it claims rather than against a look.
//
// A V-carve is one of the few toolpaths where a wrong number cannot be seen in
// the preview. The rings look the same whether the depth ladder is d/tan or
// d*tan; the shape of the path is identical and only the Z values differ, so a
// bit angle applied the wrong way round produces a perfectly plausible picture
// and a groove at nearly three times the depth asked for. Everything here ties a
// depth back to a distance that can be measured on the geometry:
//
//   the deepest ring of a 10mm square must be one step short of 5mm
//   every ring of that square must be an inset square 2*depth*tan narrower
//   a 60-degree bit must reach exactly tan45/tan30 times as deep as a 90
//   an annulus must stop at the widest circle that fits in the ring, not at
//     the widest that fits in the outer square
//
// Run it with `npm run vcarve-check`. It compiles vcarve.ts itself.

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'vcarve-'));
const out = join(dir, 'v.mjs');
await build({
  entryPoints: [join(root, 'src/cam/vcarve.ts')],
  bundle: true, format: 'esm', outfile: out, logLevel: 'error',
});
const { vcarve } = await import(pathToFileURL(out).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`);
  if (!c) fails.push(w);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const BASE = {
  vAngle: 90,
  zTop: 0,
  maxDepth: 20,
  stepover: 0.5,
  feedRate: 1200,
  plungeFeed: 300,
  rpm: 18000,
  safeZ: 5,
  spindleDwell: 3,
  tool: 2,
  sourceNote: 'test geometry',
};
const run = (loops, over = {}) => vcarve(loops, { ...BASE, ...over });

/** Axis-aligned closed square of side `side` centred on the origin. */
const square = (side) => {
  const h = side / 2;
  return { points: [[-h, -h], [h, -h], [h, h], [-h, h]], closed: true };
};
const bbox = (pts) => ({
  w: Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0])),
  h: Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1])),
});
/** Every Z the program ever commands. */
const zsOf = (gcode) => gcode.split('\n')
  .map((l) => /^G[01].* Z(-?[\d.]+)/.exec(l))
  .filter(Boolean).map((m) => Number(m[1]));

const TAN45 = Math.tan(Math.PI / 4);
const TAN30 = Math.tan(Math.PI / 6);

// --- The depth ladder on a shape whose medial axis is known by inspection ----
//
// A 10mm square. The largest circle that fits touches all four sides at 5mm, so
// a 90-degree bit (tan of the half angle is exactly 1) reaches 5mm and no more.
// The last ring that still fits is one stepover short of that, and the check has
// to be two-sided: "at least 4.5" alone passes for a generator that never stops,
// and "at most 5" alone passes for one that never starts.
const sq = run([square(10)]);
ok(sq.rings.length > 0, '10mm square, 90 degree bit: it carves something', `${sq.rings.length} rings`);
ok(sq.maxDepthReached <= 5 + 1e-9 && sq.maxDepthReached >= 5 - BASE.stepover - 1e-9,
   'and the deepest ring lands at 5mm, within one step',
   `${sq.maxDepthReached.toFixed(4)}mm, step ${BASE.stepover}mm`);
ok(sq.clipped === false, 'with 20mm of headroom nothing is clipped');

// Each ring, individually, against the geometry it was cut from. This is the
// assertion that a swapped tan cannot survive: the ring is a measurable inset
// square, and its inset has to be exactly the depth times tan(half angle).
{
  let worst = 0;
  for (const r of sq.rings) {
    const b = bbox(r.path.points);
    const inset = (10 - b.w) / 2;
    worst = Math.max(worst, Math.abs(inset - r.depth * TAN45), Math.abs(b.w - b.h));
  }
  ok(worst < 2e-3, 'and every ring is an inset square whose inset is depth * tan(45)',
     `worst error ${worst.toExponential(2)}mm`);
}

// Rings must come out shallow first: cutting the deepest one into solid stock
// and working outward is the same geometry and a broken bit.
{
  const monotonic = sq.rings.every((r, i) => i === 0 || r.depth >= sq.rings[i - 1].depth - 1e-9);
  ok(monotonic, 'rings are ordered outside-in, shallow to deep');
  const zs = zsOf(sq.gcode).filter((z) => z < BASE.safeZ);
  const descending = zs.every((z, i) => i === 0 || z <= zs[i - 1] + 1e-9);
  ok(descending && zs.length > 0, 'and the emitted Z values only ever go down', `${zs.length} cutting Z values`);
}

// Every ring gets its own plunge and its own return to the start.
{
  const plunges = sq.gcode.split('\n').filter((l) => /^G1 Z-?[\d.]+ F/.test(l)).length;
  ok(plunges === sq.rings.length, 'every ring is entered with its own plunge',
     `${plunges} plunges, ${sq.rings.length} rings`);
  const rapids = sq.gcode.split('\n').filter((l) => l === `G0 Z${BASE.safeZ}`).length;
  ok(rapids >= sq.rings.length, 'and reached from safe Z', `${rapids} retracts`);
}

// --- The bit angle, in the direction the geometry actually says ---------------
//
// Worked out from the cone rather than remembered: for the flanks to meet the
// walls a distance d away at the surface, the tip must sit at d / tan(halfAngle).
// A 60-degree bit is the pointier one — half angle 30, tan 0.577 — so the same
// offset puts it DEEPER, not shallower. 1/tan(30) over 1/tan(45) is tan45/tan30,
// and since both bits run out of offsets at the same ring, that ratio is exact.
const sq60 = run([square(10)], { vAngle: 60 });
ok(sq60.maxDepthReached > sq.maxDepthReached,
   'a 60 degree bit goes deeper than a 90 at the same offset, not shallower',
   `${sq60.maxDepthReached.toFixed(4)}mm vs ${sq.maxDepthReached.toFixed(4)}mm`);
ok(near(sq60.maxDepthReached / sq.maxDepthReached, TAN45 / TAN30, 1e-6),
   'and deeper by exactly tan(45)/tan(30)',
   `${(sq60.maxDepthReached / sq.maxDepthReached).toFixed(6)} vs ${(TAN45 / TAN30).toFixed(6)}`);
{
  let worst = 0;
  for (const r of sq60.rings) {
    const b = bbox(r.path.points);
    worst = Math.max(worst, Math.abs((10 - b.w) / 2 - r.depth * TAN30));
  }
  ok(worst < 2e-3, 'and its rings inset by depth * tan(30)', `worst error ${worst.toExponential(2)}mm`);
}
// A 120-degree bit is blunter than a 90 and must come out shallower still.
const sq120 = run([square(10)], { vAngle: 120 });
ok(sq120.maxDepthReached < sq.maxDepthReached,
   'and a 120 degree bit is shallower than a 90',
   `${sq120.maxDepthReached.toFixed(4)}mm vs ${sq.maxDepthReached.toFixed(4)}mm`);

// --- The depth limit is a limit ----------------------------------------------
//
// The one that breaks bits. A 90-degree bit in a 10mm square wants 5mm; an
// operator who typed 2mm gets 2mm, is told so in words containing the number,
// and — checked on the emitted file, not on the metadata — is never commanded
// below it.
const capped = run([square(10)], { maxDepth: 2 });
ok(near(capped.maxDepthReached, 2, 1e-9), 'maxDepth 2 stops the cut at exactly 2mm',
   `${capped.maxDepthReached}mm`);
ok(capped.clipped === true, 'and says so with clipped');
ok(capped.warnings.some((w) => /2mm/.test(w)), 'and warns in words that name the number',
   capped.warnings.find((w) => /2mm/.test(w)) ?? '(no warning)');
ok(capped.rings.every((r) => r.depth <= 2 + 1e-9), 'no ring is deeper than the limit');
{
  const deepest = Math.min(...zsOf(capped.gcode));
  ok(deepest >= BASE.zTop - 2 - 1e-9, 'and no Z in the file goes below it', `lowest Z ${deepest}`);
}
// Past the limit the rings keep marching inward at the same step, so the flat
// bottom is cleared instead of a lump being left in the middle of the letter.
// The ring count is unchanged — the offsets run out where the geometry says, not
// where the depth limit does — so what proves the march continued is that
// several rings now share the limit depth and the innermost ring is still the
// innermost ring the unclipped carve produced.
{
  const atLimit = capped.rings.filter((r) => near(r.depth, 2, 1e-9)).length;
  ok(atLimit > 1, 'and the rings carry on inward at the limit to clear the flat bottom',
     `${atLimit} rings at 2mm`);
  const a = bbox(capped.rings[capped.rings.length - 1].path.points);
  const b = bbox(sq.rings[sq.rings.length - 1].path.points);
  ok(near(a.w, b.w, 1e-6), 'reaching the same innermost ring as the unclipped carve',
     `${a.w.toFixed(3)}mm wide vs ${b.w.toFixed(3)}mm`);
  ok(sq.rings.every((r, i) => i === 0 || r.depth > sq.rings[i - 1].depth + 1e-9),
     'while the unclipped carve gives every ring a depth of its own');
}
// A limit that never bites must not claim it did.
ok(run([square(10)], { maxDepth: 8 }).clipped === false, 'a limit that never bites sets no flag');

// --- Holes: the counter of an O is a ring, not a disc -------------------------
//
// Outer 40mm square with a 20mm square hole. Two things could go wrong and both
// cut a ruined sign: the hole could be carved solid, or it could be ignored and
// the depth taken from the outer square alone.
//
// The right answer is not 5mm. Along the flats the ring is 10mm wide, so the
// medial axis there is at 5 — but in each corner the largest inscribed circle
// touches the outer walls and the hole's corner at once, centred at t on the
// diagonal with 20 - t = sqrt(2)(t - 10), so t = 14.142 and the radius is 5.858.
// That is what the carve must reach, and it is what the offsets were measured
// doing: the last non-empty offset of this annulus is at 5.8, empty at 5.9.
const annulus = run([square(40), square(20)]);
const solid = run([square(40)]);
ok(annulus.rings.length > 0, 'an annulus carves something', `${annulus.rings.length} rings`);
ok(solid.maxDepthReached > 19,
   'a solid 40mm square reaches nearly 20mm as a sanity baseline',
   `${solid.maxDepthReached.toFixed(4)}mm`);
ok(annulus.maxDepthReached <= 5.858 + 1e-9 &&
   annulus.maxDepthReached >= 5.858 - BASE.stepover - 1e-9,
   'the annulus stops at the 5.858mm corner circle, not at the 20mm one',
   `${annulus.maxDepthReached.toFixed(4)}mm`);

// Nothing may enter the hole. Its interior is Chebyshev radius under 10, and the
// grown hole boundary at the shallowest ring is at 10 + one step.
{
  let inside = 0;
  let closest = Infinity;
  for (const r of annulus.rings) {
    for (const [x, y] of r.path.points) {
      const cheb = Math.max(Math.abs(x), Math.abs(y));
      closest = Math.min(closest, cheb);
      if (cheb < 10 - 1e-6) inside++;
    }
  }
  ok(inside === 0, 'no ring point falls inside the hole', `${inside} points inside`);
  ok(closest > 10, 'and the nearest ring stands off its wall',
     `closest approach ${closest.toFixed(3)}mm from centre, hole wall at 10mm`);
}

// Two rings at the shallow levels — the shrinking outer and the growing hole —
// where a filled counter would give one.
{
  const shallowest = Math.min(...annulus.rings.map((r) => r.depth));
  const atTop = annulus.rings.filter((r) => near(r.depth, shallowest, 1e-9));
  ok(atTop.length === 2, 'the shallowest level is two rings, outer and hole',
     `${atTop.length} rings at ${shallowest.toFixed(3)}mm`);
  const areas = atTop.map((r) => {
    const q = r.path.points;
    let a = 0;
    for (let i = 0; i < q.length; i++) {
      const b = q[(i + 1) % q.length];
      a += q[i][0] * b[1] - b[0] * q[i][1];
    }
    return Math.abs(a / 2);
  });
  ok(Math.max(...areas) > Math.min(...areas), 'one enclosing the other',
     areas.map((a) => a.toFixed(1)).join(' and '));
}

// A round O, with both rings wound the same way, which is what an SVG or a DXF
// actually hands over — nothing in either format marks one loop as a hole. If
// containment were being taken from the winding rather than from the even-odd
// union offsetPaths does first, this is the case that would carve the counter
// solid while the square annulus above still passed.
{
  const ring = (r, ccw) => ({
    closed: true,
    points: Array.from({ length: 180 }, (_, i) => {
      const a = ((ccw ? 1 : -1) * 2 * Math.PI * i) / 180;
      return [r * Math.cos(a), r * Math.sin(a)];
    }),
  });
  for (const [what, hole] of [['opposite winding', ring(10, false)], ['same winding', ring(10, true)]]) {
    const o = run([ring(20, true), hole]);
    const closest = Math.min(...o.rings.flatMap((x) => x.path.points.map(([px, py]) => Math.hypot(px, py))));
    // The wall of the ring is 10mm wide, so the inscribed circle is 5mm and a
    // 90-degree bit reaches 5mm — unlike the square annulus there is no corner
    // to hide extra width in.
    ok(o.rings.length > 0 && closest > 10 && o.maxDepthReached <= 5 + 1e-9
         && o.maxDepthReached >= 5 - BASE.stepover - 1e-9,
       `a round O with its counter at ${what} carves a ring, not a disc`,
       `${o.maxDepthReached.toFixed(3)}mm deep, nearest point ${closest.toFixed(3)}mm from centre`);
  }
}

// --- A flat tip shifts the whole ladder --------------------------------------
//
// Depth is (d - w/2) / tan, so a 2mm flat on a 90-degree bit (tan 1) is exactly
// 1mm of lost depth at every offset — the deepest ring included, since the flat
// does not change which offset is the last one to fit.
const tipped = run([square(10)], { tipWidth: 2 });
ok(tipped.maxDepthReached < sq.maxDepthReached, 'a flat tip reaches less deep',
   `${tipped.maxDepthReached.toFixed(4)}mm vs ${sq.maxDepthReached.toFixed(4)}mm`);
ok(near(tipped.maxDepthReached, sq.maxDepthReached - 1, 1e-9),
   'and less deep by exactly half the flat, over tan(45)',
   `${(sq.maxDepthReached - tipped.maxDepthReached).toFixed(6)}mm lost`);
{
  let worst = 0;
  for (const r of tipped.rings) {
    const b = bbox(r.path.points);
    worst = Math.max(worst, Math.abs((10 - b.w) / 2 - (r.depth * TAN45 + 1)));
  }
  ok(worst < 2e-3, 'and every ring insets by depth * tan(45) plus the half flat',
     `worst error ${worst.toExponential(2)}mm`);
}
ok(tipped.rings.every((r) => r.depth > 0), 'offsets inside the flat cut nothing and are not emitted');
ok(run([square(10)], { tipWidth: 0 }).maxDepthReached === sq.maxDepthReached,
   'and tipWidth 0 is the same as no tip at all');

// A shape narrower than the flat itself cannot be cut by this bit.
{
  const thin = vcarve([{ points: [[0, 0], [20, 0], [20, 1], [0, 1]], closed: true }],
                      { ...BASE, tipWidth: 3, stepover: 0.1 });
  ok(thin.rings.length === 0 && thin.warnings.length > 0,
     'a shape narrower than the flat tip warns instead of carving',
     thin.warnings[0] ?? '(silent)');
}

// --- Degenerate input returns a program, never a throw ------------------------
const degenerate = [
  ['empty list', [], {}],
  ['open paths only', [{ points: [[0, 0], [10, 0], [10, 10]], closed: false }], {}],
  ['a two-point ring', [{ points: [[0, 0], [10, 0]], closed: true }], {}],
  ['a shape smaller than one step', [square(0.4)], {}],
  ['a nonsense bit angle', [square(10)], { vAngle: 0 }],
  ['a 180 degree bit', [square(10)], { vAngle: 180 }],
  ['a zero depth limit', [square(10)], { maxDepth: 0 }],
];
for (const [what, loops, over] of degenerate) {
  let r = null;
  let threw = null;
  try { r = run(loops, over); } catch (e) { threw = e.message; }
  ok(threw === null && r !== null && r.warnings.length > 0 && typeof r.gcode === 'string'
       && r.rings.length === 0 && r.maxDepthReached === 0 && r.clipped === false,
     `${what} returns a program with warnings, not a throw`,
     threw ? `threw: ${threw}` : (r?.warnings[0] ?? '(no warning)'));
}
// A zero stepover is a typo, not a reason to hang or divide by zero.
{
  const zero = run([square(10)], { stepover: 0 });
  ok(zero.rings.length > 0 && zero.warnings.some((w) => /stepover/i.test(w)),
     'a zero stepover is substituted and said out loud',
     zero.warnings.find((w) => /stepover/i.test(w)) ?? '(silent)');
}

// --- The program is a program -------------------------------------------------
{
  const lines = sq.gcode.split('\n');
  ok(lines.includes('G21 G90 G17 G94'), 'the file opens in mm, absolute, XY plane, feed per minute');
  ok(lines.includes('T2'), 'the tool change is a bare T, as RepRapFirmware wants');
  ok(lines.includes(`M3 S${BASE.rpm}`) && lines.includes('G4 S3'), 'the spindle starts and is waited for');
  ok(lines[lines.length - 2] === 'M2', 'and it ends on M2, not M30', lines[lines.length - 2]);
  ok(lines.includes('M5'), 'with the spindle stopped first');
  ok(run([square(10)], { tool: null }).gcode.split('\n').every((l) => !/^T\d/.test(l)),
     'and no tool is invented when none was chosen');
}

// --- It admits what it is -----------------------------------------------------
//
// The point of the whole file. An operator reading the top of the program has to
// find out that this is an approximation, which way it errs, and what to do about
// it, without opening the source.
{
  const head = sq.gcode.slice(0, sq.gcode.indexOf('G21'));
  ok(/medial axis/i.test(head), 'the file says it approximates the medial axis');
  ok(/not a true/i.test(head), 'and that it is not the real thing');
  ok(/stepover/i.test(head), 'and names the knob that trades finish for time');
  const bluntness = /left up to\s*\n?.*?([\d.]+)mm shallower/s.exec(head);
  ok(bluntness !== null && near(Number(bluntness[1]), BASE.stepover / TAN45, 1e-3),
     'and quotes the bluntness in millimetres, correctly',
     bluntness ? `${bluntness[1]}mm, expected ${(BASE.stepover / TAN45).toFixed(3)}mm` : '(not stated)');
}

// --- The same arithmetic, read off the emitted file ---------------------------
//
// Everything above asserts against `rings`, which is the generator describing
// its own work. This section throws that away and reads the G-code the way a
// controller would — modal X, Y and Z, one line at a time — then checks every
// cutting move against the geometry directly: the distance from that point to
// the nearest wall of the original square, divided by tan(halfAngle), has to be
// the depth the move is at. It is the same claim approached from the far end,
// and it is the end that actually runs.
{
  const modal = (gcode) => {
    let x = 0, y = 0, z = 0;
    const cuts = [];
    for (const raw of gcode.split('\n')) {
      const line = raw.replace(/\(.*?\)/g, '').trim();
      const g = /^G([01])\b/.exec(line);
      if (!g) continue;
      const mx = /X(-?[\d.]+)/.exec(line);
      const my = /Y(-?[\d.]+)/.exec(line);
      const mz = /Z(-?[\d.]+)/.exec(line);
      if (mx) x = Number(mx[1]);
      if (my) y = Number(my[1]);
      if (mz) z = Number(mz[1]);
      if (g[1] === '1' && (mx || my)) cuts.push([x, y, z]);
    }
    return cuts;
  };

  for (const angle of [90, 60, 120]) {
    const tanHalf = Math.tan(((angle / 2) * Math.PI) / 180);
    const r = run([square(20)], { vAngle: angle, maxDepth: 100 });
    const cuts = modal(r.gcode);
    let worst = 0;
    for (const [x, y, z] of cuts) {
      // square() is centred on the origin, so the walls are at ±10.
      const wall = Math.min(x + 10, y + 10, 10 - x, 10 - y);
      worst = Math.max(worst, Math.abs(z - -wall / tanHalf));
    }
    ok(cuts.length > 50 && worst < 1e-3,
       `${angle} degrees: every cutting move in the file sits at wall distance / tan`,
       `${cuts.length} moves, worst error ${worst.toExponential(1)}mm`);

    // And the shortfall against a true V-carve is exactly the figure the header
    // quotes — not merely bounded by it. A 20mm square's medial axis is 10mm
    // from the walls, so the ideal bottom is 10/tan; the last ring that fits is
    // one stepover short of the axis, which is one stepover / tan of depth.
    ok(near(r.maxDepthReached, (10 - BASE.stepover) / tanHalf, 1e-9),
       `  and falls exactly one stepover short of the axis, not less and not more`,
       `${r.maxDepthReached.toFixed(4)}mm against an ideal ${(10 / tanHalf).toFixed(4)}mm`);
  }
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
