// Continuous jogging: the command stream behind the analogue pad.
//
// Every other way this app moves the machine sends a distance and lets the
// machine get there. This one sends a *speed* and keeps sending it, thirty
// times a second, for as long as a thumb is on the pad — because that is what
// an analogue control actually produces. A stick deflection is not a place.
//
// The thing to understand before changing anything here is that the safety
// property is inverted from every other command in the app. Elsewhere, a
// message that fails to arrive means a move that does not happen. Here, a
// message that fails to arrive means a move that does not *stop*. The firmware
// answers that with a watchdog — go quiet for 250ms and it decelerates on its
// own — and this file's whole job is to be the layer that never relies on it:
//
//   the ticker resends the same vector even when nothing changed, because
//     "unchanged" and "the host has died" look identical from the machine
//   releasing sends an explicit zero, and sends it again behind any request
//     still in flight, because HTTP does not promise those arrive in order and
//     a jog that lands after a stop is a machine that keeps going
//   losing the window, the tab, the pointer or the connection is a stop
//   an error of any kind is a stop
//
// The watchdog is the backstop for when this code is gone — the tab closed, the
// laptop asleep, the wifi dropped. It is not a substitute for stopping.
//
// The command itself is M700, which is not stock RepRapFirmware: it comes from
// the meeloo/RepRapFirmware fork on feature/velocity-jog. Nothing here assumes
// the board has it — see `probeSupport`.

import { effect, signal } from './signal.js';
import { activeDriver, appendLog, capabilities, connected, log, loadSetting, machine, saveSetting } from './store.js';
import { JOG_BLOCKED_STATES, type VelocityJogStatus } from '../machine/types.js';
import type { MachineDriver } from '../machine/driver.js';

// --- Tuning ---------------------------------------------------------------

export interface VelocitySettings {
  /** Speed at full deflection, mm/s. */
  maxSpeed: number;
  /** Fraction of the pad around centre that reads as zero, 0–0.4. */
  deadzone: number;
  /**
   * Response curve exponent. 1 is linear; higher gives more of the pad's travel
   * to slow speeds, which is where the useful precision is.
   */
  expo: number;
  /** Commands per second. */
  rateHz: number;
  /** M700's P — how much motion the board prepares at a time, ms. */
  chunkMs: number;
}

/** The firmware's own default chunk, and the measured optimum. See CHUNK_RANGE. */
export const DEFAULT_CHUNK_MS = 20;
export const DEFAULT_WATCHDOG_MS = 250;

/**
 * How far the chunk time may be pushed, and why it stops where it does.
 *
 * Upward it buys speed: the ceiling on any commanded velocity is
 * `2 × acceleration × chunkMs`, because the planner will not let a move enter
 * faster than it could stop within itself, and each chunk has to be able to be
 * the last one. So 100ms quintuples the top speed — at the price of a fifth of
 * a second between moving the stick and the machine answering, which is already
 * more lag than a hand tolerates. Past that it stops being a jog control.
 *
 * Downward it buys nothing, which is the counter-intuitive half. Latency
 * follows `queueDepth × chunkMs` only while there is enough prepared motion for
 * the planner to run at all — roughly 50ms of it. Below that the planner
 * starves and latency gets *worse*: the firmware's own measurements put
 * `D=2, P=10` at 127ms against 50ms for `D=2, P=20`. The floor is in the
 * firmware, not in how fast a host can send, so the default is also the
 * minimum here and there is no way to ask for less.
 */
// The firmware's own range for P. The old ceiling here was 100, which was not
// a firmware limit but a guess, and it quietly halved the top speed available.
export const CHUNK_RANGE = { min: DEFAULT_CHUNK_MS, max: 200 };

/** The firmware's default queue depth (D), used when the board has not said. */
export const DEFAULT_QUEUE_DEPTH = 2;

/**
 * Command rate, in Hz.
 *
 * 20 is the floor because the watchdog is 250ms and 20Hz leaves five missed
 * commands of margin before the machine stops mid-jog; 50 is the ceiling
 * because past it the board spends more time parsing than moving, and `buff`
 * starts trending down. 30 sits in the middle with room either side.
 */
export const RATE_RANGE = { min: 20, max: 50 };

export const VELOCITY_DEFAULTS: VelocitySettings = {
  maxSpeed: 25,
  deadzone: 0.08,
  expo: 2,
  rateHz: 30,
  chunkMs: DEFAULT_CHUNK_MS,
};

export function loadVelocitySettings(): VelocitySettings {
  const raw = { ...VELOCITY_DEFAULTS, ...loadSetting<Partial<VelocitySettings>>('velocityJog', {}) };
  // Clamped on the way out rather than trusted: these come from localStorage,
  // which survives the version of the app that wrote them. A chunk of 5 saved
  // by an older build would quietly make the machine less responsive, not more.
  return {
    maxSpeed: Math.max(0.1, raw.maxSpeed),
    deadzone: Math.min(0.4, Math.max(0, raw.deadzone)),
    expo: Math.min(4, Math.max(1, raw.expo)),
    rateHz: Math.min(RATE_RANGE.max, Math.max(RATE_RANGE.min, raw.rateHz)),
    chunkMs: Math.min(CHUNK_RANGE.max, Math.max(CHUNK_RANGE.min, raw.chunkMs)),
  };
}

export function saveVelocitySettings(s: VelocitySettings): void {
  saveSetting('velocityJog', s);
}

// --- Input shaping --------------------------------------------------------

/**
 * Turn a pad deflection into a velocity vector.
 *
 * `x` and `y` are the deflection as fractions of the pad's radius, with +y up
 * on screen. The three things this does, in order, each fix something you can
 * feel:
 *
 *   The deadzone is RADIAL, not per-axis. Applied per axis it carves a square
 *   hole out of the middle of a round pad, so a diagonal nudge that clears
 *   neither axis does nothing while the same distance straight up moves.
 *
 *   Past the deadzone the remainder is rescaled to the full range. Without
 *   that, crossing the deadzone edge jumps straight to 8% of top speed — the
 *   machine twitches into motion instead of easing.
 *
 *   The curve is applied to SPEED, then put back on the original direction.
 *   Curving each axis separately bends the direction as well as the magnitude,
 *   so a 45° push comes out at some other angle and the machine does not go
 *   where the thumb is pointing.
 */
export function shapeStick(
  x: number,
  y: number,
  s: Pick<VelocitySettings, 'maxSpeed' | 'deadzone' | 'expo'>,
): { x: number; y: number } {
  const r = Math.hypot(x, y);
  if (!(r > s.deadzone)) return { x: 0, y: 0 };
  // A pointer dragged outside the pad is full deflection, not more than full.
  const clamped = Math.min(1, r);
  const t = Math.min(1, (clamped - s.deadzone) / (1 - s.deadzone));
  const speed = t ** s.expo * s.maxSpeed;
  const scale = speed / r;
  return { x: x * scale, y: y * scale };
}

/**
 * The fastest this axis can actually be driven, mm/s — or Infinity if the
 * controller has not said enough to know.
 *
 * Two independent caps, and the second is the one that surprises people. M203
 * is the axis maximum and is the obvious one. The other is `2 × acceleration ×
 * chunkMs`, which exists because the planner caps each move's entry speed so
 * that any move can turn out to be the last one queued and still stop inside
 * itself. With M201 X1000 and the default 20ms chunk that is 40 mm/s — and
 * asking for 80 does not fail, it just runs at 40, which is why this is worth
 * computing and showing rather than leaving to be discovered.
 *
 * The lever, if the ceiling is too low, is acceleration and not chunk time:
 * M201 X4000 gives 160 mm/s at the same latency.
 */
export function axisSpeedCeiling(letter: string, chunkMs: number): number {
  const axis = machine.get().axes.find((a) => a.letter === letter);
  if (!axis) return Infinity;
  const caps: number[] = [];
  if (axis.acceleration > 0) caps.push(2 * axis.acceleration * (chunkMs / 1000));
  if (axis.maxFeed > 0) caps.push(axis.maxFeed / 60);
  return caps.length ? Math.min(...caps) : Infinity;
}

/**
 * The fastest this machine can be jogged at all, whatever the chunk.
 *
 * Not the same question as `axisSpeedCeiling`, which answers for the chunk in
 * use. This is the best case: the longest chunk the firmware accepts, against
 * the axis's own M203. It is what the speed control should offer, because
 * capping the control at the ceiling for the *current* chunk is a control that
 * cannot ask for the machine's real speed — which is what it did, offering
 * 20 mm/s on a machine that traverses at 100.
 */
export function achievableSpeed(letters: string[]): number {
  const caps = letters.map((l) => axisSpeedCeiling(l, CHUNK_RANGE.max)).filter((c) => isFinite(c));
  return caps.length ? Math.min(...caps) : Infinity;
}

/**
 * The shortest chunk that can carry this speed.
 *
 * The coupling nobody should have to work out by hand: a chunk may be the last
 * one queued, so the firmware only accepts a speed it could stop from inside
 * one, and that is `2 × acceleration × P`. Turned around, a speed needs a
 * chunk of at least `speed / (2 × acceleration)`.
 *
 * That is not a tax for the sake of it. Stopping from 166 mm/s at 500 mm/s²
 * takes a third of a second whatever P is; the chunk merely has to be long
 * enough to admit it. Which is also why this never goes below the floor the
 * operator set: a short chunk is the right default and the only cost of a long
 * one is felt at speeds that were impossible without it.
 */
export function chunkForSpeed(speed: number, letters: string[], floorMs = DEFAULT_CHUNK_MS): number {
  const accels = letters
    .map((l) => machine.get().axes.find((a) => a.letter === l)?.acceleration ?? 0)
    .filter((a) => a > 0);
  if (!accels.length || !(speed > 0)) return floorMs;
  const needed = Math.ceil((1000 * speed) / (2 * Math.min(...accels)));
  return Math.min(CHUNK_RANGE.max, Math.max(floorMs, CHUNK_RANGE.min, needed));
}

/**
 * A watchdog that outlives the motion already queued.
 *
 * `R` stops the machine when no command has arrived for that long, and the
 * queue holds `D × P` of motion. If R were the shorter of the two, a jog at a
 * long chunk would trip its own watchdog while the operator was still pushing.
 * The default 250ms covers the default 2 × 20ms with room to spare; a longer
 * chunk has to carry the watchdog up with it.
 */
export function watchdogFor(chunkMs: number, depth = DEFAULT_QUEUE_DEPTH): number {
  return Math.max(DEFAULT_WATCHDOG_MS, depth * chunkMs + 150);
}

/**
 * How far the machine travels after the thumb comes off, in mm.
 *
 * Two parts, and the first is the one that surprises people: the queue is a
 * FIFO, so a stop waits behind `D × P` of motion that is already committed
 * before it is even seen. Then the machine decelerates normally, `v² / 2a`.
 *
 * At 20 mm/s this is about a millimetre and not worth saying. At 150 it is the
 * length of your hand, and an operator who has not been told is one who finds
 * out by watching it happen.
 */
export function stopDistance(speed: number, letters: string[], chunkMs: number, depth = DEFAULT_QUEUE_DEPTH): number {
  const accels = letters
    .map((l) => machine.get().axes.find((a) => a.letter === l)?.acceleration ?? 0)
    .filter((a) => a > 0);
  const lag = speed * ((depth * chunkMs) / 1000);
  const brake = accels.length ? (speed * speed) / (2 * Math.min(...accels)) : 0;
  return lag + brake;
}

/** The lowest ceiling among `letters` — what a combined move is really limited to. */
export function speedCeiling(letters: string[], chunkMs: number): number {
  const caps = letters.map((l) => axisSpeedCeiling(l, chunkMs)).filter((c) => isFinite(c));
  return caps.length ? Math.min(...caps) : Infinity;
}

/**
 * Bring a velocity vector under every axis's ceiling — by scaling the WHOLE
 * vector, not by trimming each axis to its own limit.
 *
 * This is the difference between going slower and going somewhere else. The
 * firmware clamps axis by axis, which is correct for it and wrong for a hand
 * control: on this machine X and Z have very different accelerations, so a push
 * mostly along one axis with a little of the other comes back out as a diagonal
 * once the fast axis is trimmed and the slow one is not. It is easy to miss,
 * because the machine is moving and it is moving at a sensible speed — it is
 * simply not going where the thumb is pointing, which is the one thing a jog
 * pad exists to do.
 *
 * One factor, applied to everything, gives up speed and keeps the heading.
 */
export function fitToCeilings(
  vector: Record<string, number>,
  chunkMs: number,
): Record<string, number> {
  let factor = 1;
  for (const [letter, v] of Object.entries(vector)) {
    const cap = axisSpeedCeiling(letter, chunkMs);
    if (isFinite(cap) && Math.abs(v) > cap) factor = Math.min(factor, cap / Math.abs(v));
  }
  if (factor >= 1) return vector;
  const out: Record<string, number> = {};
  for (const [letter, v] of Object.entries(vector)) out[letter] = v * factor;
  return out;
}

// --- Live state -----------------------------------------------------------

export type JogSupport = 'unknown' | 'checking' | 'yes' | 'no';

export interface JogHealth {
  /** Free space the controller last reported in its command queue, or null. */
  buff: number | null;
  /** Ticks skipped because the previous command had not come back yet. */
  skipped: number;
  /** Commands sent since this jog started. */
  sent: number;
}

/** Commanded velocity, mm/s per axis letter. Empty when stopped. */
export const jogVector = signal<Record<string, number>>({}, sameVector);
export const jogRunning = signal(false);
export const jogSupport = signal<JogSupport>('unknown');
/** The last status read back from the firmware — speeds AFTER its clamping. */
export const jogStatus = signal<VelocityJogStatus | null>(null);
export const jogHealth = signal<JogHealth>({ buff: null, skipped: 0, sent: 0 }, () => false);
/** Why jogging last stopped on its own, for the panel to show. Null if it did not. */
export const jogRefusal = signal<string | null>(null);

/**
 * Who is allowed to drive, while anyone is.
 *
 * There is one machine and one velocity vector, and more than one control can
 * be on screen wanting to set it — two Jog panels in two dock groups, or one on
 * a page hidden behind another, which is live because pages are hidden with
 * display:none rather than taken apart. So the vector is claimed rather than
 * shared: the first control to ask for motion gets it and keeps it until it
 * lets go, and everyone else's commands are dropped on the floor rather than
 * interleaved with the driver's at thirty a second.
 *
 * A token per instance rather than a name, because identity is the whole point
 * and two panels of the same kind on the same page would otherwise be the same
 * owner. The label is only for saying who, in a message.
 *
 * Required, with no default. A default meant an unidentified caller could take
 * the claim and then never let go of it, locking out every panel that did
 * identify itself — and the alternative, a token that drives without ever
 * claiming, is a hole straight through the middle of this. There is one caller
 * and it knows who it is.
 */
export interface JogOwner {
  readonly label: string;
}

/** The label of whoever is driving, or null. For a panel to show it is not. */
export const jogOwner = signal<string | null>(null);

/** Make a token for one control instance. */
export function jogOwnerFor(label: string): JogOwner {
  return { label };
}

function sameVector(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

// --- The stream -----------------------------------------------------------

let ticker: ReturnType<typeof setInterval> | null = null;
let vector: Record<string, number> = {};
/** Whoever currently holds the claim, or null when the machine is free. */
let holder: JogOwner | null = null;
let settings: VelocitySettings = loadVelocitySettings();
/**
 * The request currently on the wire, if any.
 *
 * Two jobs. It keeps ticks from piling up — a board that takes 60ms to answer
 * must not accumulate a queue of 30Hz commands it will still be working through
 * after the thumb comes off. And it gives the stop path something to sequence
 * itself behind; see `sendStop`.
 */
let inFlight: Promise<unknown> | null = null;
let healthPushedAt = 0;
let health: JogHealth = { buff: null, skipped: 0, sent: 0 };

/** Adopt new tuning. Takes effect on the next tick; a live jog is not interrupted. */
export function applyVelocitySettings(next: VelocitySettings): void {
  const rateChanged = next.rateHz !== settings.rateHz;
  settings = next;
  saveVelocitySettings(next);
  if (rateChanged && ticker) {
    clearInterval(ticker);
    ticker = setInterval(tick, 1000 / settings.rateHz);
  }
}

export function velocitySettings(): VelocitySettings {
  return settings;
}

/** Everything that has to be true before a pad may move the machine. */
export function canVelocityJog(): { ok: boolean; why: string } {
  if (!connected.get()) return { ok: false, why: 'Not connected' };
  if (!capabilities.get().velocityJog) return { ok: false, why: 'This controller has no velocity jogging' };
  const support = jogSupport.get();
  if (support === 'no') return { ok: false, why: 'This firmware does not implement M700' };
  if (support !== 'yes') return { ok: false, why: 'Checking the firmware…' };
  // JOG_BLOCKED_STATES, not BUSY_STATES, and note what this does NOT do: it
  // never asks the status whether a jog is already running. It cannot — the
  // firmware leaves the status at `idle` throughout an M700 jog. `jogRunning`
  // is the answer to that question and it is kept here, client-side. All this
  // decides is whether something else has the machine.
  const status = machine.get().status;
  if (JOG_BLOCKED_STATES.has(status)) return { ok: false, why: `Machine is ${status}` };
  return { ok: true, why: '' };
}

/**
 * Ask the board whether it has M700 at all, once per connection.
 *
 * Cached in the signal rather than re-asked, because the answer is a property
 * of the firmware image and cannot change while the connection lives. It is
 * cleared when the connection drops.
 */
export async function probeSupport(force = false): Promise<boolean> {
  if (!force && (jogSupport.peek() === 'yes' || jogSupport.peek() === 'no')) {
    return jogSupport.peek() === 'yes';
  }
  const driver = activeDriver();
  if (!driver || !connected.peek() || !capabilities.peek().velocityJog) {
    jogSupport.set('no');
    return false;
  }
  jogSupport.set('checking');
  try {
    const status = await driver.velocityJogStatus();
    jogStatus.set(status);
    jogSupport.set(status ? 'yes' : 'no');
    return status !== null;
  } catch (err) {
    // An unreachable board is not a board without M700 — leaving it 'unknown'
    // means the next attempt asks again instead of permanently concluding the
    // feature is missing from one dropped request.
    jogSupport.set('unknown');
    appendLog({ level: 'warning', text: `Could not check velocity jogging: ${(err as Error).message}`, time: new Date() });
    return false;
  }
}

/**
 * Set the whole velocity vector. This is the only way motion starts.
 *
 * The whole vector, always — an axis left out of `next` is commanded to zero,
 * because that is what M700 does with an axis it is not told about and having
 * this layer disagree would be worse than either behaviour on its own.
 */
export function setJogVector(next: Record<string, number>, owner: JogOwner): void {
  const clean: Record<string, number> = {};
  for (const [letter, v] of Object.entries(next)) {
    if (Number.isFinite(v) && v !== 0) clean[letter.toUpperCase()] = v;
  }

  if (!Object.keys(clean).length) {
    // Only the driver may stop the machine by letting go. A second panel
    // sending an empty vector — which it does on every frame its own stick sits
    // centred — must not cut the jog somebody else is holding.
    if (holder === owner) stopJog();
    return;
  }

  // Whoever is already driving keeps driving. Two Jog panels can be on screen at
  // once — two dock groups on a page, or one page hidden behind another, since
  // pages are hidden with display:none rather than detached — and both are live,
  // both watching the same gamepad, both computing a vector from it. Without
  // this they take turns at 30Hz: the machine gets one panel's vector, then the
  // other's, and letting go of either stops it.
  if (holder !== null && holder !== owner) return;

  const gate = canVelocityJog();
  if (!gate.ok) {
    jogRefusal.set(gate.why);
    if (holder === owner) stopJog();
    return;
  }

  holder = owner;
  jogOwner.set(owner.label);
  vector = clean;
  jogVector.set(clean);
  if (!ticker) start();
}

/**
 * Give up the machine, if this owner had it.
 *
 * What a panel calls when it is closed, hidden, or otherwise done. Distinct
 * from `stopJog`, which stops unconditionally: a panel going away must stop the
 * jog it was driving and must NOT stop one it never had.
 */
export function releaseJog(owner: JogOwner, reason?: string): void {
  if (holder !== owner) return;
  stopJog(reason);
}

/** Whether this owner is the one currently driving. */
export function jogHeldBy(owner: JogOwner): boolean {
  return holder === owner;
}

function start(): void {
  jogRefusal.set(null);
  health = { buff: null, skipped: 0, sent: 0 };
  jogHealth.set(health);
  jogRunning.set(true);
  // Sent now rather than on the first interval: a 30Hz ticker is 33ms of doing
  // nothing at the exact moment the operator pressed, and that reads as the
  // control being unresponsive rather than as the machine being slow.
  send();
  ticker = setInterval(tick, 1000 / settings.rateHz);
  appendLog({
    level: 'command',
    text: `M700 jog started — ${describe(vector)} at up to ${settings.rateHz}Hz`,
    time: new Date(),
  });
}

function tick(): void {
  if (!ticker) return;
  if (inFlight) {
    // Deliberately skipped, not queued. Falling behind is survivable — the
    // watchdog has 250ms of patience and the next tick is 33ms away — whereas a
    // backlog of stale vectors means the machine is still executing the thumb's
    // position from a second ago, including after it lifts.
    health = { ...health, skipped: health.skipped + 1 };
    pushHealth();
    return;
  }
  send();
}

function send(): void {
  const driver = activeDriver();
  if (!driver) {
    stopJog('Lost the connection');
    return;
  }
  // The chunk is derived from the speed the operator asked for, not from the
  // instantaneous vector: it has to be stable while a thumb is on the pad, and
  // the requested maximum is the only number here that does not move. The
  // watchdog goes up with it, or a long chunk trips its own.
  //
  // Only sent when either differs from the firmware's own default, so the
  // streamed command stays as short as it can be. See velocityJog in the driver.
  const letters = Object.keys(vector);
  const chunk = chunkForSpeed(settings.maxSpeed, letters.length ? letters : ['X', 'Y'], settings.chunkMs);
  const depth = jogStatus.peek()?.queueDepth ?? DEFAULT_QUEUE_DEPTH;
  const opts =
    chunk === DEFAULT_CHUNK_MS
      ? undefined
      : { chunkMs: chunk, watchdogMs: watchdogFor(chunk, depth) };
  const request = driver
    .velocityJog(vector, opts)
    .then((buff) => {
      health = { buff, skipped: health.skipped, sent: health.sent + 1 };
      pushHealth();
    })
    .catch((err: unknown) => {
      stopJog(`Jog command failed: ${(err as Error).message}`);
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
}

/**
 * Push health to the UI at most four times a second.
 *
 * It changes on every tick and nothing in it is worth a re-render at 30Hz — the
 * numbers are for noticing a trend, and a trend is still visible at 4Hz. The
 * pad's own readout is driven by `jogVector`, which only changes when the thumb
 * does.
 */
function pushHealth(): void {
  const now = performance.now();
  if (now - healthPushedAt < 250) return;
  healthPushedAt = now;
  jogHealth.set(health);
}

/**
 * Stop, and mean it.
 *
 * `reason` is for stops this code decided on — an error, a lost window, a job
 * starting. A normal release passes nothing.
 */
export function stopJog(reason?: string): void {
  const wasRunning = ticker !== null;
  if (ticker) clearInterval(ticker);
  ticker = null;
  vector = {};
  // The claim goes with the motion. Unconditional on purpose: this is what the
  // global safety paths and the Stop button call, and anything that stops the
  // machine has to leave it available to whoever reaches for it next.
  holder = null;
  jogOwner.set(null);
  jogVector.set({});
  jogRunning.set(false);
  if (reason) jogRefusal.set(reason);
  if (!wasRunning) return;

  if (reason) {
    appendLog({ level: 'warning', text: `Jog stopped: ${reason}`, time: new Date() });
  } else {
    appendLog({ level: 'command', text: 'M700 S0 — jog released', time: new Date() });
  }

  const driver = activeDriver();
  if (driver && connected.peek()) void sendStop(driver, inFlight);
  inFlight = null;
}

/**
 * Send the zero — twice, if something was still on the wire.
 *
 * The second send is not belt-and-braces, it closes a real hole. HTTP gives no
 * ordering guarantee between two outstanding requests: the jog command already
 * in flight when the thumb lifted can be delivered *after* the stop that
 * followed it, which leaves the machine running the old vector with nothing
 * further coming — motion for a full watchdog period after release, on a
 * control whose entire premise is that letting go stops it.
 *
 * So: one stop now, for latency, and another once the outstanding request has
 * definitely landed, for correctness. The cost of the extra command is an extra
 * stop on an already-stopped machine, which is nothing.
 */
async function sendStop(driver: MachineDriver, pending: Promise<unknown> | null): Promise<void> {
  const once = async (): Promise<boolean> => {
    try {
      await driver.velocityJog({});
      return true;
    } catch {
      return false;
    }
  };

  let landed = await once();

  // Second stop, sequenced behind whatever was already outstanding, so it
  // cannot be the one that gets overtaken. Skipped only when nothing was in
  // flight and the first stop was acknowledged — the case where there is
  // provably nothing left to reorder.
  if (pending || !landed) {
    await pending?.catch(() => undefined);
    landed = (await once()) || landed;
  }

  if (!landed) {
    appendLog({
      level: 'error',
      text:
        `Could not confirm the jog stop. The machine's watchdog will stop it within ` +
        `${DEFAULT_WATCHDOG_MS}ms; use the emergency stop if it does not.`,
      time: new Date(),
    });
  }
}

function describe(v: Record<string, number>): string {
  return (
    Object.entries(v)
      .map(([a, s]) => `${a}${s > 0 ? '+' : ''}${s.toFixed(1)}`)
      .join(' ') || 'stopped'
  );
}

// --- Reasons to stop that are nothing to do with the pad -------------------

/**
 * The refusals the firmware answers with, which never reach a caller.
 *
 * `rr_gcode` accepts M700 into the buffer and returns success; the refusal
 * comes back later as ordinary reply text, on the console. So a jog that the
 * machine has declined looks, from here, exactly like one it is performing —
 * the ticker keeps sending and the pad keeps showing a velocity for a machine
 * that is standing still. Watching the log for the known refusals is what turns
 * that into a message.
 */
const REFUSALS =
  /cannot jog|insufficient axes homed|in use by another movement system|unsupported command|unknown command/i;

if (typeof window !== 'undefined') {
  // Capture phase, so a pointercancel swallowed by something else still stops
  // the machine. The rest are ordinary: any of them means the operator is no
  // longer looking at the control they are holding down.
  window.addEventListener('blur', () => stopJog('Window lost focus'));
  window.addEventListener('pagehide', () => stopJog('Page was hidden'));
  window.addEventListener('pointercancel', () => stopJog('Pointer was cancelled'), true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopJog('Tab was hidden');
  });

  // Whether the last run of the effect below saw a live connection, so a
  // reconnect can be told from a re-render. Module scope rather than a signal:
  // reading it inside the effect would make the effect depend on it and re-run
  // when it changes, which is a loop.
  let wasLive = false;

  effect(() => {
    const live = connected.get();
    const status = machine.get().status;

    // Ask again on a new connection.
    //
    // Losing the connection sets support back to 'unknown' — correctly, since
    // the firmware did not change, the link did. But nothing asked again, and
    // `canVelocityJog` reads anything other than 'yes' as "not yet", so the pad
    // stayed disabled saying "Checking the firmware…" for the rest of the
    // session. The board only has to stop answering for a moment — which is
    // what a firmware fault during a jog looks like from here — and the panel
    // was dead until someone pressed Re-check or reloaded the page. Reloading
    // is what people actually did.
    //
    // Deferred out of the effect body because probeSupport writes the signals
    // this effect reads.
    if (live && !wasLive) setTimeout(() => void probeSupport(), 0);
    wasLive = live;

    if (!live) {
      // Not 'no': the firmware did not change, the connection did. Marking it
      // unsupported here would leave the pad hidden after a reconnect until the
      // page was reloaded.
      jogSupport.set('unknown');
      jogStatus.set(null);
      stopJog(jogRunning.peek() ? 'Connection lost' : undefined);
    } else if (JOG_BLOCKED_STATES.has(status) && jogRunning.peek()) {
      // The states that mean something ELSE has taken the machine — a program
      // started, homing began, the estop was hit. Emphatically not `busy`: an
      // ordinary move reports that, and a jog beginning while one is still
      // finishing is normal. (The firmware no longer reports busy for the jog
      // itself either, but this must not depend on that: an earlier version did
      // report it, and stopping on it killed every jog a fraction of a second
      // after it started.)
      stopJog(`Machine went ${status}`);
    }
  });

  effect(() => {
    const lines = log.get();
    if (!jogRunning.peek()) return;
    const last = lines[lines.length - 1];
    if (last && REFUSALS.test(last.text)) stopJog(last.text.trim());
  });
}
