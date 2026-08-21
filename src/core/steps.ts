// The jog step ladder.
//
// One rule: every distance an operator can press must be a number they could
// have chosen themselves. 0.1, 0.5, 1, 5, 10, 50 — never 1.3467, never 3.5355.
// That rules out the obvious implementations (divide the maximum by the ring
// count, or take a constant ratio between rings) and makes the ladder itself
// the primitive: the maximum picks a rung, and the rings take the rungs below
// it.
//
// The 1–5 series rather than 1–2–5 because the rings are few. With four rings a
// 1–2–5 ladder spans 10→2, which is barely a decade and gives two rings that
// feel the same; 1–5 spans 10→0.1 and every ring is obviously different from
// its neighbours.

/** Ascending 1–5 series, 0.01mm to 500mm. */
export const STEP_LADDER: readonly number[] = (() => {
  const out: number[] = [];
  for (let decade = -2; decade <= 2; decade++) {
    out.push(1 * 10 ** decade, 5 * 10 ** decade);
  }
  out.push(1000);
  return out;
})();

/** Index of the ladder rung nearest `value`, by ratio rather than difference. */
export function nearestStep(value: number): number {
  if (!(value > 0)) return 0;
  let best = 0;
  let bestError = Infinity;
  for (let i = 0; i < STEP_LADDER.length; i++) {
    const error = Math.abs(Math.log(STEP_LADDER[i] / value));
    if (error < bestError) {
      bestError = error;
      best = i;
    }
  }
  return best;
}

/**
 * Index of the largest ladder rung that is no bigger than `value`.
 *
 * Rounds down where nearestStep rounds to the closest, which is what an axis's
 * own travel calls for: a Z with 135mm of it should offer 100 and not 500, or
 * the biggest button on the column is one the machine can never complete.
 */
export function stepAtMost(value: number): number {
  let best = 0;
  for (let i = 0; i < STEP_LADDER.length; i++) {
    if (STEP_LADDER[i] <= value) best = i;
  }
  return best;
}

/**
 * The distances for `count` rings whose outermost is `STEP_LADDER[maxIndex]`.
 *
 * Returned innermost first, so index 0 is the finest move. Clamped at the
 * bottom of the ladder rather than inventing rungs below it, which is why a
 * maximum of 0.5mm with four rings gives three distances and not four.
 */
export function ringSteps(maxIndex: number, count: number): number[] {
  const top = Math.min(Math.max(maxIndex, 0), STEP_LADDER.length - 1);
  const bottom = Math.max(0, top - count + 1);
  return STEP_LADDER.slice(bottom, top + 1);
}

/** Prose label: 0.01, 0.5, 1, 50, 500 — no trailing zeros, no exponents. */
export function stepLabel(mm: number): string {
  if (mm >= 1) return String(mm);
  return mm.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
}

/**
 * Compact label for a crowded dial: the leading zero goes.
 *
 * The rose's labels lie along their own ring, so the room each one has is the
 * arc of its sector — shortest on the innermost ring, which is also where the
 * longest labels live. Dropping a leading zero costs no information and buys a
 * third of the width back, which is what lets the type stay large down there.
 */
export function stepTick(mm: number): string {
  return stepLabel(mm).replace(/^0\./, '.');
}

/**
 * The longest any of these labels can be, in glyphs.
 *
 * The rose sizes its type for THIS rather than for whatever a sector currently
 * says, so that the type does not change size every time the number does — and
 * a clamped sector's number changes continuously as the axis creeps toward its
 * stop, which made the whole rose breathe while the machine moved.
 *
 * That only works while the number is true, so it is declared here beside the
 * formatters it describes and asserted against every one of them in
 * steps-check. A formatter that grows past it would silently start overflowing
 * its sector instead of being caught.
 */
export const MAX_LABEL_GLYPHS = 5;

/**
 * A distance that is not a ladder step, short enough to sit in a rose sector.
 *
 * The ladder's own labels are at most four glyphs — 1000, .01 — and the sectors
 * were drawn for that. A clamped distance is whatever is left before the axis
 * runs out, so it arrives as 50.028471, which printed in full ran three
 * sectors wide and over the ones beside it.
 *
 * Rounded DOWN, never up. The label is a promise about how far that press will
 * travel, and a rounded-up one promises a millimetre the axis does not have.
 * The exact figure is in the sector's tooltip, where there is room for it.
 */
export function shortDistance(mm: number): string {
  if (!isFinite(mm) || mm <= 0) return '0';
  if (mm >= 100) return String(Math.floor(mm));
  if (mm >= 10) return (Math.floor(mm * 10) / 10).toFixed(1);
  if (mm >= 1) return (Math.floor(mm * 10) / 10).toFixed(1);
  return (Math.floor(mm * 100) / 100).toFixed(2).replace(/^0\./, '.');
}

/**
 * Feed rates offered by the speed cursor, mm/min, derived from the machine.
 *
 * Computed rather than listed. A fixed ladder has to be filtered against the
 * axis limit, and filtering can only ever offer a rung at or below it — so an
 * M203 of 12000 stopped the cursor at 10000, leaving a sixth of the machine's
 * speed unreachable while the label beside it read "machine limit 12000". It is
 * also wrong at the other end: a ladder that starts at 10mm/min spends its
 * bottom third on speeds nobody jogs at.
 *
 * So the limit itself is always the top rung, and the rungs below it are the
 * 1-2-5 series across the three decades beneath — which keeps every one of them
 * a number an operator could have chosen, and keeps the count in the eight-to-
 * twelve range that a slider can actually be aimed at.
 *
 *   12000 -> 20 50 100 200 500 1000 2000 5000 10000 12000
 *    6000 -> 10 20 50 100 200 500 1000 2000 5000 6000
 *     750 -> 1 2 5 10 20 50 100 200 500 750
 */
export function feedLadder(maxFeed: number): number[] {
  const top = maxFeed > 0 && isFinite(maxFeed) ? maxFeed : 20000;
  // Three decades of range below the top. Below that is creep nobody jogs at,
  // and every extra decade costs rungs the slider has to share out.
  const floor = top / 1000;
  const rungs: number[] = [];
  for (let e = -3; e <= 6; e++) {
    for (const m of [1, 2, 5]) {
      // Rounded because 1e-3 * 5 * 10 * 10 is not 0.5 in binary floating point,
      // and a speed cursor reading 0.5000000000000001 would be its own bug.
      const v = Math.round(m * 10 ** e * 1e6) / 1e6;
      if (v >= floor && v < top) rungs.push(v);
    }
  }
  rungs.push(top);
  return rungs;
}

/** The rung nearest a given feed, for restoring a saved preference. */
export function nearestFeed(value: number, maxFeed = 20000): number {
  const ladder = feedLadder(maxFeed);
  let best = ladder[0]!;
  let bestError = Infinity;
  for (const f of ladder) {
    const error = Math.abs(Math.log(f / Math.max(value, 1)));
    if (error < bestError) {
      bestError = error;
      best = f;
    }
  }
  return best;
}

