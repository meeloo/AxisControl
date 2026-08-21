// Who moves the dust shoe: the firmware, or the macros this app generates.
//
// The shoe hangs off the Z carriage on its own U axis, so U has to travel
// opposite to Z for the bristles to stay a constant height above the work.
// There have been three answers to that, and knowing which one is in force
// changes what this app writes into two generated macros.
//
//   A polling loop in daemon.g, waking every 50ms to ask whether Z had moved.
//   Then an M581.1 expression trigger, which is the same idea done properly.
//   Both are reactive, and both were beaten by the same thing: the object model
//   reports where an axis IS, never where a move is GOING, so the correction
//   cannot begin until Z has already arrived. The information is late, and no
//   amount of polling, triggers or extra motion queues makes late information
//   early.
//
//   M604 in the fork, which puts the relationship inside the motion planner.
//   The two axes become one coordinated move and the lag is not reduced, it
//   stops existing.
//
// What this file is for is a smaller question with a sharp consequence. The
// tool-length probe macros carry a `U{-var.newOffset}` term beside their
// `G10 L1 Z{var.newOffset}` — a trick that makes the shoe's engaged height
// compensate for tool length by moving U's work coordinate rather than U.
// Under M604 that is redundant: the relationship is applied in machine
// coordinates after tool offsets, so a longer tool raises the carriage, the
// leader's machine coordinate rises, and the follower comes down by exactly as
// much on its own.
//
// Redundant but harmless — a derived coordinate ignores its own tool offset, so
// it cannot double-compensate. Which is precisely why it has to be decided
// deliberately rather than left to a comment: emitting it where it is not
// needed costs nothing but reads as though it matters, and omitting it on a
// firmware without M604 silently breaks the shoe height for every tool but the
// one it was set with. The second mistake is the expensive one, so everything
// here fails towards emitting it.

import { effect, signal } from './signal.js';
import { activeDriver, capabilities, connected } from './store.js';
import type { AxisFollow } from '../machine/types.js';

/**
 * How the machine's dust shoe is told to follow Z.
 *
 * `auto` is the default and is almost always right: ask the board. The two
 * explicit settings exist because these macros are FILES, written now and run
 * later — possibly on a board that has since been reflashed, or written from a
 * laptop that is not connected to the machine they are for at all. A setting
 * that cannot be overridden would make those cases impossible to get right.
 */
export type DustShoeTracking = 'auto' | 'firmware' | 'macro';

export type FollowSupport = 'unknown' | 'checking' | 'yes' | 'no';

export const followSupport = signal<FollowSupport>('unknown');
/** The relationship the board last reported, or null if it has none. */
export const axisFollow = signal<AxisFollow | null>(null, () => false);

/**
 * Ask the board whether it can make one axis follow another, once per
 * connection.
 *
 * `force` re-asks, which is what the ATC panel's refresh does — unlike M700
 * support, the *relationship* can change while the connection lives, because
 * the engage and retract macros change it.
 */
export async function probeAxisFollowing(force = false): Promise<boolean> {
  const known = followSupport.peek();
  if (!force && (known === 'yes' || known === 'no')) return known === 'yes';

  const driver = activeDriver();
  if (!driver || !connected.peek() || !capabilities.peek().axisFollowing) {
    followSupport.set('no');
    axisFollow.set(null);
    return false;
  }

  followSupport.set('checking');
  try {
    const follow = await driver.axisFollowing();
    axisFollow.set(follow);
    followSupport.set(follow ? 'yes' : 'no');
    return follow !== null;
  } catch {
    // A request that did not arrive is not a firmware without the feature.
    // Leaving it unknown means the next look asks again rather than concluding
    // permanently — and, because 'unknown' resolves to "emit the U term", the
    // conservative answer holds in the meantime.
    followSupport.set('unknown');
    return false;
  }
}

export interface TrackingVerdict {
  /** True when the firmware moves the shoe, so the macros must not. */
  firmware: boolean;
  /** One line saying why, for a panel to show. */
  why: string;
  /** True when the setting and what the board reports disagree. */
  conflict: boolean;
}

/**
 * Resolve the setting against what the board actually says.
 *
 * The interesting case is `auto` on a machine that has M604 but has nothing
 * following — which is what a board looks like between a retract and the next
 * engage, and also what one looks like if the config was never written. Those
 * two are indistinguishable from here, so `auto` reads the CAPABILITY rather
 * than the live relationship: a firmware with M604 is one whose macros will use
 * it. Reading the live relationship instead would make the generated file
 * depend on whether the shoe happened to be engaged when the button was
 * pressed, which is not a property of anything.
 */
export function resolveDustShoeTracking(setting: DustShoeTracking): TrackingVerdict {
  const support = followSupport.get();
  const follow = axisFollow.get();
  // Two different sentences, because "can" and "is" are different facts here and
  // running them together produced "this board tracks the shoe itself (nothing
  // is following yet)", which reads as a contradiction. Nothing following is the
  // normal resting state — the retract macro disengages it at every tool change
  // — so it must not look like a fault.
  const live =
    follow?.follower && follow.leader
      ? `${follow.follower} follows ${follow.leader}${follow.engaged ? ' and is engaged now' : ', disengaged at the moment'}`
      : 'nothing is engaged at the moment, which is where a tool change leaves it';

  if (setting === 'firmware') {
    return {
      firmware: true,
      why:
        support === 'yes'
          ? `Set to firmware tracking, and the board agrees — ${live}.`
          : 'Set to firmware tracking, which this board has not confirmed.',
      conflict: support === 'no',
    };
  }

  if (setting === 'macro') {
    return {
      firmware: false,
      why:
        support === 'yes'
          ? 'Set to macro tracking, though this board could do it in firmware.'
          : 'Set to macro tracking: the offset term is written into the probe macros.',
      // Not a conflict. Choosing the macro on a board that could do better is a
      // legitimate choice — it is what you want when writing files for a
      // machine you are about to downgrade, or when comparing the two.
      conflict: false,
    };
  }

  if (support === 'yes') {
    return {
      firmware: true,
      why: `This board can hold the shoe to Z itself, so the macros leave it alone — ${live}.`,
      conflict: false,
    };
  }
  return {
    firmware: false,
    why:
      support === 'no'
        ? 'This board has no firmware tracking, so the macros carry the offset term.'
        : 'Not yet checked with the board — the macros carry the offset term until it is.',
    conflict: false,
  };
}

// Forget the answer when the connection goes, so reconnecting to a board that
// has since been reflashed asks again. Cleared to 'unknown' rather than 'no':
// the firmware did not change, the connection did, and 'no' would leave the
// panel claiming a missing feature until the page was reloaded.
effect(() => {
  if (!connected.get()) {
    followSupport.set('unknown');
    axisFollow.set(null);
  }
});
