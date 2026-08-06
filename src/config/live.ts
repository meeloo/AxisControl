// What the file says, against what the machine is actually doing.
//
// This is the question a config file cannot answer about itself. A line can be
// right and not in force: overridden by config-override.g, replaced by a later
// duplicate, sitting in an `if` branch that did not run, or simply changed at
// the console since boot and never saved. All of those leave a file that reads
// correctly and a machine that behaves otherwise, and nothing on screen has
// ever connected the two.
//
// Only a handful of commands are mapped, deliberately. Each one here is a value
// RRF reports back per axis in the object model, so the comparison is exact
// rather than inferred. Anything not in this table simply has no live reading
// and is shown without one, which is honest — a blank is better than a guess
// dressed as a check.

import type { Axis } from '../machine/types.js';
import type { ConfigLine } from './parse.js';

export interface LiveValue {
  /** The axis letter this parameter configures. */
  letter: string;
  /** What the file asks for. */
  file: number;
  /** What the machine reports. */
  machine: number;
  agrees: boolean;
}

/** Commands whose parameters are per-axis and readable back from the machine. */
const AXIS_FIELD: Record<string, { field: keyof Axis; label: string; unit: string }> = {
  M203: { field: 'maxFeed', label: 'maximum speed', unit: 'mm/min' },
  M201: { field: 'acceleration', label: 'acceleration', unit: 'mm/s²' },
  M566: { field: 'jerk', label: 'instantaneous speed change', unit: 'mm/min' },
  M92: { field: 'stepsPerMm', label: 'steps per mm', unit: 'steps/mm' },
  M906: { field: 'current', label: 'motor current', unit: 'mA' },
};

/** True when a command can be compared against the machine at all. */
export function comparable(command: string | null): boolean {
  return command !== null && command in AXIS_FIELD;
}

export function describe(command: string): { label: string; unit: string } | null {
  const spec = AXIS_FIELD[command];
  return spec ? { label: spec.label, unit: spec.unit } : null;
}

/**
 * Compare one configuration line against the live axes.
 *
 * Rounded to three decimals before comparing: RRF reports steps/mm and
 * accelerations as floats and a config written as "80" comes back as
 * 80.00000001 often enough to make an exact test useless.
 */
export function compareLine(line: ConfigLine, axes: Axis[]): LiveValue[] {
  const spec = line.command ? AXIS_FIELD[line.command] : undefined;
  if (!spec) return [];
  const out: LiveValue[] = [];
  for (const param of line.params) {
    if (param.value === null) continue;
    const axis = axes.find((a) => a.letter === param.letter);
    if (!axis) continue;
    const machine = axis[spec.field];
    if (typeof machine !== 'number' || machine === 0) continue;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    out.push({
      letter: param.letter,
      file: param.value,
      machine,
      agrees: round(param.value) === round(machine),
    });
  }
  return out;
}
