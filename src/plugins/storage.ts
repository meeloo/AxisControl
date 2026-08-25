// Plugin storage, keyed by domain.
//
// A domain is a reverse-DNS id naming a body of data rather than the plugin
// that made it, which is what lets a second plugin read the first one's tool
// table. Exactly one plugin owns a domain — the one that declares it in
// `provides` — and everyone else needs a grant.
//
// This module is the storage and not the guard. `openDomain` in the host realm
// opens anything; it is plugins/bridge.ts that resolves `storage.<domain>` to a
// permission and refuses a plugin that was not granted it. Keeping the check
// there rather than here means one door instead of a check per method, and it
// means the Plugins panel can show a domain's contents without having to grant
// itself access to it.
//
// Values are held as their JSON *text* rather than as objects. That costs a
// parse per read and buys two things that are worth more: the byte accounting
// is exact — the size this module reports is the size of the file it writes —
// and a plugin that mutates an object it stored, or one it read, cannot change
// what is stored. The bridge structured-clones across the frame boundary; in
// the host realm nothing would otherwise stand between two panels sharing one
// object.

import { effect } from '../core/signal.js';
import { activeDriver, appendLog, connected, controllerUrl } from '../core/store.js';
import type { MachineDriver } from '../machine/driver.js';
import { PluginError, type DomainScope, type PluginRecord } from './types.js';

/** Per domain, enforced on write. A plugin filling the quota breaks the app. */
export const DOMAIN_BYTE_CAP = 1_000_000;

/**
 * How long a `machine` domain stays quiet before its file is uploaded.
 *
 * The failure this exists for is a plugin that stores a value from a rendering
 * loop: without it, `set` on every animation frame is an HTTP POST on every
 * animation frame, the controller spends its time writing the SD card, and the
 * machine it is supposed to be running stutters. 400ms is long enough to
 * swallow a drag or a burst of typing and short enough that closing the tab
 * straight after a change still finds the write in flight.
 */
export const WRITE_DEBOUNCE_MS = 400;

/** Where `machine` domains live on the card. See docs/plugins.md for why here. */
export const DATA_DIR = '/plugins/data';

export interface DomainStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

interface Ownership {
  owner: string;
  scope: DomainScope;
}

type Subscriber = (key: string, value: unknown) => void;

interface DomainState {
  domain: string;
  scope: DomainScope;
  /** key → the value's JSON text. */
  entries: Map<string, string>;
  /** Running sum of `entryBytes`, so the cap check costs nothing per set. */
  entryBytes: number;
  /** True once the backing store has been read, or known to hold nothing. */
  loaded: boolean;
  loading: Promise<void> | null;
  /**
   * Keys deleted before the card's copy was read. Without them the merge in
   * `writeLoop` reads the file back and resurrects exactly the keys the operator
   * has just deleted.
   */
  tombstones: Set<string>;
  /** `machine` scope: changes that are not on the card yet. */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** The upload in flight, if any. There is never more than one per domain. */
  writing: Promise<void> | null;
  /** Which controller the cache belongs to; see `retarget`. */
  from: string | null;
  subs: Set<Subscriber>;
  /** Last fault reported for this domain, so a broken card says so once. */
  reported: string | null;
}

const owners = new Map<string, Ownership>();
const states = new Map<string, DomainState>();

/**
 * Rebuild the ownership map from what is installed. Called on load and after
 * any install or removal.
 *
 * A domain claimed twice keeps the FIRST claim and does not throw: this runs
 * during startup, and a manifest conflict must not be the reason the app fails
 * to come up. plugins/host.ts reports the conflict properly — it is the half
 * that knows how to refuse an install and tell the operator which two plugins
 * disagree. The line logged here is so that a conflict which slipped past
 * install (a plugin edited on the card by hand, two plugins restored together)
 * is still visible somewhere rather than silently deciding whose schema wins.
 */
export function registerDomains(records: PluginRecord[]): void {
  owners.clear();
  for (const record of records) {
    for (const spec of record.manifest.provides ?? []) {
      const held = owners.get(spec.domain);
      if (held) {
        if (held.owner !== record.manifest.id) {
          appendLog({
            level: 'warning',
            text:
              `Storage domain ${spec.domain} is claimed by both ${held.owner} and ` +
              `${record.manifest.id}; ${held.owner} keeps it.`,
            time: new Date(),
          });
        }
        continue;
      }
      // `scope` is required by the manifest validator, but this map is also
      // rebuilt from records that came off the card, so an old or hand-edited
      // manifest without one gets the documented default rather than undefined.
      owners.set(spec.domain, { owner: record.manifest.id, scope: spec.scope ?? 'machine' });
    }
  }

  // A domain that is already open keeps the backend it was opened with. Moving
  // live data from IndexedDB to the card (or back) mid-session is a migration,
  // not a re-registration, and doing it quietly is how half a domain ends up in
  // each place. Say so instead; the next reload picks up the declared scope.
  for (const st of states.values()) {
    const claimed = owners.get(st.domain);
    if (claimed && claimed.scope !== st.scope) {
      appendLog({
        level: 'warning',
        text:
          `Storage domain ${st.domain} is declared "${claimed.scope}" but was already opened ` +
          `as "${st.scope}"; it stays there until the app is reloaded.`,
        time: new Date(),
      });
    }
  }
}

export function ownerOf(domain: string): string | null {
  return owners.get(domain)?.owner ?? null;
}

/**
 * Where this domain's bytes live.
 *
 * `machine` is the default *in a manifest* — see docs/plugins.md — but that
 * default belongs to a domain somebody has declared. An undeclared domain is a
 * typo in a `uses` entry, a scratch domain from a plugin still being written,
 * or data whose owner was uninstalled a moment ago, and none of those has
 * earned a file on the operator's card: nothing installed could explain it,
 * and this module cannot clean it up because it cannot tell rubbish from data
 * whose plugin is merely not installed today. The browser is where unclaimed
 * data can be lost without anybody minding, and it costs no round trip to the
 * machine to find out there was nothing there.
 */
export function scopeOf(domain: string): DomainScope {
  return owners.get(domain)?.scope ?? 'browser';
}

/**
 * `machine` scope lives at `/plugins/data/<domain>.json` on the controller's
 * card and follows the machine; `browser` scope lives in IndexedDB and is gone
 * when someone clears site data. Writes to the card are debounced and
 * coalesced — a plugin setting a value per frame must not become an HTTP
 * request per frame.
 *
 * Cheap and synchronous: every handle for one domain shares one cache and one
 * subscriber list, which is what makes a change made through one handle visible
 * through another.
 */
export function openDomain(domain: string): DomainStore {
  const st = stateFor(domain);
  return {
    async get(key: string): Promise<unknown> {
      await ensureLoaded(st);
      const json = st.entries.get(key);
      return json === undefined ? undefined : JSON.parse(json);
    },

    async set(key: string, value: unknown): Promise<void> {
      await ensureLoaded(st);
      const json = JSON.stringify(value);
      // JSON.stringify answers `undefined` for undefined, a function or a
      // symbol. Storing it would drop the key on the way out and produce a
      // domain whose contents change when it is written rather than when it is
      // set, which is a bug nobody would look for here.
      if (json === undefined) {
        throw new PluginError(
          `${domain}: the value for "${key}" cannot be stored — ${describe(value)} is not JSON.`,
        );
      }

      const had = st.entries.get(key);
      const sum = st.entryBytes - (had === undefined ? 0 : entryBytes(key, had)) + entryBytes(key, json);
      const count = st.entries.size + (had === undefined ? 1 : 0);
      const after = objectBytes(sum, count);
      // Refused, not trimmed and not dropped. A plugin told its write succeeded
      // when it did not will go on building on data that is not there, and the
      // operator finds out when the tool table is short of three tools.
      if (after > DOMAIN_BYTE_CAP) {
        throw new PluginError(
          `${domain} is limited to ${DOMAIN_BYTE_CAP} bytes: storing "${key}" would take it ` +
            `to ${after}. Nothing was stored.`,
        );
      }

      st.entries.set(key, json);
      st.entryBytes = sum;
      st.tombstones.delete(key);
      notify(st, key, json);
      await persist(st, key, json);
    },

    async delete(key: string): Promise<void> {
      await ensureLoaded(st);
      const had = st.entries.get(key);
      if (had === undefined) return;
      st.entries.delete(key);
      st.entryBytes -= entryBytes(key, had);
      // Only meaningful while the card's copy is unread; `writeLoop` merges that
      // copy in before it uploads, and this is what stops it coming back.
      if (!st.loaded) st.tombstones.add(key);
      notify(st, key, undefined);
      await persist(st, key, undefined);
    },

    async keys(): Promise<string[]> {
      await ensureLoaded(st);
      return [...st.entries.keys()];
    },
  };
}

/** Fires in every frame with read access, which is how two panels share. */
export function subscribeDomain(domain: string, cb: (key: string, value: unknown) => void): () => void {
  const st = stateFor(domain);
  st.subs.add(cb);
  return () => {
    st.subs.delete(cb);
  };
}

/**
 * How many bytes this domain would occupy as a file — the same number the cap
 * is checked against, and the same number that lands on the card.
 */
export async function domainUsage(domain: string): Promise<number> {
  const st = stateFor(domain);
  await ensureLoaded(st);
  return objectBytes(st.entryBytes, st.entries.size);
}

/**
 * Removing a plugin offers this separately: the data may outlive the plugin.
 *
 * Throws for a `machine` domain with nothing connected, rather than reporting
 * a deletion that did not happen: the operator answered a question about
 * destroying their data, and "yes" has to mean it is gone or say why not.
 */
export async function deleteDomain(domain: string): Promise<void> {
  const st = states.get(domain);
  const scope = st?.scope ?? scopeOf(domain);

  if (st) {
    // Stop anything queued before the file goes, or the debounced upload lands
    // a moment after the delete and puts the whole domain back.
    st.dirty = false;
    if (st.timer !== null) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.writing) await st.writing;
  }

  if (scope === 'machine') {
    const driver = activeDriver();
    if (!driver) {
      throw new PluginError(
        `${domain} is stored on the machine; connect to it to delete the data at ${pathFor(domain)}.`,
      );
    }
    try {
      await driver.deleteFile(pathFor(domain));
    } catch (err) {
      // RRF answers "there was no such file" and "the delete failed" with the
      // same error, and a domain that was never written has no file — which is
      // the commonest case here, because the operator is asked about the data
      // whether or not the plugin ever stored any. So ask the card which one it
      // was rather than guessing: gone is the outcome that was wanted, still
      // there has to be reported.
      if (await stillOnCard(driver, domain)) throw err;
    }
  } else {
    await browserClear(domain);
  }

  if (st) {
    const keys = [...st.entries.keys()];
    st.entries.clear();
    st.entryBytes = 0;
    st.tombstones.clear();
    // Loaded and empty: there is nothing left to read back, and a re-read would
    // only find the file we have just deleted if the controller cached it.
    st.loaded = true;
    for (const key of keys) notify(st, key, undefined);
  }
}

/**
 * Flush any debounced card writes. Called before the app tears down.
 *
 * `browser` domains have nothing to flush — an IndexedDB write is awaited by
 * `set` itself, because it is local and there is no round trip to spare the
 * machine.
 */
export async function flushDomains(): Promise<void> {
  // A subscriber that writes when it is told about a write can dirty a domain
  // while the flush is running. Bounded rather than looped forever: this is a
  // teardown path, and it is a promise to write what is outstanding, not to
  // outrun a plugin that never stops.
  for (let pass = 0; pass < 3; pass++) {
    const waits: Promise<void>[] = [];
    for (const st of states.values()) {
      if (st.scope !== 'machine') continue;
      if (st.timer !== null) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      if (st.dirty || st.writing) waits.push(pump(st));
    }
    if (waits.length === 0) return;
    await Promise.all(waits);
  }
}

// --- Domain state ---------------------------------------------------------

function stateFor(domain: string): DomainState {
  let st = states.get(domain);
  if (st) return st;
  st = {
    domain,
    scope: scopeOf(domain),
    entries: new Map(),
    entryBytes: 0,
    loaded: false,
    loading: null,
    tombstones: new Set(),
    dirty: false,
    timer: null,
    writing: null,
    from: null,
    subs: new Set(),
    reported: null,
  };
  states.set(domain, st);
  return st;
}

/**
 * Deliver a change to this domain's subscribers.
 *
 * Through `queueMicrotask` so that a subscriber runs after the write that
 * caused it has finished touching the cache. Delivered synchronously, a
 * subscriber that writes back would re-enter `set` half way through its own
 * accounting; delivered here, the worst it can do is queue another change.
 *
 * The JSON is parsed once per subscriber rather than once per change, so two
 * panels reading the same key do not end up holding the same object — one of
 * them mutating it would otherwise change what the other one sees, without
 * either having written anything.
 */
function notify(st: DomainState, key: string, json: string | undefined): void {
  for (const cb of st.subs) {
    queueMicrotask(() => {
      // It may have unsubscribed between the change and this microtask — a
      // panel being torn down is exactly when that happens.
      if (!st.subs.has(cb)) return;
      try {
        cb(key, json === undefined ? undefined : JSON.parse(json));
      } catch (err) {
        appendLog({
          level: 'error',
          text: `storage subscriber for ${st.domain} threw: ${(err as Error).message}`,
          time: new Date(),
        });
      }
    });
  }
}

function ensureLoaded(st: DomainState): Promise<void> {
  if (st.loaded) return Promise.resolve();
  if (st.loading) return st.loading;
  const done = (st.scope === 'machine' ? loadFromCard(st) : loadFromBrowser(st)).finally(() => {
    // Cleared rather than kept: a load that failed because nothing was
    // connected has to be retried when something is, and a memoised rejection
    // would make the domain permanently empty for the life of the tab.
    st.loading = null;
  });
  st.loading = done;
  return done;
}

async function loadFromCard(st: DomainState): Promise<void> {
  const driver = activeDriver();
  // Not an error and not empty: unknown. `get` answers undefined, `set` keeps
  // the value in memory, and the effect at the bottom of this file loads and
  // uploads once a machine is there.
  if (!driver) return;

  const path = cardPath(st);
  if (path === null) return;

  st.from = controllerUrl.peek();
  let text: string;
  try {
    text = new TextDecoder().decode(await driver.readFile(path));
  } catch (err) {
    if (looksMissing(err)) {
      // No file yet. That is a domain nobody has written to, which is the
      // ordinary first-run case and not worth a word in the console.
      st.loaded = true;
      return;
    }
    // Anything else leaves the domain unloaded on purpose. `writeLoop` refuses to
    // upload over a file it could not read, because replacing an unreadable
    // file with a memory image is the one way this module can destroy an
    // operator's data.
    report(st, `could not read ${path}: ${(err as Error).message}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch (err) {
    report(st, `${path} is not JSON: ${(err as Error).message}`);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    report(st, `${path} does not hold a JSON object; ignoring it.`);
    return;
  }

  for (const [key, value] of Object.entries(parsed)) {
    // A value written in this session is newer than the card's, and a key
    // deleted in this session must stay deleted. Both cases exist because a
    // plugin is allowed to write before the file has been read.
    if (st.entries.has(key) || st.tombstones.has(key)) continue;
    const json = JSON.stringify(value);
    if (json === undefined) continue;
    st.entries.set(key, json);
    st.entryBytes += entryBytes(key, json);
  }
  st.loaded = true;
}

async function loadFromBrowser(st: DomainState): Promise<void> {
  for (const [key, json] of await browserRows(st.domain)) {
    if (st.entries.has(key) || st.tombstones.has(key)) continue;
    st.entries.set(key, json);
    st.entryBytes += entryBytes(key, json);
  }
  st.loaded = true;
}

/** One changed key on its way to wherever the domain lives. */
async function persist(st: DomainState, key: string, json: string | undefined): Promise<void> {
  if (st.scope === 'machine') {
    st.dirty = true;
    if (st.timer !== null) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      void pump(st);
    }, WRITE_DEBOUNCE_MS);
    return;
  }
  if (json === undefined) await browserDelete(st.domain, key);
  else await browserPut(st.domain, key, json);
}

/**
 * Upload a `machine` domain, at most one upload at a time.
 *
 * Re-entrant callers get the upload that is already running rather than a
 * second one: the whole file is written every time, so an upload started now
 * carries everything a second one would, and two POSTs of the same file racing
 * each other on the card is a way to end up with neither.
 */
function pump(st: DomainState): Promise<void> {
  if (st.writing) return st.writing;
  if (!st.dirty) return Promise.resolve();

  // `writeLoop` can return without ever awaiting — nothing connected is exactly
  // that case — so the promise is stored here rather than by the loop itself,
  // and cleared from a `finally`, which never runs synchronously. Clearing it
  // from inside the loop would install an already-finished promise as "the
  // write in flight", and every pump after that would hand back a resolved
  // promise instead of writing anything. That failure is silent, survives
  // reconnection, and is why this is spelled out.
  const running = writeLoop(st).finally(() => {
    if (st.writing === running) st.writing = null;
  });
  st.writing = running;
  return running;
}

async function writeLoop(st: DomainState): Promise<void> {
  while (st.dirty) {
    const driver = activeDriver();
    // Stays dirty. The data is in memory and the effect below hands it to the
    // next driver that connects.
    if (!driver) return;

    const path = cardPath(st);
    if (path === null) {
      // Not writable and never will be — a manifest declared a domain whose
      // name cannot be a file. Dropped rather than retried forever; cardPath
      // has already said so in the console.
      st.dirty = false;
      return;
    }

    // Merge first. Uploading a cache that never held the card's copy replaces
    // another browser's writes — or this browser's, from before a reconnect —
    // with silence.
    await ensureLoaded(st);
    if (!st.loaded) return;

    // Cleared before the await, so a write that arrives during the upload sets
    // it again and gets an upload of its own.
    st.dirty = false;
    const body = new TextEncoder().encode(serialise(st));
    try {
      await ensureDataDir(driver);
      await driver.writeFile(path, body);
      st.reported = null;
    } catch (err) {
      st.dirty = true;
      report(st, `saving ${path}: ${(err as Error).message}`);
      return;
    }
  }
}

/**
 * The domain's file, or null when the domain cannot have one.
 *
 * `pathFor` throws for a name that is not reverse-DNS, and both callers reach
 * it from a plugin's `set` — which must not blow up in the plugin's face for a
 * manifest the operator has already installed. Reported once and refused
 * quietly here instead; the install is where a bad domain name should have been
 * caught.
 */
function cardPath(st: DomainState): string | null {
  try {
    return pathFor(st.domain);
  } catch (err) {
    report(st, (err as Error).message);
    return null;
  }
}

let dataDirEnsured = false;

async function ensureDataDir(driver: MachineDriver): Promise<void> {
  if (dataDirEnsured) return;
  // RRF's mkdir makes one level and answers an error for a directory that is
  // already there, so both calls are attempted and neither failure means
  // anything. The upload that follows is what reports a real problem.
  for (const dir of ['/plugins', DATA_DIR]) {
    try {
      await driver.makeDirectory(dir);
    } catch {
      /* already there, or the controller does not need it */
    }
  }
  dataDirEnsured = true;
}

/** Is the domain's file still on the card? Used to read a delete's real outcome. */
async function stillOnCard(driver: MachineDriver, domain: string): Promise<boolean> {
  const name = `${domain}.json`;
  try {
    return (await driver.listFiles(DATA_DIR)).some((e) => !e.directory && e.name === name);
  } catch (err) {
    // No directory at all is no file at all. Anything else is an answer that
    // did not arrive, and the caller must not be told the data is gone on the
    // strength of a question the machine refused.
    return !looksMissing(err);
  }
}

/** Say it once per domain: a card that cannot be read fails on every call. */
function report(st: DomainState, what: string): void {
  if (st.reported === what) return;
  st.reported = what;
  appendLog({ level: 'warning', text: `Plugin storage: ${what}`, time: new Date() });
}

/**
 * A missing file, as opposed to a machine that would not answer.
 *
 * The distinction decides whether an unreadable domain is treated as empty, so
 * it is deliberately narrow: `status` is what the RRF client attaches to an
 * HTTP failure, and the text match covers a driver that only has a message.
 * Anything this cannot recognise is treated as "unknown", which costs a retry
 * and never costs data.
 */
function looksMissing(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') return status === 404;
  return /\b404\b|not found|no such file/i.test((err as Error)?.message ?? '');
}

function describe(value: unknown): string {
  return value === undefined ? 'undefined' : typeof value;
}

// --- Sizes and paths ------------------------------------------------------

/**
 * Bytes one entry contributes to the serialised object: `"key":value`.
 *
 * Kept per entry and summed so that `set` does not serialise the whole domain
 * to find out whether one more key fits — which is the operation a plugin
 * writing every frame would be paying for.
 */
function entryBytes(key: string, json: string): number {
  return utf8Length(JSON.stringify(key)) + 1 + utf8Length(json);
}

/** The braces and the commas around `sum` bytes of `count` entries. */
function objectBytes(sum: number, count: number): number {
  return 2 + sum + Math.max(0, count - 1);
}

function serialise(st: DomainState): string {
  const parts: string[] = [];
  for (const [key, json] of st.entries) parts.push(`${JSON.stringify(key)}:${json}`);
  return `{${parts.join(',')}}`;
}

/**
 * UTF-8 length without allocating an encoder's worth of bytes.
 *
 * Only ever called on `JSON.stringify` output, which matters for the surrogate
 * case: stringify escapes a lone surrogate as `\udXXX`, six ASCII characters,
 * so every surrogate this sees is half of a genuine pair and is worth four
 * bytes across the two halves.
 */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * The file a `machine` domain is written to.
 *
 * The domain is checked rather than trusted: it arrives from a manifest, which
 * arrived in a zip from somebody's website, and a "domain" of
 * `../../sys/config` would send this straight at the machine's own
 * configuration. Reverse-DNS is letters, digits, dots, dashes and underscores,
 * and nothing else needs to be allowed.
 */
export function pathFor(domain: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(domain) || domain.includes('..')) {
    throw new PluginError(`"${domain}" is not a usable storage domain name.`);
  }
  return `${DATA_DIR}/${domain}.json`;
}

// --- The browser backend --------------------------------------------------
//
// One database, one object store, keyed `<domain>/<key>`. Split at the FIRST
// slash: a domain is reverse-DNS and has none in it, while a key is whatever a
// plugin chose and may well have several.

const IDB_NAME = 'axiscontrol-plugins';
const IDB_STORE = 'domains';

let idb: Promise<IDBDatabase | null> | null = null;
let idbFaultLogged = false;

/**
 * The fallback when IndexedDB is not available.
 *
 * Private browsing refuses to open a database, a browser with site data
 * blocked throws from `indexedDB.open` itself, and a full quota fails the
 * transaction. None of those is a reason for the app that drives the spindle to
 * stop working, so the domain becomes a Map for the session: the plugin's
 * preferences are correct while the tab is open and gone afterwards, which is
 * the same promise `browser` scope makes anyway, only shorter.
 */
const memoryRows = new Map<string, string>();

function rowKey(domain: string, key: string): string {
  return `${domain}/${key}`;
}

function idbUnavailable(why: string): void {
  if (idbFaultLogged) return;
  idbFaultLogged = true;
  appendLog({
    level: 'warning',
    text: `Plugin storage: ${why}. Browser-scoped plugin data is kept in memory for this session only.`,
    time: new Date(),
  });
}

function openIdb(): Promise<IDBDatabase | null> {
  if (idb) return idb;
  idb = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      idbUnavailable('this environment has no IndexedDB');
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch (err) {
      // Throwing synchronously is what a browser configured to block site data
      // does, and it is the one failure mode a promise wrapper alone misses.
      idbUnavailable(`IndexedDB refused to open (${(err as Error).message})`);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      idbUnavailable(`IndexedDB would not open (${req.error?.message ?? 'no reason given'})`);
      resolve(null);
    };
    req.onblocked = () => {
      // Another tab is holding an older version open. Waiting for it would hang
      // every storage call in this tab, so take the memory fallback and say so.
      idbUnavailable('another tab is holding the plugin database open');
      resolve(null);
    };
  });
  return idb;
}

/** Promise-wrap one request. IndexedDB is events; everything above here is not. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

async function browserRows(domain: string): Promise<Array<[string, string]>> {
  const prefix = `${domain}/`;
  const db = await openIdb();
  if (!db) {
    return [...memoryRows]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k.slice(prefix.length), v] as [string, string]);
  }
  try {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    // \uffff sorts above anything a key can start with, so the bound range is
    // every row of this domain and no row of the domain that sorts next.
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const keys = (await request(store.getAllKeys(range))) as IDBValidKey[];
    const values = (await request(store.getAll(range))) as string[];
    return keys.map((k, i) => [String(k).slice(prefix.length), values[i]] as [string, string]);
  } catch (err) {
    idbUnavailable(`IndexedDB read failed (${(err as Error).message})`);
    return [];
  }
}

async function browserPut(domain: string, key: string, json: string): Promise<void> {
  const db = await openIdb();
  if (!db) {
    memoryRows.set(rowKey(domain, key), json);
    return;
  }
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(json, rowKey(domain, key));
    await committed(tx);
  } catch (err) {
    // Quota, usually. The value is already in the domain's cache, so keeping it
    // in the fallback map means this session behaves and only persistence is
    // lost — which is what the operator is told.
    idbUnavailable(`IndexedDB write failed (${(err as Error).message})`);
    memoryRows.set(rowKey(domain, key), json);
  }
}

async function browserDelete(domain: string, key: string): Promise<void> {
  memoryRows.delete(rowKey(domain, key));
  const db = await openIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(rowKey(domain, key));
    await committed(tx);
  } catch (err) {
    idbUnavailable(`IndexedDB delete failed (${(err as Error).message})`);
  }
}

async function browserClear(domain: string): Promise<void> {
  const prefix = `${domain}/`;
  for (const k of [...memoryRows.keys()]) if (k.startsWith(prefix)) memoryRows.delete(k);
  const db = await openIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    await committed(tx);
  } catch (err) {
    idbUnavailable(`IndexedDB delete failed (${(err as Error).message})`);
  }
}

// --- Following the machine ------------------------------------------------

/**
 * Hand queued writes to a driver as soon as there is one, and drop a cache that
 * belongs to a different machine.
 *
 * A module-level effect with no disposal, deliberately: this is the app's one
 * storage layer and it lives as long as the tab. Without it, everything a
 * plugin wrote while the controller was unreachable would sit in memory until
 * something else happened to write to the same domain — which for a plugin that
 * saves once, at the end of a job, is never.
 */
effect(() => {
  if (!connected.get()) {
    // The next connection may be a different board, and a directory that was
    // there on the last one proves nothing about this one.
    dataDirEnsured = false;
    return;
  }
  const url = controllerUrl.peek();
  for (const st of states.values()) {
    if (st.scope !== 'machine') continue;
    if (st.from !== null && st.from !== url) retarget(st, url);
    if (st.dirty) void pump(st);
  }
});

/**
 * The operator typed a different address in the top bar.
 *
 * Everything cached belongs to the machine that has just gone away, so it is
 * dropped rather than uploaded: writing one machine's tool table onto another
 * machine is worse than losing an unsaved change, and there is no way to ask
 * which was meant. An unsaved change is worth a line in the console, because
 * the plugin that made it was told it was stored.
 */
function retarget(st: DomainState, url: string): void {
  if (st.dirty) {
    appendLog({
      level: 'warning',
      text: `Plugin storage: unsaved ${st.domain} data was not written to ${st.from} and is being discarded.`,
      time: new Date(),
    });
  }
  st.entries.clear();
  st.entryBytes = 0;
  st.tombstones.clear();
  st.dirty = false;
  st.loaded = false;
  st.from = url;
  if (st.timer !== null) {
    clearTimeout(st.timer);
    st.timer = null;
  }
}
