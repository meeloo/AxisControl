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
// Writing comes later and deliberately so — see the panel note at the foot. The
// value of reading arrives with no risk at all attached to it, and /sys/config.g
// is the most dangerous file on the machine.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, connected, machine } from '../core/store.js';
import { empty } from '../ui/widgets.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { checkConfig, type Finding } from '../config/check.js';
import { comparable, compareLine, describe, type LiveValue } from '../config/live.js';
import type { ConfigLine } from '../config/parse.js';
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

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      machine.get();
    });
    void loadIndex().then((i) => ((this.index = i), this.requestUpdate()));
    void this.reload();
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
            ${line.params.map(
              (p) => html`<code class="cfg-param" title=${paramHelp(entry, p.letter)}
                >${p.letter}<em>${p.text}</em></code
              >`,
            )}
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

  private jump(path: string, index: number): void {
    this.closed.delete(path);
    this.requestUpdate();
    window.setTimeout(() => {
      this.querySelector(`[data-at="${path}:${index}"]`)?.scrollIntoView({ block: 'center' });
    }, 0);
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
          Reading only. Nothing here writes to the machine — changing a value still means editing
          the file in the Files panel and restarting. Making these editable, and applying them live
          so a change can be felt before it is saved, is the next step.
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
