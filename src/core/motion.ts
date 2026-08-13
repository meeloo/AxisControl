// How fast the operator wants the machine driven by hand.
//
// This used to be the Jog panel's own business, and it stopped being so the
// moment a second control could move the machine. Typing a position into the
// readout is the same act as pressing a jog sector — the operator is driving,
// standing there, watching — so it has to happen at the speed they chose, not
// at whatever each panel decided for itself. A machine that answers one control
// at 1000mm/min and another at 6000 has two personalities, and the fast one is
// a surprise at exactly the wrong moment.
//
// It lives here rather than in either panel so that neither owns it. The Jog
// panel still presents the cursor that sets it; it just no longer keeps it.

import { loadSetting, machine, saveSetting } from './store.js';
import { nearestStep } from './steps.js';

export interface JogSettings {
  /** Index into STEP_LADDER of the outermost ring. */
  maxStep: number;
  /** Feed for hand-driven motion, mm/min. */
  feed: number;
  rings: number;
}

export const JOG_DEFAULTS: JogSettings = { maxStep: nearestStep(10), feed: 1000, rings: 4 };

export function loadJogSettings(): JogSettings {
  return { ...JOG_DEFAULTS, ...loadSetting<Partial<JogSettings>>('jog', {}) };
}

export function saveJogSettings(settings: JogSettings): void {
  saveSetting('jog', settings);
}

/**
 * The fastest feed every one of these axes can sustain, mm/min.
 *
 * Infinity when the controller reports no maximum for any of them, which the
 * caller should read as "no opinion" rather than as "unlimited" — the firmware
 * clamps anyway, and inventing a number here would put one on screen that the
 * machine never agreed to.
 */
export function axisFeedLimit(letters: string[]): number {
  const limits = machine
    .get()
    .axes.filter((a) => letters.includes(a.letter) && a.maxFeed > 0)
    .map((a) => a.maxFeed);
  return limits.length ? Math.min(...limits) : Infinity;
}

/**
 * The feed to drive `letters` at: what the operator asked for, capped by what
 * the slowest axis involved can do.
 *
 * Undefined when nothing constrains it and nothing was chosen, which lets the
 * driver apply its own default rather than this inventing one.
 */
export function handFeed(letters: string[]): number | undefined {
  const wanted = loadJogSettings().feed;
  const capped = Math.min(wanted, axisFeedLimit(letters));
  return isFinite(capped) && capped > 0 ? capped : undefined;
}
