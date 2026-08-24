// Partial typings for the RepRapFirmware object model.
//
// Only the keys this UI consumes are typed; the rest stays `unknown` and is
// still browsable through the object-model panel. Reference:
//   https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Documentation
//
// These types are the durable asset in this driver. Endpoints rarely change;
// object-model *shapes* do move between firmware releases, so keeping them in
// one file makes a firmware upgrade a localised edit.

export interface OmAxis {
  letter: string;
  machinePosition: number;
  userPosition: number;
  workplaceOffsets: number[];
  homed: boolean;
  min: number;
  max: number;
  visible: boolean;
  babystep?: number;
  /** Maximum feed, mm/MINUTE (M203). Unlike move.currentMove, which is mm/s. */
  speed?: number;
  /** M201, mm/s². */
  acceleration?: number;
  /** M566, mm/min. */
  jerk?: number;
  /** M92. */
  stepsPerMm?: number;
  /** M906, mA. */
  current?: number;
}

export interface OmMove {
  axes: OmAxis[];
  workplaceNumber: number;
  speedFactor: number;
  /**
   * BEWARE the units here: RepRapFirmware reports them differently within this
   * one subtree, and nothing in the JSON says so.
   *
   *   currentMove.*  — mm/SECOND (GetRequestedSpeedMmPerSec, GetTopSpeedMmPerSec,
   *                    GetAccelerationMmPerSecSquared in Move.cpp)
   *   axes[].speed   — mm/MINUTE (InverseConvertSpeedToMmPerMin)
   *
   * The neutral model is mm/min throughout, so currentMove needs ×60 and
   * axes[].speed does not. Reading the first as mm/min makes every feed
   * readout 60× too small, which looks plausible enough to survive a glance:
   * a 6000 mm/min jog shows as "100".
   */
  currentMove?: {
    /** mm/s. */
    requestedSpeed?: number;
    /** mm/s. */
    topSpeed?: number;
    /** mm/s². */
    acceleration?: number;
  };
  /**
   * G68 coordinate rotation. Present only in firmware built with
   * SUPPORT_COORDINATE_ROTATION, so absent is "not supported", not "zero".
   * `centre` is in *machine* coordinates — G68 takes it in work coordinates and
   * the firmware adds the workplace offset before storing it.
   */
  rotation?: {
    angle: number;
    centre: number[];
  };
  /** Mesh/height-map compensation. `type` is "none" when nothing is loaded. */
  compensation?: {
    type?: string;
    file?: string;
    meshDeviation?: { mean?: number; deviation?: number };
    liveGrid?: unknown;
    probeGrid?: unknown;
  };
}

export interface OmMessageBox {
  mode: number;
  seq: number;
  title: string;
  message: string;
  timeout: number;
  axisControls: number;
  /** Prefill for the input modes; `null` when the macro supplied none. */
  default?: number | string | null;
  /** The options for mode 4, answered with M292 R<index>. */
  choices?: string[] | null;
  /** Whether the firmware is offering a way out of this box. */
  cancelButton?: boolean;
  /** Bounds on a numeric input, from M291's L and H parameters. */
  min?: number | null;
  max?: number | null;
}

export interface OmState {
  status: string;
  currentTool: number;
  displayMessage?: string;
  messageBox?: OmMessageBox | null;
  upTime?: number;
  machineMode?: string;
}

export interface OmSpindle {
  active: number;
  current: number;
  min: number;
  max: number;
  state: string;
  canReverse?: boolean;
}

export interface OmJob {
  file?: {
    fileName?: string;
    size?: number;
    generatedBy?: string;
  } | null;
  filePosition?: number;
  duration?: number;
  timesLeft?: { file?: number; filament?: number; slicer?: number };
  lastFileName?: string;
}

export interface OmTool {
  number: number;
  name: string;
  offsets: number[];
  spindle?: number;
  state?: string;
}

/** current/min/max triple RRF uses for voltages and temperatures. */
export interface OmRange {
  current?: number;
  min?: number;
  max?: number;
}

/** Where the firmware keeps each kind of file, as it reports them. */
export interface OmDirectories {
  firmware?: string;
  gCodes?: string;
  macros?: string;
  system?: string;
  web?: string;
}

export interface OmBoard {
  shortName?: string;
  name?: string;
  firmwareVersion?: string;
  firmwareName?: string;
  firmwareDate?: string;
  uniqueId?: string;
  canAddress?: number;
  /**
   * The names the board itself asks to be flashed from. Never guessed: the
   * firmware states what it will look for, and an update built from a guess is
   * how a board gets written with the wrong image.
   */
  firmwareFileName?: string;
  /** In-application programmer, SD-card variant — what does the actual write. */
  iapFileNameSD?: string;
  iapFileNameSBC?: string;
  bootloaderFileName?: string;
  wifiFirmwareFileName?: string;
  /** Never-used RAM, bytes. */
  freeRam?: number;
  /** min/max here are the extremes *observed*, not permitted limits. */
  vIn?: OmRange;
  v12?: OmRange;
  mcuTemp?: OmRange;
}

export interface OmNetworkInterface {
  type?: string;
  state?: string;
  actualIP?: string;
  mac?: string;
  gateway?: string;
  subnet?: string;
  /** WiFi RSSI, dBm. */
  signal?: number;
  speed?: number;
  numReconnects?: number;
}

export interface OmNetwork {
  name?: string;
  hostname?: string;
  interfaces?: OmNetworkInterface[];
}

export interface OmProbe {
  type?: number;
  value?: number[];
  threshold?: number;
  diveHeight?: number;
  lastStopHeight?: number;
}

/**
 * Whether a probe is currently triggered.
 *
 * There is no `triggered` field on a probe — that one belongs to
 * `sensors.endstops[]`. A probe reports `value[0]`, the raw reading, and
 * `threshold`, the G31 P value the firmware itself compares it against.
 * Digital probes (types 5 and 8) report 0 or 1000 against a default threshold
 * of 500, so the same comparison answers for them and for analog probes alike;
 * inversion (M558 I1) is already applied by the firmware before the reading
 * reaches us.
 *
 * Returns null when there is no reading or no usable threshold. That is not
 * the same answer as "open", and callers must keep them apart: a probe we
 * cannot read drawn as a probe that is not triggered is exactly the mistake
 * that gets a spindle driven into the work.
 */
export function probeTriggered(probe: OmProbe): boolean | null {
  const reading = probe.value?.[0];
  if (typeof reading !== 'number' || !Number.isFinite(reading)) return null;
  const threshold = probe.threshold;
  if (typeof threshold !== 'number' || !(threshold > 0)) return null;
  return reading >= threshold;
}

export interface OmSensors {
  probes?: OmProbe[];
  [key: string]: unknown;
}

export interface OmSeqs {
  boards?: number;
  directories?: number;
  fans?: number;
  global?: number;
  heat?: number;
  inputs?: number;
  job?: number;
  move?: number;
  network?: number;
  reply?: number;
  sensors?: number;
  spindles?: number;
  state?: number;
  tools?: number;
  volumes?: number;
  [key: string]: number | undefined;
}

export interface ObjectModel {
  boards?: OmBoard[];
  directories?: OmDirectories;
  /** Present only when a Single Board Computer is running the show. */
  sbc?: Record<string, unknown> | null;
  global?: Record<string, unknown>;
  job?: OmJob;
  move?: OmMove;
  network?: OmNetwork;
  sensors?: OmSensors;
  seqs?: OmSeqs;
  spindles?: OmSpindle[];
  state?: OmState;
  tools?: OmTool[];
  volumes?: OmVolume[];
  [key: string]: unknown;
}

/**
 * A mounted volume.
 *
 * `freeSpace` is the field worth knowing about: RRF only computes it when
 * something asks, so it can be null or absent on a perfectly healthy card, and
 * it is expensive enough on a large card that the firmware does not keep it
 * fresh. Absent means unknown here, never zero.
 */
export interface OmVolume {
  name?: string;
  mounted?: boolean;
  capacity?: number | null;
  freeSpace?: number | null;
  path?: string;
  speed?: number | null;
}

/** Top-level keys we re-fetch in full when their sequence number advances. */
export const TRACKED_KEYS = [
  'boards',
  'directories',
  'global',
  'job',
  'move',
  'network',
  'sensors',
  'spindles',
  'state',
  'tools',
] as const;

/**
 * Why `volumes` is NOT in the list above.
 *
 * It belongs there by the same logic as the rest — free space is not in the
 * frequently-changing subset the cheap poll returns, so its sequence number is
 * the only signal that it moved. It was there for one commit, and it broke
 * installing the app.
 *
 * Reading `volumes` verbosely makes the firmware compute free space, and that
 * means walking the FAT and holding the SD card while it does. RRF bumps the
 * volumes sequence number every time a file is written, so an install — which
 * writes twenty-odd files back to back — turned into a free-space walk between
 * every one of them, competing for the card with the uploads themselves.
 *
 * So the sequence number is still what says "this changed", because that much
 * is free in the cheap poll. What it triggers is a request no more often than
 * VOLUMES_MIN_INTERVAL_MS, and never while this driver has a file transfer of
 * its own in flight. See RrfDriver.refreshVolumes.
 */
export const VOLUMES_KEY = 'volumes';

/**
 * Map RRF's status string onto the neutral model.
 * RRF values: disconnected, starting, updating, off, halted, pausing, paused,
 * resuming, cancelling, processing, simulating, busy, changingTool, idle.
 */
export function mapStatus(status: string | undefined): import('../../types.js').MachineStatus {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'processing':
    case 'simulating':
      return 'running';
    case 'paused':
      return 'paused';
    case 'pausing':
    case 'cancelling':
      return 'pausing';
    case 'resuming':
      return 'resuming';
    case 'changingTool':
      return 'tool-change';
    case 'halted':
      return 'halted';
    case 'off':
      return 'off';
    case 'busy':
      return 'busy';
    case 'starting':
    case 'updating':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'busy';
  }
}

/**
 * M291 S<mode> → neutral prompt mode.
 *
 * The numbers are Duet's `MessageBoxMode`, not a reading of the M291
 * documentation:
 *
 *   0 no buttons, 1 close only, 2 OK, 3 OK+Cancel,
 *   4 multiple choice, 5 integer, 6 float, 7 string
 *
 * This was wrong by one across the whole input range until it was checked
 * against @duet3d/objectmodel — 4 was read as the integer box, which slid
 * every mode after it along, so a float question was answered with a quoted
 * string that the firmware rejects and the macro waited forever. Modes 4-7 are
 * answered with M292 R<value>; see driver.answerPrompt.
 */
export function mapPromptMode(mode: number): import('../../types.js').MachinePrompt['mode'] {
  switch (mode) {
    case 0:
      return 'none';
    case 1:
      return 'close';
    case 2:
      return 'ok';
    case 3:
      return 'ok-cancel';
    case 4:
      return 'choice';
    case 5:
      return 'input-int';
    case 6:
      return 'input-float';
    case 7:
      return 'input-string';
    default:
      return 'ok';
  }
}

/**
 * RRF axisControls is a bitmap over the machine's axis list.
 * Tolerates holes — object-model arrays are indexed by number, not packed.
 */
export function expandAxisControls(bitmap: number, axes: OmAxis[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < axes.length; i++) {
    const letter = axes[i]?.letter;
    if (letter && bitmap & (1 << i)) out.push(letter);
  }
  return out;
}

export function mapSpindleState(state: string | undefined): import('../../types.js').Spindle['state'] {
  switch (state) {
    case 'stopped':
      return 'stopped';
    case 'forward':
      return 'forward';
    case 'reverse':
      return 'reverse';
    default:
      return 'unknown';
  }
}
