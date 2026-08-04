// Sanity checks on an ATC configuration.
//
// Separate from the form because these are the things that are not visible in
// the form: a pocket that sits outside the machine, a descent that goes the
// wrong way, a retract that is below the pockets. Every one of them is a number
// that looks perfectly reasonable on its own and only becomes wrong next to
// another one.
//
// Split into two levels, and the split matters. `bad` means the geometry
// describes a move the machine cannot make or will make into something solid,
// and installing it is a mistake. `warn` means it is unusual and worth a second
// look. Nothing here is a guess at a limit the machine has not stated: the
// envelope comes from the axis limits the controller reports, and when the
// controller has not reported any (not connected, not homed) the envelope
// checks are skipped rather than invented.

import type { Axis } from '../machine/types.js';
import { slotPosition, type AtcConfig } from './config.js';

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
export function slotInEnvelope(
  config: AtcConfig,
  slot: number,
  axes: Axis[],
): boolean | null {
  const x = axis(axes, 'X');
  const y = axis(axes, 'Y');
  if (!hasTravel(x) || !hasTravel(y)) return null;
  const p = slotPosition(config, slot);
  return p.x >= x.min && p.x <= x.max && p.y >= y.min && p.y <= y.max;
}

export function checkAtc(config: AtcConfig, axes: Axis[]): AtcIssue[] {
  const issues: AtcIssue[] = [];
  const x = axis(axes, 'X');
  const y = axis(axes, 'Y');
  const z = axis(axes, 'Z');

  if (config.count < 1) issues.push({ level: 'bad', text: 'There has to be at least one pocket.' });
  if (config.offset <= 0) {
    issues.push({ level: 'bad', text: 'Pocket spacing must be greater than zero, or every tool shares one pocket.' });
  }

  // Descents. Both operations start high and end low; reversing them drives the
  // spindle up into nothing and then reports success.
  if (config.pickupEndZ >= config.pickupStartZ) {
    issues.push({
      level: 'bad',
      text: `Pickup end Z (${config.pickupEndZ}) is not below its start (${config.pickupStartZ}). The spindle screws the tool on while descending, so the end must be the lower number.`,
    });
  }
  if (config.dropEndZ >= config.dropStartZ) {
    issues.push({
      level: 'bad',
      text: `Drop end Z (${config.dropEndZ}) is not below its start (${config.dropStartZ}).`,
    });
  }

  const retract = effectiveRetractZ(config, axes);
  if (retract != null) {
    const lowest = Math.max(config.pickupStartZ, config.dropStartZ);
    if (retract <= lowest) {
      issues.push({
        level: 'bad',
        text: `Retract Z (${retract}) is not above the engagement heights (${lowest}). Every move to a pocket is made at retract height, so it has to clear the tools standing in them.`,
      });
    }
    if (hasTravel(z) && retract > z.max) {
      issues.push({ level: 'bad', text: `Retract Z (${retract}) is above the Z maximum (${z.max}).` });
    }
    if (hasTravel(z) && config.pickupEndZ < z.min) {
      issues.push({ level: 'bad', text: `Pickup end Z (${config.pickupEndZ}) is below the Z minimum (${z.min}).` });
    }
  }

  if (config.pickupReengage <= 0) {
    issues.push({
      level: 'warn',
      text: 'Re-engage lift is zero, so the threads are started and seated in one continuous descent. That cross-threads often enough that the sequence normally lifts and comes back down.',
    });
  }

  // Envelope. Only checked when the controller has said what the travel is.
  if (hasTravel(x) && hasTravel(y)) {
    const outside: number[] = [];
    for (let slot = 1; slot <= config.count; slot++) {
      if (slotInEnvelope(config, slot, axes) === false) outside.push(slot);
    }
    if (outside.length) {
      issues.push({
        level: 'bad',
        text: `Pocket${outside.length > 1 ? 's' : ''} ${outside.join(', ')} lie outside the machine's travel (X ${x.min}…${x.max}, Y ${y.min}…${y.max}).`,
      });
    }
    if (config.probingEnabled) {
      const px = config.probeSlot != null ? slotPosition(config, config.probeSlot).x : config.probeX;
      const py = config.probeSlot != null ? slotPosition(config, config.probeSlot).y : config.probeY;
      if (px < x.min || px > x.max || py < y.min || py > y.max) {
        issues.push({ level: 'bad', text: `The tool setter at X${px} Y${py} is outside the machine's travel.` });
      }
    }
  }

  if (config.probingEnabled && retract != null && config.probeZ >= retract) {
    issues.push({
      level: 'bad',
      text: `The setter's trigger height (${config.probeZ}) is at or above retract Z (${retract}), so the probing move has nowhere to travel.`,
    });
  }

  if (config.probeSlot != null && config.probeSlot > config.count) {
    issues.push({
      level: 'warn',
      text: `The setter is said to live in pocket ${config.probeSlot}, but only ${config.count} are configured.`,
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
  if (config.hasDustCover && !config.dustCoverPin.trim()) {
    issues.push({ level: 'bad', text: 'The pocket cover needs a pin name.' });
  }

  if (!config.probingEnabled) {
    issues.push({
      level: 'warn',
      text: 'Tool length probing is off, so every tool keeps whatever Z offset it already had. Fine if the offsets are set some other way; wrong by the length of the tool if they are not.',
    });
  }

  return issues;
}
