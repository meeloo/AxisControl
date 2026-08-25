// The Plugins panel: what is installed, what it is allowed to do, and the
// editor you write the next one in.
//
// Two jobs that would be separate panels anywhere else, together on purpose.
// docs/plugins.md's argument is that a plugin system is used only if trying an
// idea takes a minute, and a minute means: press New plugin, get something
// that runs, change a line, press Save, watch the frame come back. Splitting
// the list from the editor would put a navigation between every step of that.
//
// The panel is also the only place a refusal is visible. A plugin denied a
// permission does not crash — it gets a rejected promise, and a plugin whose
// author did not handle it does nothing at all, quietly, for ever. So the log
// pane is not a debugging extra down at the bottom: it is the answer to "why
// is this plugin doing nothing", and denials are in it by default.

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { connected } from '../core/store.js';
import { formatBytes } from '../core/util.js';
import type { PluginLogLine } from '../plugins/bridge.js';
import {
  clearPluginLog,
  installFromBytes,
  installFromSource,
  pluginLog,
  plugins,
  recordFor,
  reload,
  remove,
  saveSource,
  setEnabled,
} from '../plugins/host.js';
import {
  describePermission,
  manifestFromHeader,
  permissionsOf,
  type ManifestProblem,
} from '../plugins/manifest.js';
import { grantedFor } from '../plugins/permissions.js';
import { DOMAIN_BYTE_CAP, domainUsage } from '../plugins/storage.js';
import type { PluginRecord, PluginSource } from '../plugins/types.js';
// Defines <cnc-plugin-panel>, which every plugin's own panel is built from.
// Imported here rather than in panels/index.ts so that the two halves of the
// plugin UI arrive together: a plugin installed from this panel registers a
// panel definition immediately, and the layout builds it by tag name.
import './plugin-panel.js';

/** Bytes of the domain cap, as a round figure for the storage line. */
const CAP_LABEL = formatBytes(DOMAIN_BYTE_CAP);

/**
 * The two prefixes plugins/bridge.ts starts a refusal with.
 *
 * Matching on the text rather than on a level is not lovely, but the
 * alternative is a level of its own on the wire, and PluginLogLine is shared
 * with the frame's own `console.error` — which is where a plugin's real errors
 * arrive, and which the operator wants to see separately from the calls the
 * app refused to make. Both prefixes are asserted in tools/plugin-bridge-check.
 */
const REFUSAL = /^(denied|refused):/;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Put text on the clipboard, on a machine that may have no clipboard API.
 *
 * `navigator.clipboard` exists only in a secure context, and the deployment
 * this whole project is built around is a controller serving plain http over
 * the workshop LAN — so on the machine that matters most it is simply not
 * there. The textarea below is what works there, and it is the fallback rather
 * than the only path because execCommand is on its way out everywhere else.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A permissions policy, or a document that is not focused. Fall through.
  }
  const box = document.createElement('textarea');
  box.value = text;
  // Off screen but rendered: a hidden element cannot hold a selection, and one
  // in the flow would scroll the panel out from under whoever pressed Copy.
  box.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
  document.body.appendChild(box);
  box.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  box.remove();
  return ok;
}

/**
 * The example a new plugin starts as.
 *
 * This is the documentation most people will read, so it is written to be
 * copied from rather than to be short: every call it makes is one somebody
 * will want, and the comments say the thing that is not obvious from the line
 * underneath. It must RUN with no machine connected — a scaffold whose first
 * impression is an error teaches that the system is broken — which is why the
 * counter's domain is `browser` scope and why the position table says what it
 * is waiting for.
 *
 * ES5-ish on purpose: `var`, no arrow functions, no template literals. The
 * frame is a real browsing context in whatever browser the operator has, and
 * on this project that includes an iPad old enough to matter. It also keeps
 * this literal free of `${`, so the substitution below is only ever the id.
 */
function scaffoldSource(id: string): string {
  return `/* @plugin {
  "id": "${id}",
  "name": "Hello",
  "version": "1.0.0",
  "api": 1,
  "description": "A starting point: the live position, and a counter that outlives a reload.",
  "panel": { "title": "Hello", "width": 3, "height": 300 },
  "permissions": ["machine.read"],
  "provides": [{ "domain": "${id}", "scope": "browser" }]
} */

// Everything this plugin can reach is on \`axis\`. There is no parent window,
// no fetch and no localStorage in here: the frame has an opaque origin and the
// browser itself refuses all three. What you need, you ask for by name in the
// "permissions" list above, and the operator grants it once.
//
// Edit this file in the Plugins panel and press Save. The frame is torn down
// and built again: whatever is in a variable is lost, whatever is in storage
// is not.

// --- the panel -------------------------------------------------------------

// This is the frame's own document, and the app has already forwarded its
// theme into it as CSS custom properties — so var(--text-dim) here is the same
// grey as the panel next door, in either theme, without asking.
var root = document.createElement('div');
document.body.appendChild(root);

var heading = document.createElement('h1');
heading.textContent = 'Hello';
root.appendChild(heading);

var statusLine = document.createElement('p');
statusLine.className = 'dim';
statusLine.textContent = 'Waiting for the machine…';
root.appendChild(statusLine);

var table = document.createElement('table');
root.appendChild(table);

// --- the live position -----------------------------------------------------

// One row per axis, kept and rewritten rather than rebuilt. The state arrives
// several times a second, and replacing the table each time would throw away
// the selection of anyone trying to copy a number out of it.
var rows = {};

function rowFor(letter) {
  if (rows[letter]) return rows[letter];
  var tr = document.createElement('tr');
  var name = document.createElement('th');
  name.textContent = letter;
  var work = document.createElement('td');
  work.className = 'mono';
  var machine = document.createElement('td');
  machine.className = 'mono dim';
  tr.appendChild(name);
  tr.appendChild(work);
  tr.appendChild(machine);
  table.appendChild(tr);
  rows[letter] = { work: work, machine: machine };
  return rows[letter];
}

function show(state) {
  statusLine.textContent = state.status + ' · work / machine, mm';
  for (var i = 0; i < state.axes.length; i++) {
    var axisState = state.axes[i];
    var cells = rowFor(axisState.letter);
    cells.work.textContent = axisState.work.toFixed(3);
    cells.machine.textContent = axisState.machine.toFixed(3);
  }
}

// subscribe() answers a promise of the function that stops it, and the first
// state arrives without waiting for the machine to move — so there is
// something on screen straight away. Refusing the "machine.read" permission
// would reject this promise instead, which is why it has a second branch: a
// plugin that silently does nothing is the worst thing this system can produce.
var stopWatching = null;
var wanted = true;
axis.machine.subscribe(show).then(
  function (off) {
    if (wanted) stopWatching = off;
    else off();
  },
  function (err) {
    statusLine.textContent = 'No machine state: ' + err.message;
  }
);

// --- storage ---------------------------------------------------------------

// A domain names a body of data rather than the plugin that made it, which is
// what lets another plugin read this one's numbers one day. This plugin owns
// the domain it declared above, so it needs no permission for it; reading
// somebody else's takes a "uses" entry in the manifest and a grant.
//
// "browser" scope keeps this in IndexedDB, here, which is right for a count of
// clicks and wrong for anything you would mind losing when site data is
// cleared. Change it to "machine" and the file lives on the controller's card
// and follows the machine to the next laptop.
var store = null;
var clicks = 0;

var button = document.createElement('button');
button.className = 'primary';
button.disabled = true;
button.textContent = 'Counting…';
root.appendChild(button);

function label() {
  button.textContent = clicks === 1 ? 'Clicked once' : 'Clicked ' + clicks + ' times';
}

axis.storage.open('${id}').then(function (opened) {
  store = opened;
  return store.get('clicks');
}).then(function (saved) {
  clicks = typeof saved === 'number' ? saved : 0;
  button.disabled = false;
  label();
}, function (err) {
  button.textContent = 'No storage: ' + err.message;
});

button.addEventListener('click', function () {
  clicks = clicks + 1;
  label();
  // Writes are debounced and coalesced, so a run of clicks costs one write
  // rather than one each. Press Reload in the Plugins panel and the count
  // comes back: the frame is rebuilt, the data is not.
  if (store) {
    store.set('clicks', clicks).catch(function (err) {
      axis.log.error('could not save the count: ' + err.message);
    });
  }
});

// --- lifecycle -------------------------------------------------------------

// Runs when this frame's panel is going away. Nothing inside the frame needs
// tidying — the whole document goes with it — but anything the plugin holds
// outside itself, a subscription included, should be let go of here.
axis.ui.onUnmount(function () {
  wanted = false;
  if (stopWatching) stopWatching();
});

axis.log.info('hello from ${id}');
`;
}

export class PluginsPanel extends PanelElement {
  /** The plugin whose source is in the editor and whose log is shown. */
  private selected = '';
  private source = '';
  /**
   * The text the last successful save wrote.
   *
   * Not "the text in the box when the save finished". Somebody goes on typing
   * while a write to the card is in flight, and comparing the box against
   * itself afterwards marks those keystrokes saved — they are then lost at the
   * next reload with the dot that would have warned about it already cleared.
   * panels/files.ts has exactly that bug; this is the shape that does not.
   */
  private saved = '';
  private saving = false;

  private pasted = '';
  /** null means "wherever makes sense", which depends on being connected. */
  private target: PluginSource | null = null;

  private busy: string | null = null;
  private error: string | null = null;
  private done: string | null = null;

  /** The plugin whose removal is being confirmed, and the answer so far. */
  private removing = '';
  private removeData = false;

  /** Domain → bytes, or null for one that could not be read. */
  private usage = new Map<string, number | null>();
  private measuring = new Set<string>();

  private denialsOnly = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      plugins.get();
      pluginLog.get();
      connected.get();
    });
  }

  protected override updated(): void {
    this.adoptExternalEdits();
    this.measureStorage();
  }

  // --- the editor's copy of the source -------------------------------------

  private get dirty(): boolean {
    return this.selected !== '' && this.source !== this.saved;
  }

  private select(id: string): void {
    const record = recordFor(id);
    this.selected = id;
    this.source = record?.code ?? '';
    this.saved = this.source;
    this.error = null;
    this.done = null;
    this.requestUpdate();
  }

  /**
   * Follow the record when its bytes changed somewhere else.
   *
   * A plugin can be edited on the card, reinstalled, or replaced by a refresh
   * on reconnect while its source is open here. Leaving the old text in the
   * box would mean the next Save wrote bytes the operator never chose over
   * bytes they never saw.
   *
   * Only when the box is clean. Adopting over an unsaved edit would throw away
   * typing, which is worse than showing a stale copy — and the dot in the
   * title bar says the copy is theirs.
   */
  private adoptExternalEdits(): void {
    if (!this.selected || this.dirty) return;
    const record = recordFor(this.selected);
    if (!record || record.code === this.saved) return;
    this.source = record.code;
    this.saved = record.code;
    this.requestUpdate();
  }

  /**
   * What is wrong with the manifest in the box, as they type.
   *
   * Only when the source carries an `@plugin` header, which is the same test
   * host.saveSource applies: a plugin installed from a zip keeps its manifest
   * in plugin.json beside the code, and reporting "no @plugin header" against
   * every one of those would be a permanent error message about nothing.
   */
  private get problems(): ManifestProblem[] {
    if (!this.selected || !this.source.includes('@plugin')) return [];
    return manifestFromHeader(this.source).problems;
  }

  private async save(): Promise<void> {
    const id = this.selected;
    if (!id || this.saving) return;
    // Snapshot first, and compare against the snapshot afterwards. See `saved`.
    const snapshot = this.source;
    this.saving = true;
    this.error = null;
    this.done = null;
    this.requestUpdate();
    try {
      // saveSource writes the bytes, re-reads the header, re-hashes — so a
      // header that widened its permissions asks again — and reloads every
      // frame this plugin has open. That is the whole edit loop, in one call.
      await saveSource(id, snapshot);
      this.saved = snapshot;
      this.done = `Saved and reloaded ${id}`;
    } catch (err) {
      this.error = messageOf(err);
    } finally {
      this.saving = false;
      this.requestUpdate();
    }
  }

  // --- installing ----------------------------------------------------------

  private get installTarget(): PluginSource {
    // A plugin on the card follows the machine, which is what most people
    // want; but with nothing connected there is nowhere to write it, and a
    // default that always fails is not a default.
    return this.target ?? (connected.get() ? 'machine' : 'browser');
  }

  private async run(label: string, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = label;
    this.error = null;
    this.done = null;
    this.requestUpdate();
    try {
      await work();
    } catch (err) {
      this.error = messageOf(err);
    } finally {
      this.busy = null;
      this.requestUpdate();
    }
  }

  private onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared straight away, so choosing the same file twice — which is what
    // somebody does after fixing it — fires change the second time too.
    input.value = '';
    if (!file) return;
    void this.run(`Install ${file.name}`, async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const record = await installFromBytes(bytes, file.name, this.installTarget);
      this.installed(record);
    });
  }

  private installPasted(): void {
    const code = this.pasted;
    if (!code.trim()) return;
    void this.run('Install pasted source', async () => {
      const record = await installFromSource(code, this.installTarget);
      this.pasted = '';
      this.installed(record);
    });
  }

  /**
   * An id nothing is using.
   *
   * `com.example` because it is reserved for exactly this and cannot collide
   * with anybody's real reverse-DNS name. The suffix counts up rather than
   * using a timestamp: somebody making three throwaway plugins in an afternoon
   * should be able to tell them apart in a list.
   */
  private freshId(): string {
    const base = 'com.example.hello';
    if (!recordFor(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const id = `${base}-${n}`;
      if (!recordFor(id)) return id;
    }
    return `${base}-${Date.now()}`;
  }

  private newPlugin(): void {
    void this.run('New plugin', async () => {
      const id = this.freshId();
      const record = await installFromSource(scaffoldSource(id), this.installTarget);
      this.installed(record);
    });
  }

  private installed(record: PluginRecord): void {
    this.select(record.manifest.id);
    this.done =
      `Installed ${record.manifest.name} ${record.manifest.version}` +
      (record.manifest.panel
        ? ` — add its panel with the + on any page. It will ask for what it needs the first time it opens.`
        : '');
  }

  // --- storage figures ------------------------------------------------------

  /**
   * How much each declared domain is holding.
   *
   * Read once per domain and cached, because a `machine`-scope domain is a
   * file on the card: measuring it on every render would put an HTTP request
   * behind every keystroke in the editor above. The ⟳ on a plugin's storage
   * line is how it is asked again.
   */
  private measureStorage(): void {
    const live = connected.peek();
    for (const record of plugins.peek()) {
      for (const spec of record.manifest.provides ?? []) {
        // A `machine` domain that has not been read off the card measures as
        // nought — plugins/storage.ts leaves it unloaded rather than failing,
        // so that a write made offline is still uploaded later — and "0 bytes"
        // against a domain holding a tool table reads as data that has been
        // lost. Left unmeasured until there is a card to measure.
        if (spec.scope === 'machine' && !live) continue;
        if (this.usage.has(spec.domain) || this.measuring.has(spec.domain)) continue;
        this.measuring.add(spec.domain);
        void domainUsage(spec.domain).then(
          (bytes) => this.recordUsage(spec.domain, bytes),
          // Null, not zero. A domain on a card nobody is connected to is a
          // domain of unknown size, and showing "0 bytes" for it would read as
          // data that has been lost.
          () => this.recordUsage(spec.domain, null),
        );
      }
    }
  }

  private recordUsage(domain: string, bytes: number | null): void {
    this.measuring.delete(domain);
    this.usage.set(domain, bytes);
    this.requestUpdate();
  }

  private forgetUsage(record: PluginRecord): void {
    for (const spec of record.manifest.provides ?? []) this.usage.delete(spec.domain);
    this.requestUpdate();
  }

  // --- the log --------------------------------------------------------------

  private get logLines(): PluginLogLine[] {
    const lines = pluginLog.get();
    const mine = this.selected ? lines.filter((l) => l.pluginId === this.selected) : lines;
    return this.denialsOnly ? mine.filter((l) => REFUSAL.test(l.text)) : mine;
  }

  private copyLog(): void {
    const lines = this.logLines;
    if (!lines.length) return;
    const text = lines
      .map((l) => `${l.time.toISOString()} ${l.level} ${l.pluginId}: ${l.text}`)
      .join('\n');
    void copyText(text).then((ok) => {
      this.done = ok ? `Copied ${lines.length} log lines` : null;
      this.error = ok ? null : 'This browser would not let the page write to the clipboard.';
      this.requestUpdate();
    });
  }

  // --- render ---------------------------------------------------------------

  private renderPermissions(record: PluginRecord): TemplateResult {
    const asked = permissionsOf(record.manifest);
    if (!asked.length) {
      return html`<div class="plug-line"><span class="plug-key">Permissions</span>
        <span class="hint">asks for nothing — it can draw a panel and read its own storage</span>
      </div>`;
    }
    const held = grantedFor(record);
    return html`
      <div class="plug-line">
        <span class="plug-key">Permissions</span>
        <span class="plug-perms">
          ${asked.map(
            (p) => html`<span
              class="plug-perm ${held.includes(p) ? '' : 'ungranted'} ${p === 'unsafe.fullAccess'
                ? 'unsafe'
                : ''}"
              title=${describePermission(p) + (held.includes(p) ? '' : '\n\nNot granted.')}
              >${p}</span
            >`,
          )}
        </span>
      </div>
    `;
  }

  private renderStorage(record: PluginRecord): TemplateResult | typeof nothing {
    const provides = record.manifest.provides ?? [];
    const uses = record.manifest.uses ?? [];
    if (!provides.length && !uses.length) return nothing;
    return html`
      <div class="plug-line">
        <span class="plug-key">Storage</span>
        <span class="plug-domains">
          ${provides.map((spec) => {
            const bytes = this.usage.get(spec.domain);
            const size =
              bytes === undefined
                ? spec.scope === 'machine' && !connected.get()
                  ? 'not read — nothing connected'
                  : 'measuring…'
                : bytes === null
                  ? 'size unknown'
                  : formatBytes(bytes);
            return html`<span
              class="plug-domain ${bytes != null && bytes > DOMAIN_BYTE_CAP * 0.9 ? 'tight' : ''}"
              title=${`Owned by this plugin. ${
                spec.scope === 'machine'
                  ? "A file on the controller's card, which follows the machine."
                  : 'IndexedDB in this browser, gone when site data is cleared.'
              } The cap is ${CAP_LABEL} per domain.`}
              >${spec.domain} · ${spec.scope} · ${size}</span
            >`;
          })}
          ${uses.map(
            (use) => html`<span
              class="plug-domain borrowed"
              title="Owned by another plugin. This one was granted ${use.access} access to it."
              >${use.domain} · ${use.access} of another plugin's</span
            >`,
          )}
          ${provides.length
            ? html`<button
                class="tiny"
                title="Measure these again"
                @click=${() => this.forgetUsage(record)}
              >
                ⟳
              </button>`
            : nothing}
        </span>
      </div>
    `;
  }

  /**
   * The remove question, asked in the panel rather than in a confirm().
   *
   * Because it is two questions. The code goes either way; the data is a
   * separate decision, and the wording has to say why anyone would keep data
   * belonging to something they are deleting — a tool table is worth more than
   * the plugin that wrote it, and the domain it lives in is readable by
   * whatever is installed next.
   */
  private renderRemove(record: PluginRecord): TemplateResult {
    const domains = (record.manifest.provides ?? []).map((p) => p.domain);
    const id = record.manifest.id;
    return html`
      <div class="plug-remove">
        <strong>Remove ${record.manifest.name}?</strong>
        <p>
          Its files ${record.source === 'machine' ? `under /plugins/${id} on the card` : 'in this browser'}
          go, and so do its permission grants — installing it again asks about them from scratch.
        </p>
        ${domains.length
          ? html`
              <label class="check">
                <input
                  type="checkbox"
                  .checked=${this.removeData}
                  @change=${(e: Event) => {
                    this.removeData = (e.target as HTMLInputElement).checked;
                    this.requestUpdate();
                  }}
                />
                Also destroy the data in ${domains.join(', ')}
              </label>
              <p class="hint">
                Left unticked, the data stays where it is. That is usually what you want: a domain
                names a body of data rather than the plugin that made it, so a later version of
                this plugin — or a different plugin that declares the same domain — picks it up
                again. Ticked, it is gone and nothing here can bring it back.
              </p>
            `
          : html`<p class="hint">This plugin declares no storage of its own, so there is no data to keep.</p>`}
        <div class="plug-remove-actions">
          <button
            class="danger"
            ?disabled=${!!this.busy}
            @click=${() => {
              const deleteData = this.removeData;
              this.removing = '';
              this.removeData = false;
              void this.run(`Remove ${record.manifest.name}`, async () => {
                await remove(id, { deleteData });
                if (this.selected === id) {
                  this.selected = '';
                  this.source = '';
                  this.saved = '';
                }
                this.done = `Removed ${record.manifest.name}`;
              });
            }}
          >
            Remove${this.removeData ? ' and destroy the data' : ''}
          </button>
          <button
            class="ghost"
            @click=${() => {
              this.removing = '';
              this.removeData = false;
              this.requestUpdate();
            }}
          >
            Keep it
          </button>
        </div>
      </div>
    `;
  }

  private renderRecord(record: PluginRecord): TemplateResult {
    const id = record.manifest.id;
    const manifest = record.manifest;
    // Read off the manifest rather than off the grant: this marks a plugin
    // that ASKS to run outside the sandbox, which is worth seeing whether or
    // not the operator has answered yet.
    const full = (manifest.permissions ?? []).includes('unsafe.fullAccess');

    return html`
      <div class="plug ${full ? 'plug-full' : ''} ${record.fault ? 'plug-faulted' : ''}">
        <div class="plug-head">
          <label class="plug-switch" title=${record.enabled ? 'Switch it off' : 'Switch it on'}>
            <input
              type="checkbox"
              .checked=${record.enabled}
              @change=${(e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                void setEnabled(id, on).catch((err: unknown) => {
                  this.error = messageOf(err);
                  this.requestUpdate();
                });
              }}
            />
          </label>
          <span class="plug-name">${manifest.name}</span>
          <span class="plug-version">${manifest.version}</span>
          ${full
            ? html`<span class="plug-badge" title=${describePermission('unsafe.fullAccess')}>
                full access · no sandbox
              </span>`
            : nothing}
          <span class="plug-where">
            ${record.source === 'machine' ? 'on the machine' : 'in this browser'}
          </span>
          <span class="plug-buttons">
            <button
              class=${this.selected === id ? 'tiny highlight' : 'tiny'}
              @click=${() => this.select(id)}
            >
              Edit
            </button>
            <button
              class="tiny"
              title="Tear its frames down and build them again"
              ?disabled=${!record.enabled}
              @click=${() => void this.run(`Reload ${manifest.name}`, () => reload(id))}
            >
              Reload
            </button>
            <button
              class="tiny"
              @click=${() => {
                this.removing = this.removing === id ? '' : id;
                this.removeData = false;
                this.requestUpdate();
              }}
            >
              Remove
            </button>
          </span>
        </div>
        <div class="plug-id">${id}</div>
        ${manifest.description ? html`<div class="plug-desc">${manifest.description}</div>` : nothing}
        ${full
          ? html`<div class="warn-banner bad">
              This plugin runs in the app itself, not in a frame. It can do anything you can do,
              including moving the machine and rewriting its configuration, and nothing after the
              grant asks again.
            </div>`
          : nothing}
        ${record.fault ? html`<div class="plug-fault">${record.fault}</div>` : nothing}
        ${this.renderPermissions(record)} ${this.renderStorage(record)}
        <div class="plug-line">
          <span class="plug-key">Panel</span>
          <span class="hint">
            ${manifest.panel
              ? `"${manifest.panel.title}" — add it from the + on any page`
              : 'none; it has no panel of its own'}${manifest.background
              ? ', and it keeps running with no panel open'
              : ''}
          </span>
        </div>
        ${this.removing === id ? this.renderRemove(record) : nothing}
      </div>
    `;
  }

  private renderInstall(): TemplateResult {
    const target = this.installTarget;
    return html`
      <div class="plug-install">
        <div class="plug-section">Install</div>
        <!-- Not the shared .param row: its control column is 136px, and both
             of these choices are a sentence rather than a number. -->
        <label class="plug-target">
          <span>Keep it</span>
          <select
            ?disabled=${!!this.busy}
            @change=${(e: Event) => {
              this.target = (e.target as HTMLSelectElement).value as PluginSource;
              this.requestUpdate();
            }}
          >
            <option value="machine" ?selected=${target === 'machine'}>
              on the machine — under /plugins, follows the card
            </option>
            <option value="browser" ?selected=${target === 'browser'}>
              in this browser — private to it, gone when site data is cleared
            </option>
          </select>
        </label>
        ${target === 'machine' && !connected.get()
          ? html`<div class="warn-banner">
              Nothing is connected, so there is no card to write to. Connect first, or keep it in
              this browser and move it across later.
            </div>`
          : nothing}

        <div class="plug-install-row">
          <label class="plug-file">
            <span>From a file</span>
            <input
              type="file"
              accept=".zip,.js,application/zip,text/javascript"
              ?disabled=${!!this.busy}
              @change=${(e: Event) => this.onFile(e)}
            />
          </label>
          <span class="hint">A zip holding plugin.json and main.js, or a single .js with a header.</span>
        </div>

        <textarea
          class="plug-paste"
          spellcheck="false"
          placeholder="…or paste a main.js that starts with /* @plugin { … } */"
          .value=${this.pasted}
          ?disabled=${!!this.busy}
          @input=${(e: Event) => {
            this.pasted = (e.target as HTMLTextAreaElement).value;
            this.requestUpdate();
          }}
        ></textarea>

        <div class="plug-install-actions">
          <button ?disabled=${!this.pasted.trim() || !!this.busy} @click=${() => this.installPasted()}>
            Install pasted source
          </button>
          <button class="primary" ?disabled=${!!this.busy} @click=${() => this.newPlugin()}>
            New plugin
          </button>
          <span class="hint">
            New plugin writes a working example — a live position readout and a stored counter —
            and opens it below.
          </span>
        </div>
      </div>
    `;
  }

  private renderEditor(): TemplateResult | typeof nothing {
    if (!this.selected) return nothing;
    const record = recordFor(this.selected);
    if (!record) return nothing;
    const problems = this.problems;

    return html`
      <div class="plug-editor">
        <div class="editor-bar">
          <span class="editor-path" title=${this.selected}>
            ${record.manifest.name} · main.js${this.dirty ? ' •' : ''}
          </span>
          <button
            class="primary"
            ?disabled=${!this.dirty || this.saving}
            title="Write it back and reload the plugin"
            @click=${() => void this.save()}
          >
            ${this.saving ? 'Saving…' : 'Save'}
          </button>
          <button
            class="ghost"
            @click=${() => {
              this.selected = '';
              this.source = '';
              this.saved = '';
              this.requestUpdate();
            }}
          >
            Close
          </button>
        </div>
        ${problems.length
          ? html`
              <ul class="plug-problems">
                ${problems.map((p) => html`<li><code>${p.field}</code> ${p.message}</li>`)}
              </ul>
            `
          : nothing}
        <div class="editor-body">
          <textarea
            class="editor-text"
            spellcheck="false"
            .value=${this.source}
            @input=${(e: Event) => {
              this.source = (e.target as HTMLTextAreaElement).value;
              this.requestUpdate();
            }}
          ></textarea>
        </div>
      </div>
    `;
  }

  private renderLog(): TemplateResult {
    const lines = this.logLines;
    return html`
      <div class="plug-log">
        <div class="plug-log-bar">
          <span class="plug-section">
            ${this.selected ? `Log · ${this.selected}` : 'Log · every plugin'}
          </span>
          <label class="check" title="Only the calls this app refused to make">
            <input
              type="checkbox"
              .checked=${this.denialsOnly}
              @change=${(e: Event) => {
                this.denialsOnly = (e.target as HTMLInputElement).checked;
                this.requestUpdate();
              }}
            />
            Refusals only
          </label>
          <button class="tiny" ?disabled=${!lines.length} @click=${() => this.copyLog()}>Copy</button>
          <button
            class="tiny"
            ?disabled=${!lines.length}
            @click=${() => {
              clearPluginLog(this.selected || undefined);
              this.requestUpdate();
            }}
          >
            Clear
          </button>
        </div>
        <div class="console-out plug-log-out">
          ${lines.length
            ? repeat(
                lines,
                (_l, i) => i,
                (l) => html`
                  <div class="line ${l.level === 'warn' ? 'warning' : l.level}">
                    <span class="time">${l.time.toLocaleTimeString()}</span>
                    ${this.selected ? nothing : html`<span class="plug-log-who">${l.pluginId}</span>`}
                    <span class="text">${l.text}</span>
                  </div>
                `,
              )
            : html`<div class="empty">
                ${this.denialsOnly
                  ? 'Nothing has been refused.'
                  : 'A plugin’s console, its uncaught errors, and every call this app would not make.'}
              </div>`}
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const records = plugins.get();

    return html`
      <div class="plugins">
        <div class="pack-blurb">
          A plugin is somebody else's JavaScript running in the window with the STOP button in it,
          so by default it runs in a frame the browser will not let out: no app, no DOM, no network,
          no storage but its own. What it needs beyond that, it asks for here.
        </div>

        ${this.error ? html`<div class="warn-banner bad">${this.error}</div>` : nothing}
        ${this.done ? html`<div class="pack-note good">${this.done}</div>` : nothing}
        ${this.busy ? html`<div class="pack-note">${this.busy}…</div>` : nothing}

        <div class="plug-section">Installed</div>
        <div class="plug-list">
          ${records.length
            ? repeat(records, (r) => r.manifest.id, (r) => this.renderRecord(r))
            : html`<div class="empty">
                Nothing installed. Press <strong>New plugin</strong> below for a working example.
              </div>`}
        </div>

        ${this.renderInstall()} ${this.renderEditor()} ${this.renderLog()}
      </div>
    `;
  }
}

customElements.define('cnc-plugins', PluginsPanel);

registerPanel({
  id: 'plugins',
  title: 'Plugins',
  tag: 'cnc-plugins',
  defaultWidth: 6,
  defaultHeight: 560,
  // No `available`: a plugin kept in this browser needs no controller at all,
  // and the panel is where somebody writes one before there is a machine to
  // point it at.
  description: 'Install, permit, edit and remove plugins',
});
