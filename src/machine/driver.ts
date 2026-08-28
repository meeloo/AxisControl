// The contract every controller implementation satisfies.
//
// Adding a machine means implementing this interface and registering a factory
// in machine/registry.ts. Nothing in ui/ or panels/ changes.
//
// Design notes for future drivers:
//  - `connect()` should resolve only once state is flowing, and must be safe to
//    call again after `disconnect()`.
//  - State is pushed, not pulled: drivers own their own update cadence (HTTP
//    polling for RRF, a socket stream for others) and call the state callback.
//    Panels never poll.
//  - Every method may reject; the shell surfaces failures in the console panel
//    and marks the connection degraded rather than tearing it down.

import type {
  AxisFollow,
  ScanArea,
  HeightMapCommands,
  Capabilities,
  DiagnosticSection,
  FileEntry,
  LogLine,
  MachineState,
  VelocityJogStatus,
} from './types.js';

export interface ConnectionConfig {
  /** Base URL or host of the controller, e.g. "http://sebscnc.local". */
  url: string;
  password?: string;
  /**
   * Aborted when the operator gives up waiting.
   *
   * A driver must plumb this all the way down to whatever it is blocked on.
   * Cancelling that only stops the caller waiting — the socket stays open, the
   * request stays outstanding, and a controller that answers a minute later
   * still gets to resolve a connection nobody wants any more.
   */
  signal?: AbortSignal;
}

export interface JogOptions {
  /** Feed rate in mm/min. */
  feedRate: number;
  /** Machine coordinates rather than work coordinates. */
  machineCoords?: boolean;
}

/**
 * Tuning for the velocity-jog stream. Omit anything you have no opinion about
 * and the firmware keeps its own default, which is the right choice for all of
 * these — they are measured optima, not preferences.
 */
export interface VelocityJogOptions {
  /**
   * How much motion the controller prepares at a time, ms.
   *
   * Present for a caller that is measuring the firmware, and for nothing else.
   * It used to buy speed, because the ceiling was `2 × acceleration × chunkMs`;
   * the firmware now ramps toward the commanded velocity, so a larger chunk
   * buys only stopping distance. Smaller does not buy lower latency either —
   * below roughly 40ms of queued motion the planner starves and latency gets
   * *worse*. The board's own default is measured, and it moves between
   * releases: a host that pins a value is a host running at a fraction of the
   * speed it asked for after the next one. Leave it unset.
   */
  chunkMs?: number;
  /**
   * Motion stops if no command arrives inside this, ms.
   *
   * The safety property that matters most, and the reason velocity jogging is
   * safe to expose at all: if the host process dies, the tab closes or the
   * network drops mid-move, the machine decelerates under its normal limits
   * instead of running until it hits something.
   */
  watchdogMs?: number;
  /** How many chunks are queued ahead. Deeper is smoother and laggier. */
  queueDepth?: number;
}

export interface MachineDriver {
  /** Stable identifier, e.g. "rrf". */
  readonly id: string;
  /** Display name, e.g. "RepRapFirmware (Duet)". */
  readonly label: string;
  readonly capabilities: Capabilities;

  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;

  /** Subscribe to state snapshots. Returns an unsubscribe function. */
  onState(cb: (state: MachineState) => void): () => void;
  /** Subscribe to console output. Returns an unsubscribe function. */
  onLog(cb: (line: LogLine) => void): () => void;

  // --- Motion & commands -------------------------------------------------
  /** Send a raw command in the controller's own dialect. */
  send(command: string): Promise<void>;
  /** Send a command and resolve with the controller's reply text. */
  query(command: string): Promise<string>;

  /**
   * Relative move on one or more axes at once.
   *
   * A map rather than a single axis because a diagonal has to be ONE
   * coordinated move: issuing X then Y as separate commands traces an L through
   * whatever is in the corner, at full jog speed, which is precisely the shape
   * you were trying not to make.
   *
   * @param deltas signed millimetres per axis letter, e.g. { X: 5, Y: -5 }
   */
  jog(deltas: Record<string, number>, opts: JogOptions): Promise<void>;
  /**
   * Move axes to absolute positions in MACHINE coordinates.
   *
   * Machine rather than work, and that is the whole reason this is not just
   * `jog` with the arithmetic done at the call site. A relative move is only
   * unambiguous while no coordinate rotation is active: under G68 a relative XY
   * move is rotated with everything else, so "go 40mm to the right" lands
   * somewhere else entirely. An absolute machine position means one place on
   * the machine whatever else is switched on.
   *
   * One call rather than one per axis, for the reason jog takes a map: separate
   * commands trace an L through whatever is in the corner.
   *
   * The caller is responsible for the target being inside the axis limits — the
   * driver does not clamp, because silently cutting a move short is worse than
   * refusing it and every caller knows the limits.
   */
  moveToMachine(targets: Record<string, number>, opts?: { feedRate?: number }): Promise<void>;

  /**
   * Drive axes by VELOCITY rather than by destination — "run X at 25 mm/s until
   * I say otherwise". Only when `capabilities.velocityJog`, and only after
   * `velocityJogStatus()` has confirmed the firmware really has it.
   *
   * This is a different thing from `jog()`, not a variant of it. `jog()` sends
   * a distance and the machine gets there; an analogue control does not have a
   * distance to send, because a stick deflection is a speed. Building
   * continuous jogging out of repeated short `jog()` moves — which is what this
   * app did before, and what DWC still does — has the failure everyone who has
   * used it knows: the queue fills, the button stops feeling connected, and the
   * machine keeps going after release.
   *
   * Three rules, and they are the whole contract:
   *
   *   1. **The map is the entire velocity vector.** Any axis not in it is set
   *      to ZERO, not left alone. Send every axis you want moving, every time.
   *      This is deliberate on the firmware side: a truncated or half-parsed
   *      command cannot leave an axis running.
   *   2. **Keep sending.** The watchdog stops everything if nothing arrives
   *      inside `watchdogMs`. 20–50 Hz is the intended cadence, and "nothing
   *      changed" is not a reason to go quiet — resend the same vector.
   *   3. **Stopping means sending zero.** An empty map (or one that is all
   *      zeroes) is the stop, and it decelerates promptly. Falling silent also
   *      stops, but not until the watchdog expires — up to a quarter of a
   *      second of travel later.
   *
   * @param speeds signed mm/s per axis letter (deg/s for rotational axes).
   *   Machine units always: a G20 inches mode does not rescale these.
   * @returns free space left in the controller's command queue, in whatever
   *   unit it counts in, or null if it does not say. Only the trend is
   *   meaningful — heading towards zero means the sender is outrunning the
   *   machine and should slow down.
   */
  velocityJog(speeds: Record<string, number>, opts?: VelocityJogOptions): Promise<number | null>;
  /**
   * Ask the controller what it thinks the velocity-jog state is.
   *
   * Doubles as the feature probe, which is why it returns null rather than
   * throwing: null means this firmware does not implement velocity jogging at
   * all, and the caller should hide the controls rather than offer a pad that
   * silently does nothing. It is also the only way to see the speeds *after*
   * clamping — see VelocityJogStatus.
   */
  velocityJogStatus(): Promise<VelocityJogStatus | null>;

  /**
   * Ask whether one axis is being made to follow another in the planner, and
   * how — see AxisFollow.
   *
   * Read-only on purpose. The obvious next method is one that engages and
   * disengages it, and this app should not have one: engaging captures the
   * CURRENT separation between the two axes, so it is only correct once the
   * follower has been positioned, and where the follower belongs is a property
   * of the machine — bristle contact height, in the dust shoe's case. That
   * lives in the machine's own macros, which already position the axis and are
   * the right place to engage it. A button here that engaged without
   * positioning would capture whatever separation happened to exist.
   *
   * Null means the firmware does not have the feature at all. A non-null result
   * with a null `follower` means it has it and nothing is set up.
   */
  axisFollowing(): Promise<AxisFollow | null>;

  home(axes?: string[]): Promise<void>;
  /**
   * Set the work offset for `axis` so the current position reads `value`.
   * @param wcs which system to write, 1 = G54. Defaults to the active one.
   */
  setWorkZero(axis: string, value: number, wcs?: number): Promise<void>;
  /**
   * Write a work offset directly, in machine coordinates: after this, work
   * position = machine position − `machineValue` for that axis in that system.
   * Unlike setWorkZero this does not depend on where the machine is standing,
   * which is what typing a number into an offset table has to mean.
   */
  setWorkOffset(wcs: number, axis: string, machineValue: number): Promise<void>;
  /** Select work coordinate system (1 = G54). */
  selectWcs(index: number): Promise<void>;
  /**
   * Rotate the coordinate system by `angle` degrees anticlockwise about
   * (`centreX`, `centreY`) given in *work* coordinates. Only meaningful when
   * `capabilities.coordinateRotation`.
   */
  setRotation(angle: number, centreX: number, centreY: number): Promise<void>;
  /** Cancel any coordinate rotation. */
  clearRotation(): Promise<void>;
  emergencyStop(): Promise<void>;
  /**
   * Bring the controller back from an emergency stop.
   *
   * Separate from emergencyStop because it is the only way out of one: after
   * M112 the firmware refuses everything until it is reset, and without this
   * the app can stop a machine it cannot start again.
   */
  reset(): Promise<void>;

  // --- Spindle -----------------------------------------------------------
  setSpindle(rpm: number, direction: 'forward' | 'reverse'): Promise<void>;
  stopSpindle(): Promise<void>;

  // --- Live overrides ----------------------------------------------------
  /**
   * Feed rate as a percentage of what the program asked for.
   *
   * A driver method rather than a G-code string in the panel because the two
   * families do not agree on the mechanism at all: RRF takes `M220 S<pct>`,
   * while Grbl uses realtime bytes outside the G-code stream entirely. A panel
   * sending M220 would look correct and do nothing.
   */
  setFeedOverride(percent: number): Promise<void>;
  /** Nudge an axis live, without moving where the work origin is. */
  babystep(axis: string, delta: number): Promise<void>;

  // --- Tools -------------------------------------------------------------
  /** Select a tool by number, or null to deselect whatever is loaded. */
  selectTool(tool: number | null): Promise<void>;
  /**
   * Drive the tool changer for one slot, without a tool change.
   *
   * For setting the changer up and for recovering from a failed change, which
   * is when you most want to move one half of the operation at a time.
   */
  changeTool(slot: number, action: 'pickup' | 'drop'): Promise<void>;

  // --- Moves -------------------------------------------------------------
  /**
   * Move to the work origin.
   *
   * `clearanceZ` is a *machine* coordinate — the point of it is to get out of
   * the way of clamps and the workpiece, which is a question about the machine
   * and not about wherever the work zero happens to be. `includeZ` finishes by
   * bringing Z to the work origin too, which is a separate decision because it
   * is the one that can drive a cutter into something.
   */
  goToWorkOrigin(options?: { clearanceZ?: number; includeZ?: boolean }): Promise<void>;

  // --- Height map --------------------------------------------------------
  /**
   * Only meaningful when `capabilities.surfaceMap`. `describeHeightMap` exists
   * so the panel can show what it is about to send: this drives a probe into a
   * workpiece, and showing the command is how an operator checks it before
   * pressing the button rather than after.
   */
  defineProbeGrid(area: ScanArea): Promise<void>;
  probeGrid(probe: number): Promise<void>;
  applyHeightMap(): Promise<void>;
  clearHeightMap(): Promise<void>;
  describeHeightMap(area: ScanArea, probe: number | null): HeightMapCommands;

  // --- Files -------------------------------------------------------------
  listFiles(dir: string): Promise<FileEntry[]>;
  /**
   * @param onProgress receives (bytesLoaded, totalBytes|null). Optional so a
   *   driver that cannot report it simply doesn't, and callers show an
   *   indeterminate bar instead.
   */
  readFile(path: string, onProgress?: (loaded: number, total: number | null) => void): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;

  // --- Jobs --------------------------------------------------------------
  startJob(path: string): Promise<void>;
  pauseJob(): Promise<void>;
  resumeJob(): Promise<void>;
  cancelJob(): Promise<void>;
  /** Run a macro file on the controller. */
  runMacro(path: string): Promise<void>;
  /**
   * Start `path` from a byte offset into it — run-from-line, after a broken
   * cutter. Only when `capabilities.resumeFromOffset`.
   */
  startJobAt(path: string, byteOffset: number): Promise<void>;

  // --- Diagnostics -------------------------------------------------------
  /**
   * Controller health, derived from state the driver already holds. Synchronous
   * and side-effect free so the panel can call it on every render; a driver with
   * nothing to report returns an empty array and the panel hides itself.
   */
  diagnostics(): DiagnosticSection[];

  // --- Prompts -----------------------------------------------------------
  /** Answer a blocking prompt. `value` is supplied for input-mode prompts. */
  answerPrompt(seq: number, accept: boolean, value?: string | number): Promise<void>;

  // --- Escape hatch ------------------------------------------------------
  /**
   * Controller-specific surface, for the things a vendor-neutral API would only
   * get in the way of.
   *
   * This exists deliberately, and it is not a failure when a panel uses it. A
   * driver layer earns its keep on what several controllers genuinely have in
   * common; forcing the rest through it produces an abstraction that every
   * panel has to fight — a `setThing()` that means five different things, or a
   * generic call so vague nobody can tell what it will do. Better a narrow
   * common API and an honest door out of it.
   *
   * The rules for using it:
   *
   *   1. Check `driver.id` first, or a capability that implies the shape. A
   *      panel that casts `native` without asking whose it is will crash on
   *      the next controller.
   *   2. A panel that reaches through here should be one of the panels that is
   *      *about* this controller — the object-model browser, the RRF
   *      configuration editor — and should declare that by hiding itself when
   *      the capability is absent.
   *   3. Anything two drivers end up implementing belongs in this interface
   *      instead, and anything two drivers report belongs in MachineState.
   *
   * The object-model browser casts this to RrfNative; see src/panels/om.ts.
   */
  readonly native?: unknown;
}
