// RapidChange ATC configuration.
//
// A RapidChange is a row of pockets on the table, each holding a collet nut.
// The spindle unscrews a tool into a pocket by turning slowly anticlockwise
// while descending, and screws one on by doing the same clockwise. That is the
// whole mechanism, and it means the configuration is almost entirely geometry:
// where the first pocket is, how far apart they are, which way the row runs,
// and the Z heights at which the nut engages.
//
// Everything here maps onto a `global` in atcConfig.g, because that is the file
// the macros read. Nothing is invented: the field names, the defaults and the
// derived values follow the file the macros were written against, so a machine
// already running an ATC can have its file read back into this panel and edited
// rather than replaced.
//
// The one thing worth stating plainly is the failure mode. Every number here
// ends up in a G53 move with the spindle running. Getting the origin or the
// pitch wrong does not produce a warning — it drives a spinning collet into the
// pocket next door. That is why the panel computes and shows every slot
// position, and why nothing is written without being seen first.

/** Which way the row of pockets runs. */
export type AtcAlignment = 0 | 1; // 0 = along X, 1 = along Y

export interface AtcConfig {
  enabled: boolean;
  probingEnabled: boolean;

  // --- Geometry ---
  /** Number of pockets. */
  count: number;
  alignment: AtcAlignment;
  /** +1 if slot 2 is at a higher coordinate than slot 1, -1 if lower. */
  direction: 1 | -1;
  /** Centre-to-centre pocket spacing, mm. 45 on an ER20, 38 on an ER11. */
  offset: number;
  /** Centre of pocket 1, in machine coordinates. */
  originX: number;
  originY: number;

  // --- Z heights, all machine coordinates ---
  /** Where the spindle sits between operations; usually the Z maximum. */
  retractZ: number | null;
  pickupStartZ: number;
  pickupEndZ: number;
  /** How far to lift and re-descend, to seat the threads. */
  pickupReengage: number;
  pickupFeed: number;
  dropStartZ: number;
  dropEndZ: number;
  dropFeed: number;

  // --- Spindle ---
  /** Engagement speed. Low, and rarely what the VFD reports back. */
  rpm: number;
  /** Seconds to let the spindle reach speed before descending. */
  spindlePause: number;

  // --- Tool length probe ---
  /**
   * Which probe input measures tool length — the `K` of its `M558`.
   *
   * Named rather than assumed, because a machine with a workpiece probe as
   * well has more than one, and measuring the tool against the wrong one is
   * not an error the firmware can notice.
   */
  probeIndex: number;
  /** Pocket the probe lives in, or null when it is somewhere else entirely. */
  probeSlot: number | null;
  probeX: number;
  probeY: number;
  /** Machine Z of the probe's trigger surface. */
  probeZ: number;

  // --- Hardware ---
  /** M950 P number and pin for the dust cover, or null if there is none. */
  dustCoverOut: number;
  dustCoverPin: string;
  hasDustCover: boolean;
  /** M950 J number and pin for the tool-present sensor, or null if none. */
  toolSensorIn: number;
  toolSensorPin: string;
  hasToolSensor: boolean;

  // --- Integration ---
  /** Retract a U-axis dust shoe around tool changes, if one is configured. */
  dustShoe: boolean;
}

export function defaultAtcConfig(): AtcConfig {
  return {
    enabled: true,
    probingEnabled: true,
    count: 8,
    alignment: 0,
    direction: 1,
    offset: 45,
    originX: 0,
    originY: 0,
    retractZ: null,
    pickupStartZ: 27.5,
    pickupEndZ: 10,
    pickupReengage: 20,
    pickupFeed: 1700,
    dropStartZ: 27.5,
    dropEndZ: 10,
    dropFeed: 1800,
    rpm: 250,
    spindlePause: 2,
    probeIndex: 0,
    probeSlot: null,
    probeX: 0,
    probeY: 0,
    probeZ: 0,
    dustCoverOut: 6,
    dustCoverPin: 'io6.out',
    hasDustCover: false,
    toolSensorIn: 6,
    toolSensorPin: '^io7.in',
    hasToolSensor: false,
    dustShoe: false,
  };
}

/** Machine coordinates of a pocket centre, 1-based like the macros. */
export function slotPosition(config: AtcConfig, slot: number): { x: number; y: number } {
  const alongX = config.alignment === 0 ? 1 : 0;
  const step = config.offset * config.direction * (slot - 1);
  return {
    x: round(config.originX + step * alongX),
    y: round(config.originY + step * (1 - alongX)),
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// --- Reading an existing atcConfig.g ---------------------------------------

/**
 * Pull settings out of a file already on the machine.
 *
 * Deliberately forgiving, and deliberately partial: it reads the assignments it
 * recognises and leaves everything else at the default. A hand-edited file will
 * have comments, expressions and lines this knows nothing about, and the
 * alternative to reading what it can is asking an operator to retype geometry
 * they already have — which is how a working ATC gets a wrong number in it.
 *
 * `retractZ` is the interesting one: the file usually holds an expression
 * (`move.axes[2].max`) rather than a literal, so anything unparseable becomes
 * null, which means exactly that — "the machine's Z maximum".
 */
export function parseAtcConfig(text: string): { config: AtcConfig; found: string[] } {
  const config = defaultAtcConfig();
  const found: string[] = [];

  const globals = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    // `global atcFoo = 1 ; comment` and `set global.atcFoo = 1`
    const m = /^\s*(?:global\s+|set\s+global\.)(atc[A-Za-z]+)\s*=\s*([^;]+)/.exec(line);
    if (m) globals.set(m[1], m[2].trim());
  }

  const num = (key: string, apply: (v: number) => void): void => {
    const raw = globals.get(key);
    if (raw === undefined) return;
    const v = Number(raw);
    if (Number.isFinite(v)) {
      apply(v);
      found.push(key);
    }
  };
  const bool = (key: string, apply: (v: boolean) => void): void => {
    const raw = globals.get(key);
    if (raw === undefined) return;
    if (/^(true|false)$/i.test(raw)) {
      apply(/true/i.test(raw));
      found.push(key);
    }
  };

  bool('atcEnabled', (v) => (config.enabled = v));
  bool('atcProbingEnabled', (v) => (config.probingEnabled = v));
  num('atcCount', (v) => (config.count = Math.max(1, Math.round(v))));
  num('atcAlignment', (v) => (config.alignment = v === 1 ? 1 : 0));
  num('atcDirection', (v) => (config.direction = v < 0 ? -1 : 1));
  num('atcOffset', (v) => (config.offset = v));
  num('atcOriginX', (v) => (config.originX = v));
  num('atcOriginY', (v) => (config.originY = v));
  num('atcPickupStartZ', (v) => (config.pickupStartZ = v));
  num('atcPickupEndZ', (v) => (config.pickupEndZ = v));
  num('atcPickupReengage', (v) => (config.pickupReengage = v));
  num('atcPickupFeed', (v) => (config.pickupFeed = v));
  num('atcDropStartZ', (v) => (config.dropStartZ = v));
  num('atcDropEndZ', (v) => (config.dropEndZ = v));
  num('atcDropFeed', (v) => (config.dropFeed = v));
  num('atcRPM', (v) => (config.rpm = v));
  num('atcSpindlePause', (v) => (config.spindlePause = v));
  num('atcProbeIndex', (v) => (config.probeIndex = Math.max(0, Math.round(v))));
  num('atcProbeX', (v) => (config.probeX = v));
  num('atcProbeY', (v) => (config.probeY = v));
  num('atcProbeZ', (v) => (config.probeZ = v));

  // An expression here is the norm, so only a literal is taken.
  const retract = globals.get('atcRetractZ');
  if (retract !== undefined && Number.isFinite(Number(retract))) {
    config.retractZ = Number(retract);
    found.push('atcRetractZ');
  }

  // Commented out unless the probe lives in a pocket, which is why it is read
  // from an uncommented assignment only.
  num('atcProbeSlot', (v) => (config.probeSlot = Math.round(v)));

  // Hardware comes from the M950s rather than a global.
  const cover = /^\s*M950\s+P(\d+)\s+C"([^"]+)"/m.exec(text);
  if (cover) {
    config.dustCoverOut = Number(cover[1]);
    config.dustCoverPin = cover[2];
    config.hasDustCover = true;
    found.push('dust cover output');
  }
  const sensor = /^\s*M950\s+J(\d+)\s+C"([^"]+)"/m.exec(text);
  if (sensor) {
    config.toolSensorIn = Number(sensor[1]);
    config.toolSensorPin = sensor[2];
    config.hasToolSensor = true;
    found.push('tool sensor input');
  }

  return { config, found };
}

// --- Writing atcConfig.g ---------------------------------------------------

const GENERATED = '; Generated by Axis Control. Edit here or in the ATC panel.';

export function renderAtcConfig(config: AtcConfig): string {
  const lines: string[] = [
    '; RapidChange ATC configuration',
    GENERATED,
    ';',
    '; Called from config.g with:  M98 P"atcConfig.g"',
    '',
  ];

  if (config.hasDustCover) {
    lines.push(
      '; Dust cover output',
      `M950 P${config.dustCoverOut} C"${config.dustCoverPin}" Q2000`,
      '',
    );
  }
  if (config.hasToolSensor) {
    lines.push(
      '; Tool-present sensor input',
      `M950 J${config.toolSensorIn} C"${config.toolSensorPin}"`,
      '',
    );
  }

  lines.push(
    `global atcEnabled = ${config.enabled}`,
    `global atcProbingEnabled = ${config.probingEnabled}`,
    '',
    '; Geometry',
    `global atcCount = ${config.count} ; number of pockets`,
    `global atcAlignment = ${config.alignment} ; 0 = row runs along X, 1 = along Y`,
    `global atcDirection = ${config.direction} ; +1 if slot 2 is above slot 1, -1 if below`,
    `global atcOffset = ${config.offset} ; centre-to-centre pocket spacing, mm`,
    `global atcOriginX = ${config.originX} ; centre of pocket 1`,
    `global atcOriginY = ${config.originY}`,
    '',
    '; Z heights, machine coordinates',
    `global atcRetractZ = ${config.retractZ ?? 'move.axes[2].max'}`,
    `global atcPickupStartZ = ${config.pickupStartZ}`,
    `global atcPickupEndZ = ${config.pickupEndZ}`,
    `global atcPickupReengage = ${config.pickupReengage}`,
    `global atcPickupFeed = ${config.pickupFeed}`,
    `global atcDropStartZ = ${config.dropStartZ}`,
    `global atcDropEndZ = ${config.dropEndZ}`,
    `global atcDropFeed = ${config.dropFeed}`,
    '',
    '; Spindle',
    `global atcRPM = ${config.rpm} ; engagement speed; a VFD rarely reports this back accurately`,
    `global atcSpindlePause = ${config.spindlePause} ; seconds to reach speed before descending`,
    'global atcPickupRPM = {global.atcRPM}',
    'global atcDropRPM = {global.atcRPM}',
    '',
    'global atcToolHasBeenDetected = false',
    '',
    '; Tool length probe',
  );

  if (config.probeSlot != null) {
    lines.push(
      `global atcProbeSlot = ${config.probeSlot} ; probe sits in this pocket`,
      'global atcProbeX = 0 ; overwritten below from the slot',
      'global atcProbeY = 0',
    );
  } else {
    lines.push(
      `global atcProbeX = ${config.probeX}`,
      `global atcProbeY = ${config.probeY}`,
    );
  }
  lines.push(
    `global atcProbeZ = ${config.probeZ} ; machine Z of the trigger surface`,
    `global atcProbeIndex = ${config.probeIndex} ; the K number of the tool setter's M558`,
    '',
  );

  lines.push(
    '; Derived: per-slot step, from alignment, spacing and direction',
    'global atcAlignmentX = {1 - global.atcAlignment}',
    'global atcAlignmentY = {global.atcAlignment}',
    'global atcOffsetX = {global.atcOffset * global.atcDirection * global.atcAlignmentX}',
    'global atcOffsetY = {global.atcOffset * global.atcDirection * global.atcAlignmentY}',
  );

  if (config.probeSlot != null) {
    lines.push(
      '',
      'if {exists(global.atcProbeSlot)}',
      '\tset global.atcProbeX = {global.atcOriginX + global.atcOffsetX * (global.atcProbeSlot - 1)}',
      '\tset global.atcProbeY = {global.atcOriginY + global.atcOffsetY * (global.atcProbeSlot - 1)}',
    );
  }

  return lines.join('\n') + '\n';
}
