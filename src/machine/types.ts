// Vendor-neutral machine model.
//
// Every panel in the UI reads *only* these types. Nothing above the driver layer
// may import RepRapFirmware object-model types, `rr_*` endpoint names, or any
// other controller-specific vocabulary. That constraint is the whole point: a
// second controller (Makera Z1, GRBL, Smoothie…) becomes a new implementation of
// MachineDriver rather than a fork of the UI.
//
// Where a controller has a concept the model lacks, expose it through
// `capabilities` + the driver's `native` escape hatch instead of widening these
// types. The object-model browser panel does exactly that for RRF.

export type MachineStatus =
  | 'disconnected'
  | 'connecting'
  | 'idle'
  | 'busy'
  | 'running'
  | 'paused'
  | 'pausing'
  | 'resuming'
  | 'homing'
  | 'tool-change'
  | 'halted'
  | 'off';

/**
 * Statuses in which hand-driven motion cannot happen.
 *
 * Deliberately NOT `BUSY_STATES`, and the whole difference is `busy`. An
 * ordinary move reports `busy` for as long as it runs — which includes the
 * distance rose's own G1s, so refusing on busy greyed the rose out under the
 * operator's thumb the moment a jog started.
 *
 * Velocity jogging (M700) is a separate case and has moved: the firmware used
 * to report `busy` while jogging and now leaves the status at `idle`. That is
 * why nothing in this app infers "a jog is running" from the status — see
 * `jogRunning` in core/velocity.ts, which is client-side and is the only
 * authority on it. This set is still what it was, though, because a velocity
 * jog can begin while the machine is still busy finishing something else, and
 * refusing then would be just as wrong.
 *
 * `paused` is absent for the same kind of reason. Jogging while paused is when
 * you most want it — clearing a chip, checking a cut, moving the head to see
 * what you are doing — and RRF allows it.
 *
 * What is left is the cases where something else genuinely owns the machine, or
 * where there is nothing to drive: a program running, a homing move or tool
 * change in progress, an emergency stop, motors off, no connection. Those are
 * still reported, so a running macro or print stays distinguishable.
 */
export const JOG_BLOCKED_STATES: ReadonlySet<MachineStatus> = new Set<MachineStatus>([
  'disconnected',
  'connecting',
  'running',
  'pausing',
  'resuming',
  'homing',
  'tool-change',
  'halted',
  'off',
]);

/**
 * Statuses in which it is unsafe to start a new motion command.
 *
 * For anything that queues work and then waits — running a macro, starting a
 * spindle. Hand-driven motion wants JOG_BLOCKED_STATES instead; see the note
 * there for why the two differ.
 */
export const BUSY_STATES: ReadonlySet<MachineStatus> = new Set<MachineStatus>([
  'disconnected',
  'connecting',
  'busy',
  'running',
  'pausing',
  'resuming',
  'homing',
  'tool-change',
  'halted',
  'off',
]);

export interface Axis {
  /** X, Y, Z, U, A… — the controller's own letter. */
  letter: string;
  /** Position in machine coordinates (mm). */
  machine: number;
  /** Position in the active work coordinate system (mm). */
  work: number;
  homed: boolean;
  min: number;
  max: number;
  /** True for axes that participate in the toolpath (X/Y/Z), false for aux axes. */
  visible: boolean;
  /** Per-WCS offsets, index 0 = G54. Empty if the controller doesn't expose them. */
  workOffsets: number[];
  /** Maximum feed for this axis in mm/min, 0 when the controller doesn't say. */
  maxFeed: number;
  /** Live offset applied on top of the work offset (RRF babystep), mm. */
  babystep: number;
  /* The tuning values, as the controller currently holds them. Zero means the
     controller does not report it — these exist so the config panel can say
     whether a file's M201/M203/M566/M92/M906 is actually in force. */
  /** M201, mm/s². */
  acceleration: number;
  /** M566 instantaneous speed change, mm/min. */
  jerk: number;
  /** M92, steps per mm. */
  stepsPerMm: number;
  /** M906 motor current, mA. */
  current: number;
}

export interface Spindle {
  /** Commanded RPM. */
  active: number;
  /** Measured/actual RPM if the controller reports it, else same as active. */
  current: number;
  min: number;
  max: number;
  state: 'stopped' | 'forward' | 'reverse' | 'unknown';
}

export interface JobState {
  fileName: string | null;
  /** Byte offset into the running file — used to locate the cutter in the toolpath. */
  filePosition: number | null;
  fileSize: number | null;
  /** 0..1, best available estimate. */
  progress: number | null;
  elapsed: number | null;
  remaining: number | null;
}

export interface ToolState {
  number: number;
  name: string | null;
  offsets: number[];
}

/** A prompt the controller is blocking on (RRF M291, and equivalents elsewhere). */
export interface MachinePrompt {
  /** Stable identifier so we only render/answer each prompt once. */
  seq: number;
  title: string;
  message: string;
  /**
   * none = informational; ok = single button; ok-cancel = two; choice = pick
   * one of `choices`; input-* = needs a value.
   */
  mode:
    | 'none'
    | 'close'
    | 'ok'
    | 'ok-cancel'
    | 'choice'
    | 'input-int'
    | 'input-float'
    | 'input-string';
  /** Show jog controls inside the dialog (RRF axisControls bitmap, expanded). */
  axisControls: string[];
  timeout: number | null;
  defaultValue?: string | number;
  /** Options for `choice`, answered by index. */
  choices?: string[];
  /**
   * Whether the controller is offering a way out. Absent means it did not say,
   * which is not the same as "no" — see the messagebox, which only takes the
   * cancel button away when the controller explicitly says there is none.
   */
  cancelButton?: boolean;
  /** Bounds on a numeric input, when the prompt carried them. */
  min?: number;
  max?: number;
}

/**
 * Rotation of the work coordinate system about a point in the XY plane.
 *
 * This is what makes a crooked workpiece usable: probe two points along one
 * edge, rotate the coordinate system to match, and the CAM output runs square
 * to the stock without re-fixturing it. `angle` is degrees anticlockwise.
 */
export interface Rotation {
  angle: number;
  /** Rotation centre in *machine* coordinates. */
  centre: [number, number];
}

/**
 * Height-map compensation, when it is switched on.
 *
 * Like rotation, this silently changes every move — Z is corrected against the
 * map — so it has to be visible rather than buried in a controller-specific
 * corner of the object model.
 */
export interface SurfaceCompensation {
  /** Map file in use, if the controller names one. */
  file: string | null;
  /** Mean height error over the probed points, mm. */
  mean: number | null;
  /** RMS deviation from that mean, mm. */
  deviation: number | null;
}

/**
 * What the controller says about updating its own firmware.
 *
 * Every filename here comes from the board rather than from a table in this
 * app. RepRapFirmware states the exact name it will look for when told to
 * flash itself, and that is the only trustworthy source: the same release
 * carries images for a dozen boards, and picking the wrong one writes the
 * wrong image to flash.
 */
export interface FirmwareInfo {
  /** e.g. "MB6HC". */
  board: string;
  /** e.g. "Duet 3 MB6HC". */
  boardName: string;
  /** e.g. "3.6.0". */
  version: string;
  /** CAN address; 0 is the main board. */
  canAddress: number;
  /** The image the board flashes from, e.g. "Duet3Firmware_MB6HC.uf2". */
  firmwareFile: string | null;
  /** The in-application programmer that does the writing, SD-card variant. */
  iapFile: string | null;
  /** Where firmware files are uploaded, e.g. "0:/firmware/". */
  directory: string | null;
  /** True when a Single Board Computer runs the show and updates go via it. */
  sbc: boolean;
}

export interface MachineState {
  status: MachineStatus;
  /** Human-readable controller identity, e.g. "Duet 3 MB6HC / RRF 3.6.0". */
  identity: string | null;
  axes: Axis[];
  /** Active work coordinate system, 1 = G54. */
  wcs: number;
  /** How many work coordinate systems the controller exposes. */
  wcsCount: number;
  /** Active coordinate rotation, or null when there is none / it is unsupported. */
  rotation: Rotation | null;
  /** Active height-map compensation, or null when none is loaded. */
  compensation: SurfaceCompensation | null;
  spindle: Spindle | null;
  job: JobState | null;
  tool: ToolState | null;
  prompt: MachinePrompt | null;
  /** Feed rate of the current move, mm/min. */
  feedRate: number | null;
  /** Speed/feed override factor, 1.0 = 100%. */
  feedMultiplier: number;
  /** Free-form key/value state the driver wants surfaced but the model doesn't name. */
  extras: Record<string, unknown>;
  /** Main board first, then anything on the CAN bus. Empty when unknown. */
  firmware: FirmwareInfo[];
  /**
   * Storage the controller has mounted. Empty when the controller has none, or
   * has one it declines to describe — plenty of controllers stream from the
   * host and have no card at all, and a panel has to be able to tell "no card"
   * from "a card I know nothing about" without guessing.
   */
  volumes: Volume[];
}

/**
 * One axis made to follow another inside the motion planner.
 *
 * This machine's dust shoe is the case it exists for: the shoe hangs off the Z
 * carriage on its own U axis, so U has to move opposite to Z for the bristles
 * to stay at a constant height above the work. Doing that from G-code cannot
 * work, and the reason is worth stating because a lot of effort went into
 * proving it — a watcher can only react *after* Z has moved, and the object
 * model does not expose where a move is going, only where it is. The
 * information is late, and no amount of polling, triggers or extra motion
 * queues makes late information early.
 *
 * Inside the planner the two become one coordinated move and the problem
 * disappears. `follower = scale × leader + offset`, in MACHINE coordinates and
 * after tool offsets — which is what makes tool length compensate itself: a
 * longer tool puts the carriage higher for the same work Z, the leader's
 * machine coordinate rises, and the follower comes down to match.
 */
export interface AxisFollow {
  /** The driven axis. Null when the firmware has the feature but nothing is set up. */
  follower: string | null;
  /** The axis it tracks. Null when nothing is set up. */
  leader: string | null;
  /** Usually −1: something carried on a carriage moves the opposite way to stay put. */
  scale: number;
  /** Machine-coordinate constant in the relationship. */
  offset: number;
  /** Whether the relationship is currently being applied. */
  engaged: boolean;
}

/**
 * What the controller says about velocity jogging when asked.
 *
 * The one field worth reading closely is `speeds`: those are what the firmware
 * is *actually* running, after its own clamping, not what was asked for. A
 * velocity command is capped at the axis maximum (M203) and the cap does not
 * produce an error — ask for 200 mm/s on an axis whose maximum is 100 and the
 * machine runs at 100 while reporting success. Reading this back is the only
 * way to know that happened, and it is the right way round: a refusal in the
 * middle of a jog would be a stop.
 *
 * `chunkMs` and `queueDepth` are the board's own numbers, reported so the
 * readouts can be honest about latency. They are not settings this app has any
 * business choosing — see VelocityJogOptions.
 */
export interface VelocityJogStatus {
  active: boolean;
  /** How much motion is prepared at a time, ms. Sets latency and the speed ceiling. */
  chunkMs: number;
  /** Motion stops if no command arrives inside this, ms. */
  watchdogMs: number;
  /** How many chunks are queued ahead. */
  queueDepth: number;
  /** Running speed per axis letter, mm/s — after clamping. */
  speeds: Record<string, number>;
}

/** A mounted filesystem on the controller. */
export interface Volume {
  /** How the controller names it, e.g. "SD card" or "usb0". Never empty. */
  name: string;
  /** Path the volume is mounted at, e.g. "0:/". Null when unstated. */
  mountPath: string | null;
  /** Total size in bytes, or null when the controller does not say. */
  capacity: number | null;
  /**
   * Bytes free, or null when unknown.
   *
   * Null rather than zero, and the distinction earns its keep: RRF reports
   * freeSpace as null on a volume it has not been asked to compute it for, and
   * showing that as "0 bytes free" would read as a card about to fail.
   */
  free: number | null;
  /** False for a slot with no card in it. */
  mounted: boolean;
}

export function emptyMachineState(): MachineState {
  return {
    status: 'disconnected',
    identity: null,
    axes: [],
    wcs: 1,
    wcsCount: 1,
    rotation: null,
    compensation: null,
    spindle: null,
    job: null,
    tool: null,
    prompt: null,
    feedRate: null,
    feedMultiplier: 1,
    extras: {},
    firmware: [],
    volumes: [],
  };
}

/**
 * A controller health readout, in a shape no controller dictates.
 *
 * Deliberately pre-formatted strings rather than numbers with units: what is
 * worth showing differs enormously between controllers, and a model that tried
 * to name every field would be a list of RepRapFirmware's fields with the
 * others missing. The driver decides what matters and how to say it; the panel
 * only lays it out.
 *
 * `level` is for facts the controller itself asserts — a halted machine, a
 * probe that is triggered, a poll that is failing. It must never be an invented
 * threshold: a supply voltage shown in red because someone guessed at a limit
 * teaches the operator to ignore red.
 */
export type DiagnosticLevel = 'ok' | 'warn' | 'bad' | 'info';

export interface DiagnosticItem {
  label: string;
  value: string;
  level?: DiagnosticLevel;
  /** Secondary line — ranges, context, why the level is what it is. */
  detail?: string;
}

export interface DiagnosticSection {
  title: string;
  items: DiagnosticItem[];
  /**
   * Commands this section offers. They are in the controller's own dialect and
   * come *from* the driver, so the panel stays vendor-neutral by sending them
   * back verbatim without knowing what they mean.
   */
  actions?: Array<{ label: string; command: string; title?: string }>;
  /** Shown when the section has nothing to report. */
  emptyNote?: string;
}

export interface FileEntry {
  name: string;
  /** Controller-absolute path. */
  path: string;
  directory: boolean;
  size: number;
  modified: Date | null;
}

export type LogLevel = 'command' | 'reply' | 'warning' | 'error' | 'info';

export interface LogLine {
  level: LogLevel;
  text: string;
  time: Date;
}

/**
 * What a given controller can actually do. Panels consult this to decide whether
 * to render themselves at all, so adding a less capable driver degrades the UI
 * gracefully instead of producing dead buttons.
 */
export interface Capabilities {
  /** Exposes a browsable/editable structured state tree (RRF object model). */
  objectModel: boolean;
  /** Supports listing/reading/writing files on the controller. */
  files: boolean;
  /** Supports writing files back (config editing). */
  fileWrite: boolean;
  /** Runs macro files stored on the controller. */
  macros: boolean;
  /** Number of work coordinate systems (0 = unsupported). */
  workCoordinateSystems: number;
  /** Can rotate the coordinate system about a point in XY (G68-style). */
  coordinateRotation: boolean;
  /** Can probe a grid into a height map and compensate Z against it. */
  surfaceMap: boolean;
  /** Reports byte offset into the running file, enabling live toolpath tracking. */
  jobFilePosition: boolean;
  /** Supports an automatic tool changer workflow. */
  toolChanger: boolean;
  /** Can answer blocking prompts (M291-style). */
  prompts: boolean;
  /** Can set a live feed-rate override while moving. */
  feedOverride: boolean;
  /** Can nudge an axis live without changing the work offset. */
  babystep: boolean;
  /**
   * Can start a job from a byte offset into the file.
   *
   * Separate from `jobFilePosition`, which is about *reading* the offset back.
   * A controller can report where it is without being able to be told where to
   * begin, and run-from-line needs both.
   */
  resumeFromOffset: boolean;
  /** Selecting a tool by number means something to this controller. */
  toolSelection: boolean;
  /**
   * This driver knows how to express movement as a *velocity* rather than a
   * destination — "run X at 25 mm/s until I say otherwise".
   *
   * Note carefully what this does and does not promise. It says the driver can
   * form the command; it does NOT say the machine on the other end of the wire
   * will accept it. Capabilities are fixed per driver and this one depends on
   * the firmware build — RRF only gained M700 in a fork — so the driver claims
   * the ability and the caller confirms it against the actual board with
   * `velocityJogStatus()`. Treating the flag as the answer puts a jog pad in
   * front of an operator on a machine that will silently refuse every command
   * it sends.
   */
  velocityJog: boolean;
  /**
   * This driver knows how to ask about one axis following another — see
   * AxisFollow.
   *
   * Same shape of promise as `velocityJog`, and the same warning: it says the
   * driver can form the question, not that the firmware will answer it. RRF's
   * M604 is a fork command, and a provisional number at that, so the only
   * reliable answer comes from asking the board — `axisFollowing()`.
   */
  axisFollowing: boolean;
  /** Directory the driver considers the natural root for G-code jobs. */
  gcodeRoot: string;
  /** Directory holding controller configuration, if browsable. */
  configRoot: string | null;
  /** Directory holding macros, if any. */
  macroRoot: string | null;
}

export function defaultCapabilities(): Capabilities {
  return {
    objectModel: false,
    files: false,
    fileWrite: false,
    macros: false,
    workCoordinateSystems: 0,
    coordinateRotation: false,
    surfaceMap: false,
    jobFilePosition: false,
    toolChanger: false,
    prompts: false,
    feedOverride: false,
    babystep: false,
    resumeFromOffset: false,
    toolSelection: false,
    velocityJog: false,
    axisFollowing: false,
    gcodeRoot: '/gcodes',
    configRoot: null,
    macroRoot: null,
  };
}

/**
 * A rectangle of the table to probe, and how densely.
 *
 * Vendor-neutral: this describes a patch of the machine's bed, which is the
 * same idea whoever is driving it. Spacing is per axis because a long bed
 * rarely needs the same density along both.
 */
export interface ScanArea {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  spacingX: number;
  spacingY: number;
}

/**
 * The commands a height-map operation will send, for showing before sending.
 *
 * This probes into a workpiece, so the panel puts the exact command on screen
 * and an operator checks it before pressing the button rather than after.
 */
export interface HeightMapCommands {
  define: string;
  scan: string;
  apply: string;
  clear: string;
}
