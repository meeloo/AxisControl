// V-carving: cutting a closed outline with a V-bit so the groove is deep where
// the shape is wide and shallow where it is narrow, which is what gives hand-cut
// lettering its chiselled look.
//
// The honest name for what this does is the offset-ladder approximation of the
// medial axis. It is not a true medial-axis V-carve, and it is worth saying so
// before anything else — a machinist who is told which approximation he is being
// handed can decide what to do about it, and one who is told "V-carve" and left
// to find the difference in the workpiece cannot.
//
// The geometry it rests on is exact. Stand a V-bit at a point that is a distance
// d from the nearest wall on every side and drop it to depth d / tan(halfAngle);
// its cone then meets the surface exactly d out in every direction, so it touches
// both walls and cuts nothing beyond them. "Offset the outline inward by d, cut
// that ring at d / tan(halfAngle)" is therefore the correct depth everywhere the
// shape is locally a strip, which is most of a letter. Walking d inward in steps
// and stopping when the offsets collapse carves the whole groove.
//
// What is approximate is only that d moves in steps. The rings themselves are
// exact — this was measured against Clipper rather than assumed, because the two
// places it could have gone wrong are the two places it matters:
//
//   At a reflex corner of the shape (the inside of an L, the crotch of a Y) the
//   points a distance d away lie on a circular arc of radius d about the corner.
//   Clipper's round joins draw precisely that: offsetting a square hole outward
//   by 1mm puts its corner vertices 1.0000–1.0002mm from the corner. That is the
//   true medial-axis geometry, not a rounding-off of it.
//
//   At an acute convex corner (the point of a V, a serif) the offsets stay sharp
//   and their apex walks in along the bisector at d / sin(halfWedge), which is
//   again exactly where the medial axis spoke runs. A 30-degree wedge offset by
//   2mm has its apex at 7.728mm; theory says 7.7274mm.
//
// So the whole error is at the far end of the ladder: the last ring that still
// fits sits up to one step short of the medial axis, and nothing cuts past it.
// The bottom of the groove comes out up to stepover / tan(halfAngle) shallower
// than a true V-carve, and a sharp point comes out with a small flat on it rather
// than running to a true point. Halving the stepover halves both and doubles the
// program length. That sentence, with the actual millimetres in it, is printed at
// the top of every file this produces, because it is the trade the operator is
// being offered and he cannot see it in the toolpath.

import { Gcode, n, type GeneratedProgram } from './format.js';
import { offsetPaths } from '../import/offset.js';
import type { Polyline } from '../import/types.js';

export interface VCarveParams {
  /** Full included angle of the V-bit, degrees (60 and 90 are the common ones). */
  vAngle: number;
  /** Flat width at the tip, mm. 0 for a true point. */
  tipWidth?: number;
  /** Top of the material in work coordinates. */
  zTop: number;
  /** Refuse to go deeper than this, mm, however wide the shape is. */
  maxDepth: number;
  /** Radial step between offset rings, mm. Smaller is finer and slower. */
  stepover: number;
  feedRate: number;
  plungeFeed: number;
  rpm: number;
  safeZ: number;
  spindleDwell: number;
  /**
   * Tool to change to before cutting, or null to use whatever is loaded. Null is
   * the honest default, for the same reason it is in profile(): a panel where no
   * tool was chosen does not know what is in the spindle.
   */
  tool?: number | null;
  sourceNote: string;
}

export interface VCarveResult extends GeneratedProgram {
  /** Deepest point the program actually reaches, mm below zTop. Positive. */
  maxDepthReached: number;
  /** True when maxDepth clipped the cut somewhere. */
  clipped: boolean;
  /** The rings, for drawing a preview: depth is mm below zTop, positive. */
  rings: Array<{ path: Polyline; depth: number }>;
}

/**
 * Chord tolerance for the arcs the offsetter puts at reflex corners, mm.
 *
 * Fixed rather than exposed: it is the same 0.02mm the importer flattens curves
 * at, it is an order of magnitude below anything a router leaves behind, and one
 * more number in the panel that nobody can sensibly answer is worse than none.
 */
const ARC_TOLERANCE = 0.02;

/** Substituted when the stepover asked for is not a positive number, mm. */
const MIN_STEP = 0.05;

/**
 * Rings are abandoned past this many levels.
 *
 * The march ends when the offsets collapse, which always happens for a bounded
 * shape — but a 0.01mm stepover across a 400mm sign is a hundred thousand rings
 * and a program nobody wants, arrived at slowly. The cap turns that into a
 * warning instead of a hang.
 */
const MAX_LEVELS = 4000;

const DEG = Math.PI / 180;

/**
 * Pure inward offset of `loops` by `distance` millimetres.
 *
 * offsetPaths has no "offset by d" mode — it thinks in cutters, and its delta is
 * (toolDiameter / 2 + allowance), signed by the side. An inside cut with a tool
 * of diameter 2d and no allowance is exactly an inward offset by d, so that is
 * the form used here rather than a second copy of the Clipper setup. Its
 * handling of containment comes with it: a drawing's outer rings and holes are
 * unioned even-odd first, which leaves outers anticlockwise and holes clockwise,
 * and one negative delta then shrinks the outers while it grows the holes. That
 * is what stops the counter of an O from being carved solid.
 *
 * Its warnings are dropped deliberately. It reports "the tool does not fit
 * inside them" whenever a profile vanishes, which for a single cut is exactly
 * what you want to hear and here happens once per ring by design — every
 * V-carve ends with its offsets collapsing. The warnings this operation really
 * needs are raised once, below, against the ladder as a whole.
 */
function inward(loops: Polyline[], distance: number): Polyline[] {
  return offsetPaths(loops, {
    side: 'inside',
    toolDiameter: distance * 2,
    allowance: 0,
    tolerance: ARC_TOLERANCE,
  }).loops;
}

export function vcarve(loops: Polyline[], p: VCarveParams): VCarveResult {
  const warnings: string[] = [];

  const closed = loops.filter((l) => l.closed && l.points.length >= 3);
  const open = loops.length - closed.length;
  if (open) {
    warnings.push(
      `${open} open path(s) ignored — a V-carve needs a closed outline to have an inside at all. Cut them on the line instead.`,
    );
  }

  if (!(p.vAngle > 0 && p.vAngle < 180)) {
    warnings.push(
      `${n(p.vAngle)} degrees is not a V-bit: the included angle has to be between 0 and 180, and 60 or 90 is what is usually in the drawer.`,
    );
    return nothing(p, warnings);
  }
  const tanHalf = Math.tan((p.vAngle / 2) * DEG);

  // Half the flat at the tip. A bit ground to a true point has none, and the two
  // cases are the same arithmetic — the flat simply shifts the whole ladder, so
  // that an offset of d reaches (d - flat) / tan rather than d / tan, and any
  // offset inside the flat itself reaches nothing.
  const flat = Math.max(0, p.tipWidth ?? 0) / 2;

  let step = p.stepover;
  if (!(step > 0)) {
    warnings.push(
      `A stepover of ${n(p.stepover)}mm is not a step — ${n(MIN_STEP)}mm used instead. Set one deliberately.`,
    );
    step = MIN_STEP;
  }

  const limit = Math.max(0, p.maxDepth);
  if (limit <= 0) {
    warnings.push('The depth limit is zero or negative, so there is nothing this could cut.');
    return nothing(p, warnings);
  }

  if (!closed.length) {
    warnings.push('No closed outlines to V-carve.');
    return nothing(p, warnings);
  }

  const rings: Array<{ path: Polyline; depth: number }> = [];
  let clipped = false;
  let maxDepthReached = 0;
  let deepestWanted = 0;
  let widestOffset = 0;
  let collapsed = false;

  for (let level = 1; level <= MAX_LEVELS; level++) {
    const d = level * step;
    const found = inward(closed, d);
    // The offsets are nested: the set of points at least d from the boundary
    // only shrinks as d grows, so the first empty one is the last one. Stopping
    // here rather than probing further is safe and is where most of the runtime
    // of this function goes.
    if (!found.length) {
      collapsed = true;
      break;
    }
    widestOffset = d;

    const wanted = (d - flat) / tanHalf;
    // Inside the flat at the tip the bit is not a V at all, and a ring there
    // would be a full-width scrape at zero depth. Skipped, not cut.
    if (wanted <= 0) continue;
    deepestWanted = wanted;

    const depth = Math.min(wanted, limit);
    if (wanted > limit + 1e-9) clipped = true;
    if (depth > maxDepthReached) maxDepthReached = depth;
    for (const path of found) rings.push({ path, depth });
  }

  if (!collapsed) {
    warnings.push(
      `Stopped after ${MAX_LEVELS} rings without the offsets collapsing. The stepover (${n(step)}mm) is very small for this drawing — the middle of the widest areas is left uncut.`,
    );
  }

  if (!rings.length) {
    warnings.push(
      flat > 0 && widestOffset > 0
        ? `Nothing is wider than the ${n(flat * 2)}mm flat on the tip of this bit, so it can only rub. Use a pointed bit or a smaller one.`
        : `Nothing is wider than one ${n(step)}mm step, so no ring survives. Reduce the stepover.`,
    );
    return nothing(p, warnings);
  }

  if (clipped) {
    warnings.push(
      `Depth limited to ${n(limit)}mm: a ${n(p.vAngle)} degree bit would have gone ${n(deepestWanted)}mm down at the widest point. ` +
        `The bottom comes out flat at ${n(limit)}mm there instead of running to a point, and the rings past the limit clear that flat at the same ${n(step)}mm step.`,
    );
  }

  // The blunt ridge, in the units the operator sets: one step of offset is one
  // step / tan(halfAngle) of depth, and the last ring is up to one step short of
  // the medial axis.
  const bluntness = step / tanHalf;

  // Longhand plurals rather than "outline(s)". Gcode.comment strips brackets —
  // it has to, since a comment is delimited by them — so the shorthand arrives
  // in the file as "1 closed outlines", and a header that cannot count is not
  // one an operator reads the rest of.
  const many = (k: number, one: string, more: string) => `${k} ${k === 1 ? one : more}`;

  const g = new Gcode();
  g.header('V-carve', [
    p.sourceNote,
    `${many(closed.length, 'closed outline', 'closed outlines')}, ${n(p.vAngle)} degree bit` +
      (flat > 0 ? `, ${n(flat * 2)}mm flat at the tip` : ', pointed tip'),
    `${many(rings.length, 'ring', 'rings')} at ${n(step)}mm steps, deepest ${n(maxDepthReached)}mm below Z${n(p.zTop)}`,
    ...(clipped ? [`depth clipped at ${n(limit)}mm; unclipped it would reach ${n(deepestWanted)}mm`] : []),
    'This is the offset-ladder approximation of the medial axis, not a true',
    'medial-axis V-carve. The outline is offset inward in fixed steps and each',
    'ring is cut at the depth where the cone of the bit just touches both walls,',
    'so the walls and the run-out into corners are right. What the cut never',
    'reaches is the last step: the bottom of the groove is left up to',
    `${n(bluntness)}mm shallower than a true V-carve, and a sharp point comes out`,
    'with a small flat on it rather than running to a point. Halve the stepover',
    'to halve both, at twice the program length.',
  ]);
  g.blank();
  g.toolChange(p.tool ?? null);
  g.spindleOn(p.rpm, p.spindleDwell);
  g.rapid({ z: p.safeZ });

  // Level-major, outside in, and it has to be: unlike a profile, where a loop
  // can be taken to full depth before the next one is started, every ring here
  // is a different path at a different depth. The ladder is the depth ladder.
  // Cutting it inward means each ring is only ever asked to remove the sliver
  // the ring above it left, instead of one full-depth plunge into solid stock.
  let previousDepth = -1;
  for (const ring of rings) {
    if (ring.depth !== previousDepth) {
      g.blank();
      g.comment(`ring depth ${n(ring.depth)}mm`);
      previousDepth = ring.depth;
    }
    const z = p.zTop - ring.depth;
    const pts = ring.path.points;
    // Straight down at plunge feed from clearance, as the profile operation
    // does. There is a faster descent available — the ring above has already
    // opened most of this hole — but how much of it is open depends on the local
    // width of the shape, and guessing that wrong drives the bit into stock at
    // rapid. A V-bit is centre-cutting, so the honest plunge is cheap.
    g.rapid({ z: p.safeZ });
    g.rapid({ x: pts[0][0], y: pts[0][1] });
    g.feed({ z, f: p.plungeFeed });
    for (let i = 1; i <= pts.length; i++) {
      const [x, y] = pts[i % pts.length];
      g.feed({ x, y, f: p.feedRate });
    }
  }

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: 'vcarve.nc',
    gcode: g.toString(),
    summary:
      `V-carve ${closed.length} outline(s) with a ${n(p.vAngle)}° bit: ` +
      `${rings.length} ring(s) at ${n(step)}mm, ${n(maxDepthReached)}mm deep` +
      (clipped ? ` (clipped from ${n(deepestWanted)}mm)` : ''),
    warnings,
    maxDepthReached,
    clipped,
    rings,
  };
}

/**
 * The program for "there is nothing here to carve".
 *
 * Shaped like profile()'s equivalent: a real GeneratedProgram with a header and
 * no motion, so a panel can show it, name it and refuse to run it through the
 * same path as any other result. Throwing would make every caller guard a
 * degenerate drawing, and an empty drawing is not an error.
 */
function nothing(p: VCarveParams, warnings: string[]): VCarveResult {
  return {
    name: 'vcarve.nc',
    gcode: new Gcode().header('V-carve', [p.sourceNote, 'nothing to cut']).toString(),
    summary: 'Nothing to cut',
    warnings,
    maxDepthReached: 0,
    clipped: false,
    rings: [],
  };
}
