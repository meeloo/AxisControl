// A physical stick, read as a velocity.
//
// This is the input M700 was built for. Everywhere else in the app a control
// produces a distance and the machine goes there; a stick produces a deflection,
// which is a speed, and there was nothing to send it to until velocity jogging
// existed. A thumb on a touchscreen is an imitation of this — a good one, but
// you cannot feel the centre and you cannot look at the machine while you use
// it. A stick you can hold without looking is the point.
//
// Three things about the Gamepad API that shape everything below.
//
//   It is polled, not evented. `navigator.getGamepads()` returns a snapshot that
//   only updates when you ask for it, so this runs its own loop. On
//   requestAnimationFrame deliberately: the browser stops calling it when the
//   tab is hidden, which is exactly the behaviour wanted — a hidden tab must not
//   be driving a machine, and core/velocity.ts stops the jog on the same event.
//
//   Axis conventions are not the machine's. Pushing a stick forward gives −1 on
//   the Y axis, because the API describes screen space. Up on the stick has to
//   be Y+ on the table, so it is flipped here rather than in four call sites.
//
//   Nothing is guaranteed. "Standard mapping" is a hint, not a promise; a pad
//   that does not report it still gives axes and buttons in the usual order on
//   every pad anyone actually owns, so this uses them and degrades to doing
//   nothing rather than refusing to work.

import { signal } from './signal.js';
import { loadSetting, saveSetting } from './store.js';

/** What the stick is doing, in the machine's terms. */
export interface PadReading {
  /** Left stick, −1…1, +y away from the operator. */
  x: number;
  y: number;
  /** Right stick's vertical, −1…1, +z up. */
  z: number;
  /**
   * Whether the deadman is satisfied, so this may drive the machine.
   *
   * False still carries live x/y/z: the panel shows where the stick is even
   * when it is not allowed to move anything, because "nothing is happening" and
   * "you have not pressed the button" look identical otherwise.
   */
  live: boolean;
  /** True when any axis is off centre by more than the deadzone. */
  deflected: boolean;
}

export interface PadSettings {
  /**
   * Require a button to be held before the stick moves anything.
   *
   * On by default. A stick self-centres, so releasing it is already physical —
   * but a pad can be put down on, dropped, or leant against, and the axes drift
   * on a worn one. The convention on every hand-held jog pendant is a held
   * enable, and the firmware's own guidance says to have one.
   */
  deadman: boolean;
}

const DEFAULTS: PadSettings = { deadman: true };

export function loadPadSettings(): PadSettings {
  return { ...DEFAULTS, ...loadSetting<Partial<PadSettings>>('gamepad', {}) };
}

export function savePadSettings(s: PadSettings): void {
  saveSetting('gamepad', s);
}

/**
 * Buttons that satisfy the deadman: any shoulder or trigger.
 *
 * Any of the four rather than one chosen in a settings dialog, which is the
 * difference between a control someone can pick up and one they have to
 * configure first. They are where a hand already rests, there is one under each
 * index finger whichever way the pad is held, and nothing else on a pad is
 * both easy to hold and hard to press by accident.
 */
const DEADMAN_BUTTONS = [4, 5, 6, 7];

/** Below this a stick is treated as centred, before the panel's own shaping. */
const RAW_DEADZONE = 0.06;

/** The pad currently being read, by its id, or null. */
export const padName = signal<string | null>(null);
/** True when this browser has the API at all. Safari had it late; iOS still varies. */
export const padSupported = typeof navigator !== 'undefined' && 'getGamepads' in navigator;

function pads(): Gamepad[] {
  if (!padSupported) return [];
  // The array is sparse and contains nulls for unplugged slots.
  return Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => p !== null);
}

/**
 * The pad to read.
 *
 * The first connected one, rather than a chosen one. Two pads on a machine tool
 * is not a case worth a setting, and "whichever you plugged in" is what someone
 * expects when they plug one in.
 */
function pick(): Gamepad | null {
  return pads()[0] ?? null;
}

function axis(g: Gamepad, i: number): number {
  const v = g.axes[i];
  return typeof v === 'number' && Math.abs(v) > RAW_DEADZONE ? v : 0;
}

function read(g: Gamepad): PadReading {
  // Y flipped on both sticks: the API's positive Y is toward the operator.
  const x = axis(g, 0);
  const y = -axis(g, 1);
  const z = -axis(g, 3);
  const held = DEADMAN_BUTTONS.some((i) => g.buttons[i]?.pressed === true);
  return { x, y, z, live: held, deflected: x !== 0 || y !== 0 || z !== 0 };
}

/**
 * Poll a pad and hand every frame to `onRead`, until the returned function is
 * called.
 *
 * `null` means there is no pad — which the caller has to act on rather than
 * ignore, because a pad unplugged mid-move must stop the machine and a caller
 * that only ever hears about readings would never find out.
 */
export function watchPad(onRead: (reading: PadReading | null) => void): () => void {
  if (!padSupported) {
    onRead(null);
    return () => {};
  }

  let frame = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const g = pick();
    padName.set(g ? g.id : null);
    onRead(g ? read(g) : null);
    frame = requestAnimationFrame(tick);
  };

  // The API hides pads until one is touched, so a pad that was already plugged
  // in when the page loaded does not appear until a button is pressed. The
  // connection event is how it shows up without one; the poll below finds it
  // either way once it does.
  const wake = (): void => {
    if (!stopped && !frame) frame = requestAnimationFrame(tick);
  };
  window.addEventListener('gamepadconnected', wake);
  window.addEventListener('gamepaddisconnected', wake);
  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener('gamepadconnected', wake);
    window.removeEventListener('gamepaddisconnected', wake);
    padName.set(null);
  };
}
