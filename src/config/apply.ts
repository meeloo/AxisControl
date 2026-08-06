// Trying a configuration value on the machine without writing it down.
//
// This is the part that changes how tuning feels. Most of what config.g sets
// can be re-sent at any time and takes effect immediately — speeds,
// accelerations, jerk, currents, steps per mm, soft limits. The edit / restart
// / feel it / edit again loop only exists because the file is the only way
// anybody offers to change them. Send the command instead and the loop is
// seconds long, with the file untouched until the number is one worth keeping.
//
// Nothing here writes to /sys. The worst this can do is leave the machine
// running values that a restart will forget, which is also the escape hatch:
// M999 undoes everything on this screen.

import type { ConfigLine } from './parse.js';

/**
 * Commands that can be re-sent live, and what to warn about first.
 *
 * Short on purpose. Every one of these is a value RRF holds in a register and
 * re-reads on the next move, so sending it again is exactly what config.g does
 * at boot. Commands that CREATE things — M584 mapping drivers, M950 making
 * pins, M563 defining tools — are left out: re-running them mid-session is a
 * different operation from configuring them at boot and not one to discover by
 * accident.
 */
const LIVE: Record<string, { label: string; caution?: string }> = {
  M92: {
    label: 'steps per mm',
    caution: 'Changing steps per mm moves where the machine thinks it is. Re-home afterwards.',
  },
  M201: { label: 'acceleration' },
  M203: { label: 'maximum speed' },
  M208: {
    label: 'axis limits',
    caution: 'Soft limits decide what the machine will refuse. Widening one removes a guard.',
  },
  M566: { label: 'instantaneous speed change' },
  M906: {
    label: 'motor current',
    caution: 'Motor current is a heat and torque setting. Raising it past what the motor is rated for will cook it.',
  },
};

export function liveAppliable(command: string | null): boolean {
  return command !== null && command in LIVE;
}

export function caution(command: string | null): string | null {
  return (command && LIVE[command]?.caution) ?? null;
}

/** Key for one editable value: which file, which line, which parameter. */
export function editKey(path: string, line: ConfigLine, letter: string): string {
  return `${path}:${line.index}:${letter}`;
}

/**
 * The command to send, with edits substituted.
 *
 * Every parameter of the line goes out, not only the changed ones. These
 * commands set all of their parameters at once and an omitted one is left at
 * whatever it happens to be, so sending `M906 X1000` alone would be a different
 * instruction from the line it came from. Unedited values keep their original
 * text — "2000.00" stays "2000.00" — so what is sent reads like what is on
 * screen.
 */
export function commandFor(
  line: ConfigLine,
  edits: ReadonlyMap<string, string>,
  path: string,
): string {
  const parts = line.params.map((p) => {
    const edited = edits.get(editKey(path, line, p.letter));
    return `${p.letter}${edited ?? p.text}`;
  });
  return [line.command, ...parts].join(' ');
}

/** Whether this machine state is one to be changing configuration in. */
export function blockedBy(status: string): string | null {
  if (status === 'disconnected' || status === 'connecting') return 'Not connected.';
  if (status === 'halted') return 'The machine is halted. Restart it first.';
  if (status === 'running' || status === 'paused' || status === 'pausing' || status === 'resuming') {
    return 'A job is running. Changing acceleration or current under a cutter is not a thing to try.';
  }
  if (status === 'tool-change') return 'A tool change is in progress.';
  return null;
}
