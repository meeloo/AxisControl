// "Use where the machine is standing" — one button, everywhere it applies.
//
// Half the numbers this app asks for are positions, and the honest way to find
// a position is to jog the machine to it and read the DRO. Typing it back in is
// a transcription step, and transcription is where a digit goes missing: a
// pocket at Y1260 typed as Y126 is not a wrong number, it is a gantry crossing
// the table at rapid.
//
// So the button is deliberately dumb and shared. It reads live axis positions,
// hands them to whatever expression the field needs, and writes the result. The
// interesting part is what it refuses to do:
//
//   - It reads the axes it actually needs, and each one has to be homed. An
//     unhomed axis has a position — the firmware reports one — and it is
//     meaningless. Capturing it gives a plausible number nobody can tell is
//     wrong later.
//   - It never guesses the frame. Machine coordinates and work coordinates are
//     different numbers for the same physical point, and which one a field
//     wants is a property of the field, not of the machine. The ATC's pockets
//     are machine coordinates because its macros use G53; a CAM operation's
//     corner is work coordinates because the program runs in the WCS. Getting
//     that backwards is silent and catastrophic, so `frame` is required and the
//     tooltip says which one it used.

import { html, type TemplateResult } from 'lit';
import { connected, machine } from '../core/store.js';
import { wcsCode } from '../wcs/names.js';

/** Which set of numbers a field is expressed in. */
export type Frame = 'machine' | 'work';

export interface Capture {
  /** Axis letters read. Every one must exist and be homed. */
  axes: string[];
  frame: Frame;
  /**
   * The value to write, given a reader for the axes above.
   *
   * A function rather than a plain axis letter so a field that is *derived*
   * from position — a depth measured down from the stock top, a diameter
   * measured out from a centre — can use the same button as a plain
   * coordinate, instead of growing its own one-off control.
   */
  value: (at: (letter: string) => number) => number;
  /** Tooltip, without the number. "Use the current X", "Use the depth down to the tool". */
  label: string;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Live position of one axis in the given frame, or null if there is no such axis. */
export function axisPosition(letter: string, frame: Frame): number | null {
  const a = machine.peek().axes.find((x) => x.letter === letter);
  if (!a) return null;
  return round(frame === 'machine' ? a.machine : a.work);
}

/**
 * Why this capture cannot be taken, or null when it can.
 *
 * Returned as a sentence rather than a boolean because "the button is greyed
 * out and I do not know why" is its own kind of broken.
 */
export function captureBlocked(capture: Pick<Capture, 'axes'>): string | null {
  if (!connected.peek()) return 'Not connected to the machine.';
  const axes = machine.peek().axes;
  for (const letter of capture.axes) {
    const a = axes.find((x) => x.letter === letter);
    if (!a) return `This machine has no ${letter} axis.`;
    if (!a.homed) return `${letter} is not homed, so its position does not mean anything yet.`;
  }
  return null;
}

/** What the button would write right now, or null if it cannot be taken. */
export function captureValue(capture: Capture): number | null {
  if (captureBlocked(capture)) return null;
  const at = (letter: string): number => axisPosition(letter, capture.frame) ?? 0;
  const v = capture.value(at);
  return Number.isFinite(v) ? round(v) : null;
}

function frameName(frame: Frame): string {
  if (frame === 'machine') return 'machine coordinates';
  const wcs = machine.peek().wcs || 1;
  return wcsCode(wcs);
}

/**
 * A crosshair, which is what a machinist means by "where it is standing now".
 *
 * Inline rather than a font or a sprite: it is 200 bytes, it inherits the
 * button's colour in both themes, and it cannot arrive late.
 */
const CROSSHAIR = html`
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.4" />
    <path
      d="M8 0.8v3.1M8 12.1v3.1M0.8 8h3.1M12.1 8h3.1"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
`;

/**
 * The button itself.
 *
 * The tooltip carries the number it would write, which turns it into a readout:
 * you can see what you are about to set before setting it, and see that it is
 * the value you expect rather than one from before the last jog.
 */
function crosshair(title: string, blocked: string | null, take: () => void): TemplateResult {
  return html`
    <button
      type="button"
      class="capture"
      title=${title}
      aria-label=${title}
      ?disabled=${blocked !== null}
      @click=${(e: Event) => {
        // Inside a <label>, so stop the click being forwarded to the input.
        e.preventDefault();
        e.stopPropagation();
        take();
      }}
    >
      ${CROSSHAIR}
    </button>
  `;
}

export function captureButton(capture: Capture, onValue: (v: number) => void): TemplateResult {
  const blocked = captureBlocked(capture);
  const value = blocked ? null : captureValue(capture);
  const title =
    blocked ?? `${capture.label} in ${frameName(capture.frame)}${value === null ? '' : ` — ${value} mm`}`;

  return crosshair(title, blocked, () => {
    const v = captureValue(capture);
    if (v !== null) onValue(v);
  });
}

// --- Points -----------------------------------------------------------------
//
// A point is not two numbers that happen to sit next to each other. Capturing
// only the X of a pocket centre would leave the field describing a place the
// machine has never been — half of where it is standing now, half of where it
// was standing when somebody last pressed the other button — and nothing on
// screen would say so. So a point has one button, and it takes every axis at
// the same instant.

/** Live position of each axis, or null if any of them cannot be read. */
export function pointValues(axes: string[], frame: Frame): number[] | null {
  if (captureBlocked({ axes })) return null;
  const out = axes.map((letter) => axisPosition(letter, frame) ?? 0);
  return out.every((v) => Number.isFinite(v)) ? out : null;
}

/** The crosshair for a whole point: all of its axes, or none of them. */
export function pointCaptureButton(
  axes: string[],
  frame: Frame,
  onValues: (values: number[]) => void,
): TemplateResult {
  const blocked = captureBlocked({ axes });
  const values = blocked ? null : pointValues(axes, frame);
  const letters = axes.join('');
  const title = blocked
    ? blocked
    : `Use the current ${letters} in ${frameName(frame)}` +
      (values ? ` — ${axes.map((a, i) => `${a}${values[i]}`).join(' ')}` : '');

  return crosshair(title, blocked, () => {
    const v = pointValues(axes, frame);
    if (v) onValues(v);
  });
}

// --- Shorthands for the common cases ---------------------------------------

/** Straight read of one axis. */
export function fromAxis(letter: string, frame: Frame): Capture {
  return {
    axes: [letter],
    frame,
    value: (at) => at(letter),
    label: `Use the current ${letter}`,
  };
}

/**
 * A depth: how far the tool is below a top surface.
 *
 * Jog down until the tip touches, press it, and the depth is the distance it
 * travelled — which is how anyone would measure it with the machine in front
 * of them.
 */
export function fromDepthBelow(top: () => number, frame: Frame = 'work'): Capture {
  return {
    axes: ['Z'],
    frame,
    value: (at) => top() - at('Z'),
    label: 'Use the depth from the top surface down to where the tool is now',
  };
}

/** A diameter: twice the distance from a centre to where the tool is. */
export function fromRadiusAround(
  centre: () => { x: number; y: number },
  frame: Frame = 'work',
): Capture {
  return {
    axes: ['X', 'Y'],
    frame,
    value: (at) => {
      const c = centre();
      return 2 * Math.hypot(at('X') - c.x, at('Y') - c.y);
    },
    label: 'Use twice the distance from the centre to where the tool is now',
  };
}
