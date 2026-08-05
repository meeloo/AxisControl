// Sanity checks on an ATC configuration.
//
// Separate from the form because these are the things that are not visible in
// the form: a pocket that sits outside the machine, a descent that goes the
// wrong way, a retract that is below the pockets, a second bank laid down on
// top of the first. Every one of them is a number that looks perfectly
// reasonable on its own and only becomes wrong next to another one.
//
// Split into two levels, and the split matters. `bad` means the geometry
// describes a move the machine cannot make or will make into something solid,
// and installing it is a mistake. `warn` means it is unusual and worth a second
// look. Nothing here is a guess at a limit the machine has not stated: the
// envelope comes from the axis limits the controller reports, and when the
// controller has not reported any (not connected, not homed) the envelope
// checks are skipped rather than invented.

import type { Axis } from '../machine/types.js';
import {
  allSlots,
  probeFor,
  probePosition,
  slotPosition,
  type AtcBank,
  type AtcConfig,
} from './config.js';

export interface AtcIssue {
  level: 'bad' | 'warn';
  text: string;
}

function axis(axes: Axis[], letter: string): Axis | undefined {
  return axes.find((a) => a.letter === letter);
}

/** True when the controller has told us a usable travel for this axis. */
function hasTravel(a: Axis | undefined): a is Axis {
  return !!a && isFinite(a.min) && isFinite(a.max) && a.max > a.min;
}

/** Machine Z the macros retract to, resolving the "Z maximum" default. */
export function effectiveRetractZ(config: AtcConfig, axes: Axis[]): number | null {
  if (config.retractZ != null) return config.retractZ;
  const z = axis(axes, 'Z');
  return hasTravel(z) ? z.max : null;
}

/** Is a pocket reachable? Null when the machine has not said what its travel is. */
export function slotInEnvelope(bank: AtcBank, slot: number, axes: Axis[]): boolean | null {
  const x = axis(axes, 'X');
  const y = axis(axes, 'Y');
  if (!hasTravel(x) || !hasTravel(y)) return null;
  const p = slotPosition(bank, slot);
  return p.x >= x.min && p.x <= x.max && p.y >= y.min && p.y <= y.max;
}

export function checkAtc(config: AtcConfig, axes: Axis[]): AtcIssue[] {
  const issues: AtcIssue[] = [];
  const x = axis(axes, 'X');
  const y = axis(axes, 'Y');
  const z = axis(axes, 'Z');
  const many = config.banks.length > 1;
  /** Which bank an issue is about — omitted entirely when there is only one. */
  const of = (bank: AtcBank) => (many ? `${bank.name}: ` : '');

  if (!config.banks.length) {
    issues.push({ level: 'bad', text: 'There has to be at least one bank of pockets.' });
    return issues;
  }

  const retract = effectiveRetractZ(config, axes);

  for (const bank of config.banks) {
    if (bank.count < 1) issues.push({ level: 'bad', text: `${of(bank)}there has to be at least one pocket.` });
    if (bank.offset <= 0) {
      issues.push({
        level: 'bad',
        text: `${of(bank)}pocket spacing must be greater than zero, or every tool shares one pocket.`,
      });
    }

    // Descents. Both operations start high and end low; reversing them drives
    // the spindle up into nothing and then reports success.
    if (bank.pickupEndZ >= bank.pickupStartZ) {
      issues.push({
        level: 'bad',
        text: `${of(bank)}pickup end Z (${bank.pickupEndZ}) is not below its start (${bank.pickupStartZ}). The spindle screws the tool on while descending, so the end must be the lower number.`,
      });
    }
    if (bank.dropEndZ >= bank.dropStartZ) {
      issues.push({
        level: 'bad',
        text: `${of(bank)}drop end Z (${bank.dropEndZ}) is not below its start (${bank.dropStartZ}).`,
      });
    }

    if (retract != null) {
      const highest = Math.max(bank.pickupStartZ, bank.dropStartZ);
      if (retract <= highest) {
        issues.push({
          level: 'bad',
          text: `${of(bank)}retract Z (${retract}) is not above the engagement heights (${highest}). Every move to a pocket is made at retract height, so it has to clear the tools standing in them.`,
        });
      }
      if (hasTravel(z) && bank.pickupEndZ < z.min) {
        issues.push({ level: 'bad', text: `${of(bank)}pickup end Z (${bank.pickupEndZ}) is below the Z minimum (${z.min}).` });
      }
    }

    if (bank.pickupReengage <= 0) {
      issues.push({
        level: 'warn',
        text: `${of(bank)}re-engage lift is zero, so the threads are started and seated in one continuous descent. That cross-threads often enough that the sequence normally lifts and comes back down.`,
      });
    }

    if (bank.cover && !bank.cover.pin.trim()) {
      issues.push({ level: 'bad', text: `${of(bank)}the pocket cover needs a pin name.` });
    }

    if (hasTravel(x) && hasTravel(y)) {
      const outside: number[] = [];
      for (let slot = 1; slot <= bank.count; slot++) {
        if (slotInEnvelope(bank, slot, axes) === false) outside.push(slot);
      }
      if (outside.length) {
        issues.push({
          level: 'bad',
          text: `${of(bank)}pocket${outside.length > 1 ? 's' : ''} ${outside.join(', ')} lie outside the machine's travel (X ${x.min}…${x.max}, Y ${y.min}…${y.max}).`,
        });
      }
    }
  }

  if (retract != null && hasTravel(z) && retract > z.max) {
    issues.push({ level: 'bad', text: `Retract Z (${retract}) is above the Z maximum (${z.max}).` });
  }

  // Banks laid on top of each other. Two rows that cross is not a configuration
  // anyone types on purpose, and the machine will not notice: it drives to a
  // coordinate that happens to hold two nuts.
  issues.push(...checkOverlap(config));

  // The setters. Each bank uses one; a machine with a second bank across the
  // table may well have given it its own.
  const setters = new Map<string, { probe: ReturnType<typeof probeFor>; banks: string[] }>();
  config.banks.forEach((bank, i) => {
    const probe = probeFor(config, i);
    const key = bank.probe ? `bank${i}` : 'machine';
    const entry = setters.get(key) ?? { probe, banks: [] };
    entry.banks.push(bank.name);
    setters.set(key, entry);
  });

  if (config.probingEnabled) {
    for (const [key, { probe, banks }] of setters) {
      const where = many && key !== 'machine' ? `${banks.join(', ')}: the setter` : 'The tool setter';
      const p = probePosition(config, probe);
      if (hasTravel(x) && hasTravel(y) && (p.x < x.min || p.x > x.max || p.y < y.min || p.y > y.max)) {
        issues.push({ level: 'bad', text: `${where} at X${p.x} Y${p.y} is outside the machine's travel.` });
      }
      if (retract != null && probe.z >= retract) {
        issues.push({
          level: 'bad',
          text: `${where}'s trigger height (${probe.z}) is at or above retract Z (${retract}), so the probing move has nowhere to travel.`,
        });
      }
      if (probe.slot) {
        const bank = config.banks[probe.slot.bank];
        if (!bank) {
          issues.push({ level: 'warn', text: `${where} is said to live in a bank that no longer exists.` });
        } else if (probe.slot.slot > bank.count) {
          issues.push({
            level: 'warn',
            text: `${where} is said to live in pocket ${probe.slot.slot} of ${bank.name}, which has only ${bank.count}.`,
          });
        }
      }
    }
  } else {
    issues.push({
      level: 'warn',
      text: 'Tool length probing is off, so every tool keeps whatever Z offset it already had. Fine if the offsets are set some other way; wrong by the length of the tool if they are not.',
    });
  }

  if (config.rpm <= 0) {
    issues.push({ level: 'bad', text: 'Engagement RPM must be greater than zero — the nut is turned on and off by the spindle.' });
  } else if (config.rpm > 1000) {
    issues.push({
      level: 'warn',
      text: `${config.rpm} RPM is fast for engagement. The nut is threaded on at a few hundred; faster tends to cross-thread or over-tighten.`,
    });
  }
  if (config.spindlePause < 1) {
    issues.push({
      level: 'warn',
      text: 'Less than a second to reach engagement speed. A VFD ramping from stop usually needs longer, and descending before it is turning strips the thread.',
    });
  }

  if (config.dustShoe && !axis(axes, 'U')) {
    issues.push({
      level: 'warn',
      text: 'Dust-shoe hooks are switched on, but this machine reports no U axis. The macros call dustShoeRetract.g / dustShoeEngage.g, which have to exist.',
    });
  }

  if (config.hasToolSensor && !config.toolSensorPin.trim()) {
    issues.push({ level: 'bad', text: 'The tool sensor needs a pin name.' });
  }

  // Two banks driving the same output would open one cover and report the other.
  const outputs = new Map<number, string[]>();
  for (const bank of config.banks) {
    if (!bank.cover) continue;
    outputs.set(bank.cover.out, [...(outputs.get(bank.cover.out) ?? []), bank.name]);
  }
  for (const [out, names] of outputs) {
    if (names.length > 1) {
      issues.push({ level: 'bad', text: `${names.join(' and ')} both drive cover output ${out}.` });
    }
  }

  return issues;
}

/**
 * Pockets from different banks that land on each other.
 *
 * Compared across banks only: pockets within one bank are a fixed pitch apart
 * by construction, and a pitch that is too small is already reported. The
 * threshold is the smaller of the two pitches — closer than half of it and the
 * nuts occupy the same place, closer than all of it and they are nearer to each
 * other than to their own neighbours, which is worth a look either way.
 */
function checkOverlap(config: AtcConfig): AtcIssue[] {
  const slots = allSlots(config);
  const worst = new Map<string, { level: 'bad' | 'warn'; text: string }>();

  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (a.bank === b.bank) continue;
      const pitch = Math.min(config.banks[a.bank].offset, config.banks[b.bank].offset);
      if (pitch <= 0) continue;
      const gap = Math.hypot(a.x - b.x, a.y - b.y);
      if (gap >= pitch) continue;

      const key = `${a.bank}:${b.bank}`;
      const level: 'bad' | 'warn' = gap < pitch / 2 ? 'bad' : 'warn';
      const existing = worst.get(key);
      if (existing && (existing.level === 'bad' || level === 'warn')) continue;
      worst.set(key, {
        level,
        text:
          `${config.banks[a.bank].name} pocket ${a.slot} (T${a.tool}) and ` +
          `${config.banks[b.bank].name} pocket ${b.slot} (T${b.tool}) are ${gap.toFixed(1)} mm apart, ` +
          `which is ${level === 'bad' ? 'inside' : 'within'} the ${pitch} mm pocket spacing. ` +
          'Two banks cannot share the same piece of table.',
      });
    }
  }

  return [...worst.values()];
}
