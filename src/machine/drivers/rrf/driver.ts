// RepRapFirmware driver — maps the object model onto the neutral machine model.

import type { ConnectionConfig, JogOptions, MachineDriver } from '../../driver.js';
import {
  defaultCapabilities,
  emptyMachineState,
  type Axis,
  type Capabilities,
  type DiagnosticItem,
  type DiagnosticSection,
  type FileEntry,
  type FirmwareInfo,
  type LogLine,
  type MachineState,
} from '../../types.js';
import { RrfClient, SessionLostError } from './client.js';
import { mergeInto } from './merge.js';
import {
  TRACKED_KEYS,
  VOLUMES_KEY,
  expandAxisControls,
  mapPromptMode,
  mapSpindleState,
  mapStatus,
  type ObjectModel,
  type OmRange,
  type OmSeqs,
} from './om.js';
import { formatBytes, formatDuration, joinPath } from '../../../core/util.js';
// The height-map commands live here rather than in the panel now: probing a
// grid is a universal idea, and M557/G29 is one dialect's way of saying it.
import {
  CLEAR_COMMAND,
  applyCommand,
  defineGridCommand,
  scanCommand,
} from '../../../surface/rrf.js';
import type { HeightMapCommands, ScanArea } from '../../types.js';

/** Exposed through `driver.native` for the object-model browser panel. */
/**
 * RepRapFirmware's own surface, reached through `driver.native`.
 *
 * Everything here is a thing only this controller has. Nothing else has an
 * object model to browse, and `set global.x = 1` is RRF's own expression
 * syntax rather than G-code — so putting these on MachineDriver would define a
 * vocabulary that no second driver could ever implement, which is the failure
 * mode a driver layer is supposed to prevent.
 */
export interface RrfNative {
  getModel(): ObjectModel;
  /** Fetch a subtree on demand, e.g. "sensors.probes". */
  fetchKey(key: string): Promise<unknown>;
  client(): RrfClient;
  /**
   * Assign to a variable in the object model — `set global.atcRPM = 250`.
   *
   * `literal` is written into the command as-is, so the caller decides whether
   * a value is a number, a quoted string or an expression. Quoting it here
   * would make it impossible to set anything but strings.
   */
  setVariable(path: string, literal: string): Promise<void>;
}

const POLL_INTERVAL_MS = 250;
/** Back off to this while the machine is idle to spare the board's sockets. */
const IDLE_POLL_INTERVAL_MS = 500;
/**
 * Shortest gap between two free-space reads, ms.
 *
 * Asking for `volumes` verbosely makes the firmware walk the FAT to total up
 * free space, holding the SD card while it does. Ten seconds is far more often
 * than a card's free space matters and far less often than the poll would
 * otherwise ask — the sequence number moves on every file written, and an
 * install writes twenty of them back to back.
 */
const VOLUMES_MIN_INTERVAL_MS = 10_000;

export class RrfDriver implements MachineDriver {
  readonly id = 'rrf';
  readonly label = 'RepRapFirmware (Duet)';

  readonly capabilities: Capabilities = {
    ...defaultCapabilities(),
    objectModel: true,
    files: true,
    fileWrite: true,
    macros: true,
    workCoordinateSystems: 9,
    // G68/G69, XY plane only. Experimental in RRF but present since 3.4, and
    // 3.6.1 fixed the direction to anticlockwise as the standard requires.
    coordinateRotation: true,
    // M557 + G29; the K parameter is what keeps it off the tool setter.
    surfaceMap: true,
    jobFilePosition: true,
    toolChanger: true,
    prompts: true,
    feedOverride: true,
    babystep: true,
    resumeFromOffset: true,
    toolSelection: true,
    gcodeRoot: '/gcodes',
    configRoot: '/sys',
    macroRoot: '/macros',
  };

  private client: RrfClient | null = null;
  private model: ObjectModel = {};
  private seqs: OmSeqs = {};
  private state: MachineState = emptyMachineState();
  private stateSubs = new Set<(s: MachineState) => void>();
  private logSubs = new Set<(l: LogLine) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = true;
  /**
   * File transfers this driver currently has in flight.
   *
   * The poll loop runs on its own timer, so it is concurrent with any upload or
   * download a panel is doing. Anything that touches the SD card from the poll
   * has to stand out of the way while that is true, or it is competing with the
   * transfer for the one card.
   */
  private transfers = 0;
  /** True when the volumes sequence number has moved since the last read. */
  private volumesStale = true;
  /** When the last free-space read finished, from performance.now(). */
  private volumesReadAt = -Infinity;
  private config: ConnectionConfig | null = null;
  private consecutiveFailures = 0;

  readonly native: RrfNative = {
    getModel: () => this.model,
    setVariable: (path: string, literal: string) => this.send(`set ${path} = ${literal}`),
    fetchKey: async (key: string) => {
      if (!this.client) throw new Error('not connected');
      return this.client.model(key, 'd99vn');
    },
    client: () => {
      if (!this.client) throw new Error('not connected');
      return this.client;
    },
  };

  // --- Lifecycle ---------------------------------------------------------

  async connect(config: ConnectionConfig): Promise<void> {
    await this.disconnect();
    this.config = config;
    this.stopped = false;
    this.client = new RrfClient(config.url);
    this.client.signal = config.signal ?? null;

    this.patchState({ status: 'connecting' });
    const info = await this.client.connect(config.password ?? '');
    this.log('info', `connected to ${info.boardType}${info.sessionKey != null ? '' : ' (legacy session)'}`);

    await this.seedModel();
    this.rebuildState();

    this.schedule(0);
  }

  /**
   * Seed the cached model, one top-level key at a time.
   *
   * Emphatically NOT `rr_model?flags=d99vn` with an empty key. That asks the
   * board to serialise its entire object model, verbose, nulls included, to
   * unlimited depth — by far the largest response it can be made to produce, and
   * on a machine with nine tools and four axes it is big enough that the board
   * can fail to deliver it at all. (The firmware gained an `p` flag specifically
   * to shorten responses, which is the same problem viewed from the other end.)
   *
   * Fetching per key is also what the documented seqs-driven pattern expects,
   * and it degrades gracefully: one key the firmware chokes on costs us that
   * subtree, not the whole connection.
   */
  private async seedModel(): Promise<void> {
    const client = this.requireClient();
    this.model = {};

    const seqs = (await client.model('seqs', 'd99vn')) as OmSeqs;
    this.seqs = { ...(seqs ?? {}) };

    for (const key of TRACKED_KEYS) {
      try {
        const subtree = await client.model(key, 'd99vn');
        this.model = mergeInto(this.model, { [key]: subtree });
      } catch (err) {
        // A missing or oversized key must not abort the connection.
        this.log('warning', `could not read ${key}: ${(err as Error).message}`);
      }
    }
    this.model = mergeInto(this.model, { seqs: this.seqs });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const c = this.client;
    this.client = null;
    this.model = {};
    this.seqs = {};
    // A reconnect is a different card as far as this is concerned — possibly
    // literally, if somebody swapped it while the app was pointed elsewhere.
    this.transfers = 0;
    this.volumesStale = true;
    this.volumesReadAt = -Infinity;
    if (c) {
      try {
        await c.disconnect();
      } catch {
        // Best effort — the board may already have dropped us.
      }
    }
    this.patchState({ ...emptyMachineState() });
  }

  onState(cb: (s: MachineState) => void): () => void {
    this.stateSubs.add(cb);
    cb(this.state);
    return () => this.stateSubs.delete(cb);
  }

  onLog(cb: (l: LogLine) => void): () => void {
    this.logSubs.add(cb);
    return () => this.logSubs.delete(cb);
  }

  // --- Poll loop ---------------------------------------------------------

  /**
   * Re-read free space, if it has changed and it is a reasonable moment to ask.
   *
   * Three guards, and the middle one is the one that matters. Asking for
   * `volumes` verbosely makes the firmware total up free space by walking the
   * FAT, which holds the SD card for as long as it takes — and RRF advances the
   * volumes sequence number on every file written. Without the guards, an
   * install put a free-space walk between every one of its twenty uploads,
   * competing with the uploads for the card and leaving the app's own files
   * unservable by the time it went to read them back.
   *
   * Failure is swallowed on purpose. Free space is the least important thing
   * this driver reports, and a board that declines to compute it should not
   * cost the poll its other work.
   */
  private async refreshVolumes(): Promise<void> {
    if (!this.volumesStale || !this.client) return;
    if (this.transfers > 0) return;
    if (performance.now() - this.volumesReadAt < VOLUMES_MIN_INTERVAL_MS) return;

    this.volumesReadAt = performance.now();
    this.volumesStale = false;
    try {
      const subtree = await this.client.model(VOLUMES_KEY, 'd99vn');
      this.model = mergeInto(this.model, { [VOLUMES_KEY]: subtree });
    } catch {
      // Try again on the next change rather than hammering a board that said no.
    }
  }

  /**
   * Run a file transfer, with the poll's SD-card reads held off while it does.
   *
   * Every path in and out of the card goes through here so that nothing on the
   * poll loop can decide to walk the filesystem in the middle of an upload.
   */
  private async transfer<T>(fn: () => Promise<T>): Promise<T> {
    this.transfers++;
    try {
      return await fn();
    } finally {
      this.transfers--;
      // A write changed the card, so the figure on screen is now wrong. Mark it
      // rather than read it: the next poll picks it up once the interval is up,
      // and a burst of writes still costs one read rather than one each.
      this.volumesStale = true;
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || !this.client) return;
    this.polling = true;

    try {
      // 1. One cheap request for the live subset of the whole tree, plus seqs.
      const live = (await this.client.model('', 'd99fn')) as ObjectModel;
      this.model = mergeInto(this.model, live);

      // 2. Re-fetch in full only the subtrees whose sequence number moved.
      const next = (live.seqs ?? {}) as OmSeqs;
      const changed = TRACKED_KEYS.filter((k) => next[k] !== undefined && next[k] !== this.seqs[k]);

      for (const key of changed) {
        const subtree = await this.client.model(key, 'd99vn');
        this.model = mergeInto(this.model, { [key]: subtree });
        this.seqs[key] = next[key];
      }

      // 2b. Free space, on its own much slower clock. See refreshVolumes.
      if (next[VOLUMES_KEY] !== undefined && next[VOLUMES_KEY] !== this.seqs[VOLUMES_KEY]) {
        this.seqs[VOLUMES_KEY] = next[VOLUMES_KEY];
        this.volumesStale = true;
      }
      await this.refreshVolumes();

      // 3. seqs.reply advancing means buffered console output is waiting.
      if (next.reply !== undefined && next.reply !== this.seqs.reply) {
        this.seqs.reply = next.reply;
        const text = await this.client.reply();
        if (text.trim()) this.emitReply(text);
      }

      this.consecutiveFailures = 0;
      this.rebuildState();

      const idle = this.state.status === 'idle' || this.state.status === 'off';
      this.schedule(idle ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    } catch (err) {
      await this.handlePollError(err);
    } finally {
      this.polling = false;
    }
  }

  private async handlePollError(err: unknown): Promise<void> {
    this.consecutiveFailures++;

    if (err instanceof SessionLostError) {
      // The board evicted us (timeout, reset, or another client took the slot).
      // Re-running rr_connect is the documented recovery.
      this.log('warning', 'session lost — reconnecting');
      try {
        if (this.client && this.config) {
          await this.client.connect(this.config.password ?? '');
          await this.seedModel();
          this.consecutiveFailures = 0;
          this.rebuildState();
          this.log('info', 'reconnected');
        }
      } catch (e) {
        this.log('error', `reconnect failed: ${(e as Error).message}`);
      }
      this.schedule(1000);
      return;
    }

    // A reset (M999, firmware update, power cycle) shows up as repeated network
    // errors. Keep retrying with a ceiling rather than tearing the UI down.
    if (this.consecutiveFailures === 3) {
      this.log('error', `lost contact with controller: ${(err as Error).message}`);
      this.patchState({ status: 'disconnected' });
    }
    const backoff = Math.min(500 * this.consecutiveFailures, 5000);
    this.schedule(backoff);
  }

  // --- State mapping -----------------------------------------------------

  private rebuildState(): void {
    const m = this.model;

    // RRF's object-model arrays are indexed by *number*, not packed, so any
    // slot the machine doesn't define comes back as null. This config declares
    // M563 P1..P9 with no P0, so `tools[0]` is null — and reading `.number` off
    // it is what "null is not an object" was. Never touch fields on a member of
    // one of these arrays without dropping the holes first.
    const omAxes = (m.move?.axes ?? []).filter(Boolean);
    const omTools = (m.tools ?? []).filter(Boolean);
    const omSpindles = (m.spindles ?? []).filter(Boolean);
    const board = (m.boards ?? []).filter(Boolean)[0] ?? null;

    const axes: Axis[] = omAxes.map((a) => ({
      letter: a.letter,
      machine: a.machinePosition ?? 0,
      work: a.userPosition ?? 0,
      homed: !!a.homed,
      min: a.min ?? 0,
      max: a.max ?? 0,
      visible: a.visible !== false,
      workOffsets: a.workplaceOffsets ?? [],
      // Already mm/min — this one the firmware converts for us.
      maxFeed: a.speed ?? 0,
      babystep: a.babystep ?? 0,
      acceleration: a.acceleration ?? 0,
      jerk: a.jerk ?? 0,
      stepsPerMm: a.stepsPerMm ?? 0,
      current: a.current ?? 0,
    }));

    const spindleOm = omSpindles.find((s) => s.max > 0) ?? omSpindles[0] ?? null;
    const job = m.job;
    const fileSize = job?.file?.size ?? null;
    const filePosition = job?.filePosition ?? null;

    const currentToolNumber = m.state?.currentTool ?? -1;
    const toolOm = omTools.find((t) => t.number === currentToolNumber) ?? null;

    const box = m.state?.messageBox;

    // Every board on the bus, main first — each states its own image and its
    // own programmer, which is what makes flashing possible without a table of
    // board names in this app.
    const firmware: FirmwareInfo[] = (m.boards ?? []).filter(Boolean).map((b) => ({
      board: b.shortName ?? '',
      boardName: b.name ?? b.shortName ?? 'Duet',
      version: b.firmwareVersion ?? '',
      canAddress: b.canAddress ?? 0,
      firmwareFile: b.firmwareFileName ?? null,
      iapFile: b.iapFileNameSD ?? null,
      directory: m.directories?.firmware ?? null,
      sbc: m.sbc != null,
    }));

    this.state = {
      status: mapStatus(m.state?.status),
      identity: board
        ? `${board.name ?? board.shortName ?? 'Duet'}${
            board.firmwareVersion ? ` / RRF ${board.firmwareVersion}` : ''
          }`
        : null,
      axes,
      wcs: m.move?.workplaceNumber != null ? m.move.workplaceNumber + 1 : 1,
      wcsCount: 9,
      // Absent `move.rotation` means the firmware wasn't built with coordinate
      // rotation at all; a zero angle means it is supported but not in use.
      // Both surface as null, and the capability flag below tells them apart.
      // "none" is RRF's own word for no compensation loaded; anything else means
      // Z is being corrected on every move.
      compensation:
        m.move?.compensation && m.move.compensation.type && m.move.compensation.type !== 'none'
          ? {
              file: m.move.compensation.file ?? null,
              mean: m.move.compensation.meshDeviation?.mean ?? null,
              deviation: m.move.compensation.meshDeviation?.deviation ?? null,
            }
          : null,
      rotation:
        m.move?.rotation && m.move.rotation.angle !== 0
          ? {
              angle: m.move.rotation.angle,
              centre: [m.move.rotation.centre?.[0] ?? 0, m.move.rotation.centre?.[1] ?? 0],
            }
          : null,
      spindle: spindleOm
        ? {
            active: spindleOm.active ?? 0,
            current: spindleOm.current ?? 0,
            min: spindleOm.min ?? 0,
            max: spindleOm.max ?? 0,
            state: mapSpindleState(spindleOm.state),
          }
        : null,
      job: job?.file?.fileName
        ? {
            fileName: job.file.fileName,
            filePosition,
            fileSize,
            progress:
              fileSize && filePosition != null && fileSize > 0
                ? Math.min(1, filePosition / fileSize)
                : null,
            elapsed: job.duration ?? null,
            remaining: job.timesLeft?.file ?? null,
          }
        : null,
      tool: toolOm
        ? { number: toolOm.number, name: toolOm.name || null, offsets: toolOm.offsets ?? [] }
        : null,
      prompt: box
        ? {
            seq: box.seq,
            title: box.title || '',
            message: box.message || '',
            mode: mapPromptMode(box.mode),
            axisControls: expandAxisControls(box.axisControls ?? 0, omAxes),
            timeout: box.timeout || null,
          }
        : null,
      // ×60: currentMove is mm/s in the object model, the neutral model is
      // mm/min. See the units warning on OmMove.currentMove.
      feedRate:
        m.move?.currentMove?.requestedSpeed != null
          ? m.move.currentMove.requestedSpeed * 60
          : null,
      feedMultiplier: m.move?.speedFactor ?? 1,
      // The ATC and dust shoe state in this machine's config lives entirely in
      // RRF globals, and globals are part of the object model — so panels get
      // real machine state here rather than shadow bookkeeping.
      firmware,
      // Index-named rather than skipped when the firmware gives no name: a
      // second unnamed volume has to be distinguishable from the first, and
      // "Volume 1" beats an empty row.
      volumes: (m.volumes ?? []).filter(Boolean).map((v, i) => ({
        name: v.name || `Volume ${i}`,
        mountPath: v.path ?? null,
        // partitionSize is the usable size and capacity is the card's; the
        // usable one is what a free-space figure has to be a fraction of, or
        // the bar reads wrong on any card whose partition is smaller than it.
        capacity: v.partitionSize ?? v.capacity ?? null,
        free: v.freeSpace ?? null,
        mounted: v.mounted ?? true,
      })),
      extras: { global: m.global ?? {} },
    };

    this.emitState();
  }

  private patchState(patch: Partial<MachineState>): void {
    this.state = { ...this.state, ...patch };
    this.emitState();
  }

  private emitState(): void {
    for (const cb of this.stateSubs) cb(this.state);
  }

  private log(level: LogLine['level'], text: string): void {
    const line: LogLine = { level, text, time: new Date() };
    for (const cb of this.logSubs) cb(line);
  }

  /** RRF prefixes replies with "Error: " / "Warning: "; surface that as a level. */
  private emitReply(text: string): void {
    for (const raw of text.split('\n')) {
      const t = raw.trimEnd();
      if (!t.trim()) continue;
      const level: LogLine['level'] = /^Error:/i.test(t)
        ? 'error'
        : /^Warning:/i.test(t)
          ? 'warning'
          : 'reply';
      this.log(level, t);
    }
  }

  // --- Commands ----------------------------------------------------------

  private requireClient(): RrfClient {
    if (!this.client) throw new Error('not connected to a controller');
    return this.client;
  }

  async send(command: string): Promise<void> {
    this.log('command', command);
    await this.requireClient().gcode(command);
  }

  /**
   * Send and wait for the reply. RRF buffers replies per HTTP client (3.5+), so
   * this does not steal output from DWC or grr.py running alongside us.
   */
  async query(command: string): Promise<string> {
    const client = this.requireClient();
    this.log('command', command);
    await client.gcode(command);

    // Wait for seqs.reply to advance rather than guessing at a delay.
    const before = this.seqs.reply;
    for (let i = 0; i < 40; i++) {
      const seqs = (await client.model('seqs', 'd2')) as OmSeqs;
      if (seqs.reply !== before) {
        this.seqs.reply = seqs.reply;
        const text = await client.reply();
        if (text.trim()) this.emitReply(text);
        return text;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return '';
  }

  async jog(deltas: Record<string, number>, opts: JogOptions): Promise<void> {
    const words = Object.entries(deltas)
      .filter(([, d]) => d !== 0)
      .map(([axis, d]) => `${axis.toUpperCase()}${d}`)
      .join(' ');
    if (!words) return;
    // One G1 for every axis, so a diagonal is interpolated rather than stepped.
    // G91 relative, move, then back — RRF has no continuous-jog code, so
    // hold-to-jog is built from repeated discrete moves at the UI layer.
    //
    // G1 and not G0, which is the one that looks wrong. A jog is a rapid, so
    // G0 is the instinctive choice — but in CNC and Laser mode RRF runs G0 at
    // the maximum feed rate from M203 and ignores the F word entirely, to
    // comply with the NIST standard. This machine is in CNC mode, so a G0 jog
    // would discard the speed the operator set and take every axis at its
    // limit. The speed slider has to mean something, so: G1.
    const prefix = opts.machineCoords ? 'G53 ' : '';
    await this.send(`M120\nG91\n${prefix}G1 ${words} F${opts.feedRate}\nM121`);
  }

  async moveToMachine(
    targets: Record<string, number>,
    opts: { feedRate?: number } = {},
  ): Promise<void> {
    const words = Object.entries(targets)
      .map(([axis, v]) => `${axis.toUpperCase()}${v.toFixed(3)}`)
      .join(' ');
    if (!words) return;
    // G53 G90: absolute, in machine coordinates, so the target means one place
    // on the machine regardless of the work offset or an active G68 rotation.
    // G1 rather than G0 for the same reason as jog — in CNC mode RRF runs G0 at
    // the M203 maximum and ignores F entirely, so a G0 here would take every
    // axis at its limit instead of at the speed asked for.
    const feed = opts.feedRate && opts.feedRate > 0 ? opts.feedRate : 1000;
    await this.send(`M120\nG90\nG53 G1 ${words} F${feed}\nM121`);
  }

  async home(axes?: string[]): Promise<void> {
    if (!axes || axes.length === 0) return this.send('G28');
    await this.send(`G28 ${axes.map((a) => a.toUpperCase()).join(' ')}`);
  }

  async setWorkZero(axis: string, value: number, wcs = this.state.wcs): Promise<void> {
    // G10 L20 sets the offset so the current position reads `value`.
    await this.send(`G10 L20 P${wcs} ${axis.toUpperCase()}${value}`);
  }

  async setWorkOffset(wcs: number, axis: string, machineValue: number): Promise<void> {
    // L2 writes the offset itself rather than deriving it from where the
    // machine happens to be, so it works while the machine is parked anywhere
    // — including while it is unhomed and the current position is a fiction.
    await this.send(`G10 L2 P${wcs} ${axis.toUpperCase()}${machineValue}`);
  }

  async selectWcs(index: number): Promise<void> {
    // G54..G59 are 54..59; G59.1..G59.3 continue past that.
    const code = index <= 6 ? `G${53 + index}` : `G59.${index - 6}`;
    await this.send(code);
  }

  async setRotation(angle: number, centreX: number, centreY: number): Promise<void> {
    // R, and one of A/X plus one of B/Y, are all mandatory — RRF's HandleG68
    // does MustSee on each, so omitting the centre is an error rather than a
    // rotation about the origin.
    await this.send(`G68 X${centreX} Y${centreY} R${angle}`);
  }

  async clearRotation(): Promise<void> {
    await this.send('G69');
  }

  async emergencyStop(): Promise<void> {
    this.log('warning', 'EMERGENCY STOP (M112)');
    await this.requireClient().gcode('M112');
  }

  /**
   * M999 — restart the firmware.
   *
   * Sent through the client rather than send(), which waits for a reply: the
   * board reboots instead of answering, so waiting can only ever time out.
   *
   * The board goes away for a few seconds afterwards. The poll loop already
   * treats that as a lost connection and reconnects, so nothing else is needed
   * here beyond not tearing down the session ourselves.
   */
  async reset(): Promise<void> {
    this.log('warning', 'RESTART (M999) — the controller will reboot');
    await this.requireClient().gcode('M999');
  }

  async setSpindle(rpm: number, direction: 'forward' | 'reverse'): Promise<void> {
    await this.send(`${direction === 'forward' ? 'M3' : 'M4'} S${rpm}`);
  }

  async stopSpindle(): Promise<void> {
    await this.send('M5');
  }

  // --- Live overrides ----------------------------------------------------

  async setFeedOverride(percent: number): Promise<void> {
    await this.send(`M220 S${Math.round(percent)}`);
  }

  /**
   * M290 with R0 — absolute, not cumulative.
   *
   * R1 would add to whatever babystep is already applied, so holding a nudge
   * button would run away. R0 sets it, which is what a slider means.
   */
  async babystep(axis: string, delta: number): Promise<void> {
    await this.send(`M290 R0 ${axis.toUpperCase()}${delta}`);
  }

  // --- Tools -------------------------------------------------------------

  async selectTool(tool: number | null): Promise<void> {
    await this.send(`T${tool === null ? -1 : tool}`);
  }

  /**
   * The changer's own macros, run directly rather than through a tool change.
   *
   * This is the RapidChange installation's `atcPickup.g`/`atcDrop.g`, which is
   * an RRF-shaped arrangement: the geometry lives in globals and the moves live
   * in macro files. Another controller with the same physical changer would
   * emit the moves itself, which is exactly why this is a driver method and not
   * an M98 composed in the panel.
   */
  async changeTool(slot: number, action: 'pickup' | 'drop'): Promise<void> {
    const macro = action === 'pickup' ? 'atcPickup.g' : 'atcDrop.g';
    await this.send(`M98 P"/sys/${macro}" S${slot}`);
  }

  // --- Moves -------------------------------------------------------------

  /**
   * M120/M121 bracket the move so the modal state the operator was in — G91,
   * a feed rate, a plane — survives it. Going to the origin should not change
   * what the next hand-typed command means.
   */
  async goToWorkOrigin(options: { clearanceZ?: number; includeZ?: boolean } = {}): Promise<void> {
    // G53 for the clearance move: a machine coordinate, so it means the same
    // thing whatever the work offset is.
    const lift = options.clearanceZ === undefined ? '' : `G53 G0 Z${options.clearanceZ}\n`;
    const descend = options.includeZ ? 'G0 Z0\n' : '';
    await this.send(`M120\nG90\n${lift}G0 X0 Y0\n${descend}M121`);
  }

  // --- Height map --------------------------------------------------------

  async defineProbeGrid(area: ScanArea): Promise<void> {
    await this.send(defineGridCommand(area));
  }

  async probeGrid(probe: number): Promise<void> {
    await this.send(scanCommand(probe));
  }

  async applyHeightMap(): Promise<void> {
    await this.send(applyCommand());
  }

  async clearHeightMap(): Promise<void> {
    await this.send(CLEAR_COMMAND);
  }

  describeHeightMap(area: ScanArea, probe: number | null): HeightMapCommands {
    return {
      define: defineGridCommand(area),
      // Nothing to name the probe with yet, and saying so beats printing a
      // command that would not run.
      scan: probe === null ? 'G29 K? S0' : scanCommand(probe),
      apply: applyCommand(),
      clear: CLEAR_COMMAND,
    };
  }

  // --- Files -------------------------------------------------------------

  async listFiles(dir: string): Promise<FileEntry[]> {
    const entries = await this.transfer(() => this.requireClient().filelist(dir));
    return entries
      .map((e) => ({
        name: e.name,
        path: joinPath(dir, e.name),
        directory: e.type === 'd',
        size: e.size ?? 0,
        modified: e.date ? new Date(e.date) : null,
      }))
      .sort((a, b) =>
        a.directory !== b.directory
          ? a.directory
            ? -1
            : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
  }

  readFile(
    path: string,
    onProgress?: (loaded: number, total: number | null) => void,
  ): Promise<Uint8Array> {
    return this.transfer(() => this.requireClient().download(path, onProgress));
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.transfer(() => this.requireClient().uploadFile(path, data));
  }

  deleteFile(path: string): Promise<void> {
    return this.transfer(() => this.requireClient().delete(path));
  }

  makeDirectory(path: string): Promise<void> {
    return this.transfer(() => this.requireClient().mkdir(path));
  }

  // --- Jobs --------------------------------------------------------------

  async startJob(path: string): Promise<void> {
    await this.send(`M32 "${path}"`);
  }

  async pauseJob(): Promise<void> {
    await this.send('M25');
  }

  async resumeJob(): Promise<void> {
    await this.send('M24');
  }

  async cancelJob(): Promise<void> {
    await this.send('M0');
  }

  async runMacro(path: string): Promise<void> {
    await this.send(`M98 P"${path}"`);
  }

  /**
   * Select the file, seek into it, resume.
   *
   * M26 takes a byte offset, which is the same unit the viewer tracks the
   * running job in — so the point picked off the drawing is the point the
   * machine restarts from, with no conversion to get wrong.
   */
  async startJobAt(path: string, byteOffset: number): Promise<void> {
    await this.send(`M23 "${path}"`);
    await this.send(`M26 S${byteOffset}`);
    await this.send('M24');
  }

  // --- Diagnostics -------------------------------------------------------

  /**
   * Health readout assembled from the object model this driver already polls.
   *
   * Every value here is something the board reports. Nothing is compared
   * against a threshold invented in this file — RRF's `vIn.min`/`vIn.max` are
   * the *extremes observed*, not permitted limits, so they are shown as context
   * beside the current reading rather than used to colour it. The only levels
   * set are ones the controller itself asserts: a halted machine, a triggered
   * probe, a poll that is failing.
   *
   * Anything needing real limits — driver temperature flags, stall detection,
   * stack usage — lives behind the M122 button, because the firmware's own
   * report is authoritative and decoding its bitfields here would be guesswork.
   */
  diagnostics(): DiagnosticSection[] {
    const m = this.model;
    const board = (m.boards ?? []).filter(Boolean)[0];
    const sections: DiagnosticSection[] = [];

    const range = (r: OmRange | undefined, unit: string, places = 1): DiagnosticItem['detail'] =>
      r && (r.min != null || r.max != null)
        ? `seen ${r.min?.toFixed(places) ?? '?'}–${r.max?.toFixed(places) ?? '?'}${unit}`
        : undefined;

    // --- Controller ---
    const controller: DiagnosticItem[] = [];
    if (board) {
      controller.push({ label: 'Board', value: board.name ?? board.shortName ?? 'unknown' });
      controller.push({
        label: 'Firmware',
        value: `${board.firmwareName ?? 'RepRapFirmware'} ${board.firmwareVersion ?? ''}`.trim(),
        detail: board.firmwareDate ? `built ${board.firmwareDate}` : undefined,
      });
      if (board.uniqueId) controller.push({ label: 'Unique ID', value: board.uniqueId });
    }
    controller.push({
      label: 'Status',
      value: m.state?.status ?? 'unknown',
      level: this.state.status === 'halted' ? 'bad' : 'ok',
      detail: m.state?.machineMode ? `mode ${m.state.machineMode}` : undefined,
    });
    if (m.state?.upTime != null) {
      controller.push({ label: 'Uptime', value: formatDuration(m.state.upTime) });
    }
    sections.push({
      title: 'Controller',
      items: controller,
      actions: [
        { label: 'M122', command: 'M122', title: "Full firmware diagnostics — printed to the console" },
        { label: 'M98 config.g', command: 'M98 P"config.g"', title: 'Re-run config.g and report any errors' },
      ],
    });

    // --- Power and temperature ---
    const power: DiagnosticItem[] = [];
    if (board?.vIn?.current != null) {
      power.push({ label: 'VIN', value: `${board.vIn.current.toFixed(1)} V`, detail: range(board.vIn, ' V') });
    }
    if (board?.v12?.current != null) {
      power.push({ label: '12V rail', value: `${board.v12.current.toFixed(1)} V`, detail: range(board.v12, ' V') });
    }
    if (board?.mcuTemp?.current != null) {
      power.push({
        label: 'MCU temperature',
        value: `${board.mcuTemp.current.toFixed(1)} °C`,
        detail: range(board.mcuTemp, ' °C'),
      });
    }
    if (board?.freeRam != null) {
      power.push({ label: 'Never-used RAM', value: formatBytes(board.freeRam) });
    }
    if (power.length) sections.push({ title: 'Power & temperature', items: power });

    // --- Network ---
    const interfaces = (m.network?.interfaces ?? []).filter(Boolean);
    if (interfaces.length || m.network?.hostname) {
      const net: DiagnosticItem[] = [];
      if (m.network?.hostname) net.push({ label: 'Hostname', value: m.network.hostname });
      interfaces.forEach((iface, i) => {
        const bits = [iface.actualIP, iface.speed ? `${iface.speed} Mbps` : null].filter(Boolean);
        net.push({
          label: iface.type ? `${iface.type}${interfaces.length > 1 ? ` ${i}` : ''}` : `Interface ${i}`,
          value: iface.state ?? 'unknown',
          level: iface.state === 'active' ? 'ok' : 'info',
          detail: [bits.join(' · '), iface.signal != null ? `signal ${iface.signal} dBm` : null]
            .filter(Boolean)
            .join(' · ') || undefined,
        });
      });
      sections.push({ title: 'Network', items: net });
    }

    // --- Probes ---
    // Live probe readings are the fastest way to tell a wiring fault from a
    // configuration one, and to confirm a probe triggers before trusting a
    // routine to drive the spindle into the work with it.
    const probes = (m.sensors?.probes ?? []).filter(Boolean);
    sections.push({
      title: 'Probes',
      emptyNote: 'No probes configured — see M558 in config-probe.g.',
      items: probes.map((probe, i) => ({
        label: `K${i}`,
        value: probe.triggered ? 'TRIGGERED' : 'open',
        level: probe.triggered ? 'warn' : 'ok',
        detail: [
          probe.value?.length ? `reading ${probe.value.join(', ')}` : null,
          probe.type != null ? `type ${probe.type}` : null,
          probe.threshold != null ? `threshold ${probe.threshold}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      })),
    });

    // --- Connection ---
    // Not from the board: this is how well *we* are talking to it, which is
    // the one thing the board itself can never report.
    sections.push({
      title: 'Connection',
      items: [
        { label: 'Controller', value: this.config?.url ?? '—' },
        {
          label: 'Poll',
          value: `every ${this.state.status === 'idle' || this.state.status === 'off' ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS} ms`,
        },
        {
          label: 'Failed polls',
          value: String(this.consecutiveFailures),
          level: this.consecutiveFailures > 0 ? 'warn' : 'ok',
          detail: this.consecutiveFailures > 0 ? 'consecutive; the driver backs off and retries' : undefined,
        },
      ],
    });

    return sections;
  }

  // --- Prompts -----------------------------------------------------------

  async answerPrompt(seq: number, accept: boolean, value?: string | number): Promise<void> {
    // M292 acknowledges a blocking M291. P0 = OK/accept, P1 = cancel.
    // S<seq> identifies which box is being answered so a stale click can't
    // dismiss a newer prompt; R supplies the value for input modes (S4-S7).
    //
    // NOTE: the S and R parameters are 3.5+ additions. If your firmware is
    // older, drop them — a bare `M292 P0` is the long-standing form.
    let cmd = `M292 P${accept ? 0 : 1} S${seq}`;
    if (accept && value !== undefined) {
      cmd += typeof value === 'number' ? ` R${value}` : ` R"${String(value).replace(/"/g, '""')}"`;
    }
    await this.send(cmd);
  }
}
