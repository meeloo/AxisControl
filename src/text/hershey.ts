// Text as a toolpath, without going near a font file.
//
// A Hershey glyph is already a list of pen-up and pen-down moves, so turning a
// line of text into something a machine can cut is layout and arithmetic — no
// outlines, no offsetting, no medial axis. That is the whole reason to start
// here: it is the case where the toolpath IS the letter, which is what you want
// for labelling a fixture or a control panel. Tracing a TrueType outline with a
// V-bit gives outlined letters, not engraved ones, and is a different job.
//
// The .jhf format, for whoever reads this next:
//
//   12345  9MWRFRT RRYQZR[SZRY
//   \___/\_/\/\__________________
//     |   |  |  pairs of characters, one per vertex; each is (char - 'R')
//     |   |  left and right side bearings, also (char - 'R')
//     |   vertex count INCLUDING the bearing pair
//     glyph number, unused here — the file is in ASCII order
//
// A pair of " R" — space, then R — is a pen lift. Y grows downward in the
// original, as it did on the CRT, so it is flipped on the way out.

import { FACES, type HersheyFace } from './faces.js';

/** A run of points the tool cuts without lifting. Millimetres, Y up. */
export type Polyline = Array<{ x: number; y: number }>;

export interface TextOptions {
  /** Cap height in mm. Hershey's own cap height is 21 units. */
  size: number;
  /** Degrees anticlockwise about the start of the baseline. */
  rotation?: number;
  /** Extra space between glyphs, in mm. Negative tightens. */
  tracking?: number;
  /** Baseline separation for multi-line text, as a multiple of size. */
  lineHeight?: number;
  /** Where the text sits relative to (0,0). */
  align?: 'left' | 'centre' | 'right';
  /** Which face, by id. Unknown ids fall back to the first rather than throw. */
  face?: string;
}

/** The faces available, in the order they should be offered. */
export function faces(): HersheyFace[] {
  return FACES;
}

/**
 * Hershey's own units. Cap height is 21 units from baseline to the top of a
 * capital, which is what `size` is scaled against — so 10mm text has 10mm
 * capitals, which is the number a person means.
 */
const CAP_HEIGHT = 21;
const BASE = 'R'.charCodeAt(0);

interface Glyph {
  /** Distance from the origin to the next glyph's origin, in Hershey units. */
  advance: number;
  strokes: Array<Array<{ x: number; y: number }>>;
}

/** Parse one .jhf line. Returns null for a line with nothing drawable. */
function parseGlyph(line: string): Glyph | null {
  if (line.length < 10) return null;
  const left = line.charCodeAt(8) - BASE;
  const right = line.charCodeAt(9) - BASE;
  const strokes: Glyph['strokes'] = [];
  let current: Array<{ x: number; y: number }> = [];

  for (let i = 10; i + 1 < line.length; i += 2) {
    const a = line[i]!;
    const b = line[i + 1]!;
    if (a === ' ' && b === 'R') {
      // Pen up. A run of one point is a dot in principle, but no glyph in this
      // face has one, and emitting a zero-length move would be a plunge with
      // no cut.
      if (current.length > 1) strokes.push(current);
      current = [];
      continue;
    }
    current.push({
      x: a.charCodeAt(0) - BASE - left,
      // Hershey's Y grows downward. Flip here rather than at the end so
      // everything downstream is in the coordinates a machine uses.
      y: -(b.charCodeAt(0) - BASE),
    });
  }
  if (current.length > 1) strokes.push(current);
  return { advance: right - left, strokes };
}

/**
 * Parsed faces, built on first use and kept.
 *
 * Six faces is about 45KB of source and a few thousand small objects once
 * parsed. Parsing all of them at import would be work done for five faces
 * nobody selected, on a board that is also trying to run a machine.
 */
const parsed = new Map<string, Array<Glyph | null>>();

function glyphsOf(faceId: string): Array<Glyph | null> {
  const face = FACES.find((f) => f.id === faceId) ?? FACES[0]!;
  let g = parsed.get(face.id);
  if (!g) {
    g = face.data.split('\n').map(parseGlyph);
    parsed.set(face.id, g);
  }
  return g;
}

function glyphFor(glyphs: Array<Glyph | null>, ch: string): Glyph | null {
  const code = ch.charCodeAt(0);
  if (code < 32 || code > 127) return null;
  return glyphs[code - 32] ?? null;
}

/**
 * Alignment is measured on the ink, not on the advance width.
 *
 * Typography centres the metrics box, which includes the side bearing after
 * the last letter — so centred text sits about half a bearing left of where it
 * looks like it should. On a screen nobody notices. On a workpiece somebody
 * measures it, and "centred" has to mean the letters are centred.
 */
function inkExtent(strokes: Array<Array<{ x: number; y: number }>>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of strokes) {
    for (const p of s) {
      if (p.x < min) min = p.x;
      if (p.x > max) max = p.x;
    }
  }
  return min === Infinity ? { min: 0, max: 0 } : { min, max };
}

/**
 * Lay a string out as polylines, in millimetres with Y up.
 *
 * Returns an empty list for text with nothing drawable in it, rather than
 * throwing: a panel binding this to an input field would otherwise throw on
 * every keystroke that leaves the box empty.
 *
 * Characters outside ASCII are skipped rather than substituted. A box glyph or
 * a question mark would be a thing the machine actually cuts, and cutting a
 * placeholder into somebody's workpiece because their text had an accent in it
 * is worse than the letter being absent.
 */
export function textToPolylines(text: string, options: TextOptions): Polyline[] {
  const scale = options.size / CAP_HEIGHT;
  const trackingUnits = (options.tracking ?? 0) / scale;
  const lineStep = options.size * (options.lineHeight ?? 1.6);
  const angle = ((options.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const align = options.align ?? 'left';
  const glyphs = glyphsOf(options.face ?? FACES[0]!.id);

  const out: Polyline[] = [];
  const lines = text.split('\n');

  lines.forEach((line, row) => {
    // Down the page from the first baseline, so the first line is where the
    // operator put the origin rather than the last one being.
    const originY = -row * lineStep;

    // Laid out from zero first, so the ink can be measured before it is placed.
    const placed: Array<Array<{ x: number; y: number }>> = [];
    let penX = 0;
    for (const ch of line) {
      const g = glyphFor(glyphs, ch);
      if (!g) continue;
      for (const stroke of g.strokes) {
        placed.push(stroke.map((p) => ({ x: penX + p.x * scale, y: p.y * scale })));
      }
      penX += (g.advance + trackingUnits) * scale;
    }
    if (!placed.length) return;

    const ink = inkExtent(placed);
    const shift =
      align === 'centre' ? -(ink.min + ink.max) / 2 : align === 'right' ? -ink.max : -ink.min;

    for (const stroke of placed) {
      out.push(
        stroke.map((p) => {
          const x = p.x + shift;
          const y = p.y + originY;
          // Rotate about the origin of the whole block, not the glyph, so a
          // rotated line stays a straight line.
          return { x: x * cos - y * sin, y: x * sin + y * cos };
        }),
      );
    }
  });

  return out;
}

/** The bounding box of a laid-out block, for showing before anything is cut. */
export function boundsOf(polylines: Polyline[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of polylines) {
    for (const p of line) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}
