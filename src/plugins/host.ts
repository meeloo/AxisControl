// Installing, enabling, and running plugins.
//
// The half of the system that owns the list: what is installed, where its
// bytes live, whether it is running, and why it is not. plugins/bridge.ts owns
// one frame and the calls that frame may make; this owns everything either
// side of it — reading the card, asking the operator, registering the panel,
// tearing it all down again.
//
// One rule runs through the whole file: a broken plugin must not be able to
// stop the others. The input here is somebody else's zip, unpacked into a
// directory on the same card as the machine's configuration, and possibly
// edited by hand since. So every per-plugin step is wrapped, the failure is
// recorded on that plugin's record where the Plugins panel can show it, and
// the loop carries on to the next one. Nothing in this file throws out of a
// load.

import { BUILD } from '../core/build.js';
import { effect, signal, type Signal } from '../core/signal.js';
import {
  actions,
  activeDriver,
  appendLog,
  capabilities,
  connected,
  loadSetting,
  machine,
  saveSetting,
} from '../core/store.js';
import { looksLikeZip, unzip, type ZipEntry } from '../core/zip.js';
import type { MachineDriver } from '../machine/driver.js';
import { registerPanel, unregisterPanel, type PanelDefinition } from '../ui/panel.js';
import { createFrame, type PluginFrame, type PluginLogLine } from './bridge.js';
import {
  hashPlugin,
  isCompatible,
  manifestFromHeader,
  parseManifest,
  permissionsOf,
  type ManifestProblem,
} from './manifest.js';
import { clearGrant, grantedFor, needsPrompt, requestGrant } from './permissions.js';
import { DATA_DIR, deleteDomain, openDomain, registerDomains } from './storage.js';
import {
  API_VERSION,
  PluginError,
  type Manifest,
  type PermissionName,
  type PluginRecord,
  type PluginSource,
} from './types.js';

export const plugins: Signal<PluginRecord[]> = signal<PluginRecord[]>([], () => false);
export const pluginLog: Signal<PluginLogLine[]> = signal<PluginLogLine[]>([], () => false);

/** Where plugins live on the card. See docs/plugins.md for why not /www or /sys. */
export const PLUGIN_DIR = '/plugins';

/**
 * The panel id a plugin's panel is registered under, and the element that
 * hosts it.
 *
 * One element type for every plugin rather than one per plugin: the layout
 * builds a panel by tag name, and defining a custom element per installed
 * plugin would mean names that cannot be undefined again when the plugin is
 * removed — `customElements.define` is for ever.
 */
export const PLUGIN_PANEL_PREFIX = 'plugin:';
export const PLUGIN_PANEL_TAG = 'cnc-plugin-panel';

/** Grid columns, of 12, for a manifest that does not say. */
const DEFAULT_PANEL_WIDTH = 4;
/** Pixels, for a manifest that does not say. */
const DEFAULT_PANEL_HEIGHT = 320;

/**
 * Lines kept across every plugin.
 *
 * A ring rather than a per-plugin buffer: the log pane in the Plugins panel
 * shows one plugin at a time but the interesting failure is often two plugins
 * interleaved — one writing a domain the other reads — and an order that only
 * exists per plugin cannot show that. Bounded because a plugin logging from a
 * render loop must cost a fixed amount of memory, not a growing one.
 */
const LOG_LIMIT = 400;

/** The plugin id must be a single safe path segment: it becomes a directory. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

let records: PluginRecord[] = [];

/** Hidden frames, one per enabled plugin that declared `background`. */
const services = new Map<string, PluginFrame>();

/** Modules loaded into the host realm by `unsafe.fullAccess`. */
interface FullAccessInstance {
  module: Record<string, unknown>;
  stop: (() => void) | null;
}
const fullAccess = new Map<string, FullAccessInstance>();

/** Open panels, per plugin. Kept so a reload can rebuild in place. */
interface Attachment {
  pluginId: string;
  container: HTMLElement;
  frame: PluginFrame | null;
  /** A full-access plugin's own teardown, returned by its `mountPanel`. */
  cleanup: (() => void) | null;
  /** False once the panel host has destroyed this attachment. */
  live: boolean;
}
const attachments = new Map<string, Set<Attachment>>();

/** Panel ids this module has registered, so removing one can unregister it. */
const registered = new Set<string>();

// --- The record list ------------------------------------------------------

export function recordFor(pluginId: string): PluginRecord | null {
  return records.find((r) => r.manifest.id === pluginId) ?? null;
}

/**
 * Publish the list.
 *
 * A fresh array every time. The signal compares with `() => false` so it would
 * notify either way, but a panel that keeps the previous array to diff against
 * would otherwise be handed the same one it already has.
 */
function publish(): void {
  plugins.set(records.slice());
}

function appendPluginLog(line: PluginLogLine): void {
  const lines = pluginLog.peek();
  lines.push(line);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  pluginLog.touch();
}

function note(pluginId: string, level: PluginLogLine['level'], text: string): void {
  appendPluginLog({ pluginId, level, text, time: new Date() });
}

/** For the editor's log pane. Omit the id to clear everything. */
export function clearPluginLog(pluginId?: string): void {
  const kept = pluginId === undefined ? [] : pluginLog.peek().filter((l) => l.pluginId !== pluginId);
  pluginLog.set(kept);
}

/**
 * Stop a plugin and say why, on the record where the panel can show it.
 *
 * The operator's stored intent is NOT written here — only `setEnabled` does
 * that. A plugin stopped because the app cannot serve its API version, or
 * because another plugin owns a domain it claims, has not been switched off by
 * anybody, and writing "off" would mean it stayed off after the cause was
 * gone. Left alone, the next load tries again and either starts it or reports
 * the same fault.
 */
function disable(record: PluginRecord, why: string): void {
  record.enabled = false;
  record.fault = why;
  publish();
  syncPanelRegistrations();
  note(record.manifest.id, 'error', why);
  appendLog({ level: 'warning', text: `Plugin ${record.manifest.name}: ${why}`, time: new Date() });
}

function clearFault(record: PluginRecord): void {
  if (!record.fault) return;
  record.fault = '';
  publish();
}

/** A frame that died or stopped answering. The plugin stays enabled. */
function faulted(pluginId: string, why: string): void {
  const record = recordFor(pluginId);
  if (!record) return;
  record.fault = why;
  publish();
  note(pluginId, 'error', why);
}

// --- Panels ---------------------------------------------------------------

export function panelIdFor(pluginId: string): string {
  return `${PLUGIN_PANEL_PREFIX}${pluginId}`;
}

/** The plugin behind a panel id, or null for one of the app's own panels. */
export function pluginIdOfPanel(panelId: string): string | null {
  return panelId.startsWith(PLUGIN_PANEL_PREFIX) ? panelId.slice(PLUGIN_PANEL_PREFIX.length) : null;
}

/**
 * Panel definitions for every enabled plugin that declares one.
 *
 * The registry is a live Map, so this is a diff rather than an append:
 * definitions this module put there and no longer wants are removed, which is
 * what makes a removed plugin's panel disappear from the picker instead of
 * sitting there offering to build an element for code that is gone.
 *
 * Definitions the app itself registered are never touched — only ids carrying
 * the `plugin:` prefix that this module has registered in the first place.
 */
/**
 * The panel definitions from last time, registered before anything is loaded.
 *
 * A plugin's panel is registered when the plugin loads, and a plugin loads
 * from the controller's card — which is unreadable until a driver connects,
 * seconds after the dashboard has already restored itself. The layout drops a
 * saved panel whose definition it cannot find (rightly: that is how a removed
 * plugin's panel disappears) and then persists what is left, so the plugin's
 * panel was not merely missing on load, it was erased from the saved layout.
 * Every reload cost the operator the panel they had arranged.
 *
 * So the definitions are cached, and replayed synchronously at startup before
 * the dashboard is built. A cached panel whose plugin has since gone renders
 * its own explanation and is unregistered as soon as the real load disagrees,
 * which is a second of a stale title against a layout that survives.
 */
const PANEL_CACHE_KEY = 'pluginPanels';

interface CachedPanel {
  id: string;
  title: string;
  width: number;
  height: number;
  description?: string;
}

export function registerCachedPanels(): void {
  for (const panel of loadSetting<CachedPanel[]>(PANEL_CACHE_KEY, [])) {
    if (!panel || typeof panel.id !== 'string' || !panel.id.startsWith(PLUGIN_PANEL_PREFIX)) continue;
    registerPanel({
      id: panel.id,
      title: panel.title || panel.id,
      tag: PLUGIN_PANEL_TAG,
      defaultWidth: panel.width || DEFAULT_PANEL_WIDTH,
      defaultHeight: panel.height || DEFAULT_PANEL_HEIGHT,
      description: panel.description,
    });
    registered.add(panel.id);
  }
}

export function syncPanelRegistrations(): void {
  const wanted = new Map<string, PanelDefinition>();
  for (const record of records) {
    const panel = record.manifest.panel;
    if (!record.enabled || !panel) continue;
    wanted.set(panelIdFor(record.manifest.id), {
      id: panelIdFor(record.manifest.id),
      title: panel.title || record.manifest.name,
      tag: PLUGIN_PANEL_TAG,
      defaultWidth: panel.width ?? DEFAULT_PANEL_WIDTH,
      defaultHeight: panel.height ?? DEFAULT_PANEL_HEIGHT,
      description: panel.description ?? record.manifest.description,
      // No `available`: a plugin panel is offered whatever the controller can
      // do. Which capabilities a plugin needs is the plugin's business, and a
      // panel that vanishes from the picker when the machine is disconnected
      // would be one nobody could find while writing it.
    });
  }
  for (const id of [...registered]) {
    if (wanted.has(id)) continue;
    unregisterPanel(id);
    registered.delete(id);
  }
  for (const [id, def] of wanted) {
    registerPanel(def);
    registered.add(id);
  }
  saveSetting(
    PANEL_CACHE_KEY,
    [...wanted.values()].map((d) => ({
      id: d.id,
      title: d.title,
      width: d.defaultWidth,
      height: d.defaultHeight,
      description: d.description,
    })),
  );
}

function attachmentsOf(pluginId: string): Set<Attachment> {
  let set = attachments.get(pluginId);
  if (!set) attachments.set(pluginId, (set = new Set<Attachment>()));
  return set;
}

/**
 * The panel host asks for this when a plugin panel mounts.
 *
 * Returns null when there is nothing to show — no such plugin, it is disabled,
 * or it declares no panel — and the caller should render the reason from the
 * record rather than an empty box. Everything else is asynchronous behind the
 * handle: the grant dialog may have to be answered before a frame can be
 * built, and a panel that waited for that would block the layout.
 *
 * Two things reach the caller as DOM events on `container`, because they are
 * the only ones not visible in the `plugins` signal:
 *
 *   `plugin-title`  detail `{ title }` — `axis.ui.title(text)`.
 *   `plugin-resize` detail `{ height }`, cancelable — `axis.ui.resize(px)`.
 *     Call preventDefault() if the layout owns the height, which inside the
 *     dock it does; left alone, the frame is set to the height the plugin
 *     asked for, which is what a container that grows wants.
 *
 * Everything else — a plugin disabled, removed, faulted or reloaded while its
 * panel is open — lands on the record, and `plugins` is touched: a panel bound
 * to that signal re-renders and asks again. The handle stays valid throughout;
 * a reload rebuilds the frame into the same container by itself.
 */
export function attachPanel(pluginId: string, container: HTMLElement): { destroy: () => void } | null {
  const record = recordFor(pluginId);
  if (!record || !record.enabled || !record.manifest.panel) return null;

  const attachment: Attachment = { pluginId, container, frame: null, cleanup: null, live: true };
  attachmentsOf(pluginId).add(attachment);
  void mount(attachment);
  return {
    destroy: () => {
      attachment.live = false;
      const open = attachmentsOf(pluginId);
      open.delete(attachment);
      if (open.size === 0) attachments.delete(pluginId);
      teardown(attachment);
    },
  };
}

/**
 * Build a panel's frame. Never rejects: every caller is a `void mount(...)`,
 * because nothing on screen waits for a frame to be ready, and a rejection
 * from one would surface as an unhandled promise in the devtools rather than
 * as the fault the Plugins panel exists to show.
 */
async function mount(attachment: Attachment): Promise<void> {
  if (!attachment.live || attachment.frame || attachment.cleanup) return;
  const record = recordFor(attachment.pluginId);
  if (!record || !record.enabled) return;

  try {
    const granted = await ensureGranted(record);
    // Three checks, and none of them implies the others: the dialog is modal
    // but it is not instant, and while it was open the operator may have
    // closed the panel (live) or saved new code, which replaces the record
    // with a different object whose own reload will build the frame.
    if (!granted || !attachment.live || recordFor(attachment.pluginId) !== record) return;
    if (attachment.frame || attachment.cleanup) return;

    if (granted.includes('unsafe.fullAccess')) {
      await mountFullAccessPanel(attachment, record);
      return;
    }

    attachment.frame = createFrame(record, granted, {
      container: attachment.container,
      onLog: appendPluginLog,
      onFault: (why) => faulted(attachment.pluginId, why),
      onTitle: (title) => announce(attachment.container, 'plugin-title', { title }),
      onResize: (height) => {
        // dispatchEvent answers false when something called preventDefault,
        // which is the panel host saying the height is the layout's to decide.
        const handled = !announce(attachment.container, 'plugin-resize', { height }, true);
        if (!handled && attachment.frame) attachment.frame.element.style.height = `${height}px`;
      },
    });
  } catch (err) {
    faulted(attachment.pluginId, `its panel would not start: ${messageOf(err)}`);
  }

  // No machine feed is started here on purpose. plugins/bridge.ts opens the
  // `machine.state` channel itself, when the guest subscribes and only if
  // machine.read was granted; a second feed from this side would deliver every
  // snapshot twice to a plugin counting them, and guest.ts documents that
  // channel as one the host must not push to unasked.
}

function announce(container: HTMLElement, type: string, detail: unknown, cancelable = false): boolean {
  return container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, cancelable }));
}

/**
 * Drop a panel's frame, keeping the attachment.
 *
 * `PluginFrame.destroy` cannot run the plugin's `onUnmount` hooks: it removes
 * the element there and then, while a posted message is only delivered on a
 * later task. A plugin that saves what the operator typed when its panel
 * closes would lose it every time. So the message goes now, the element is
 * hidden so that a reload does not briefly show two frames, and the frame goes
 * on the next task — by which time the hooks have had theirs.
 */
function teardown(attachment: Attachment): void {
  if (attachment.cleanup) {
    const cleanup = attachment.cleanup;
    attachment.cleanup = null;
    try {
      cleanup();
    } catch (err) {
      note(attachment.pluginId, 'error', `its panel teardown threw: ${messageOf(err)}`);
    }
  }
  const frame = attachment.frame;
  if (!frame) return;
  attachment.frame = null;
  // Only worth sending while the frame is still in the document. A panel
  // element that has already been detached from the DOM has no contentWindow
  // left to post to, and emit() would log a delivery warning for what is an
  // ordinary panel close.
  if (frame.element.isConnected) {
    frame.emit('lifecycle', { phase: 'unmount' });
    frame.element.style.display = 'none';
  }
  setTimeout(() => frame.destroy(), 0);
}

/** Rebuild every open panel of one plugin — the visible half of a reload. */
function remount(pluginId: string): void {
  for (const attachment of [...attachmentsOf(pluginId)]) void mount(attachment);
}

// --- Starting and stopping ------------------------------------------------

/**
 * What this record may do, or null when it may not run at all.
 *
 * Asks the operator when there is something to ask. permissions.ts queues the
 * dialogs, so several plugins starting at once — which is every startup —
 * produce one question after another rather than one replacing another under
 * the operator's hand.
 */
async function ensureGranted(record: PluginRecord): Promise<PermissionName[] | null> {
  if (!isCompatible(record.manifest)) {
    disable(
      record,
      `it is written for plugin API ${record.manifest.api} and this build serves ${API_VERSION}.`,
    );
    return null;
  }
  if (needsPrompt(record) && !(await requestGrant(record))) {
    disable(
      record,
      'the permissions it asks for were refused, so it is switched off. Enable it again to be asked once more.',
    );
    return null;
  }
  const granted = grantedFor(record);
  const missing = permissionsOf(record.manifest).filter((p) => !granted.includes(p));
  // grantedFor is the intersection of what this manifest asks for with what is
  // on file, so a shortfall here is a decision that was made against an older
  // version, or a grant record that was edited. Running on part of a list is
  // the one thing docs/plugins.md rules out: half a plugin fails in ways its
  // author never saw.
  if (missing.length) {
    disable(record, `it has not been granted ${missing.join(', ')}.`);
    return null;
  }
  return granted;
}

/**
 * Start whatever this plugin runs with no panel open: a service frame, or a
 * full-access module. A plugin that is only a panel starts nothing here and is
 * not an error.
 */
async function start(record: PluginRecord): Promise<void> {
  const id = record.manifest.id;
  if (!record.enabled) return;
  if (services.has(id) || fullAccess.has(id)) return;

  const granted = await ensureGranted(record);
  // Re-read: the record can have been replaced or switched off while the grant
  // dialog was open.
  if (!granted || !record.enabled || recordFor(id) !== record) return;

  try {
    if (granted.includes('unsafe.fullAccess')) {
      await startFullAccess(record);
      clearFault(record);
    } else if (record.manifest.background && granted.includes('background')) {
      services.set(
        id,
        createFrame(record, granted, {
          onLog: appendPluginLog,
          onFault: (why) => faulted(id, why),
        }),
      );
      clearFault(record);
    }
    // A plugin that is only a panel started nothing here, so it clears
    // nothing: this runs again on every connection, and a fault reported by a
    // panel frame that has stopped answering must not be wiped by a call that
    // did not go anywhere near it.
  } catch (err) {
    disable(record, `it would not start: ${messageOf(err)}`);
  }
}

/** Stop everything this plugin is running. Open panels keep their place. */
function stop(pluginId: string): void {
  services.get(pluginId)?.destroy();
  services.delete(pluginId);
  stopFullAccess(pluginId);
  // Torn down but not detached: the panel element is still on screen, and a
  // reload is expected to put a new frame in the same container.
  for (const attachment of [...attachmentsOf(pluginId)]) teardown(attachment);
}

export async function setEnabled(pluginId: string, on: boolean): Promise<void> {
  const record = recordFor(pluginId);
  if (!record) return;

  if (!on) {
    stop(pluginId);
    record.enabled = false;
    record.fault = '';
    rememberEnabled(pluginId, false);
    publish();
    syncPanelRegistrations();
    return;
  }

  // Enabled first, then asked. `start` and `mount` both refuse to do anything
  // for a record that is not enabled, and the grant dialog is an await.
  record.enabled = true;
  record.fault = '';
  rememberEnabled(pluginId, true);
  publish();
  syncPanelRegistrations();

  await start(record);
  // `disable` may have run inside `start` — a refusal, or a permission that is
  // no longer on file — in which case there is nothing to show.
  if (record.enabled) remount(pluginId);
}

/**
 * Tear the frames down and build them again — the whole edit loop.
 *
 * Every frame for this plugin: the service frame and each open panel. State
 * inside the plugin is lost, storage is not, and nothing is left behind — a
 * reload that leaked a frame per save would, over an afternoon of editing,
 * leave dozens of documents subscribed to the machine.
 */
export async function reload(pluginId: string): Promise<void> {
  const record = recordFor(pluginId);
  if (!record) return;
  stop(pluginId);
  await start(record);
  if (record.enabled) remount(pluginId);
}

// --- Loading --------------------------------------------------------------

/**
 * Read what is installed and start what is enabled.
 *
 * Machine-stored plugins live in `/plugins/<id>/` on the card — see
 * docs/plugins.md for why not `/www` and why not `/sys` — and browser-stored
 * ones in IndexedDB. A card that cannot be read is not an error: the app runs
 * with the local ones and says so.
 *
 * Safe to call again, and called again on every connection, because the card
 * cannot be read before there is a driver. A plugin that is already running
 * and whose bytes have not changed is left exactly as it is, so reconnecting
 * does not restart every frame in the window.
 *
 * Starting is deliberately not awaited. A plugin that needs a grant puts a
 * modal question in front of the operator, and holding the loader open until
 * it is answered would mean a second call — the one the connection makes —
 * queued behind a dialog nobody is looking at.
 */
export function loadInstalled(): Promise<void> {
  // Serialised rather than deduplicated: the second call is usually the
  // connection, and it has a card to read that the first one did not. Handing
  // it the first call's promise would skip that read entirely.
  loading = loading.then(loadOnce, loadOnce);
  return loading;
}

let loading: Promise<void> = Promise.resolve();

/**
 * One pass, and never a rejection.
 *
 * Two callers reach this — main.ts at startup and the effect below on every
 * connection — and the second one cannot catch anything, because it is a
 * `void` call inside a reactive effect. A load that rejected there would show
 * up as an unhandled promise in the devtools instead of as a line in the
 * console the operator is looking at.
 */
async function loadOnce(): Promise<void> {
  try {
    await reconcile();
  } catch (err) {
    appendLog({ level: 'error', text: `Plugins could not be read: ${messageOf(err)}`, time: new Date() });
  }
}

async function reconcile(): Promise<void> {
  // Browser first: a plugin kept locally is the one somebody is working on,
  // and if the same id is also on the card it is the copy they mean.
  const found = [...(await readBrowserPlugins()), ...(await readCardPlugins())];

  const next: PluginRecord[] = [];
  const seen = new Set<string>();
  for (const fresh of found) {
    const id = fresh.manifest.id;
    if (seen.has(id)) {
      note(
        id,
        'warn',
        'it is installed both in this browser and on the machine; the browser copy is the one running.',
      );
      continue;
    }
    seen.add(id);

    const held = recordFor(id);
    if (held && held.source === fresh.source && held.hash === fresh.hash) {
      // Unchanged. Keep the object rather than the copy: its frames, its
      // fault and the operator's enable state are all attached to it.
      next.push(held);
      continue;
    }
    // Changed underneath us — edited on the card, or restored from a backup.
    // The new record takes its enabled flag from the stored setting rather
    // than from the record it replaces, deliberately: the old one may have
    // been stopped by a fault, and new bytes are exactly the case where that
    // fault has just been fixed. Only `setEnabled` writes the setting, so an
    // operator's decision to switch a plugin off still survives this.
    if (held) stop(id);
    next.push(fresh);
  }

  // Anything that has gone from both stores stops and is forgotten. Its panel
  // definition goes with it, below.
  for (const gone of records) {
    if (seen.has(gone.manifest.id)) continue;
    stop(gone.manifest.id);
    for (const attachment of [...attachmentsOf(gone.manifest.id)]) {
      attachment.live = false;
      teardown(attachment);
    }
    attachments.delete(gone.manifest.id);
  }

  records = next;
  registerDomains(records);
  faultDomainConflicts();
  publish();
  syncPanelRegistrations();

  for (const record of records) {
    // Each start is on its own: a plugin that throws on the way up must not
    // take the rest of the list with it, and `start` already records its own
    // failures on the record.
    void start(record).catch((err: unknown) => {
      note(record.manifest.id, 'error', `it would not start: ${messageOf(err)}`);
    });
    if (record.enabled) remount(record.manifest.id);
  }
}

/**
 * A domain claimed by two installed plugins.
 *
 * storage.ts's `registerDomains` keeps the first claim and logs; this is the
 * other half of that — the later claimant is stopped, because a plugin whose
 * own domain belongs to somebody else would be refused access to its own data
 * call by call and look merely broken. Install refuses this outright; two
 * plugins can only reach here by being copied onto the card directly.
 */
function faultDomainConflicts(): void {
  const owner = new Map<string, string>();
  for (const record of records) {
    for (const spec of record.manifest.provides ?? []) {
      const held = owner.get(spec.domain);
      if (held === undefined) {
        owner.set(spec.domain, record.manifest.id);
        continue;
      }
      if (held === record.manifest.id) continue;
      // Said once. This runs on every connection, and a conflict nobody has
      // resolved yet would otherwise write the same warning to the machine's
      // console every time the app reconnected.
      if (record.enabled) {
        disable(record, `the storage domain ${spec.domain} it claims already belongs to ${held}.`);
      }
    }
  }
}

// Plugins again as soon as there is a machine to read them from.
//
// main.ts calls loadInstalled at startup, when most plugins are unreadable
// because they live on the card. This covers every route to a connection —
// including the operator connecting by hand from the top bar, which main.ts's
// own call after auto-connect does not.
effect(() => {
  if (!connected.get()) return;
  void loadInstalled();
});

// --- Installing -----------------------------------------------------------

/** A zip holding plugin.json + main.js, or a bare .js with a header manifest. */
export async function installFromBytes(
  bytes: Uint8Array,
  filename: string,
  source: PluginSource,
): Promise<PluginRecord> {
  if (!looksLikeZip(bytes)) return installCode(decode(bytes), source, filename);

  let entries: ZipEntry[];
  try {
    entries = await unzip(bytes);
  } catch (err) {
    throw new PluginError(`${filename} could not be opened as a zip: ${messageOf(err)}`);
  }

  const manifestEntry = pickEntry(entries, 'plugin.json');
  const codeEntry = pickEntry(entries, 'main.js');
  if (!manifestEntry || !codeEntry) {
    throw new PluginError(
      `${filename} does not hold a plugin: a plugin zip contains plugin.json and main.js, ` +
        `and this one is missing ${!manifestEntry ? 'plugin.json' : 'main.js'}.`,
    );
  }

  const text = decode(manifestEntry.bytes);
  const parsed = parseManifest(text);
  if (!parsed.manifest) throw problemError(`${filename}: plugin.json`, parsed.problems);

  const cssEntry = pickEntry(entries, 'panel.css');
  return install({
    manifest: parsed.manifest,
    manifestText: text,
    code: decode(codeEntry.bytes),
    css: cssEntry ? decode(cssEntry.bytes) : undefined,
    source,
  });
}

export function installFromSource(code: string, source: PluginSource): Promise<PluginRecord> {
  return installCode(code, source, 'this source');
}

// Async so that a bad header is a rejection rather than a synchronous throw:
// `installFromSource` is declared to return a promise, and a caller that only
// wrote `.catch()` would otherwise see the error escape past it.
async function installCode(code: string, source: PluginSource, what: string): Promise<PluginRecord> {
  const parsed = manifestFromHeader(code);
  if (!parsed.manifest) throw problemError(what, parsed.problems);
  return install({
    manifest: parsed.manifest,
    // Written out rather than cut from the file: the header is a comment in
    // the code, and plugin.json beside it has to be JSON on its own.
    manifestText: JSON.stringify(parsed.manifest, null, 2),
    code,
    source,
  });
}

interface Incoming {
  manifest: Manifest;
  manifestText: string;
  code: string;
  css?: string;
  source: PluginSource;
}

/**
 * The last gate before a plugin's bytes are written anywhere.
 *
 * Everything refused here is refused with the conflict named, because the
 * operator is about to choose between two plugins and cannot do that from
 * "install failed".
 */
async function install(incoming: Incoming): Promise<PluginRecord> {
  const manifest = incoming.manifest;
  const id = manifest.id;

  const held = recordFor(id);
  if (held) {
    throw new PluginError(
      `${id} is already installed (${held.source === 'machine' ? 'on the machine' : 'in this browser'}), ` +
        `version ${held.manifest.version}. Remove it first, or open it in the editor to replace its code.`,
    );
  }
  if (!isCompatible(manifest)) {
    throw new PluginError(
      `${id} is written for plugin API ${manifest.api}; this build of Axis Control serves ` +
        `${API_VERSION}. Installing it would let it run until the first call this build does not have.`,
    );
  }
  for (const spec of manifest.provides ?? []) {
    const owner = records.find((r) => (r.manifest.provides ?? []).some((p) => p.domain === spec.domain));
    if (owner) {
      throw new PluginError(
        `${id} claims the storage domain ${spec.domain}, which ${owner.manifest.id} already owns. ` +
          'A domain has exactly one owner — that is what lets a second plugin trust the data it reads.',
      );
    }
  }

  const record: PluginRecord = {
    manifest,
    code: incoming.code,
    css: incoming.css,
    source: incoming.source,
    hash: await hashPlugin(manifest, incoming.code),
    enabled: true,
  };

  await writeCode(record, incoming.manifestText);

  records = [...records, record];
  registerDomains(records);
  rememberEnabled(id, true);
  publish();
  syncPanelRegistrations();
  note(id, 'info', `installed ${manifest.name} ${manifest.version}`);
  appendLog({ level: 'info', text: `Installed plugin ${manifest.name} ${manifest.version}`, time: new Date() });

  // Awaited, unlike the loader's starts: an install is one deliberate act by
  // somebody who is standing there, and the grant dialog belongs to it.
  await start(record);
  return record;
}

/**
 * Write changed source back to wherever the plugin lives, then reload it.
 *
 * The manifest travels with the code when the plugin carries an `@plugin`
 * header, which is how a plugin written in the editor asks for a new
 * permission: the header is edited, this re-parses it, the hash changes and
 * the operator is asked again on the way back up.
 */
export async function saveSource(pluginId: string, code: string): Promise<void> {
  const record = recordFor(pluginId);
  if (!record) throw new PluginError(`${pluginId} is not installed.`);

  let manifest = record.manifest;
  let manifestText: string | null = null;
  // The string, not a successful parse: a file that mentions @plugin and fails
  // to parse is somebody editing their header, and silently keeping the old
  // manifest would leave them staring at a change that did nothing.
  if (code.includes('@plugin')) {
    const parsed = manifestFromHeader(code);
    if (!parsed.manifest) throw problemError(`${pluginId}: the @plugin header`, parsed.problems);
    if (parsed.manifest.id !== pluginId) {
      throw new PluginError(
        `the @plugin header now says the id is ${parsed.manifest.id}. An id is a plugin's identity — ` +
          'its storage, its grants and its panel all hang off it - so this is a different plugin. Install it as one.',
      );
    }
    if (!isCompatible(parsed.manifest)) {
      throw new PluginError(
        `the @plugin header asks for plugin API ${parsed.manifest.api}; this build serves ${API_VERSION}.`,
      );
    }
    manifest = parsed.manifest;
    manifestText = JSON.stringify(manifest, null, 2);
  }

  const hash = await hashPlugin(manifest, code);
  const saved: PluginRecord = { ...record, manifest, code, hash };
  await writeCode(saved, manifestText);

  // In place, so that everything holding this record — an open panel, a
  // service frame about to be torn down — is looking at the same object.
  record.manifest = manifest;
  record.code = code;
  record.hash = hash;
  registerDomains(records);
  publish();
  syncPanelRegistrations();

  // Re-hashed above, so `needsPrompt` inside the reload asks again if this
  // version widened what it wants.
  await reload(pluginId);
}

/** Removes the code and the grants; the data goes only if asked for. */
export async function remove(pluginId: string, options: { deleteData: boolean }): Promise<void> {
  const record = recordFor(pluginId);
  if (!record) return;

  // Stopped before anything is deleted. Deleting a domain out from under a
  // plugin that is still running is a race the plugin wins: its next debounced
  // write puts the file back on the card a moment after the operator was told
  // the data was gone.
  stop(pluginId);
  for (const attachment of [...attachmentsOf(pluginId)]) {
    attachment.live = false;
    teardown(attachment);
  }
  attachments.delete(pluginId);

  // Then the data, and before the code: deleteDomain refuses to report a
  // `machine` domain gone when it could not reach the card, and finding that
  // out afterwards would leave data the operator asked to destroy sitting
  // there with nothing installed that knows what it is.
  let dataFailure: string | null = null;
  if (options.deleteData) {
    for (const spec of record.manifest.provides ?? []) {
      try {
        await deleteDomain(spec.domain);
      } catch (err) {
        dataFailure = messageOf(err);
      }
    }
  }

  try {
    await eraseCode(record);
  } catch (err) {
    // Left in the list on purpose. Files still on the card are a plugin that
    // comes back on the next load, and showing it as removed until then would
    // be a lie the operator only finds out about later.
    disable(record, messageOf(err));
    throw err;
  }

  records = records.filter((r) => r !== record);
  clearGrant(pluginId);
  forgetEnabled(pluginId);
  registerDomains(records);
  publish();
  syncPanelRegistrations();
  appendLog({ level: 'info', text: `Removed plugin ${record.manifest.name}`, time: new Date() });

  if (dataFailure) {
    throw new PluginError(`${record.manifest.name} was removed, but its data was not: ${dataFailure}`);
  }
}

// --- Full access ----------------------------------------------------------

/**
 * The `unsafe.fullAccess` path: no frame, the real modules, by explicit grant.
 *
 * The module is imported from a blob URL, which is the only way to run a
 * string as a module without `eval` — and a fresh URL every time, so a reload
 * really does load the new code rather than the module cache's copy of the old.
 *
 * The guard below is the whole safety of this function. Every other path in
 * this file can afford to be wrong about a permission because the frame is
 * still there; here there is nothing behind it, so the check is repeated at
 * the point of use rather than trusted from the caller.
 *
 * What cannot be undone: a module, once imported, is in the realm for ever. A
 * timer it started, a listener it added and a reference it kept outlive
 * `stop`, and only its own teardown function can undo them. That is the real
 * cost of this permission, and it is why the dialog says "nothing after this
 * asks again".
 */
export async function startFullAccess(record: PluginRecord): Promise<void> {
  if (!grantedFor(record).includes('unsafe.fullAccess')) {
    throw new PluginError(
      `${record.manifest.id} was not granted unsafe.fullAccess. Loading it into the app's own realm ` +
        'would put it outside every check in this file.',
    );
  }

  const id = record.manifest.id;
  stopFullAccess(id);

  const url = URL.createObjectURL(new Blob([record.code], { type: 'text/javascript' }));
  let module: Record<string, unknown>;
  try {
    module = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new PluginError(`${id} could not be loaded: ${messageOf(err)}`);
  }
  // Revoked once the import has resolved, not before: the fetch of the module
  // body happens inside that await, and a URL revoked early is a module that
  // fails to load on a slow machine and works on a fast one.
  URL.revokeObjectURL(url);

  const entry = typeof module['start'] === 'function' ? module['start'] : module['default'];
  let stopFn: (() => void) | null = null;
  if (typeof entry === 'function') {
    const returned = await (entry as (host: unknown) => unknown)(fullAccessHost(record));
    if (typeof returned === 'function') stopFn = returned as () => void;
  }
  fullAccess.set(id, { module, stop: stopFn });

  note(id, 'warn', 'running with full access: no sandbox, and no permission check on anything it does.');
}

/**
 * What a full-access plugin is handed.
 *
 * The store's `actions` rather than the driver, for the same reason the bridge
 * routes through them: `actions` is the neutral guarded layer, it logs what it
 * sends, and a plugin's G-code should be as visible in the console as a typed
 * one. The driver is here as well, because the point of this permission is the
 * thing the API has not thought of — but reaching for it means the app's log
 * no longer knows what the plugin did.
 */
function fullAccessHost(record: PluginRecord): Record<string, unknown> {
  const id = record.manifest.id;
  return {
    version: { api: API_VERSION, app: BUILD.version },
    manifest: record.manifest,
    machine,
    capabilities,
    connected,
    actions,
    driver: activeDriver,
    storage: { open: openDomain },
    log: {
      info: (text: string) => note(id, 'info', String(text)),
      warn: (text: string) => note(id, 'warn', String(text)),
      error: (text: string) => note(id, 'error', String(text)),
    },
    ui: {
      notify: (text: string, level: 'info' | 'warning' | 'error' = 'info') => {
        appendLog({ level, text: `${record.manifest.name}: ${text}`, time: new Date() });
        note(id, level === 'warning' ? 'warn' : level, String(text));
      },
    },
  };
}

/**
 * A full-access plugin's panel, if it has one.
 *
 * There is no frame to put in the container, so the module is asked to fill it
 * itself: `export function mountPanel(container, host)`, returning an optional
 * teardown. A plugin that declares a panel and exports no such function is
 * saying two different things, and the log says so rather than leaving an
 * empty box on the page.
 */
async function mountFullAccessPanel(attachment: Attachment, record: PluginRecord): Promise<void> {
  const id = record.manifest.id;
  if (!fullAccess.has(id)) await startFullAccess(record);
  if (!attachment.live) return;

  const instance = fullAccess.get(id);
  const mountPanel = instance?.module['mountPanel'];
  if (typeof mountPanel !== 'function') {
    note(id, 'error', 'it declares a panel but exports no mountPanel(container, host) to fill it.');
    return;
  }
  const returned = await (mountPanel as (el: HTMLElement, host: unknown) => unknown)(
    attachment.container,
    fullAccessHost(record),
  );
  if (!attachment.live) {
    // Destroyed while it was mounting. Run its teardown now or the panel it
    // just built stays in a container nobody owns.
    if (typeof returned === 'function') (returned as () => void)();
    return;
  }
  attachment.cleanup = typeof returned === 'function' ? (returned as () => void) : null;
}

function stopFullAccess(pluginId: string): void {
  const instance = fullAccess.get(pluginId);
  if (!instance) return;
  fullAccess.delete(pluginId);
  if (!instance.stop) return;
  try {
    instance.stop();
  } catch (err) {
    note(pluginId, 'error', `its stop() threw: ${messageOf(err)}`);
  }
}

// --- Where the bytes live -------------------------------------------------

async function writeCode(record: PluginRecord, manifestText: string | null): Promise<void> {
  if (record.source === 'machine') {
    const driver = activeDriver();
    if (!driver) {
      throw new PluginError(
        `${record.manifest.id} is stored on the machine; connect to it before saving, or the write ` +
          'would be lost with the tab.',
      );
    }
    const dir = cardDir(record.manifest.id);
    await makeDirectories(driver, dir);
    if (manifestText !== null) await driver.writeFile(`${dir}/plugin.json`, encode(manifestText));
    await driver.writeFile(`${dir}/main.js`, encode(record.code));
    if (record.css !== undefined) await driver.writeFile(`${dir}/panel.css`, encode(record.css));
    return;
  }
  await codePut({
    id: record.manifest.id,
    manifest: manifestText ?? JSON.stringify(record.manifest, null, 2),
    code: record.code,
    css: record.css,
    at: Date.now(),
  });
}

async function eraseCode(record: PluginRecord): Promise<void> {
  if (record.source !== 'machine') {
    await codeDelete(record.manifest.id);
    return;
  }
  const driver = activeDriver();
  if (!driver) {
    throw new PluginError(
      `${record.manifest.id} lives on the machine's card; connect to it to remove it, or it would ` +
        'come back the next time the app was opened.',
    );
  }
  const dir = cardDir(record.manifest.id);
  let entries: Array<{ path: string; directory: boolean }> = [];
  try {
    entries = await driver.listFiles(dir);
  } catch (err) {
    // Already gone is the outcome that was wanted. Anything else and the
    // deletes below have nothing to work from, so say so now.
    if (!looksMissing(err)) throw err;
  }
  for (const entry of entries) {
    if (entry.directory) continue;
    try {
      await driver.deleteFile(entry.path);
    } catch {
      /* checked below: what matters is whether the plugin can still be read */
    }
  }
  try {
    await driver.deleteFile(dir);
  } catch {
    // RRF will not delete a directory that still has something in it — a
    // subdirectory of assets, most likely. Not fatal on its own; the check
    // below decides.
  }
  // The failure worth reporting is not a stray file, it is a plugin that comes
  // back: the loader reads a directory as a plugin if plugin.json is there.
  let left: Array<{ name: string }> = [];
  try {
    left = await driver.listFiles(dir);
  } catch {
    return; // The directory is gone.
  }
  if (left.some((e) => e.name === 'plugin.json')) {
    throw new PluginError(
      `${dir} could not be deleted from the card, so ${record.manifest.id} would be back on the next ` +
        'reload. Check that the card is not write-protected.',
    );
  }
}

/**
 * The directory a plugin's files live in.
 *
 * The id is checked rather than trusted, exactly as storage.ts checks a
 * domain: it arrives from a manifest, which arrived in a zip from somebody's
 * website, and an id of `../sys` would aim a write at the machine's own
 * configuration. The manifest validator enforces reverse-DNS already; this is
 * the second lock, on the path itself, for records that came off the card with
 * a manifest nobody validated.
 */
function cardDir(pluginId: string): string {
  if (!SAFE_ID.test(pluginId) || pluginId.includes('..')) {
    throw new PluginError(`"${pluginId}" is not a usable plugin id.`);
  }
  return `${PLUGIN_DIR}/${pluginId}`;
}

async function makeDirectories(driver: MachineDriver, dir: string): Promise<void> {
  // RRF makes one level at a time and answers an error for a directory that is
  // already there, so both are attempted and neither failure means anything.
  // The write that follows is what reports a real problem.
  for (const path of [PLUGIN_DIR, dir]) {
    try {
      await driver.makeDirectory(path);
    } catch {
      /* already there */
    }
  }
}

// --- Reading the card -----------------------------------------------------

let lastListFailure: string | null = null;

async function readCardPlugins(): Promise<PluginRecord[]> {
  const driver = activeDriver();
  // The app starts disconnected and this runs at startup, so being asked
  // before there is a machine is the ordinary case, not a failure.
  if (!driver) return [];

  let entries;
  try {
    entries = await driver.listFiles(PLUGIN_DIR);
  } catch (err) {
    // A machine nobody has installed a plugin on has no /plugins directory,
    // and that is the state every machine starts in — an error line for it
    // would be wrong on every first run. An unmounted card reports itself the
    // same way, so it is still worth one quiet line, once per reason.
    const why = messageOf(err);
    if (!looksMissing(err) && why !== lastListFailure) {
      lastListFailure = why;
      appendLog({ level: 'info', text: `No plugins read from ${PLUGIN_DIR}: ${why}`, time: new Date() });
    }
    return [];
  }
  lastListFailure = null;

  const found: PluginRecord[] = [];
  for (const entry of entries) {
    if (!entry.directory) continue;
    // storage.ts keeps every domain's JSON in /plugins/data. It is not a
    // plugin, and reading it as one would report a fault on every startup.
    if (`${PLUGIN_DIR}/${entry.name}` === DATA_DIR) continue;
    if (!SAFE_ID.test(entry.name)) {
      appendLog({
        level: 'warning',
        text: `${PLUGIN_DIR}/${entry.name} is not a usable plugin id and was skipped.`,
        time: new Date(),
      });
      continue;
    }
    found.push(await readCardPlugin(driver, entry.name));
  }
  return found;
}

/**
 * One directory on the card, as a record — including when it is broken.
 *
 * A directory whose manifest will not parse still comes back, carrying the
 * fault and whatever code was readable. The alternative is a plugin that is
 * invisible in the Plugins panel and therefore cannot be repaired in the
 * editor or removed from the app: the operator would have to go and find the
 * card. The placeholder manifest's id is the directory name, which is what
 * every path in this file uses to find it again.
 */
async function readCardPlugin(driver: MachineDriver, name: string): Promise<PluginRecord> {
  const dir = `${PLUGIN_DIR}/${name}`;
  let manifestText = '';
  let code = '';
  try {
    manifestText = decode(await driver.readFile(`${dir}/plugin.json`));
  } catch (err) {
    return brokenRecord(name, '', `${dir}/plugin.json could not be read: ${messageOf(err)}`);
  }
  try {
    code = decode(await driver.readFile(`${dir}/main.js`));
  } catch (err) {
    return brokenRecord(name, '', `${dir}/main.js could not be read: ${messageOf(err)}`);
  }

  let css: string | undefined;
  try {
    css = decode(await driver.readFile(`${dir}/panel.css`));
  } catch {
    // Optional, and its absence is the common case.
  }

  const parsed = parseManifest(manifestText);
  if (!parsed.manifest) {
    return brokenRecord(name, code, problemError(`${dir}/plugin.json`, parsed.problems).message);
  }
  if (parsed.manifest.id !== name) {
    return brokenRecord(
      name,
      code,
      `${dir}/plugin.json calls itself ${parsed.manifest.id}, but it is in a directory called ` +
        `${name}. The directory is the id everywhere else, so rename one of them.`,
    );
  }
  return {
    manifest: parsed.manifest,
    code,
    css,
    source: 'machine',
    hash: await hashPlugin(parsed.manifest, code),
    enabled: enabledSetting(parsed.manifest.id),
  };
}

function brokenRecord(id: string, code: string, why: string): PluginRecord {
  return {
    manifest: {
      id,
      name: id,
      version: '0',
      api: API_VERSION,
      permissions: [],
      provides: [],
      uses: [],
    },
    code,
    source: 'machine',
    // Not hashed from the manifest above, which is invented: a hash that
    // changed when this placeholder changed would be meaningless, and no grant
    // should ever match it.
    hash: `broken:${id}`,
    enabled: false,
    fault: why,
  };
}

async function readBrowserPlugins(): Promise<PluginRecord[]> {
  const found: PluginRecord[] = [];
  for (const stored of await codeRows()) {
    const parsed = parseManifest(stored.manifest);
    if (!parsed.manifest) {
      // Nothing can have written this but this module, so a manifest that will
      // not parse means the database has been edited or corrupted.
      appendLog({
        level: 'warning',
        text: `The browser-stored plugin "${stored.id}" has an unreadable manifest and was skipped.`,
        time: new Date(),
      });
      continue;
    }
    found.push({
      manifest: parsed.manifest,
      code: stored.code,
      css: stored.css,
      source: 'browser',
      hash: await hashPlugin(parsed.manifest, stored.code),
      enabled: enabledSetting(parsed.manifest.id),
    });
  }
  return found;
}

// --- Enabled, remembered --------------------------------------------------
//
// One setting holding every decision, as Record<pluginId, boolean>, next to
// the grants in localStorage. A plugin is enabled when it is installed, and
// only `setEnabled` writes here — a plugin stopped by a fault has not been
// switched off by anybody, and writing "off" for it would mean it stayed off
// after the cause was gone.

const ENABLED_KEY = 'pluginEnabled';

function enabledMap(): Record<string, boolean> {
  const raw = loadSetting<unknown>(ENABLED_KEY, {});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, boolean>;
}

function enabledSetting(pluginId: string): boolean {
  // Enabled unless it says otherwise: a plugin that was installed and never
  // touched again should run.
  return enabledMap()[pluginId] !== false;
}

function rememberEnabled(pluginId: string, on: boolean): void {
  const map = enabledMap();
  map[pluginId] = on;
  saveSetting(ENABLED_KEY, map);
}

function forgetEnabled(pluginId: string): void {
  const map = enabledMap();
  if (!(pluginId in map)) return;
  delete map[pluginId];
  saveSetting(ENABLED_KEY, map);
}

// --- The browser store ----------------------------------------------------
//
// A database of its own, not a second object store in storage.ts's
// `axiscontrol-plugins`. Two reasons, and both of them are failures that would
// be hard to see afterwards: adding a store to an existing database needs a
// version bump, and two modules bumping one database from the same tab is
// exactly what `onblocked` is for; and that database holds plugins' DATA,
// which docs/plugins.md says may outlive the plugin that made it. Code and
// data have to be deletable one without the other.

interface StoredCode {
  id: string;
  /** The manifest as text, so what the operator wrote survives a round trip. */
  manifest: string;
  code: string;
  css?: string;
  at: number;
}

const CODE_DB = 'axiscontrol-plugin-code';
const CODE_STORE = 'plugins';

/**
 * The fallback when IndexedDB is not there.
 *
 * Private browsing refuses to open a database and a browser with site data
 * blocked throws from `open` itself. Neither is a reason for the app that
 * drives the spindle to stop working: a plugin installed into this map works
 * for the session and is gone with the tab, and the operator is told once.
 */
const memoryCode = new Map<string, StoredCode>();
let codeDb: Promise<IDBDatabase | null> | null = null;
let codeFaultLogged = false;

function codeUnavailable(why: string): void {
  if (codeFaultLogged) return;
  codeFaultLogged = true;
  appendLog({
    level: 'warning',
    text: `Plugins: ${why}. Browser-stored plugins are kept in memory for this session only.`,
    time: new Date(),
  });
}

function openCodeDb(): Promise<IDBDatabase | null> {
  if (codeDb) return codeDb;
  codeDb = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      codeUnavailable('this environment has no IndexedDB');
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(CODE_DB, 1);
    } catch (err) {
      // Throwing synchronously is what a browser configured to block site data
      // does, and it is the one failure a promise wrapper alone misses.
      codeUnavailable(`IndexedDB refused to open (${messageOf(err)})`);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(CODE_STORE)) {
        req.result.createObjectStore(CODE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      codeUnavailable(`IndexedDB would not open (${req.error?.message ?? 'no reason given'})`);
      resolve(null);
    };
    req.onblocked = () => {
      codeUnavailable('another tab is holding the plugin database open');
      resolve(null);
    };
  });
  return codeDb;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function idbCommitted(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

async function codeRows(): Promise<StoredCode[]> {
  const db = await openCodeDb();
  if (!db) return [...memoryCode.values()];
  try {
    const tx = db.transaction(CODE_STORE, 'readonly');
    const rows = (await idbRequest(tx.objectStore(CODE_STORE).getAll())) as StoredCode[];
    // Anything the memory fallback took after a write failed is still the
    // newest copy of that plugin, so it wins over the row on disk.
    const byId = new Map(rows.filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
    for (const [id, row] of memoryCode) byId.set(id, row);
    return [...byId.values()];
  } catch (err) {
    codeUnavailable(`IndexedDB read failed (${messageOf(err)})`);
    return [...memoryCode.values()];
  }
}

async function codePut(row: StoredCode): Promise<void> {
  const db = await openCodeDb();
  if (!db) {
    memoryCode.set(row.id, row);
    return;
  }
  try {
    const tx = db.transaction(CODE_STORE, 'readwrite');
    tx.objectStore(CODE_STORE).put(row);
    await idbCommitted(tx);
  } catch (err) {
    // Quota, usually. Keeping it in the fallback means the session behaves and
    // only persistence is lost, which is what the operator is told.
    codeUnavailable(`IndexedDB write failed (${messageOf(err)})`);
    memoryCode.set(row.id, row);
  }
}

async function codeDelete(id: string): Promise<void> {
  memoryCode.delete(id);
  const db = await openCodeDb();
  if (!db) return;
  try {
    const tx = db.transaction(CODE_STORE, 'readwrite');
    tx.objectStore(CODE_STORE).delete(id);
    await idbCommitted(tx);
  } catch (err) {
    throw new PluginError(`it could not be deleted from this browser's storage: ${messageOf(err)}`);
  }
}

// --- Small helpers --------------------------------------------------------

/**
 * One named file out of a zip, shallowest first.
 *
 * A plugin zipped from its directory carries a `my-plugin/` prefix on
 * everything, and a plugin zipped from inside it does not. Both are what
 * somebody means by "zip up the plugin", so the basename is what is matched.
 * macOS's resource forks are dropped, because `__MACOSX/._plugin.json` is a
 * real entry in a real zip made by the Finder and it is not a manifest.
 */
function pickEntry(entries: ZipEntry[], filename: string): ZipEntry | null {
  const candidates = entries
    .filter((e) => !e.name.startsWith('__MACOSX/'))
    .filter((e) => {
      const base = e.name.slice(e.name.lastIndexOf('/') + 1);
      return base === filename && !base.startsWith('._');
    })
    .sort((a, b) => depth(a.name) - depth(b.name));
  return candidates[0] ?? null;
}

function depth(path: string): number {
  return path.split('/').length;
}

/** Every problem at once: each retry costs a round trip through the editor. */
function problemError(where: string, problems: ManifestProblem[]): PluginError {
  const lines = problems.map((p) => `  ${p.field}: ${p.message}`).join('\n');
  return new PluginError(`${where} is not a valid plugin manifest:\n${lines}`);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A missing file, as opposed to a machine that would not answer.
 *
 * Deliberately narrow, and the same test storage.ts makes: `status` is what
 * the RRF client attaches to an HTTP failure, and the text match covers a
 * driver that only has a message. Anything unrecognised counts as "unknown",
 * which costs a retry and never costs data.
 */
function looksMissing(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') return status === 404;
  return /\b404\b|not found|no such file|no such dir/i.test(messageOf(err));
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
