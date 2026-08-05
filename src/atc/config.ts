// RapidChange ATC configuration.
//
// A RapidChange is a row of pockets on the table, each holding a collet nut.
// The spindle unscrews a tool into a pocket by turning slowly anticlockwise
// while descending, and screws one on by doing the same clockwise. That is the
// whole mechanism, and it means the configuration is almost entirely geometry:
// where the first pocket is, how far apart they are, which way the row runs,
// and the Z heights at which the nut engages.
//
// A machine may have more than one such row — eight pockets along X and four
// more along Y is a real layout, and the second row is usually at a different
// height with a different pitch. So the geometry lives in banks, and everything
// that belongs to the spindle rather than to a row of pockets — engagement RPM,
// spin-up time, the retract height, the tool-present sensor — stays machine-wide.
//
// Tool numbers run straight through the banks in order: eight pockets then four
// gives T1..T8 and T9..T12. Nothing is derived from position, so moving a bank
// does not renumber anything; inserting a pocket into an earlier bank does, and
// that is the cost of contiguous numbering.
//
// Everything here maps onto a `global` in atcConfig.g, because that is the file
// the macros read. The field names and defaults follow the file the macros were
// written against, so a machine already running an ATC can have its file read
// back into this panel and edited rather than replaced.
//
// The one thing worth stating plainly is the failure mode. Every number here
// ends up in a G53 move with the spindle running. Getting the origin or the
// pitch wrong does not produce a warning — it drives a spinning collet into the
// pocket next door. That is why the panel computes and shows every slot
// position, and why nothing is written without being seen first.

/** Which way a row of pockets runs. */
export type AtcAlignment = 0 | 1; // 0 = along X, 1 = along Y

/**
 * A tool length setter.
 *
 * `slot` names a pocket the setter sits in, in which case its XY comes from
 * that pocket's geometry rather than being typed in a second time and drifting
 * from it.
 */
export interface AtcProbe {
  slot: { bank: number; slot: number } | null;
  x: number;
  y: number;
  /** Machine Z of the trigger surface. */
  z: number;
  /**
   * Which probe input measures tool length — the `K` of its `M558`.
   *
   * Named rather than assumed, because a machine with a workpiece probe as well
   * has more than one, and measuring the tool against the wrong one is not an
   * error the firmware can notice.
   */
  index: number;
}

/** One row of pockets. */
export interface AtcBank {
  /** Shown in the panel and written into the macros as a comment. */
  name: string;
  /** Number of pockets. */
  count: number;
  alignment: AtcAlignment;
  /** +1 if pocket 2 is at a higher coordinate than pocket 1, -1 if lower. */
  direction: 1 | -1;
  /** Centre-to-centre pocket spacing, mm. 45 on an ER20, 38 on an ER11. */
  offset: number;
  /** Centre of pocket 1, in machine coordinates. */
  originX: number;
  originY: number;

  // --- Z heights, all machine coordinates ---
  pickupStartZ: number;
  pickupEndZ: number;
  /** How far to lift and re-descend, to seat the threads. */
  pickupReengage: number;
  pickupFeed: number;
  dropStartZ: number;
  dropEndZ: number;
  dropFeed: number;

  /** M950 P number and pin for this bank's pocket cover, or null if it has none. */
  cover: { out: number; pin: string } | null;

  /**
   * A setter of this bank's own, used for tools fetched from it.
   *
   * Null means the machine-wide one. A second bank across the table is far
   * enough from the first setter that its own is worth having, but most
   * machines have one setter and this stays null.
   */
  probe: AtcProbe | null;
}

export interface AtcConfig {
  enabled: boolean;
  probingEnabled: boolean;

  banks: AtcBank[];

  // --- Machine-wide ---
  /** Where the spindle sits between operations; null means the Z maximum. */
  retractZ: number | null;
  /** Engagement speed. Low, and rarely what the VFD reports back. */
  rpm: number;
  /** Seconds to let the spindle reach speed before descending. */
  spindlePause: number;
  /** The setter used by any bank that does not have its own. */
  probe: AtcProbe;

  // --- Hardware ---
  /** M950 J number and pin for the tool-present sensor. On the spindle, so machine-wide. */
  toolSensorIn: number;
  toolSensorPin: string;
  hasToolSensor: boolean;

  // --- Integration ---
  /** Retract a U-axis dust shoe around tool changes, if one is configured. */
  dustShoe: boolean;
}

export function defaultAtcBank(name = 'Tool bank'): AtcBank {
  return {
    name,
    count: 8,
    alignment: 0,
    direction: 1,
    offset: 45,
    originX: 0,
    originY: 0,
    pickupStartZ: 27.5,
    pickupEndZ: 10,
    pickupReengage: 20,
    pickupFeed: 1700,
    dropStartZ: 27.5,
    dropEndZ: 10,
    dropFeed: 1800,
    cover: null,
    probe: null,
  };
}

export function defaultAtcProbe(): AtcProbe {
  return { slot: null, x: 0, y: 0, z: 0, index: 0 };
}

export function defaultAtcConfig(): AtcConfig {
  return {
    enabled: true,
    probingEnabled: true,
    banks: [defaultAtcBank()],
    retractZ: null,
    rpm: 250,
    spindlePause: 2,
    probe: defaultAtcProbe(),
    toolSensorIn: 6,
    toolSensorPin: '^io7.in',
    hasToolSensor: false,
    dustShoe: false,
  };
}

/**
 * Take a configuration of unknown vintage and make it current.
 *
 * The panel remembers the last configuration in local storage, and a browser
 * that has one from before banks existed is holding a working machine's
 * geometry. Losing it to a shape change would mean retyping pocket coordinates
 * — the exact thing this panel exists to avoid — so the old flat fields are
 * read into bank 0 and everything else keeps its meaning.
 */
export function adoptAtcConfig(raw: unknown): AtcConfig {
  const config = defaultAtcConfig();
  if (!raw || typeof raw !== 'object') return config;
  const old = raw as Record<string, unknown>;

  const num = (key: string, apply: (v: number) => void): void => {
    if (typeof old[key] === 'number' && Number.isFinite(old[key])) apply(old[key] as number);
  };
  const bool = (key: string, apply: (v: boolean) => void): void => {
    if (typeof old[key] === 'boolean') apply(old[key] as boolean);
  };

  bool('enabled', (v) => (config.enabled = v));
  bool('probingEnabled', (v) => (config.probingEnabled = v));
  bool('dustShoe', (v) => (config.dustShoe = v));
  bool('hasToolSensor', (v) => (config.hasToolSensor = v));
  num('toolSensorIn', (v) => (config.toolSensorIn = v));
  if (typeof old.toolSensorPin === 'string') config.toolSensorPin = old.toolSensorPin;
  num('rpm', (v) => (config.rpm = v));
  num('spindlePause', (v) => (config.spindlePause = v));
  if (old.retractZ === null) config.retractZ = null;
  else num('retractZ', (v) => (config.retractZ = v));

  if (Array.isArray(old.banks) && old.banks.length) {
    config.banks = (old.banks as unknown[]).map((b) => ({ ...defaultAtcBank(), ...(b as object) }));
    config.probe = { ...defaultAtcProbe(), ...((old.probe as object) ?? {}) };
    return config;
  }

  // The old single-bank shape.
  const bank = defaultAtcBank();
  const bnum = (key: string, apply: (v: number) => void): void => {
    if (typeof old[key] === 'number' && Number.isFinite(old[key])) apply(old[key] as number);
  };
  bnum('count', (v) => (bank.count = Math.max(1, Math.round(v))));
  bnum('alignment', (v) => (bank.alignment = v === 1 ? 1 : 0));
  bnum('direction', (v) => (bank.direction = v < 0 ? -1 : 1));
  bnum('offset', (v) => (bank.offset = v));
  bnum('originX', (v) => (bank.originX = v));
  bnum('originY', (v) => (bank.originY = v));
  bnum('pickupStartZ', (v) => (bank.pickupStartZ = v));
  bnum('pickupEndZ', (v) => (bank.pickupEndZ = v));
  bnum('pickupReengage', (v) => (bank.pickupReengage = v));
  bnum('pickupFeed', (v) => (bank.pickupFeed = v));
  bnum('dropStartZ', (v) => (bank.dropStartZ = v));
  bnum('dropEndZ', (v) => (bank.dropEndZ = v));
  bnum('dropFeed', (v) => (bank.dropFeed = v));
  if (old.hasDustCover === true) {
    bank.cover = {
      out: typeof old.dustCoverOut === 'number' ? old.dustCoverOut : 6,
      pin: typeof old.dustCoverPin === 'string' ? old.dustCoverPin : 'io6.out',
    };
  }
  config.banks = [bank];

  bnum('probeX', (v) => (config.probe.x = v));
  bnum('probeY', (v) => (config.probe.y = v));
  bnum('probeZ', (v) => (config.probe.z = v));
  bnum('probeIndex', (v) => (config.probe.index = Math.max(0, Math.round(v))));
  if (typeof old.probeSlot === 'number') config.probe.slot = { bank: 0, slot: Math.round(old.probeSlot) };

  return config;
}

// --- Slots and tool numbers -------------------------------------------------

/** Machine coordinates of a pocket centre, 1-based like the macros. */
export function slotPosition(bank: AtcBank, slot: number): { x: number; y: number } {
  const alongX = bank.alignment === 0 ? 1 : 0;
  const step = bank.offset * bank.direction * (slot - 1);
  return {
    x: round(bank.originX + step * alongX),
    y: round(bank.originY + step * (1 - alongX)),
  };
}

/** The tool number a pocket answers to. Banks number straight through, from T1. */
export function toolNumber(config: AtcConfig, bank: number, slot: number): number {
  let base = 1;
  for (let i = 0; i < bank && i < config.banks.length; i++) base += config.banks[i].count;
  return base + slot - 1;
}

/** Which pocket a tool number names, or null when nothing holds it. */
export function toolAt(config: AtcConfig, tool: number): { bank: number; slot: number } | null {
  let base = 1;
  for (let i = 0; i < config.banks.length; i++) {
    const count = config.banks[i].count;
    if (tool >= base && tool < base + count) return { bank: i, slot: tool - base + 1 };
    base += count;
  }
  return null;
}

/** Every configured pocket, in tool order. */
export function allSlots(
  config: AtcConfig,
): Array<{ bank: number; slot: number; tool: number; x: number; y: number }> {
  const out: Array<{ bank: number; slot: number; tool: number; x: number; y: number }> = [];
  config.banks.forEach((bank, b) => {
    for (let slot = 1; slot <= bank.count; slot++) {
      out.push({ bank: b, slot, tool: toolNumber(config, b, slot), ...slotPosition(bank, slot) });
    }
  });
  return out;
}

/** The setter a bank's tools are measured against, and where it is. */
export function probeFor(config: AtcConfig, bank: number): AtcProbe {
  return config.banks[bank]?.probe ?? config.probe;
}

/** A setter's position, resolving one that sits in a pocket. */
export function probePosition(config: AtcConfig, probe: AtcProbe): { x: number; y: number } {
  if (!probe.slot) return { x: probe.x, y: probe.y };
  const bank = config.banks[probe.slot.bank];
  if (!bank) return { x: probe.x, y: probe.y };
  return slotPosition(bank, probe.slot.slot);
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
 * Both shapes are read. A file with no `atcBankCount` is the single-bank one
 * this panel used to write (and the one the RapidChange macros ship with), and
 * becomes one bank; anything a machine is already running has to survive being
 * read back, or the first thing this panel does to a working ATC is forget it.
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
    const m = /^\s*(?:global\s+|set\s+global\.)(atc[A-Za-z0-9]+)\s*=\s*([^;]+)/.exec(line);
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
  const str = (key: string, apply: (v: string) => void): void => {
    const raw = globals.get(key);
    const m = raw !== undefined ? /^"([^"]*)"$/.exec(raw) : null;
    if (m) {
      apply(m[1]);
      found.push(key);
    }
  };

  bool('atcEnabled', (v) => (config.enabled = v));
  bool('atcProbingEnabled', (v) => (config.probingEnabled = v));
  num('atcRPM', (v) => (config.rpm = v));
  num('atcSpindlePause', (v) => (config.spindlePause = v));

  // An expression here is the norm, so only a literal is taken.
  const retract = globals.get('atcRetractZ');
  if (retract !== undefined && Number.isFinite(Number(retract))) {
    config.retractZ = Number(retract);
    found.push('atcRetractZ');
  }

  // Banks. `atcBankCount` marks a file this panel wrote; without it the file is
  // the older single-bank shape, whose globals have no bank prefix.
  const bankCount = Number(globals.get('atcBankCount'));
  const prefixes = Number.isFinite(bankCount) && bankCount >= 1
    ? Array.from({ length: Math.round(bankCount) }, (_, i) => `atcB${i}`)
    : ['atc'];
  if (prefixes[0] === 'atcB0') found.push('atcBankCount');

  config.banks = prefixes.map((prefix, index) => {
    const bank = defaultAtcBank(prefixes.length > 1 ? `Bank ${index + 1}` : 'Tool bank');
    str(`${prefix}Name`, (v) => (bank.name = v));
    num(`${prefix}Count`, (v) => (bank.count = Math.max(1, Math.round(v))));
    num(`${prefix}Alignment`, (v) => (bank.alignment = v === 1 ? 1 : 0));
    num(`${prefix}Direction`, (v) => (bank.direction = v < 0 ? -1 : 1));
    num(`${prefix}Offset`, (v) => (bank.offset = v));
    num(`${prefix}OriginX`, (v) => (bank.originX = v));
    num(`${prefix}OriginY`, (v) => (bank.originY = v));
    num(`${prefix}PickupStartZ`, (v) => (bank.pickupStartZ = v));
    num(`${prefix}PickupEndZ`, (v) => (bank.pickupEndZ = v));
    num(`${prefix}PickupReengage`, (v) => (bank.pickupReengage = v));
    num(`${prefix}PickupFeed`, (v) => (bank.pickupFeed = v));
    num(`${prefix}DropStartZ`, (v) => (bank.dropStartZ = v));
    num(`${prefix}DropEndZ`, (v) => (bank.dropEndZ = v));
    num(`${prefix}DropFeed`, (v) => (bank.dropFeed = v));

    // A bank's own setter, when it has one.
    const hasProbe = globals.get(`${prefix}HasProbe`);
    if (hasProbe !== undefined && /true/i.test(hasProbe)) {
      const probe = defaultAtcProbe();
      num(`${prefix}ProbeX`, (v) => (probe.x = v));
      num(`${prefix}ProbeY`, (v) => (probe.y = v));
      num(`${prefix}ProbeZ`, (v) => (probe.z = v));
      num(`${prefix}ProbeIndex`, (v) => (probe.index = Math.max(0, Math.round(v))));
      num(`${prefix}ProbeSlot`, (v) => (probe.slot = { bank: index, slot: Math.round(v) }));
      bank.probe = probe;
    }
    return bank;
  });

  // The machine-wide setter. In the old shape these were the only ones.
  num('atcProbeX', (v) => (config.probe.x = v));
  num('atcProbeY', (v) => (config.probe.y = v));
  num('atcProbeZ', (v) => (config.probe.z = v));
  num('atcProbeIndex', (v) => (config.probe.index = Math.max(0, Math.round(v))));
  // Commented out unless the setter lives in a pocket, which is why it is read
  // from an uncommented assignment only.
  num('atcProbeSlot', (v) => (config.probe.slot = { bank: 0, slot: Math.round(v) }));
  num('atcProbeSlotBank', (v) => {
    if (config.probe.slot) config.probe.slot.bank = Math.max(0, Math.round(v));
  });

  // Hardware comes from the M950s rather than a global. Cover outputs are
  // matched to banks in the order they appear, which is the order they are
  // written; a hand-written file with one cover gives it to the first bank.
  const covers = [...text.matchAll(/^\s*M950\s+P(\d+)\s+C"([^"]+)"/gm)];
  covers.forEach((cover, i) => {
    const bank = config.banks[i];
    if (!bank) return;
    bank.cover = { out: Number(cover[1]), pin: cover[2] };
    found.push(`cover output for ${bank.name}`);
  });
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

/** Per-slot XY step for a bank, precomputed so the macros do not repeat it. */
function bankStep(bank: AtcBank): { x: number; y: number } {
  const alongX = bank.alignment === 0 ? 1 : 0;
  return {
    x: round(bank.offset * bank.direction * alongX),
    y: round(bank.offset * bank.direction * (1 - alongX)),
  };
}

/**
 * The globals a bank contributes, and the names of the "current bank" globals
 * they are copied into by atcBank.g.
 *
 * One table drives both, because the two lists have to stay identical: a field
 * declared here and forgotten in the resolver is a bank that silently inherits
 * the previous bank's pocket height.
 */
export function bankFields(config: AtcConfig, index: number): Array<{ name: string; value: string }> {
  const bank = config.banks[index];
  const step = bankStep(bank);
  const probe = bank.probe;
  const probePos = probe ? probePosition(config, probe) : null;
  return [
    { name: 'Count', value: String(bank.count) },
    { name: 'OriginX', value: String(bank.originX) },
    { name: 'OriginY', value: String(bank.originY) },
    { name: 'OffsetX', value: String(step.x) },
    { name: 'OffsetY', value: String(step.y) },
    { name: 'PickupStartZ', value: String(bank.pickupStartZ) },
    { name: 'PickupEndZ', value: String(bank.pickupEndZ) },
    { name: 'PickupReengage', value: String(bank.pickupReengage) },
    { name: 'PickupFeed', value: String(bank.pickupFeed) },
    { name: 'DropStartZ', value: String(bank.dropStartZ) },
    { name: 'DropEndZ', value: String(bank.dropEndZ) },
    { name: 'DropFeed', value: String(bank.dropFeed) },
    // -1 rather than a separate flag: the macros test it, and a cover output is
    // never negative.
    { name: 'CoverOut', value: String(bank.cover ? bank.cover.out : -1) },
    { name: 'ProbeX', value: String(probePos ? probePos.x : config.probe.x) },
    { name: 'ProbeY', value: String(probePos ? probePos.y : config.probe.y) },
    { name: 'ProbeZ', value: String(probe ? probe.z : config.probe.z) },
    { name: 'ProbeIndex', value: String(probe ? probe.index : config.probe.index) },
  ];
}

export function renderAtcConfig(config: AtcConfig): string {
  const total = config.banks.reduce((n, b) => n + b.count, 0);
  const lines: string[] = [
    '; RapidChange ATC configuration',
    GENERATED,
    ';',
    '; Called from config.g with:  M98 P"atcConfig.g"',
    '',
  ];

  config.banks.forEach((bank) => {
    if (!bank.cover) return;
    lines.push(`; Pocket cover for ${bank.name}`, `M950 P${bank.cover.out} C"${bank.cover.pin}" Q2000`, '');
  });
  if (config.hasToolSensor) {
    lines.push('; Tool-present sensor input', `M950 J${config.toolSensorIn} C"${config.toolSensorPin}"`, '');
  }

  lines.push(
    `global atcEnabled = ${config.enabled}`,
    `global atcProbingEnabled = ${config.probingEnabled}`,
    '',
    '; Machine-wide',
    `global atcRetractZ = ${config.retractZ ?? 'move.axes[2].max'}`,
    `global atcRPM = ${config.rpm} ; engagement speed; a VFD rarely reports this back accurately`,
    `global atcSpindlePause = ${config.spindlePause} ; seconds to reach speed before descending`,
    'global atcPickupRPM = {global.atcRPM}',
    'global atcDropRPM = {global.atcRPM}',
    'global atcToolHasBeenDetected = false',
    '',
    `global atcBankCount = ${config.banks.length}`,
    `global atcToolCount = ${total} ; tools run T1..T${total}, straight through the banks`,
    '',
  );

  config.banks.forEach((bank, i) => {
    const first = toolNumber(config, i, 1);
    lines.push(
      `; --- Bank ${i}: ${bank.name} — T${first}..T${first + bank.count - 1}`,
      `global atcB${i}Name = "${bank.name.replace(/"/g, "'")}"`,
      `global atcB${i}FirstTool = ${first}`,
      `global atcB${i}Alignment = ${bank.alignment} ; 0 = row runs along X, 1 = along Y`,
      `global atcB${i}Direction = ${bank.direction} ; +1 if pocket 2 is above pocket 1, -1 if below`,
      `global atcB${i}Offset = ${bank.offset} ; centre-to-centre pocket spacing, mm`,
      ...bankFields(config, i).map((f) => `global atcB${i}${f.name} = ${f.value}`),
      `global atcB${i}HasProbe = ${bank.probe !== null}`,
      ...(bank.probe?.slot ? [`global atcB${i}ProbeSlot = ${bank.probe.slot.slot}`] : []),
      '',
    );
  });

  lines.push(
    '; The bank currently selected. atcBank.g copies one bank into these, and',
    '; every operation reads them — so a macro never has to know which bank it',
    '; is working on, only that one has been selected.',
    ...bankFields(config, 0).map((f) => `global atcCur${f.name} = ${f.value}`),
    'global atcCurBank = 0',
    '',
    '; The machine-wide tool setter, used by any bank without its own.',
  );
  const wide = probePosition(config, config.probe);
  lines.push(
    `global atcProbeX = ${wide.x}`,
    `global atcProbeY = ${wide.y}`,
    `global atcProbeZ = ${config.probe.z} ; machine Z of the trigger surface`,
    `global atcProbeIndex = ${config.probe.index} ; the K number of the tool setter's M558`,
    ...(config.probe.slot
      ? [
          `global atcProbeSlot = ${config.probe.slot.slot} ; the setter sits in this pocket`,
          `global atcProbeSlotBank = ${config.probe.slot.bank}`,
        ]
      : []),
  );

  return lines.join('\n') + '\n';
}
