// The machine's configuration, read and explained.
//
// Read-only, on purpose and for now. Everything here is about answering three
// questions that config.g cannot answer about itself:
//
//   What does this line do?          — the reference is already in the app
//   Is it actually in force?         — compare it against the object model
//   Is anything about it nonsense?   — see config/check.ts
//
// The third is the one that pays. RRF runs config.g top to bottom and mostly
// does not complain: set the same maximum speed twice and the second wins in
// silence, configure an axis before M584 creates it and the line is refused at
// boot with nobody watching, misspell a parameter and it is ignored. Each
// leaves a machine that runs, behaves differently from what the file appears to
// say, and offers no clue why.
//
// And then a fourth, which is the one that changes how tuning feels:
//
//   What if it were 3000 instead?  — send it and find out
//
// Values on the whitelist can be edited here and applied to the machine
// directly. Nothing is written to /sys: the edit lives in the running firmware
// until it is saved or until a restart forgets it. That is what collapses the
// edit / restart / feel it / edit again loop into seconds, and it is safe to
// play with precisely because M999 undoes all of it.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, connected, machine } from '../core/store.js';
import { empty } from '../ui/widgets.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { checkConfig, type Finding } from '../config/check.js';
import { comparable, compareLine, describe, type LiveValue } from '../config/live.js';
import { blockedBy, caution, commandFor, editKey, liveAppliable } from '../config/apply.js';
import { editable, type ConfigLine } from '../config/parse.js';
import { actions } from '../core/store.js';
import { loadIndex } from '../docs/load.js';
import type { GcodeIndex } from '../docs/types.js';

export class ConfigPanel extends PanelElement {
  private loaded: LoadedConfig | null = null;
  private index: GcodeIndex | null = null;
  private error: string | null = null;
  private loading = false;
  /** Files the operator has collapsed. */
  private closed = new Set<string>();
  /** Show every line, rather than only the commands. */
  private verbose = false;
  /** Values typed here but not yet sent, keyed by file:line:letter. */
  private edits = new Map<string, string>();
  /** Values sent to the machine and not saved to any file. */
  private applied = new Map<string, string>();
  private applying = false;
  private applyError: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      machine.get();
    });
    void loadIndex().then((i) => ((this.index = i), this.requestUpdate()));
    void this.reload();
  }

  /** Lines whose values this panel is willing to touch. */
  private static readonly EDITABLE = new Set(['M92', 'M201', 'M203', 'M208', 'M566', 'M906']);

  /** Every pending edit, grouped into the lines they belong to. */
  private pendingLines(): Array<{ path: string; line: ConfigLine }> {
    const out: Array<{ path: string; line: ConfigLine }> = [];
    for (const file of this.loaded?.files ?? []) {
      for (const line of file.lines) {
        const touched = line.params.some((p) => this.edits.has(editKey(file.path, line, p.letter)));
        if (touched) out.push({ path: file.path, line });
      }
    }
    return out;
  }

  /**
   * Send the edited lines, in the order the file runs them.
   *
   * Sequentially rather than all at once: these are configuration commands and
   * a later one can depend on an earlier, so preserving the file's order is the
   * only thing that behaves the same as a restart would.
   */
  private async applyEdits(): Promise<void> {
    const pending = this.pendingLines();
    if (!pending.length || this.applying) return;
    const blocked = blockedBy(machine.peek().status);
    if (blocked) {
      this.applyError = blocked;
      this.requestUpdate();
      return;
    }
    this.applying = true;
    this.applyError = null;
    this.requestUpdate();
    try {
      for (const { path, line } of pending) {
        await actions.send(commandFor(line, this.edits, path));
        for (const p of line.params) {
          const key = editKey(path, line, p.letter);
          const value = this.edits.get(key);
          if (value !== undefined) this.applied.set(key, value);
        }
      }
      this.edits.clear();
    } catch (err) {
      this.applyError = (err as Error).message;
    } finally {
      this.applying = false;
      this.requestUpdate();
    }
  }

  /** Put the machine back to what the file says, without writing anything. */
  private async revertAll(): Promise<void> {
    const lines: Array<{ path: string; line: ConfigLine }> = [];
    for (const file of this.loaded?.files ?? []) {
      for (const line of file.lines) {
        if (line.params.some((p) => this.applied.has(editKey(file.path, line, p.letter)))) {
          lines.push({ path: file.path, line });
        }
      }
    }
    this.edits.clear();
    this.applying = true;
    this.requestUpdate();
    try {
      // An empty edit map means "as written in the file", which is the point.
      for (const { path, line } of lines) await actions.send(commandFor(line, new Map(), path));
      this.applied.clear();
    } catch (err) {
      this.applyError = (err as Error).message;
    } finally {
      this.applying = false;
      this.requestUpdate();
    }
  }

  private async reload(): Promise<void> {
    const driver = activeDriver();
    if (!driver || this.loading) return;
    this.loading = true;
    this.error = null;
    this.requestUpdate();
    try {
      this.loaded = await loadConfig(driver);
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
      this.requestUpdate();
    }
  }

  private get findings(): Finding[] {
    const axes = machine.get().axes.map((a) => a.letter);
    return this.loaded ? checkConfig(this.loaded.files, this.index, axes) : [];
  }

  /** Findings against one line, so they can be shown where the problem is. */
  private findingsFor(path: string, line: ConfigLine): Finding[] {
    return this.findings.filter((f) => f.path === path && f.line.index === line.index);
  }

  private renderLive(values: LiveValue[], command: string): TemplateResult | typeof nothing {
    if (!values.length) return nothing;
    const spec = describe(command);
    const off = values.filter((v) => !v.agrees);
    if (!off.length) {
      return html`<span class="cfg-live ok" title=${`The machine reports the same ${spec?.label ?? 'value'}`}
        >in force</span
      >`;
    }
    return html`<span
      class="cfg-live bad"
      title="The file and the machine disagree. Something has changed this since boot, or a later line, config-override.g or a conditional has replaced it."
      >machine says ${off.map((v) => `${v.letter}${v.machine}`).join(' ')}</span
    >`;
  }

  /** Whether this exact line's values may be edited and sent. */
  private canEdit(line: ConfigLine): boolean {
    return editable(line, ConfigPanel.EDITABLE) && liveAppliable(line.command);
  }

  private renderParam(
    path: string,
    line: ConfigLine,
    p: { letter: string; text: string; value: number | null },
    entry: { params: Array<{ letter: string; text: string }> } | undefined,
  ): TemplateResult {
    const help = paramHelp(entry, p.letter);
    // A parameter with no number — a pin name, a driver list — is shown as it
    // is written even on an editable line. There is nothing to nudge.
    if (!this.canEdit(line) || p.value === null) {
      return html`<code class="cfg-param" title=${help}>${p.letter}<em>${p.text}</em></code>`;
    }
    const key = editKey(path, line, p.letter);
    const pending = this.edits.get(key);
    const applied = this.applied.get(key);
    const shown = pending ?? applied ?? p.text;
    return html`<code
      class="cfg-param edit ${pending !== undefined ? 'pending' : applied !== undefined ? 'applied' : ''}"
      title=${help}
      >${p.letter}<input
        type="number"
        step="any"
        .value=${shown}
        @wheel=${(e: WheelEvent) => {
          // A wheel over a focused number input changes it. Scrolling down a
          // config panel should not retune the machine on the way past.
          (e.target as HTMLInputElement).blur();
        }}
        @change=${(e: Event) => {
          const raw = (e.target as HTMLInputElement).value.trim();
          if (raw === '' || raw === p.text) this.edits.delete(key);
          else this.edits.set(key, raw);
          this.applyError = null;
          this.requestUpdate();
        }}
      /></code>`;
  }

  private renderLine(path: string, line: ConfigLine): TemplateResult | typeof nothing {
    const isCommand = line.kind === 'command' || line.kind === 'disabled';
    if (!isCommand && !this.verbose) return nothing;

    const entry = line.command ? this.index?.codes.find((c) => c.code === line.command) : undefined;
    const found = this.findingsFor(path, line);
    const live = line.kind === 'command' && comparable(line.command)
      ? compareLine(line, machine.get().axes)
      : [];

    return html`
      <div class="cfg-line ${line.kind} ${found.length ? 'flagged' : ''}">
        <span class="cfg-num">${line.index + 1}</span>
        <div class="cfg-body">
          <div class="cfg-code">
            ${line.command
              ? html`<code class="cfg-cmd" title=${entry?.title ?? ''}>${line.command}</code>`
              : nothing}
            ${line.params.map((p) => this.renderParam(path, line, p, entry))}
            ${!line.command ? html`<span class="cfg-raw">${line.raw.trim()}</span>` : nothing}
            ${line.kind === 'command' ? this.renderLive(live, line.command ?? '') : nothing}
            ${line.kind === 'disabled'
              ? html`<span class="cfg-off" title="Commented out — it does not run">off</span>`
              : nothing}
            ${line.expression
              ? html`<span class="cfg-off" title="This line computes its value, so it cannot be read as a number">expression</span>`
              : nothing}
            ${line.depth > 0
              ? html`<span class="cfg-off" title="Inside an if or while, so it may not run at all">conditional</span>`
              : nothing}
            ${this.lineState(path, line)}
          </div>
          ${entry ? html`<div class="cfg-title">${entry.title}</div>` : nothing}
          ${line.comment && line.kind === 'command'
            ? html`<div class="cfg-comment">${line.comment}</div>`
            : nothing}
          ${found.map(
            (f) => html`<div class="cfg-finding ${f.severity}">
              ${f.message}
              ${f.other
                ? html`<button
                    class="link"
                    @click=${() => this.jump(f.other!.path, f.other!.line.index)}
                  >
                    see line ${f.other.line.index + 1}
                  </button>`
                : nothing}
            </div>`,
          )}
        </div>
      </div>
    `;
  }

  /**
   * What has been done to this line, if anything.
   *
   * "applied" matters more than it looks: it is the difference between a value
   * the machine is running because somebody chose it on this screen, and one
   * that disagrees with the file for a reason nobody has explained. Without it
   * the live badge beside it would read as a fault.
   */
  private lineState(path: string, line: ConfigLine): TemplateResult | typeof nothing {
    const keys = line.params.map((p) => editKey(path, line, p.letter));
    if (keys.some((k) => this.edits.has(k))) {
      return html`<span class="cfg-state pending" title="Typed here, not sent yet">edited</span>`;
    }
    if (keys.some((k) => this.applied.has(k))) {
      return html`<span class="cfg-state applied" title="Sent to the machine and running now. Not saved — a restart forgets it."
        >applied, not saved</span
      >`;
    }
    return nothing;
  }

  private jump(path: string, index: number): void {
    this.closed.delete(path);
    this.requestUpdate();
    window.setTimeout(() => {
      this.querySelector(`[data-at="${path}:${index}"]`)?.scrollIntoView({ block: 'center' });
    }, 0);
  }

  /**
   * The tuning bar: what is pending, what is running, and the way back.
   *
   * Only appears once there is something to say. A row of disabled buttons at
   * the top of a panel that is usually just being read is noise, and the whole
   * point of this panel is that it is quiet until it has something.
   */
  private renderApplyBar(): TemplateResult | typeof nothing {
    const pending = this.pendingLines();
    const appliedCount = new Set(
      [...this.applied.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))),
    ).size;
    if (!pending.length && !appliedCount && !this.applyError) return nothing;

    const cautions = [...new Set(pending.map((p) => caution(p.line.command)).filter(Boolean))];
    const blocked = blockedBy(machine.get().status);

    return html`
      <div class="cfg-apply">
        <div class="cfg-apply-row">
          ${pending.length
            ? html`<strong>${pending.length} line${pending.length === 1 ? '' : 's'} edited</strong>`
            : nothing}
          ${appliedCount
            ? html`<span class="cfg-state applied">${appliedCount} running, not saved</span>`
            : nothing}
          <span class="topbar-spacer"></span>
          ${pending.length
            ? html`<button
                  class="primary tiny"
                  ?disabled=${this.applying || blocked !== null}
                  title=${blocked ?? 'Send these to the machine now. Nothing is written to /sys.'}
                  @click=${() => void this.applyEdits()}
                >
                  ${this.applying ? 'Sending…' : 'Try on the machine'}
                </button>
                <button class="tiny ghost" ?disabled=${this.applying} @click=${() => {
                  this.edits.clear();
                  this.requestUpdate();
                }}>
                  Discard
                </button>`
            : nothing}
          ${appliedCount && !pending.length
            ? html`<button
                class="tiny"
                ?disabled=${this.applying}
                title="Send the values as the file has them, undoing what was tried here"
                @click=${() => void this.revertAll()}
              >
                Back to the file
              </button>`
            : nothing}
        </div>
        ${blocked ? html`<div class="cfg-apply-note bad">${blocked}</div>` : nothing}
        ${this.applyError ? html`<div class="cfg-apply-note bad">${this.applyError}</div>` : nothing}
        ${cautions.map((c) => html`<div class="cfg-apply-note">${c}</div>`)}
        ${appliedCount
          ? html`<div class="cfg-apply-note">
              Running in the firmware only. A restart forgets all of it, and nothing has been
              written to /sys.
            </div>`
          : nothing}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!connected.get()) return empty('Not connected');
    if (this.error) {
      return html`<div class="pack cfg">
        <div class="warn-banner bad">${this.error}</div>
        <div class="pack-actions"><button @click=${() => void this.reload()}>Try again</button></div>
      </div>`;
    }
    if (!this.loaded) return empty(this.loading ? 'Reading /sys/config.g…' : 'No configuration read');

    const findings = this.findings;
    const counts = {
      conflict: findings.filter((f) => f.severity === 'conflict').length,
      order: findings.filter((f) => f.severity === 'order').length,
      unknown: findings.filter((f) => f.severity === 'unknown').length,
    };

    return html`
      <div class="pack cfg">
        <div class="cfg-bar">
          <button class="tiny" ?disabled=${this.loading} @click=${() => void this.reload()}>
            ${this.loading ? 'Reading…' : 'Re-read'}
          </button>
          <label class="cfg-toggle">
            <input
              type="checkbox"
              .checked=${this.verbose}
              @change=${(e: Event) => {
                this.verbose = (e.target as HTMLInputElement).checked;
                this.requestUpdate();
              }}
            />
            <span>All lines</span>
          </label>
          <span class="cfg-count">
            ${this.loaded.files.length} files ·
            ${this.loaded.files.reduce(
              (n, f) => n + f.lines.filter((l) => l.kind === 'command').length,
              0,
            )}
            commands
          </span>
        </div>

        ${this.renderApplyBar()}

        ${findings.length
          ? html`<div class="cfg-summary">
              <strong>${findings.length}</strong> thing${findings.length === 1 ? '' : 's'} worth a
              look:
              ${counts.conflict ? html`<span class="cfg-chip conflict">${counts.conflict} overwritten</span>` : nothing}
              ${counts.order ? html`<span class="cfg-chip order">${counts.order} out of order</span>` : nothing}
              ${counts.unknown ? html`<span class="cfg-chip unknown">${counts.unknown} unrecognised</span>` : nothing}
            </div>`
          : html`<div class="cfg-summary ok">Nothing looks contradictory.</div>`}

        ${this.loaded.missing.map(
          (m) => html`<div class="warn-banner">
            ${m.path} is run by an M98 but could not be read — ${m.reason}
          </div>`,
        )}

        <div class="cfg-files">
          ${this.loaded.files.map((file) => {
            const open = !this.closed.has(file.path);
            const flagged = findings.filter((f) => f.path === file.path).length;
            return html`
              <section class="cfg-file">
                <button
                  class="cfg-file-head"
                  @click=${() => {
                    if (open) this.closed.add(file.path);
                    else this.closed.delete(file.path);
                    this.requestUpdate();
                  }}
                >
                  <span class="cfg-caret">${open ? '▾' : '▸'}</span>
                  <strong>${file.path}</strong>
                  <em>${file.lines.filter((l) => l.kind === 'command').length} commands</em>
                  ${flagged ? html`<span class="cfg-chip conflict">${flagged}</span>` : nothing}
                </button>
                ${open
                  ? html`<div class="cfg-lines">
                      ${file.lines.map(
                        (line) => html`<div data-at=${`${file.path}:${line.index}`}>
                          ${this.renderLine(file.path, line)}
                        </div>`,
                      )}
                    </div>`
                  : nothing}
              </section>
            `;
          })}
        </div>

        <div class="param-note cfg-note">
          Editing a value here sends it to the machine; nothing is written to <code>/sys</code>.
          A restart forgets whatever was tried. Saving a value you have settled on, back into the
          line it came from, is the next step.
        </div>
      </div>
    `;
  }
}

/** The documented meaning of one parameter of one command. */
function paramHelp(entry: { params: Array<{ letter: string; text: string }> } | undefined, letter: string): string {
  if (!entry) return '';
  const p = entry.params.find((x) => x.letter.toUpperCase().startsWith(letter));
  return p ? `${p.letter} — ${p.text}` : '';
}

customElements.define('cnc-config', ConfigPanel);

registerPanel({
  id: 'config',
  title: 'Configuration',
  tag: 'cnc-config',
  defaultWidth: 6,
  defaultHeight: 560,
  available: (caps) => caps.files,
  description: 'Read config.g and everything it runs, with the reference and what is actually in force',
});
