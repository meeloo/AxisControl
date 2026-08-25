// The host half of the wire: one frame, and every call it is allowed to make.

import { BUILD } from '../core/build.js';
import { effect } from '../core/signal.js';
import { actions, activeDriver, appendLog, capabilities, connected, machine } from '../core/store.js';
import { frameHtml, themeTokens } from './guest.js';
import {
  CALL_TIMEOUT_MS,
  DYNAMIC_PERMISSION,
  METHOD_PERMISSIONS,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
} from './protocol.js';
import { openDomain, ownerOf, subscribeDomain } from './storage.js';
import {
  API_VERSION,
  PermissionDenied,
  PluginError,
  type PermissionName,
  type PluginRecord,
} from './types.js';

export interface PluginLogLine {
  pluginId: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  time: Date;
}

export interface FrameOptions {
  /** Where the panel frame goes. Omitted for a service frame, which is hidden. */
  container?: HTMLElement;
  onLog: (line: PluginLogLine) => void;
  /** Called when the plugin dies or stops answering. */
  onFault: (why: string) => void;
  /**
   * `axis.ui.title(text)`, already validated. Optional because a service frame
   * has no title to set; a panel host that leaves it out gets a plugin whose
   * title call succeeds and changes nothing, which is the one outcome
   * docs/plugins.md asks this system never to produce — so pass it.
   */
  onTitle?: (title: string) => void;
  /**
   * `axis.ui.resize(px)`: how tall the plugin says it wants to be.
   *
   * Optional, and when it is absent the frame sizes itself. That default is
   * right for a frame in a container that grows, and wrong inside the dock,
   * where the panel's height belongs to the layout — so the dock passes this
   * and decides for itself whether to honour the number.
   */
  onResize?: (height: number) => void;
}

export interface PluginFrame {
  readonly pluginId: string;
  readonly element: HTMLIFrameElement;
  /** Resolves when the guest has said hello. */
  readonly ready: Promise<void>;
  /** Push an event to the plugin — machine state, a storage change, a theme. */
  emit(channel: string, payload: unknown): void;
  /** False once it has missed pings. See docs/plugins.md on what this cannot fix. */
  readonly responsive: boolean;
  destroy(): void;
}

/**
 * Pings that may go unanswered before a frame is called unresponsive.
 *
 * Two rather than one because the interval is a timer, and a timer in a
 * background tab, on a laptop coming out of sleep, or behind a long paint can
 * fire late enough that a perfectly healthy frame looks silent for one round.
 * Calling a working plugin dead is how an operator learns to ignore the
 * warning, and the warning is the only notice they get of the one failure this
 * boundary cannot prevent — a frame that never yields freezes the window.
 */
const MISSED_PONGS = 2;

/**
 * How many controller-bound calls one plugin may make per window.
 *
 * The failure is not malice, it is a `for` loop: a plugin that sends a G-code
 * per animation frame turns into hundreds of HTTP requests a second aimed at
 * the controller that is supposed to be cutting. Twenty in five seconds is
 * more than any hand-driven panel in this app produces and far less than a
 * loop, and the bucket refills continuously, so a plugin that pauses gets its
 * allowance back a token at a time rather than in a lump every five seconds.
 */
export const RATE_LIMIT_CALLS = 20;
export const RATE_LIMIT_WINDOW_MS = 5_000;

/** Longest `ui.notify` text kept, in characters. */
const NOTIFY_CAP = 500;

/** Longest line kept from a frame's own `console` and `axis.log`. */
const LOG_TEXT_CAP = 8_000;

// --- The frame ------------------------------------------------------------

/**
 * Start a plugin in a frame of its own.
 *
 * The security of the whole system is two attribute values on the element
 * below, so they are set before the element is connected and never changed
 * afterwards. Everything else here — ids, timeouts, pings — exists so that a
 * plugin cannot leave the host waiting: every request is answered, including
 * the ones that are refused, and including the ones cut short by `destroy`.
 *
 * `destroy` cannot honour `axis.ui.onUnmount`: the frame is removed
 * synchronously and a posted message is delivered on a later task, so a caller
 * that wants unmount hooks to run must `emit('lifecycle', { phase: 'unmount' })`
 * and yield to the event loop before calling it.
 */
export function createFrame(
  record: PluginRecord,
  granted: PermissionName[],
  options: FrameOptions,
): PluginFrame {
  const pluginId = record.manifest.id;
  const frame = document.createElement('iframe');

  // Set before the element is connected and before srcdoc: the sandbox
  // attribute is read when the frame navigates, so an iframe that is inserted
  // first and sandboxed second can load one document with this app's origin.
  //
  // `allow-scripts` and nothing beside it. In particular never
  // `allow-same-origin`: with both, the browser gives the frame this app's
  // origin back and the sandbox is over — parent.document, localStorage, the
  // service worker and same-origin fetch to the controller all return. Every
  // permission check below assumes the browser is denying those, and none of
  // them would be worth writing if this attribute said anything else.
  frame.setAttribute('sandbox', 'allow-scripts');
  // No Referer on anything the frame manages to send. A sandboxed frame can
  // still navigate itself (see the CSP note in guest.ts), and the app's own
  // URL — which on this deployment is the machine's address — should not ride
  // along on the way out.
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', record.manifest.panel?.title || record.manifest.name || pluginId);

  const service = !options.container;
  frame.style.cssText = service
    ? 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
    : 'display:block;width:100%;height:100%;border:0;background:transparent';

  frame.srcdoc = frameHtml(record.manifest, granted, record.code, record.css, themeTokens());
  (options.container ?? serviceHolder()).appendChild(frame);

  let destroyed = false;
  let responsive = true;
  /** The guest has said hello. Separate from `readySettled`, which is the
      promise's state and can be settled by a timeout the guest knows nothing
      about — pinging a frame that never booted would report it dead twice. */
  let booted = false;
  let readySettled = false;
  let awaitingPongs = 0;
  let pingId = 0;

  /** Guest request id → the call the host is still working on. */
  const inFlight = new Map<number, { method: string; timer: ReturnType<typeof setTimeout> }>();
  /** Channel → how to stop feeding it. */
  const channels = new Map<string, () => void>();

  let markReady: () => void = () => {};
  let failReady: (why: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // Nobody has to await `ready` — a panel frame is normally started and left to
  // render — so a frame that never boots would otherwise surface as an
  // "unhandled promise rejection" in the browser console instead of as the
  // fault the Plugins panel is there to show.
  ready.catch(() => {});

  function log(level: PluginLogLine['level'], text: string): void {
    options.onLog({ pluginId, level, text, time: new Date() });
  }

  /** True when the message was handed to the frame. */
  function post(message: unknown): boolean {
    if (destroyed) return false;
    const win = frame.contentWindow;
    if (!win) return false;
    try {
      win.postMessage(message, '*');
      return true;
    } catch {
      // Either the frame is gone or the payload will not structured-clone.
      // Both are the caller's problem to report, because only the caller knows
      // whether something is waiting for it.
      return false;
    }
  }

  function emit(channel: string, payload: unknown): void {
    // Sanitised here rather than at each call site: `emit` is the one place a
    // host object crosses into the frame, and a payload that will not clone
    // throws inside postMessage, which loses the event with nothing said.
    if (!post({ v: PROTOCOL_VERSION, t: 'event', channel, payload: cloneable(payload) })) {
      if (!destroyed) log('warn', `the "${channel}" event could not be delivered to this frame`);
    }
  }

  function fault(why: string): void {
    if (destroyed) return;
    responsive = false;
    options.onFault(why);
  }

  function answer(id: number, ok: boolean, value: unknown, error?: string): void {
    const call = inFlight.get(id);
    if (!call) return; // Timed out, or the frame was destroyed under it.
    clearTimeout(call.timer);
    inFlight.delete(id);
    if (!ok) {
      // Loud by default. A plugin that silently does nothing is the worst
      // thing this system can produce, and a refusal the operator never sees
      // looks exactly like a plugin that is merely broken.
      log('error', error ?? 'the call failed');
      post({ v: PROTOCOL_VERSION, t: 'res', id, ok: false, error: error ?? 'the call failed' });
      return;
    }
    if (post({ v: PROTOCOL_VERSION, t: 'res', id, ok: true, value })) return;
    // The answer exists and cannot be carried — `dispatch` reduces what it
    // returns to plain data, so this is the case it did not foresee. Say so,
    // rather than letting the guest's promise wait for a message that was
    // never sent.
    post({
      v: PROTOCOL_VERSION,
      t: 'res',
      id,
      ok: false,
      error: `${call.method} answered with something that cannot cross the bridge`,
    });
  }

  function onRequest(id: number, method: string, args: unknown[]): void {
    if (inFlight.has(id)) return; // A repeated id would settle the wrong call.
    const timer = setTimeout(() => {
      const call = inFlight.get(id);
      if (!call) return;
      inFlight.delete(id);
      const why = `${method} did not answer within ${CALL_TIMEOUT_MS}ms`;
      log('error', why);
      post({ v: PROTOCOL_VERSION, t: 'res', id, ok: false, error: why });
    }, CALL_TIMEOUT_MS);
    inFlight.set(id, { method, timer });

    void dispatch(record, granted, method, args).then(
      (value) => {
        // Two methods are about the frame rather than the app, so `dispatch`
        // validates the argument and this applies it. Keeping the validation
        // over there means one door, including for a caller that is not a
        // frame at all.
        if (method === 'ui.title' && typeof value === 'string') applyTitle(value);
        if (method === 'ui.resize' && typeof value === 'number') applyHeight(value);
        answer(id, true, value);
      },
      (err: unknown) => answer(id, false, undefined, messageOf(err)),
    );
  }

  function applyTitle(title: string): void {
    frame.setAttribute('title', title);
    options.onTitle?.(title);
  }

  function applyHeight(px: number): void {
    if (options.onResize) {
      options.onResize(px);
      return;
    }
    // No host opinion, so the frame takes the plugin at its word. Right for a
    // frame in a container that grows with it; the dock passes onResize
    // instead, because there the height is the layout's to decide.
    frame.style.height = `${px}px`;
  }

  /**
   * Start feeding a channel the guest asked for.
   *
   * The guest opens its channel *before* the matching request is answered, so
   * that a change occurring between the two is not lost — which means the
   * channel cannot inherit that request's permission check. A frame that sent
   * only this message and never the request would otherwise be handed a live
   * feed of the machine for free, so the same list is consulted here.
   */
  function openChannel(channel: string): void {
    if (channels.has(channel)) return;
    if (channel === 'machine.state') {
      if (!granted.includes('machine.read')) {
        log('error', new PermissionDenied('machine.read', 'machine.subscribe').message);
        return;
      }
      // Runs once immediately, so a plugin that subscribes gets the current
      // state without also having to call machine.state.
      channels.set(
        channel,
        effect(() => {
          emit(channel, machine.get());
        }),
      );
      return;
    }
    if (channel.startsWith('storage:')) {
      const domain = channel.slice('storage:'.length);
      try {
        checkDomainAccess(record, granted, 'storage.subscribe', domain, 'read');
      } catch (err) {
        log('error', messageOf(err));
        return;
      }
      channels.set(
        channel,
        subscribeDomain(domain, (key, value) => emit(channel, { key, value })),
      );
      return;
    }
    // `theme` and `lifecycle` are host-driven: the host emits them when it has
    // something to say, so there is nothing to wire up and nothing to refuse.
  }

  function closeChannel(channel: string): void {
    const dispose = channels.get(channel);
    if (!dispose) return;
    channels.delete(channel);
    dispose();
  }

  const onMessage = (event: MessageEvent): void => {
    // Identity, not origin. This frame has no allow-same-origin, so its origin
    // is the string "null" — and so is the origin of every other plugin frame
    // on the page and of anything else with an opaque origin. An origin check
    // would therefore accept all of them as this one. The window object is the
    // only thing that is unforgeably this frame.
    if (destroyed || !event.source || event.source !== frame.contentWindow) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== 'object' || message['v'] !== PROTOCOL_VERSION) return;

    switch (message['t']) {
      case 'ready': {
        if (booted) return;
        booted = true;
        clearTimeout(bootTimer);
        // A frame that boots after the timeout still gets its init and its
        // pings: it was late, not dead, and the fault clears itself as soon as
        // it answers one.
        if (!readySettled) {
          readySettled = true;
          markReady();
        }
        post({
          v: PROTOCOL_VERSION,
          t: 'init',
          manifest: cloneable(record.manifest),
          granted: [...granted],
          theme: themeTokens(),
        });
        return;
      }
      case 'req': {
        const id = message['id'];
        const method = message['method'];
        if (typeof id !== 'number' || typeof method !== 'string') return;
        const args = message['args'];
        onRequest(id, method, Array.isArray(args) ? args : []);
        return;
      }
      case 'log': {
        const level = message['level'];
        if (level !== 'info' && level !== 'warn' && level !== 'error') return;
        // The guest runtime caps its own lines, but the guest runtime is a
        // string of code the plugin's document is free to have replaced. What
        // arrives here is whatever the frame chose to send, and a log pane
        // holding one line of a megabyte is a log pane nobody can scroll.
        log(level, clip(String(message['text'] ?? ''), LOG_TEXT_CAP));
        return;
      }
      case 'pong': {
        awaitingPongs = 0;
        if (!responsive) {
          responsive = true;
          log('info', 'the plugin is answering again');
        }
        return;
      }
      case 'subscribe': {
        const channel = message['channel'];
        if (typeof channel === 'string') openChannel(channel);
        return;
      }
      case 'unsubscribe': {
        const channel = message['channel'];
        if (typeof channel === 'string') closeChannel(channel);
        return;
      }
      default:
        return;
    }
  };
  window.addEventListener('message', onMessage);

  // A frame that never says hello is a plugin whose source threw before the
  // runtime could boot, or a document the browser refused to build. Either way
  // nobody is coming, and the promise has to stop being pending.
  const bootTimer = setTimeout(() => {
    if (readySettled || destroyed) return;
    readySettled = true;
    const why = `${pluginId} did not start within ${CALL_TIMEOUT_MS}ms`;
    failReady(new PluginError(why));
    fault(why);
  }, CALL_TIMEOUT_MS);

  const pinger = setInterval(() => {
    if (destroyed || !booted) return;
    if (awaitingPongs >= MISSED_PONGS) {
      if (responsive) {
        fault(
          `${pluginId} has stopped answering. It may be in a loop; a frame that never yields ` +
            'can freeze this window, and disabling it is the only cure.',
        );
      }
      // Keep pinging: the mark is allowed to come back off by itself, which is
      // what makes a plugin that was merely slow recoverable without a reload.
    }
    awaitingPongs++;
    post({ v: PROTOCOL_VERSION, t: 'ping', id: ++pingId });
  }, PING_INTERVAL_MS);

  function destroy(): void {
    if (destroyed) return;
    clearInterval(pinger);
    clearTimeout(bootTimer);
    window.removeEventListener('message', onMessage);
    for (const dispose of channels.values()) dispose();
    channels.clear();

    // Every call still in flight has a promise waiting on it inside the frame,
    // and the frame is about to be removed. Answering them before it goes
    // costs one message each and means a plugin that is destroyed mid-call
    // sees a rejection it can log, rather than an await that never returns.
    for (const [id, call] of inFlight) {
      clearTimeout(call.timer);
      post({
        v: PROTOCOL_VERSION,
        t: 'res',
        id,
        ok: false,
        error: `${call.method} was cut short: the plugin was stopped`,
      });
    }
    inFlight.clear();

    // The host side has one promise of its own, and whoever awaited it is
    // still there after the frame has gone.
    if (!readySettled) {
      readySettled = true;
      failReady(new PluginError(`${pluginId} was stopped before it started`));
    }

    destroyed = true;
    frame.remove();
  }

  return {
    pluginId,
    element: frame,
    ready,
    emit,
    get responsive() {
      return responsive;
    },
    destroy,
  };
}

/**
 * Where service frames live: off-screen, not `display:none`.
 *
 * A frame in a `display:none` subtree has no layout, and browsers are within
 * their rights to throttle it to a standstill — which is precisely the frame
 * that must keep running, since `background` was granted so that a plugin
 * could work with no panel open. One pixel off the left edge costs nothing and
 * keeps it an ordinary rendered document.
 */
let holder: HTMLElement | null = null;
function serviceHolder(): HTMLElement {
  if (holder && holder.isConnected) return holder;
  const div = document.createElement('div');
  div.id = 'axis-plugin-services';
  div.setAttribute('aria-hidden', 'true');
  div.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden';
  (document.body ?? document.documentElement).appendChild(div);
  holder = div;
  return div;
}

// --- The door -------------------------------------------------------------

/**
 * Run one call on the plugin's behalf.
 *
 * The only place a plugin's request becomes an action. Refuses an unknown
 * method rather than passing it on, resolves the dynamic permissions
 * (`storage.<domain>`, `network.<origin>`) from the arguments, and routes
 * machine work through `core/store.ts`'s `actions` rather than the driver — so
 * the guard is in one place instead of one per controller dialect.
 *
 * Every `machine.command` and `machine.motion` call is logged to the app's own
 * console log: a plugin's G-code should be as visible as a typed one.
 *
 * Async so that every refusal is a rejection. A throw and a rejection are the
 * same thing to the caller here, but only one of them stays that way if this
 * ever grows a synchronous branch, and a refusal that escapes as a throw is a
 * refusal the frame answers with nothing.
 */
export async function dispatch(
  record: PluginRecord,
  granted: PermissionName[],
  method: string,
  args: unknown[],
): Promise<unknown> {
  // hasOwnProperty rather than `in`: `in` walks the prototype chain, so
  // "toString", "constructor" and "__proto__" would all pass this gate and
  // arrive at the switch below as methods this table never listed. The table
  // is meant to be the whole truth about what a plugin can reach.
  if (!Object.prototype.hasOwnProperty.call(METHOD_PERMISSIONS, method)) {
    throw new PluginError(
      `refused: "${method}" is not something this app serves. Only the methods listed in the ` +
        'plugin API exist; anything else is refused rather than passed through.',
    );
  }

  const required = METHOD_PERMISSIONS[method];
  // A dynamic permission cannot be decided from the name — it is
  // `storage.<domain>` or `network.<origin>`, and the domain and the origin
  // are arguments — so those methods check themselves, below, where the
  // arguments have been read.
  if (required !== null && !DYNAMIC_PERMISSION.has(method) && !granted.includes(required)) {
    throw new PermissionDenied(required, method);
  }

  switch (method) {
    // --- itself ----------------------------------------------------------
    case 'version':
      return { api: API_VERSION, app: BUILD.version };

    case 'ui.title':
      // Validated here and applied by the frame: this is the one door, and a
      // caller that is not a frame still gets the argument checked.
      return requireString(args[0], 'ui.title needs a title').slice(0, 120);

    case 'ui.resize': {
      const px = requireFinite(args[0], 'ui.resize needs a height in pixels');
      // A negative or absurd height is a layout this app cannot render, and
      // clamping it is kinder than refusing: the plugin asked to be a size,
      // and the answer is the nearest size that exists.
      return Math.max(0, Math.min(20_000, Math.round(px)));
    }

    case 'ui.notify': {
      const text = requireString(args[0], 'ui.notify needs a message');
      const level = args[1] === 'warn' ? 'warning' : args[1] === 'error' ? 'error' : 'info';
      // Capped, because this lands in the same console the operator reads the
      // machine's replies in, and a plugin notifying with a whole file would
      // push that history out of the 500 lines the log keeps.
      appendLog({
        level,
        text: `${record.manifest.id}: ${clip(text, NOTIFY_CAP)}`,
        time: new Date(),
      });
      return undefined;
    }

    // --- the machine, read ------------------------------------------------
    case 'machine.state':
      // Reduced to plain data here rather than at the frame, so that what a
      // plugin gets is what any caller gets. `extras` is whatever the driver
      // chose to surface — RRF's object model arrives as class instances — and
      // a value that will not structured-clone does not fail the call, it
      // leaves the plugin's promise pending for good.
      return cloneable(machine.peek());

    case 'machine.capabilities':
      return cloneable(capabilities.peek());

    case 'machine.subscribe':
      // Nothing to do but agree: the permission was checked above and the
      // events are fed by `createFrame`, which is the half that has a frame to
      // send them to. The request exists so that a refusal reaches the plugin
      // as a rejection rather than as silence on a channel.
      return undefined;

    // --- the machine, motion ---------------------------------------------
    case 'machine.jog': {
      const deltas = requireAxisMap(args[0], 'machine.jog needs an object of axis distances');
      const feed = requireFinite(args[1], 'machine.jog needs a feed rate in mm/min');
      if (feed <= 0) throw new PluginError('machine.jog needs a feed rate greater than zero');
      await beforeMachineCall(record, method, describeCall(method, args));
      await actions.jog(deltas, feed);
      return undefined;
    }

    case 'machine.moveTo': {
      const targets = requireAxisMap(args[0], 'machine.moveTo needs an object of axis positions');
      const feed = args[1] === undefined || args[1] === null ? undefined : requireFinite(args[1], 'machine.moveTo needs a feed rate in mm/min');
      await beforeMachineCall(record, method, describeCall(method, args));
      await actions.moveToMachine(targets, feed);
      return undefined;
    }

    case 'machine.home': {
      const axes = requireAxisList(args[0]);
      await beforeMachineCall(record, method, describeCall(method, args));
      await actions.home(axes);
      return undefined;
    }

    case 'machine.goToWorkOrigin': {
      const raw = (args[0] ?? {}) as Record<string, unknown>;
      const options: { clearanceZ?: number; includeZ?: boolean } = {};
      if (typeof raw['clearanceZ'] === 'number' && Number.isFinite(raw['clearanceZ'])) {
        options.clearanceZ = raw['clearanceZ'];
      }
      if (typeof raw['includeZ'] === 'boolean') options.includeZ = raw['includeZ'];
      await beforeMachineCall(record, method, describeCall(method, args));
      await actions.goToWorkOrigin(options);
      return undefined;
    }

    // --- the machine, commands -------------------------------------------
    case 'machine.send': {
      const gcode = requireString(args[0], 'machine.send needs a command').trim();
      if (!gcode) throw new PluginError('machine.send needs a command, not an empty string');
      // One command per call. A multi-line string would be one audit line
      // standing for several commands, one rate-limit token spent on all of
      // them, and a console that shows the first line of what was run.
      if (/[\r\n]/.test(gcode)) {
        throw new PluginError(
          'machine.send takes one command per call. Send them one at a time, so that each one ' +
            'appears in the console and counts against the rate limit on its own.',
        );
      }
      await beforeMachineCall(record, method, describeCall(method, [gcode]));
      await actions.send(gcode);
      return undefined;
    }

    case 'machine.runMacro': {
      const path = checkPath(method, args[0], false);
      await beforeMachineCall(record, method, describeCall(method, [path]));
      await actions.runMacro(path);
      return undefined;
    }

    case 'machine.setSpindle': {
      const rpm = requireFinite(args[0], 'machine.setSpindle needs an RPM');
      if (rpm < 0) throw new PluginError('machine.setSpindle needs an RPM of zero or more');
      const direction = args[1] === 'reverse' ? 'reverse' : 'forward';
      await beforeMachineCall(record, method, describeCall(method, [rpm, direction]));
      await actions.setSpindle(rpm, direction);
      return undefined;
    }

    case 'machine.stopSpindle':
      await beforeMachineCall(record, method, describeCall(method, args));
      await actions.stopSpindle();
      return undefined;

    case 'machine.setWorkZero': {
      const axis = requireString(args[0], 'machine.setWorkZero needs an axis letter');
      const value = args[1] === undefined ? 0 : requireFinite(args[1], 'machine.setWorkZero needs a number');
      const wcs = args[2] === undefined || args[2] === null ? undefined : requireFinite(args[2], 'machine.setWorkZero needs a WCS index');
      await beforeMachineCall(record, method, describeCall(method, [axis, value, wcs]));
      await actions.setWorkZero(axis, value, wcs);
      return undefined;
    }

    case 'machine.selectWcs': {
      const index = requireFinite(args[0], 'machine.selectWcs needs a WCS index, 1 = G54');
      if (!Number.isInteger(index) || index < 1) {
        throw new PluginError('machine.selectWcs needs a whole number of 1 or more, where 1 is G54');
      }
      await beforeMachineCall(record, method, describeCall(method, [index]));
      await actions.selectWcs(index);
      return undefined;
    }

    // --- the card ---------------------------------------------------------
    case 'files.list': {
      const dir = checkPath(method, args[0], false);
      // FileEntry carries a Date, which clones; the driver is free to answer
      // with more than the type promises, which may not.
      return cloneable(await requireDriver(method).listFiles(dir));
    }

    case 'files.read': {
      const path = checkPath(method, args[0], false);
      return requireDriver(method).readFile(path);
    }

    case 'files.write': {
      const path = checkPath(method, args[0], true);
      const bytes = requireBytes(args[1]);
      await requireDriver(method).writeFile(path, bytes);
      return undefined;
    }

    case 'files.delete': {
      const path = checkPath(method, args[0], true);
      await requireDriver(method).deleteFile(path);
      return undefined;
    }

    // --- shared data ------------------------------------------------------
    case 'storage.get': {
      const domain = requireDomain(args[0]);
      checkDomainAccess(record, granted, method, domain, 'read');
      return openDomain(domain).get(requireString(args[1], 'storage.get needs a key'));
    }

    case 'storage.set': {
      const domain = requireDomain(args[0]);
      checkDomainAccess(record, granted, method, domain, 'write');
      await openDomain(domain).set(requireString(args[1], 'storage.set needs a key'), args[2]);
      return undefined;
    }

    case 'storage.delete': {
      const domain = requireDomain(args[0]);
      checkDomainAccess(record, granted, method, domain, 'write');
      await openDomain(domain).delete(requireString(args[1], 'storage.delete needs a key'));
      return undefined;
    }

    case 'storage.keys': {
      const domain = requireDomain(args[0]);
      checkDomainAccess(record, granted, method, domain, 'read');
      return openDomain(domain).keys();
    }

    case 'storage.subscribe': {
      const domain = requireDomain(args[0]);
      checkDomainAccess(record, granted, method, domain, 'read');
      // Fed by `createFrame`, for the same reason as machine.subscribe.
      return undefined;
    }

    // --- the network ------------------------------------------------------
    case 'net.fetch':
      return netFetch(granted, args[0], args[1]);

    default:
      // Reachable only if METHOD_PERMISSIONS grows a method and this switch
      // does not. Refusing is the right half to fail on: a method that is
      // listed but unimplemented must not become a method that silently
      // succeeds.
      throw new PluginError(`refused: "${method}" is listed in the plugin API but not implemented`);
  }
}

// --- Permission resolution ------------------------------------------------

/**
 * Whether this plugin may touch a storage domain, and how.
 *
 * A plugin's own domain is free. It declared it in `provides`, install refuses
 * a second claimant, and a dialog asking an operator to let a plugin read its
 * own data would teach them that this dialog is noise.
 *
 * Ownership comes from the registry rather than from the manifest, because the
 * registry is where a conflict has already been settled — a plugin that lost
 * one must not go on treating the domain as its own. The manifest is consulted
 * only for a domain nobody has registered at all, which is a domain nobody can
 * be in conflict over.
 */
function checkDomainAccess(
  record: PluginRecord,
  granted: PermissionName[],
  method: string,
  domain: string,
  need: 'read' | 'write',
): void {
  const owner = ownerOf(domain);
  if (owner === record.manifest.id) return;
  if (owner === null && (record.manifest.provides ?? []).some((p) => p.domain === domain)) return;

  const permission: PermissionName = `storage.${domain}`;
  if (!granted.includes(permission)) throw new PermissionDenied(permission, method);

  if (need === 'write') {
    // The grant is one permission per domain, but `uses` says read or write,
    // and the narrower of the two is what the plugin asked for. Honouring only
    // the grant would let a plugin that declared `read` rewrite a tool table
    // it was only ever meant to consult.
    const use = (record.manifest.uses ?? []).find((u) => u.domain === domain);
    if (!use || use.access !== 'write') {
      throw new PluginError(
        `denied: ${method} would change "${domain}", which ${record.manifest.id} asked to read. ` +
          'A plugin that needs to write to a domain it does not own has to declare `"access": ' +
          '"write"` in its manifest, and be granted it.',
      );
    }
  }
}

/**
 * The origin a `net.fetch` is aimed at, checked against the grants.
 *
 * Exactly one origin per permission, matched exactly: `network.https://a.example`
 * is not a grant to `https://b.a.example`, and it is not a grant to
 * `http://a.example` either. A subdomain is somebody else's server as often as
 * it is the same one, and a scheme is the difference between a request nobody
 * can read and one anybody on the workshop LAN can.
 */
async function netFetch(granted: PermissionName[], rawUrl: unknown, rawInit: unknown): Promise<unknown> {
  const url = requireString(rawUrl, 'axis.fetch needs a URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginError(
      `axis.fetch needs an absolute URL with a scheme and a host; "${clip(url, 120)}" is not one.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PluginError(`axis.fetch will not open ${parsed.protocol} URLs, only http and https`);
  }

  const permission: PermissionName = `network.${parsed.origin}`;
  const allowed = granted.some(
    (p) => typeof p === 'string' && p.startsWith('network.') && sameOrigin(p.slice('network.'.length), parsed.origin),
  );
  if (!allowed) throw new PermissionDenied(permission, 'net.fetch');

  const init: RequestInit = {
    // No cookies, ever, in either direction. The plugin was granted an origin,
    // not the operator's session with it: a fetch that carried credentials
    // would let a plugin act as whoever is signed in, which is a permission
    // nobody was asked about.
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  };
  const raw = (rawInit ?? {}) as Record<string, unknown>;
  if (typeof raw['method'] === 'string') init.method = raw['method'];
  if (raw['headers'] && typeof raw['headers'] === 'object') {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw['headers'] as Record<string, unknown>)) {
      headers[name] = String(value);
    }
    init.headers = headers;
  }
  if (typeof raw['body'] === 'string' || raw['body'] instanceof ArrayBuffer || ArrayBuffer.isView(raw['body'])) {
    init.body = raw['body'] as BodyInit;
  }

  let response: Response;
  try {
    response = await fetch(parsed.href, init);
  } catch (err) {
    // A failed cross-origin fetch says almost nothing by design, so name the
    // two answers that are not in the message: it is refused by CORS, or the
    // host is not there.
    throw new PluginError(
      `axis.fetch to ${parsed.origin} failed: ${messageOf(err)}. A cross-origin request needs ` +
        'the server to allow this app in its CORS headers.',
    );
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  // Plain data, because a Response is not structured-cloneable; guest.ts puts
  // the familiar shape back together on the other side.
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

function sameOrigin(granted: string, origin: string): boolean {
  try {
    return new URL(granted).origin === origin;
  } catch {
    return granted.toLowerCase().replace(/\/+$/, '') === origin;
  }
}

// --- Paths ----------------------------------------------------------------

/**
 * Directories a plugin may read and must never write.
 *
 * Both are places where the writer is somebody else and the reader is not a
 * person: nothing warns you that the file changed, and what breaks breaks at
 * the next boot or the next update rather than at the write.
 */
const WRITE_PROTECTED: ReadonlyArray<{ prefix: string; why: string }> = [
  {
    prefix: '/www',
    why:
      "that is where this app and DWC are installed. The Install panel rewrites that directory " +
      'on every update, so a plugin writing there is either overwriting the page it is running ' +
      'in or leaving files that the next update deletes.',
  },
  {
    prefix: '/sys',
    why:
      "that is the machine's configuration, which the firmware reads at boot. A plugin " +
      'rewriting config.g can leave a machine that will not start, with nothing on screen to ' +
      'say why — so it is not a feature this API offers, however well meant.',
  },
];

/**
 * A path a plugin named, or a refusal saying which rule it broke.
 *
 * The comparison is case-insensitive because the card is FAT: `/WWW/index.html`
 * and `/www/index.html` are one file to the controller, and a check that only
 * knew about the lower-case spelling would be a check with a spelling of its
 * own that got round it.
 */
function checkPath(method: string, raw: unknown, write: boolean): string {
  const path = requireString(raw, `${method} needs a path`);
  if (!path.startsWith('/')) {
    throw new PluginError(
      `denied: ${method} needs a path from the root of the card, starting with "/". ` +
        `"${clip(path, 120)}" is relative, and there is no working directory here for it to be ` +
        'relative to.',
    );
  }
  if (path.split('/').includes('..')) {
    throw new PluginError(
      `denied: "${clip(path, 120)}" contains "..", which walks up out of the directory it names. ` +
        'A path that can climb makes every check below it meaningless, so it is refused rather ' +
        'than resolved.',
    );
  }
  // Control characters are refused rather than stripped: a newline is a second
  // line in whatever request the driver builds out of this path, and a NUL ends
  // the name early on the controller's side while still looking whole in the log.
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new PluginError(`denied: ${method} was given a path containing a control character`);
  }
  if (write) {
    const lower = path.toLowerCase();
    for (const { prefix, why } of WRITE_PROTECTED) {
      if (lower === prefix || lower.startsWith(`${prefix}/`)) {
        throw new PluginError(`denied: ${method} may not write under ${prefix} — ${why}`);
      }
    }
  }
  return path;
}

// --- Rate limiting --------------------------------------------------------

interface Bucket {
  tokens: number;
  at: number;
  /** When the operator was last told this plugin is over the limit. */
  warned: number;
}

const buckets = new Map<string, Bucket>();

/**
 * One token for a call that reaches the controller, or false.
 *
 * A token bucket rather than a counter per fixed window: a window resets in a
 * lump, so a plugin can spend the whole allowance in the last millisecond of
 * one window and the whole of the next in the first — forty requests back to
 * back, which is the burst this exists to prevent.
 */
function takeToken(pluginId: string, now: number): boolean {
  const bucket = buckets.get(pluginId) ?? { tokens: RATE_LIMIT_CALLS, at: now, warned: 0 };
  buckets.set(pluginId, bucket);
  const refill = ((now - bucket.at) * RATE_LIMIT_CALLS) / RATE_LIMIT_WINDOW_MS;
  bucket.tokens = Math.min(RATE_LIMIT_CALLS, bucket.tokens + Math.max(0, refill));
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Everything that happens before a plugin moves the machine.
 *
 * The audit line goes in first, so the console shows what was attempted even
 * when the controller then refuses it, and the rate limit is checked before
 * the line is written so that a plugin in a loop cannot flush the operator's
 * own history out of the 500 lines the log keeps. The refusal is announced
 * once per window for the same reason.
 */
async function beforeMachineCall(record: PluginRecord, method: string, what: string): Promise<void> {
  const pluginId = record.manifest.id;
  const now = Date.now();
  if (!takeToken(pluginId, now)) {
    const bucket = buckets.get(pluginId);
    if (bucket && now - bucket.warned > RATE_LIMIT_WINDOW_MS) {
      bucket.warned = now;
      appendLog({
        level: 'warning',
        text: `${pluginId} is sending too fast and is being held back (limit ${RATE_LIMIT_CALLS} commands per ${RATE_LIMIT_WINDOW_MS / 1000}s)`,
        time: new Date(),
      });
    }
    throw new PluginError(
      `denied: ${method} is over the rate limit of ${RATE_LIMIT_CALLS} machine commands per ` +
        `${RATE_LIMIT_WINDOW_MS / 1000} seconds for ${pluginId}. Wait, then try again — a plugin ` +
        'looping on the controller starves the machine that is supposed to be cutting.',
    );
  }

  appendLog({ level: 'command', text: `${pluginId}: ${what}`, time: new Date() });

  // `actions` answers a call made while disconnected by logging and returning
  // undefined, which a plugin cannot tell from success. It is the commonest
  // failure there is, so it becomes a rejection with a sentence in it.
  if (!connected.peek()) {
    throw new PluginError(`${method} failed: not connected to a machine`);
  }
}

/** What the console log says a plugin did. One line, in the app's own words. */
function describeCall(method: string, args: unknown[]): string {
  const name = method.startsWith('machine.') ? method.slice('machine.'.length) : method;
  switch (method) {
    case 'machine.send':
      return `send ${String(args[0])}`;
    case 'machine.runMacro':
      return `run ${String(args[0])}`;
    case 'machine.jog':
      return `jog ${axisText(args[0])} at ${String(args[1])} mm/min`;
    case 'machine.moveTo':
      return `move to ${axisText(args[0])}`;
    case 'machine.home': {
      const axes = requireAxisList(args[0]);
      return axes && axes.length > 0 ? `home ${axes.join(' ')}` : 'home';
    }
    case 'machine.goToWorkOrigin':
      return 'go to work origin';
    case 'machine.setSpindle':
      return `spindle ${String(args[0])} rpm ${String(args[1])}`;
    case 'machine.stopSpindle':
      return 'stop spindle';
    case 'machine.setWorkZero':
      return `set work ${String(args[0])} to ${String(args[1])}`;
    case 'machine.selectWcs':
      return `select G${53 + Number(args[0])}`;
    default:
      return name;
  }
}

function axisText(value: unknown): string {
  const map = value as Record<string, number>;
  return Object.entries(map ?? {})
    .map(([axis, delta]) => `${axis}${delta}`)
    .join(' ');
}

// --- Arguments ------------------------------------------------------------

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new PluginError(`${what} (got ${typeName(value)})`);
  return value;
}

function requireFinite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PluginError(`${what} (got ${typeName(value)})`);
  }
  return value;
}

function requireDomain(value: unknown): string {
  const domain = requireString(value, 'storage needs a domain name, like "org.axiscontrol.tools"');
  if (!domain) throw new PluginError('storage needs a domain name, not an empty string');
  return domain;
}

/**
 * An object of axis letters to distances, with every number checked.
 *
 * NaN is the reason this is not just a cast. `G1 XNaN` is a line the
 * controller has to interpret, and what a given firmware does with it is not
 * something to find out on a machine with a spindle running.
 */
function requireAxisMap(value: unknown, what: string): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginError(`${what} (got ${typeName(value)})`);
  }
  const out: Record<string, number> = {};
  for (const [axis, delta] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z]$/.test(axis)) {
      throw new PluginError(`${what}: "${clip(axis, 40)}" is not an axis letter`);
    }
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      throw new PluginError(`${what}: ${axis} is ${typeName(delta)}, which is not a distance`);
    }
    out[axis.toUpperCase()] = delta;
  }
  if (Object.keys(out).length === 0) throw new PluginError(`${what}: no axes were named`);
  return out;
}

function requireAxisList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new PluginError('machine.home needs an array of axis letters');
  return value.map((axis) => {
    if (typeof axis !== 'string' || !/^[A-Za-z]$/.test(axis)) {
      throw new PluginError(`machine.home: "${clip(String(axis), 40)}" is not an axis letter`);
    }
    return axis.toUpperCase();
  });
}

/** Whatever a plugin called "bytes", as bytes. */
function requireBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new PluginError(
    `files.write needs a string, a Uint8Array or an ArrayBuffer (got ${typeName(value)})`,
  );
}

function requireDriver(method: string): NonNullable<ReturnType<typeof activeDriver>> {
  const driver = activeDriver();
  if (!driver) throw new PluginError(`${method} failed: not connected to a machine`);
  return driver;
}

// --- Values that have to survive postMessage ------------------------------

/**
 * A deep copy of `value` holding only what structuredClone can carry.
 *
 * A clone that throws is not a failed call, it is a call that never answers:
 * the throw happens in the host as it posts the reply, so the guest's promise
 * is left pending for good. What arrives here is not always plain data —
 * `MachineState.extras` is whatever the driver chose to surface, and the RRF
 * driver's object model arrives as class instances — so everything is reduced
 * to plain objects on the way out.
 *
 * Dates survive as Dates: `FileEntry.modified` and `LogLine.time` are the two
 * that reach a plugin, structuredClone carries them, and a plugin handed a
 * string where the type says Date has to be told about it in the docs.
 *
 * A class instance keeps its own data properties and loses its prototype,
 * which is exactly what structuredClone would have done to it anyway — an
 * accessor defined on a prototype is not an own property and was never going
 * to cross.
 */
function cloneable(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') return value;
  if (type === 'undefined') return undefined;
  // A function or a symbol is the one thing postMessage refuses outright.
  if (type === 'function' || type === 'symbol') return undefined;

  const object = value as object;
  // Cycles, and an object reached twice, which must stay one object on the
  // other side rather than becoming two copies of itself.
  if (seen.has(object)) return seen.get(object);

  if (object instanceof Date) return new Date(object.getTime());
  if (object instanceof ArrayBuffer) return object.slice(0);
  if (ArrayBuffer.isView(object)) {
    const view = object as Uint8Array;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (object instanceof Error) return { name: object.name, message: object.message };
  if (object instanceof RegExp) return object.source;

  if (Array.isArray(object)) {
    const out: unknown[] = [];
    seen.set(object, out);
    for (const item of object) out.push(cloneable(item, seen));
    return out;
  }
  if (object instanceof Map) {
    const out: Record<string, unknown> = {};
    seen.set(object, out);
    for (const [key, item] of object) out[String(key)] = cloneable(item, seen);
    return out;
  }
  if (object instanceof Set) {
    const out: unknown[] = [];
    seen.set(object, out);
    for (const item of object) out.push(cloneable(item, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(object, out);
  for (const [key, item] of Object.entries(object)) out[key] = cloneable(item, seen);
  return out;
}

// --- Small things ---------------------------------------------------------

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
