// Text laid out as a toolpath, checked against arithmetic rather than a look.
//
// This is geometry that ends up in a workpiece, and the failures are the quiet
// kind: a size that is not the size asked for, a rotation that also translates,
// text that creeps because the advance is wrong. All of those cut perfectly
// happily and produce the wrong thing.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'hershey-'));
const out = join(dir, 'h.mjs');
await build({ entryPoints: [join(root, 'src/text/hershey.ts')], bundle: true,
  format: 'esm', outfile: out, logLevel: 'error' });
const { textToPolylines, boundsOf, faces } = await import(pathToFileURL(out).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

// --- It produces something at all ------------------------------------------
const hello = textToPolylines('HELLO', { size: 10 });
ok(hello.length > 0, 'text becomes polylines', `${hello.length} strokes`);
ok(hello.every((s) => s.length > 1), 'and every one is a move, not a plunge');
ok(textToPolylines('', { size: 10 }).length === 0, 'empty text is empty, not a throw');
ok(textToPolylines('   ', { size: 10 }).length === 0, 'and so is a line of spaces');

// --- Size means what it says ------------------------------------------------
//
// The number in the box is cap height. If "10mm" produces 7mm capitals the
// operator finds out with a ruler, after cutting.
for (const size of [5, 10, 25]) {
  const b = boundsOf(textToPolylines('H', { size }));
  ok(near(b.maxY - b.minY, size, size * 0.02),
     `a ${size}mm capital H measures ${size}mm tall`, (b.maxY - b.minY).toFixed(3));
}

// --- Rotation turns, and does not also move --------------------------------
const flat = boundsOf(textToPolylines('HELLO', { size: 10 }));
const turned = boundsOf(textToPolylines('HELLO', { size: 10, rotation: 90 }));
ok(near(turned.maxY - turned.minY, flat.maxX - flat.minX, 0.05),
   'rotated 90 degrees, the width becomes the height',
   `${(flat.maxX - flat.minX).toFixed(2)} -> ${(turned.maxY - turned.minY).toFixed(2)}`);
const back = textToPolylines('HELLO', { size: 10, rotation: 360 });
const first = textToPolylines('HELLO', { size: 10 });
ok(near(boundsOf(back).minX, boundsOf(first).minX) && near(boundsOf(back).minY, boundsOf(first).minY),
   'and a full turn lands exactly where it started');

// --- Alignment is about the origin -----------------------------------------
const left = boundsOf(textToPolylines('WIDTH', { size: 10, align: 'left' }));
const mid = boundsOf(textToPolylines('WIDTH', { size: 10, align: 'centre' }));
const right = boundsOf(textToPolylines('WIDTH', { size: 10, align: 'right' }));
// Measured on the ink, not the advance width: typography centres the metrics
// box, which leaves the letters half a side bearing off centre. Nobody notices
// on a screen; somebody measures it on a workpiece.
ok(near(mid.minX + mid.maxX, 0, 0.01), 'centred text straddles the origin exactly',
   `${mid.minX.toFixed(3)}..${mid.maxX.toFixed(3)}`);
ok(near(left.minX, 0, 0.01), 'left-aligned ink starts at the origin', left.minX.toFixed(3));
ok(near(right.maxX, 0, 0.01), 'right-aligned ink ends at it', right.maxX.toFixed(3));
ok(near(mid.maxX - mid.minX, left.maxX - left.minX, 0.01),
   'and all three are the same width', `${(mid.maxX - mid.minX).toFixed(2)}mm`);

// --- Lines stack downward ---------------------------------------------------
const two = boundsOf(textToPolylines('A\nB', { size: 10, lineHeight: 1.5 }));
const one = boundsOf(textToPolylines('A', { size: 10 }));
ok(near(one.maxY, two.maxY, 0.05), 'the first line stays where the origin is',
   `${one.maxY.toFixed(2)} vs ${two.maxY.toFixed(2)}`);
ok(near(two.maxY - two.minY, 10 + 15, 0.4), 'and the second is a line-height below it',
   (two.maxY - two.minY).toFixed(2));

// --- Tracking, and text that does not creep --------------------------------
const tight = boundsOf(textToPolylines('IIIII', { size: 10, tracking: 0 }));
const loose = boundsOf(textToPolylines('IIIII', { size: 10, tracking: 2 }));
ok(near(loose.maxX - tight.maxX, 8, 0.3), 'tracking adds its millimetres per gap',
   `${(loose.maxX - tight.maxX).toFixed(2)}mm across 4 gaps`);

// --- The face is all there --------------------------------------------------
let missing = [];
for (let c = 33; c <= 126; c++) {
  const ch = String.fromCharCode(c);
  if (textToPolylines(ch, { size: 10 }).length === 0) missing.push(ch);
}
ok(missing.length === 0, 'every printable ASCII character draws something',
   missing.join('') || 'none missing');

// Characters the face has no glyph for are skipped, not substituted: cutting a
// placeholder into somebody's work because their text had an accent is worse
// than the letter being absent.
ok(textToPolylines('é', { size: 10 }).length === 0, 'and a character it lacks draws nothing');
ok(textToPolylines('Aé B', { size: 10 }).length > 0, 'without taking the rest of the line with it');

// --- Every face, not just the default --------------------------------------
//
// Six faces from one parser: a glyph line that the simplex face never produces
// — a longer vertex run, a different bearing — is exactly what the script and
// blackletter faces are full of.
const all = faces();
ok(all.length >= 6, 'six faces are offered', `${all.length}: ${all.map((f) => f.id).join(' ')}`);
for (const face of all) {
  const missing = [];
  for (let c = 33; c <= 126; c++) {
    const ch = String.fromCharCode(c);
    if (textToPolylines(ch, { size: 10, face: face.id }).length === 0) missing.push(ch);
  }
  ok(missing.length === 0, `${face.id} draws every printable character`, missing.join('') || 'none missing');
  const b = boundsOf(textToPolylines('H', { size: 10, face: face.id }));
  // Every Hershey face shares the 21-unit cap height, so a 10mm H is 10mm tall
  // whichever one is chosen — which is what makes swapping faces safe mid-job.
  ok(b !== null && near(b.maxY - b.minY, 10, 0.6), `and its 10mm H measures 10mm`,
     b ? (b.maxY - b.minY).toFixed(2) : 'nothing drawn');
}
ok(textToPolylines('A', { size: 10, face: 'nonsense' }).length > 0,
   'an unknown face falls back rather than throwing');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
