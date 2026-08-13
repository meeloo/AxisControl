// Outline text checked against arithmetic rather than against a look.
//
// Everything this file asserts is something that cuts perfectly happily and
// produces the wrong part: a hole wound the same way as its outer, so the
// offsetter treats it as solid; a capital that is not the height that was
// asked for; a curve flattened to a fixed number of segments, so a big letter
// comes out faceted; text that says it is centred and is not.
//
// The fonts come from the machine rather than from the repository — a licensed
// typeface is not something to check in — so the file picks whatever it finds
// and says which. The one font it does not look for is a single-line engraving
// font, because none ships with a Linux distribution; those are built here with
// opentype.js instead, in both the shapes a stroke font takes: contours left
// open, and contours that run out along the stroke and back over themselves,
// which is the only way TrueType can hold one.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'outline-'));
const out = join(dir, 'o.mjs');
await build({ entryPoints: [join(root, 'src/text/outline.ts')], bundle: true,
  format: 'esm', outfile: out, logLevel: 'error' });
const { parseFont } = await import(pathToFileURL(out).href);
const opentype = await import(pathToFileURL(join(root, 'node_modules/opentype.js/dist/opentype.mjs')).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

const area = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
};
const bounds = (paths) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const [x, y] of p.points) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
};
const points = (paths) => paths.reduce((n, p) => n + p.points.length, 0);

const read = (path) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

// --- Whatever fonts this machine has ----------------------------------------
//
// Two outline formats, because they are the case that matters: TrueType and
// CFF disagree about which way an outer contour winds, so a check that only
// ever loads one of them proves nothing about the other.
const candidates = {
  truetype: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
  ],
  cff: [
    '/usr/share/fonts/opentype/tlwg/Loma.otf',
    '/usr/share/fonts/opentype/urw-base35/NimbusSans-Regular.otf',
    '/usr/share/fonts/OTF/DejaVuSans.otf',
  ],
};

const fonts = [];
for (const [format, paths] of Object.entries(candidates)) {
  const found = paths.find((p) => existsSync(p));
  if (found) fonts.push({ format, path: found, font: parseFont(found, read(found)) });
}
ok(fonts.length > 0, 'a font to test against was found on this machine',
   fonts.map((f) => `${f.format}: ${f.path}`).join('  ') || 'none — install fonts-dejavu');
if (!fonts.length) { console.log('\n1 FAILED: no fonts'); process.exit(1); }
for (const f of fonts) console.log(`      ${f.format}  ${f.path}  ->  "${f.font.info.name}" ${f.font.info.unitsPerEm}/em`);

for (const { format, path, font } of fonts) {
  const label = `${format} (${path.split('/').pop()})`;
  console.log(`\n--- ${label} ---`);

  // --- It produces something at all -----------------------------------------
  const hello = font.layout('HELLO', { size: 10 });
  ok(hello.length > 0, `${label}: text becomes contours`, `${hello.length} contours`);
  ok(font.layout('', { size: 10 }).length === 0, `${label}: empty text is empty, not a throw`);
  ok(font.layout('   ', { size: 10 }).length === 0, `${label}: and so is a line of spaces`);

  // --- Winding: an O is a ring and a hole, not two rings ---------------------
  //
  // The offsetter unions under the even-odd rule and then moves every ring by
  // one signed delta, so containment has to be carried by direction. Two
  // contours winding the same way is a solid blob with a scar on it.
  const o = font.layout('O', { size: 20 });
  ok(o.length === 2, `${label}: "O" is exactly two contours`, `${o.length}`);
  if (o.length === 2) {
    const [a, b] = o.map((p) => area(p.points));
    ok(Math.sign(a) !== Math.sign(b), `${label}: and they wind opposite ways`,
       `${a.toFixed(2)} / ${b.toFixed(2)} mm²`);
    // Outer anticlockwise, hole clockwise — Clipper's normal form, and what
    // orientForCut assumes when it decides which side the material is on.
    const outer = Math.abs(a) > Math.abs(b) ? a : b;
    const hole = Math.abs(a) > Math.abs(b) ? b : a;
    ok(outer > 0 && hole < 0, `${label}: outer anticlockwise, hole clockwise`,
       `outer ${outer.toFixed(2)}, hole ${hole.toFixed(2)}`);
  }
  ok(o.every((p) => p.closed), `${label}: an outline font emits closed contours`);
  ok(!font.info.singleLine, `${label}: and is not mistaken for an engraving font`);

  // --- Size means cap height ------------------------------------------------
  //
  // The number in the box is how tall a capital comes out. If "10mm" gives 7mm
  // capitals the operator finds out with a rule, after cutting.
  for (const size of [3, 10, 50]) {
    const b = bounds(font.layout('H', { size }));
    ok(near(b.maxY - b.minY, size, size * 0.01),
       `${label}: a ${size}mm capital H measures ${size}mm`, (b.maxY - b.minY).toFixed(4));
  }
  // Baseline at y=0, so multi-line text and rotation have a fixed pivot.
  const hBox = bounds(font.layout('H', { size: 10 }));
  ok(near(hBox.minY, 0, 0.001), `${label}: sitting on the baseline at y=0`, hBox.minY.toFixed(4));

  // --- Flattening follows a tolerance, not a segment count ------------------
  //
  // Halving the allowed chord error has to buy points on a curved glyph. A
  // fixed subdivision passes every other check in this file and still facets a
  // 50mm letter.
  const coarse = points(font.layout('O', { size: 50, tolerance: 0.05 }));
  const fine = points(font.layout('O', { size: 50, tolerance: 0.025 }));
  const finer = points(font.layout('O', { size: 50, tolerance: 0.0125 }));
  ok(fine > coarse && finer > fine, `${label}: halving the tolerance adds points`,
     `${coarse} -> ${fine} -> ${finer}`);
  // And the same letter at a tenth the size needs fewer of them, because the
  // tolerance is millimetres on the workpiece rather than font units.
  const big = points(font.layout('O', { size: 50 }));
  const small = points(font.layout('O', { size: 5 }));
  ok(small < big, `${label}: a small letter needs fewer points than a big one`, `${small} vs ${big}`);
  // And the chords themselves shorten, which is the same statement made about
  // the geometry rather than about the point count.
  const longestChord = (paths) => {
    let worst = 0;
    for (const p of paths) for (let i = 0; i < p.points.length; i++) {
      const a = p.points[i], b = p.points[(i + 1) % p.points.length];
      worst = Math.max(worst, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    return worst;
  };
  ok(longestChord(font.layout('O', { size: 50, tolerance: 0.005 })) <
     longestChord(font.layout('O', { size: 50, tolerance: 0.05 })),
     `${label}: a tighter tolerance means shorter chords`);

  // --- Alignment is about the ink -------------------------------------------
  const left = bounds(font.layout('WIDTH', { size: 10, align: 'left' }));
  const mid = bounds(font.layout('WIDTH', { size: 10, align: 'centre' }));
  const right = bounds(font.layout('WIDTH', { size: 10, align: 'right' }));
  ok(near(mid.minX + mid.maxX, 0, 0.001), `${label}: centred text straddles the origin exactly`,
     `${mid.minX.toFixed(3)}..${mid.maxX.toFixed(3)}`);
  ok(near(left.minX, 0, 0.001), `${label}: left-aligned ink starts at the origin`, left.minX.toFixed(4));
  ok(near(right.maxX, 0, 0.001), `${label}: right-aligned ink ends at it`, right.maxX.toFixed(4));
  ok(near(mid.maxX - mid.minX, left.maxX - left.minX, 0.001),
     `${label}: and all three are the same width`, `${(mid.maxX - mid.minX).toFixed(2)}mm`);

  // --- Rotation turns and does not also move --------------------------------
  const flat = bounds(font.layout('HELLO', { size: 10 }));
  const turned = bounds(font.layout('HELLO', { size: 10, rotation: 90 }));
  ok(near(turned.maxY - turned.minY, flat.maxX - flat.minX, 0.05),
     `${label}: rotated 90 degrees, the width becomes the height`,
     `${(flat.maxX - flat.minX).toFixed(2)} -> ${(turned.maxY - turned.minY).toFixed(2)}`);
  const back = bounds(font.layout('HELLO', { size: 10, rotation: 360 }));
  ok(near(back.minX, flat.minX) && near(back.minY, flat.minY),
     `${label}: and a full turn lands where it started`);

  // --- Lines stack downward -------------------------------------------------
  const two = bounds(font.layout('A\nB', { size: 10, lineHeight: 1.5 }));
  const one = bounds(font.layout('A', { size: 10 }));
  ok(near(one.maxY, two.maxY, 0.05), `${label}: the first line stays at the origin`,
     `${one.maxY.toFixed(2)} vs ${two.maxY.toFixed(2)}`);
  ok(near(two.maxY - two.minY, 25, 0.5), `${label}: the second is a line-height below`,
     (two.maxY - two.minY).toFixed(2));

  // --- Tracking adds its millimetres per gap --------------------------------
  const tight = bounds(font.layout('IIIII', { size: 10, tracking: 0 }));
  const loose = bounds(font.layout('IIIII', { size: 10, tracking: 2 }));
  ok(near((loose.maxX - loose.minX) - (tight.maxX - tight.minX), 8, 0.05),
     `${label}: tracking adds its millimetres per gap`,
     `${((loose.maxX - loose.minX) - (tight.maxX - tight.minX)).toFixed(2)}mm across 4 gaps`);

  // --- Kerning --------------------------------------------------------------
  //
  // Only asserted where the font has a kern pair to find; a font with no
  // kerning at all is not a failure of this code.
  const raw = opentype.parse(read(path));
  const A = raw.charToGlyph('A'), V = raw.charToGlyph('V');
  const pair = raw.getKerningValue(A, V) || raw.kerningPairs?.[`${A.index},${V.index}`] || 0;
  if (pair < 0) {
    const kerned = bounds(font.layout('AV', { size: 50 }));
    // Same string, kerning cancelled by adding the pair back as tracking.
    const loosened = bounds(font.layout('AV', { size: 50, tracking: (-pair * 50) / raw.unitsPerEm }));
    ok((loosened.maxX - loosened.minX) > (kerned.maxX - kerned.minX) + 0.1,
       `${label}: "AV" is kerned`, `${(kerned.maxX - kerned.minX).toFixed(2)}mm vs ` +
       `${(loosened.maxX - loosened.minX).toFixed(2)}mm unkerned, pair ${pair}`);
  } else {
    console.log(`      (no "AV" kern pair in this font — kerning not asserted)`);
  }

  // --- Missing glyphs are skipped, not substituted ---------------------------
  //
  // A private-use codepoint, because it is the one thing no text font claims.
  // Cutting a .notdef box into somebody's workpiece because their text had a
  // character this font lacks is worse than the character being absent.
  const absent = '\uE000';
  ok(!raw.hasChar(absent), `${label}: the font really has no U+E000 glyph`);
  ok(font.layout(absent, { size: 10 }).length === 0,
     `${label}: a character the font lacks draws nothing`);
  ok(font.layout(`A${absent}B`, { size: 10 }).length > 0,
     `${label}: without taking the rest of the line with it`);
  // Not restricted to ASCII: an outline font's cmap is the authority, and
  // skipping an accent the font actually has would be losing real letters.
  if (raw.hasChar('é')) {
    ok(font.layout('é', { size: 10 }).length > 0, `${label}: an accented character it has is drawn`);
  }
  // Astral codepoints are one character, not two orphaned surrogate halves.
  const astral = '\u{1F600}';
  if (raw.hasChar(astral)) {
    ok(font.layout(astral, { size: 10 }).length > 0, `${label}: and an astral-plane glyph it has`);
  }
  ok(font.layout('\uD83D', { size: 10 }).length === 0,
     `${label}: a lone surrogate draws nothing rather than throwing`);
}

// --- Single-line fonts -------------------------------------------------------
//
// No engraving font ships with a distribution, so one is built here. Its
// glyphs are open polylines by construction, which is exactly what a stroke
// font such as Relief SingleLine contains, and CFF stores them as authored —
// the round trip through opentype.js keeps the contours open.
console.log('\n--- built single-line font ---');
const stroke = (pts) => {
  const p = new opentype.Path();
  p.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) p.lineTo(x, y);
  return p;
};
const buildFont = (glyphs) => new opentype.Font({
  familyName: 'CheckStroke', styleName: 'Regular', unitsPerEm: 1000,
  ascender: 800, descender: -200,
  glyphs: [new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 600, path: new opentype.Path() }), ...glyphs],
}).toArrayBuffer();

const strokeGlyphs = [
  ['H', 700, [[100, 0], [100, 700]]],
  ['I', 400, [[200, 0], [200, 700]]],
  ['L', 600, [[100, 700], [100, 0], [500, 0]]],
  ['V', 700, [[50, 700], [350, 0], [650, 700]]],
  ['A', 700, [[50, 0], [350, 700], [650, 0]]],
  ['T', 600, [[50, 700], [550, 700]]],
  ['E', 600, [[500, 700], [100, 700], [100, 0], [500, 0]]],
].map(([ch, adv, pts]) => new opentype.Glyph({
  name: ch, unicode: ch.charCodeAt(0), advanceWidth: adv, path: stroke(pts),
}));
const single = parseFont('built-stroke', buildFont(strokeGlyphs));
ok(single.info.singleLine, 'a font of open strokes is detected as single-line');
const strokeH = single.layout('H', { size: 10 });
ok(strokeH.every((p) => !p.closed), 'and its contours are emitted open');
ok(near(bounds(strokeH).maxY - bounds(strokeH).minY, 10, 0.01),
   'with cap height still meaning cap height', (bounds(strokeH).maxY - bounds(strokeH).minY).toFixed(4));
ok(single.layout('', { size: 10 }).length === 0, 'and empty text is still empty');

// The same glyphs drawn as retraced strokes — out along the line and back over
// itself — which is the only way glyf can hold a stroke, since a TrueType
// contour is closed by definition. First point and last point match there, so
// the open-contour test cannot see it and the enclosed-area test has to.
console.log('\n--- built retraced single-line font ---');
const retracedGlyphs = [
  ['H', 700, [[100, 0], [100, 700]]],
  ['I', 400, [[200, 0], [200, 700]]],
  ['L', 600, [[100, 700], [100, 0], [500, 0]]],
  ['V', 700, [[50, 700], [350, 0], [650, 700]]],
  ['A', 700, [[50, 0], [350, 700], [650, 0]]],
  ['T', 600, [[50, 700], [550, 700]]],
].map(([ch, adv, pts]) => new opentype.Glyph({
  name: ch, unicode: ch.charCodeAt(0), advanceWidth: adv,
  path: stroke([...pts, ...pts.slice(0, -1).reverse()]),
}));
const retraced = parseFont('built-retraced', buildFont(retracedGlyphs));
ok(retraced.info.singleLine, 'a font of retraced strokes is detected as single-line too');
ok(retraced.layout('H', { size: 10 }).every((p) => !p.closed), 'and emitted open');

// --- Every font on the machine, not two of them --------------------------------
//
// The assertions above are deep on one TrueType font and one CFF font. This is
// the opposite shape: three shallow questions asked of every font installed,
// because the two that matter most fail silently and fail per font.
//
// Cap height is the reason this exists. A font whose "H" does not sit on the
// baseline scales by a quantity larger than the letter and cuts short, and
// nothing on screen says so — the preview is drawn from the same wrong numbers,
// so it looks right and measures wrong. Three fonts on this machine do exactly
// that (the two IPA gothics and Debian's Japanese gothic, whose Latin "H" is
// raised 104 units), and no pair of test fonts would have caught it.
//
// Fonts that will not parse are counted rather than failed. A distribution can
// ship anything under /usr/share/fonts — NotoColorEmoji here is a bitmap font
// with no outlines at all — and refusing it is correct behaviour, not a fault.
{
  const files = [...new Set(
    execSync('fc-list --format "%{file}\\n" 2>/dev/null || true')
      .toString().split('\n').map((s) => s.trim())
      .filter((f) => /\.(ttf|otf)$/i.test(f)),
  )].sort();

  const unreadable = [];
  const wrongHeight = [];
  const wrongWinding = [];
  const calledSingle = [];
  let checked = 0;

  for (const file of files) {
    let font;
    try {
      const buf = readFileSync(file);
      font = parseFont(basename(file), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } catch {
      unreadable.push(basename(file));
      continue;
    }
    checked++;
    if (font.info.singleLine) calledSingle.push(basename(file));

    const h = font.layout('H', { size: 10 });
    if (h.length) {
      const ys = h.flatMap((p) => p.points.map((q) => q[1]));
      const tall = Math.max(...ys) - Math.min(...ys);
      if (!near(tall, 10)) wrongHeight.push(`${basename(file)} ${tall.toFixed(4)}`);
    }

    if (!font.info.singleLine) {
      const o = font.layout('O', { size: 10 });
      if (o.length === 2) {
        const [a, b] = o.map((p) => area(p.points));
        const outer = Math.abs(a) > Math.abs(b) ? a : b;
        if (Math.sign(a) === Math.sign(b)) wrongWinding.push(`${basename(file)} same sign`);
        else if (outer < 0) wrongWinding.push(`${basename(file)} outer clockwise`);
      }
    }
  }

  ok(checked > 5, `swept ${checked} installed fonts`, `${unreadable.length} not outline fonts, skipped`);
  ok(wrongHeight.length === 0, 'every one of them cuts a 10mm capital at 10mm',
     wrongHeight.length ? wrongHeight.join('; ') : `${checked} fonts`);
  ok(wrongWinding.length === 0, 'and puts an anticlockwise outer around a clockwise hole',
     wrongWinding.length ? wrongWinding.join('; ') : `${checked} fonts`);
  // No ordinary text font may be mistaken for an engraving font: the panel
  // would follow the outline as a line instead of carving the shape.
  ok(calledSingle.length === 0, 'and none of them is mistaken for a single-line font',
     calledSingle.length ? calledSingle.join(', ') : `${checked} fonts`);
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
