// Text from a font file, as contours a machine can cut.
//
// hershey.ts is the case where the toolpath IS the letter. This is the other
// one: an outline font describes the boundary of the ink, so what comes out of
// here is rings that something downstream has to offset, pocket or V-carve.
// The two files deliberately agree on everything the operator can see — `size`
// is cap height in both, alignment is measured on the ink in both — so changing
// from a Hershey face to a font file does not silently resize the job.
//
// opentype.js does the parsing. What it does not do is normalise anything, and
// what it leaves to the caller all cuts the wrong shape when it is got wrong:
// winding direction, curve flattening, cap height, and whether the font is an
// outline font at all. Every claim below about how fonts behave was measured
// against the fonts on this machine and against the real Relief SingleLine
// release, not remembered; tools/outline-check.mjs re-runs what can be re-run
// without shipping a typeface in the repository.

import { parse, type Font, type Glyph, type PathCommand } from 'opentype.js';
import { signedArea, type Point, type Polyline } from '../import/types.js';

export interface OutlineFont {
  /** Stable id used to select this font. */
  id: string;
  /** Family + style as the file declares it, for the chooser. */
  name: string;
  /** unitsPerEm, for scaling. */
  unitsPerEm: number;
  /** True when the font's glyphs are open strokes rather than closed outlines
   *  (engraving / single-line fonts such as Relief SingleLine). */
  singleLine: boolean;
}

export interface OutlineTextOptions {
  /** Cap height in mm — a capital letter comes out this tall. */
  size: number;
  /** Degrees anticlockwise about the start of the baseline. */
  rotation?: number;
  /** Extra space between glyphs, in mm. Negative tightens. */
  tracking?: number;
  /** Baseline separation for multi-line text, as a multiple of size. */
  lineHeight?: number;
  /** Where the text sits relative to (0,0). */
  align?: 'left' | 'centre' | 'right';
  /**
   * Chord tolerance for flattening curves, in mm at the finished size.
   *
   * This is how far the straight segments may sit from the true curve, so it
   * belongs in millimetres on the workpiece rather than in segments per curve:
   * the same letter at 3mm and at 50mm needs an order of magnitude different
   * number of points to be equally smooth, and a fixed count gives one of them
   * facets and the other a file full of points nobody needed.
   */
  tolerance?: number;
}

export interface ParsedFont {
  info: OutlineFont;
  /** Lay a string out as contours, mm, Y up, positioned like hershey.ts's textToPolylines. */
  layout(text: string, options: OutlineTextOptions): Polyline[];
}

/** Chord tolerance when the caller does not name one, mm at the finished size. */
const DEFAULT_TOLERANCE = 0.01;

/**
 * Segments one curve may be cut into.
 *
 * A tolerance small enough to reach this is finer than the machine can
 * position; the cap is here so that a degenerate control polygon cannot ask for
 * a million points.
 */
const MAX_SEGMENTS = 1024;

/**
 * How many straight segments a Bezier needs to stay within the tolerance.
 *
 * Wang's formula: over a parameter step h a curve leaves its chord by at most
 * h²·max|B''|/8, and max|B''| follows from the second differences of the
 * control points, so solving for the step that keeps that under the tolerance
 * gives the count outright.
 *
 * The more familiar approach — recursively halve while the control points sit
 * further from the chord than the tolerance — was what this did first, and it
 * was replaced because each level of subdivision cuts the error by four. The
 * point count therefore only moves when the tolerance crosses a factor of four:
 * asked for 0.05mm, 0.025mm and 0.0125mm on Loma's "O" it produced 130, 258 and
 * 258 points. Half the range of the setting did nothing at all.
 */
function segmentsFor(maxSecondDerivative: number, tolerance: number): number {
  const n = Math.ceil(Math.sqrt(maxSecondDerivative / (8 * tolerance)));
  return Math.min(MAX_SEGMENTS, Math.max(1, n));
}

function flattenQuadratic(
  out: Point[],
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  tolerance: number,
): void {
  const n = segmentsFor(2 * Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), tolerance);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2]);
  }
}

function flattenCubic(
  out: Point[],
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  tolerance: number,
): void {
  const n = segmentsFor(
    6 * Math.max(
      Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2),
      Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3),
    ),
    tolerance,
  );
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
}

/**
 * Turn one glyph's path commands into rings of points, in font units.
 *
 * Both Q and C turn up and neither is a safe assumption from the file
 * extension: TrueType glyphs arrive as M/L/Q/Z and CFF ones as M/C/Z, and a
 * .otf may hold either.
 *
 * The rings come back exactly as the font authored them, with no closing point
 * added and none removed. The Z is not a point — in both formats the closing
 * edge is implicit, and ordinary CFF fonts lean on that heavily, so the last
 * point of a perfectly normal contour is often nowhere near the first.
 */
function flattenGlyph(commands: PathCommand[], tolerance: number): Point[][] {
  const rings: Point[][] = [];
  let ring: Point[] | null = null;
  let x = 0;
  let y = 0;

  const finish = (): void => {
    if (ring && ring.length > 1) rings.push(ring);
    ring = null;
  };

  for (const command of commands) {
    switch (command.type) {
      case 'M':
        finish();
        ring = [[command.x, command.y]];
        x = command.x;
        y = command.y;
        break;
      case 'L':
        ring?.push([command.x, command.y]);
        x = command.x;
        y = command.y;
        break;
      case 'Q':
        if (ring) flattenQuadratic(ring, x, y, command.x1, command.y1, command.x, command.y, tolerance);
        x = command.x;
        y = command.y;
        break;
      case 'C':
        if (ring) {
          flattenCubic(ring, x, y, command.x1, command.y1, command.x2, command.y2, command.x, command.y, tolerance);
        }
        x = command.x;
        y = command.y;
        break;
      case 'Z':
        finish();
        break;
    }
  }
  finish();
  return rings;
}

/** Perimeter of a ring, counting the closing edge back to the first point. */
function perimeter(ring: Point[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

/** Distance from a ring's last point back to its first. */
function gapOf(ring: Point[]): number {
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return Math.hypot(first[0] - last[0], first[1] - last[1]);
}

/**
 * Mean width of the region a ring encloses, in font units.
 *
 * Twice the area over the perimeter: for a long thin band it is the width of
 * the band, and for a stroke that runs out and back over itself it is zero.
 */
function meanWidth(ring: Point[]): number {
  const length = perimeter(ring);
  return length > 0 ? (2 * Math.abs(signedArea(ring))) / length : 0;
}

/**
 * Is this font's ink a set of strokes rather than a set of outlines?
 *
 * It has to come from the glyph data. Names lie in both directions, and the
 * answer decides whether the toolpath follows the line or V-carves a region,
 * which are not similar mistakes.
 *
 * The obvious test — a contour whose last point does not return to its first is
 * an open stroke — is wrong in both formats, which is worth recording because
 * it looks so plausible:
 *
 *  - TrueType has no open contour. Every glyf contour is closed by definition
 *    and opentype.js's reader walks the points with wraparound, so the last
 *    command always lands back on the moveTo. A stroke stored in glyf is a ring
 *    that runs out along the line and back over itself.
 *  - CFF closes contours implicitly, so ordinary text fonts routinely end a
 *    contour far from where it started and let the closepath draw the last
 *    edge. Loma's "H" ends 1450 units from its start, and it is an entirely
 *    normal outline font. Scoring open contours there calls 60% of the glyphs
 *    strokes.
 *
 * What does separate them is that a stroke encloses no area. Measured over the
 * first 120 drawable glyphs of every font on this machine — DejaVu, Liberation,
 * FreeSerif/Sans/Mono, Loma, OpenSymbol, a Japanese gothic, a bitmap-derived
 * Unifont, and Relief SingleLine's own outline release — not one contour had a
 * mean width under 0.2% of the em, and the thinnest was 2%. The two genuine
 * single-line releases, Relief SingleLine CAD and its ornament face, scored
 * 42.8% and 32.8% of contours under that width. A threshold of 15% sits more
 * than twenty times clear of both ends.
 */
function detectSingleLine(font: Font): boolean {
  const upm = font.unitsPerEm;
  const strokeWidth = upm * 0.002;
  // Nothing here measures anything finer than "does it enclose area", and this
  // runs over a hundred glyphs while the font is being opened.
  const coarse = upm / 50;

  let rings = 0;
  let strokes = 0;
  let examined = 0;
  for (let index = 1; index < font.numGlyphs && examined < 120; index++) {
    const contours = flattenGlyph(font.glyphs.get(index).path.commands, coarse);
    if (!contours.length) continue;
    examined++;
    for (const ring of contours) {
      rings++;
      if (meanWidth(ring) < strokeWidth) strokes++;
    }
  }
  return rings > 0 && strokes / rings > 0.15;
}

/** Crossing-number test, so containment agrees with the even-odd rule the
 *  offsetter uses rather than with a second, subtly different one. */
function pointInRing(ring: Point[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Wind outer rings anticlockwise and holes clockwise.
 *
 * opentype.js hands back whatever the font's own fill convention was, and the
 * two conventions are opposite: measured here, the outer ring of "O" in DejaVu
 * Sans, Liberation Sans and FreeSerif — all TrueType — has negative signed area
 * with the hole positive, while Loma (CFF) has the outer positive and the hole
 * negative. DejaVu emits the hole first, so contour order says nothing either.
 *
 * That would be survivable on its own, because offsetPaths unions under the
 * even-odd rule and Clipper rewinds the result. It is not survivable for the
 * rest of the pipeline: cutting 'on the line' passes paths through untouched
 * and orientForCut then reads winding as "which side is the material", so the
 * same word in two fonts would climb-mill in one and conventional-mill in the
 * other. Deciding it here, from containment rather than from the format, makes
 * the answer the same for every font and matches the normal form offset.ts
 * documents.
 */
function orientByNesting(rings: Point[][]): Point[][] {
  return rings.map((ring, i) => {
    const [px, py] = ring[0]!;
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (j !== i && pointInRing(rings[j]!, px, py)) depth++;
    }
    const wantAnticlockwise = depth % 2 === 0;
    return signedArea(ring) > 0 === wantAnticlockwise ? ring : ring.slice().reverse();
  });
}

/**
 * How tall a capital is, in font units.
 *
 * The top of "H" is measured first, and OS/2's sCapHeight is only the fallback.
 * That is the opposite of the typographic order, and it is deliberate: here the
 * number is not a hint for setting type, it is a dimension somebody will put
 * calipers on. Measuring the outline gives the height of the thing the machine
 * cuts; sCapHeight gives the height the font says it has, and the two disagree
 * often enough to matter. Sweeping every font on this machine through both,
 * asking each for a 10mm capital: ipag and the Japanese gothic cut 9.32mm,
 * ipagp 9.87mm and FreeSerifBold 10.04mm from their declared values, and
 * exactly 10.000mm from the measured one. A 7% error on a nameplate is not a
 * subtlety, and the operator has no way to see where it came from.
 *
 * What is measured is the "H"'s ink height, top minus bottom, and not its top
 * above the baseline. Those are the same number in any font whose capitals sit
 * on the baseline, which is nearly all of them — but the Latin "H" in the two
 * IPA gothic faces and Debian's Japanese gothic is raised 104 units off it, so
 * its top is at 1538 and its ink is 1434 tall. Taking the top scales by a
 * quantity 7% larger than the letter, and the letter comes out 7% short. Ink
 * height is what a caliper reads, and a caliper is the point.
 *
 * A font with no Latin capital to measure — a symbol face, a CJK subset without
 * "H" — falls back to sCapHeight, and then to the 0.7em rule of thumb, which is
 * a guess and is why it is last.
 */
function capHeightOf(font: Font): number {
  const h = font.charToGlyphIndex('H');
  if (h) {
    const box = font.glyphs.get(h).getBoundingBox();
    if (box.y2 > box.y1) return box.y2 - box.y1;
  }
  const declared = font.tables.os2?.sCapHeight;
  if (typeof declared === 'number' && declared > 0) return declared;
  return font.unitsPerEm * 0.7;
}

/**
 * Kerning for one pair, in font units.
 *
 * font.getKerningValue prefers GPOS, and when a font has a GPOS table with no
 * kern feature in it, it returns the empty lookup list's answer of zero and
 * never looks at the older `kern` table. Liberation Sans is exactly that font:
 * 908 pairs in `kern`, an empty GPOS kern lookup, and getKerningValue answering
 * 0 for "AV". DejaVu Sans and FreeSerif behave the same way. Falling through on
 * a zero costs nothing — zero is the no-kerning answer anyway — and is the
 * difference between "AV" at 50mm looking set and looking typed.
 */
function kernBetween(font: Font, left: Glyph, right: Glyph): number {
  const gpos = font.getKerningValue(left, right);
  if (gpos) return gpos;
  return font.kerningPairs?.[`${left.index},${right.index}`] ?? 0;
}

/**
 * Alignment is measured on the ink, not on the advance width.
 *
 * Same reason as hershey.ts: typography centres the metrics box, side bearings
 * included, so centred text sits about half a bearing off. On a screen nobody
 * notices. On a workpiece somebody puts a rule across it.
 */
function inkExtent(rings: Point[][]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const ring of rings) {
    for (const [x] of ring) {
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  return min === Infinity ? { min: 0, max: 0 } : { min, max };
}

/** Parse a font file. Throws with a readable message on anything unparseable. */
export function parseFont(id: string, data: ArrayBuffer): ParsedFont {
  let font: Font;
  try {
    font = parse(data);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${id}: this file is not a font that can be read (${detail}).`);
  }
  if (!font.unitsPerEm || !font.numGlyphs) {
    throw new Error(`${id}: the font declares no glyphs or no units per em, so nothing can be sized from it.`);
  }

  const singleLine = detectSingleLine(font);
  const capHeight = capHeightOf(font);
  const name =
    font.getEnglishName('fullName') ||
    [font.getEnglishName('fontFamily'), font.getEnglishName('fontSubfamily')].filter(Boolean).join(' ') ||
    id;

  const info: OutlineFont = { id, name, unitsPerEm: font.unitsPerEm, singleLine };

  /**
   * Lay a string out as contours, in millimetres with Y up.
   *
   * Empty text returns an empty list rather than throwing, because a panel
   * binding this to an input field would otherwise throw on every keystroke
   * that empties the box.
   *
   * Characters the font has no glyph for are skipped, not substituted. The
   * cmap is the authority, so accents and anything else the file genuinely
   * covers do get cut — unlike the Hershey faces there is no reason to stop at
   * ASCII — but a character it lacks draws nothing at all. A .notdef box is
   * something the machine would really cut into somebody's workpiece, which is
   * worse than the letter being absent.
   */
  function layout(text: string, options: OutlineTextOptions): Polyline[] {
    // Millimetres per font unit, fixed by cap height so that `size` means the
    // same thing here as it does for a Hershey face.
    const scale = options.size / capHeight;
    if (!isFinite(scale) || scale === 0) return [];

    // The tolerance the caller asked for is millimetres on the workpiece, so it
    // has to come back into font units before any curve is subdivided.
    const tolerance = Math.max(1e-9, (options.tolerance ?? DEFAULT_TOLERANCE) / scale);
    const trackingUnits = (options.tracking ?? 0) / scale;
    const lineStep = options.size * (options.lineHeight ?? 1.6);
    const angle = ((options.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const align = options.align ?? 'left';
    const closeRings = !singleLine;

    const out: Polyline[] = [];

    text.split('\n').forEach((line, row) => {
      // Down the page from the first baseline, so the first line is where the
      // operator put the origin rather than the last one being.
      const originY = -row * lineStep;

      // Laid out from zero first, so the ink can be measured before it is placed.
      const placed: Point[][] = [];
      let pen = 0;
      let previous: Glyph | null = null;

      // for...of walks codepoints, not UTF-16 units, so an astral character is
      // one lookup rather than two halves of a surrogate pair that map to
      // nothing.
      for (const ch of line) {
        const index = font.charToGlyphIndex(ch);
        if (!index) continue;
        const glyph = font.glyphs.get(index);
        if (previous) pen += kernBetween(font, previous, glyph);

        let rings = flattenGlyph(glyph.path.commands, tolerance);
        if (closeRings) {
          // Where a contour does end on its start point, that repeat is dropped:
          // a closed polyline already implies the closing edge, and keeping it
          // would add a zero-length segment for every such contour in the job.
          rings = rings.map((ring) =>
            ring.length > 2 && gapOf(ring) < 1e-6 ? ring.slice(0, -1) : ring,
          );
          rings = orientByNesting(rings);
        }
        for (const ring of rings) {
          placed.push(ring.map(([x, y]): Point => [(pen + x) * scale, y * scale]));
        }

        pen += (glyph.advanceWidth ?? 0) + trackingUnits;
        previous = glyph;
      }
      if (!placed.length) return;

      const ink = inkExtent(placed);
      const shift =
        align === 'centre' ? -(ink.min + ink.max) / 2 : align === 'right' ? -ink.max : -ink.min;

      for (const ring of placed) {
        out.push({
          points: ring.map(([px, py]): Point => {
            const x = px + shift;
            const y = py + originY;
            // Rotate about the origin of the whole block, not the glyph, so a
            // rotated line stays a straight line.
            return [x * cos - y * sin, x * sin + y * cos];
          }),
          closed: closeRings,
        });
      }
    });

    return out;
  }

  return { info, layout };
}
