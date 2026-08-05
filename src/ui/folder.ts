// Which folder a panel opens in.
//
// The controller's own layout is not the one anybody works in. Macros collect
// into subfolders, jobs collect into per-project ones, and a panel that always
// starts at /macros or /gcodes makes you walk down the same three folders every
// time you open it. So each panel that browses files remembers a folder of its
// own, chosen once.
//
// Per panel rather than per app: the Files panel wants /sys, the Macros panel
// wants whichever group of macros you actually press, and the viewer wants
// wherever this month's jobs are posted. One shared setting would be wrong for
// two of the three.
//
// The choice is stored by panel id, not by panel instance. Two viewers open
// side by side are the same kind of thing looking at the same machine, and
// making you set the folder twice would be an odd reward for splitting the
// screen.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from './panel.js';
import { activeDriver, loadSetting, saveSetting } from '../core/store.js';
import { basename, parentPath } from '../core/util.js';
import type { FileEntry } from '../machine/types.js';

const KEY = (panel: string) => `dir.${panel}`;

/** The folder this panel should open in, or `fallback` when none was chosen. */
export function panelDir(panel: string, fallback: string | null): string | null {
  const saved = loadSetting<string | null>(KEY(panel), null);
  return saved && saved.startsWith('/') ? saved : fallback;
}

/** Remember a folder for this panel; null goes back to the controller's default. */
export function setPanelDir(panel: string, dir: string | null): void {
  saveSetting(KEY(panel), dir);
}

export function hasPanelDir(panel: string): boolean {
  return typeof loadSetting<string | null>(KEY(panel), null) === 'string';
}

/**
 * A folder chooser: shows the current one, opens a list of what is inside it.
 *
 * Its own element because three panels need it and none of them wants to own
 * the browsing state. Directories only — this picks where to look, not what to
 * open, and listing the files as well would invite clicking one and having
 * nothing happen.
 */
export class DirPicker extends PanelElement {
  /** Panel whose folder this sets. */
  panel = '';
  /** Where to go when nothing has been chosen, and what "default" means. */
  fallback: string | null = null;
  /** Called with the new folder — the panel reloads; this does not. */
  onPick: (dir: string | null) => void = () => {};

  private open = false;
  private browsing: string | null = null;
  private entries: FileEntry[] = [];
  private loading = false;
  private error: string | null = null;

  private get current(): string | null {
    return panelDir(this.panel, this.fallback);
  }

  private async toggle(): Promise<void> {
    this.open = !this.open;
    this.requestUpdate();
    if (this.open) await this.browse(this.current ?? '/');
  }

  private async browse(dir: string): Promise<void> {
    const driver = activeDriver();
    if (!driver) return;
    this.loading = true;
    this.error = null;
    this.browsing = dir;
    this.requestUpdate();
    try {
      this.entries = (await driver.listFiles(dir)).filter((e) => e.directory);
    } catch (err) {
      this.entries = [];
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
      this.requestUpdate();
    }
  }

  private choose(dir: string | null): void {
    setPanelDir(this.panel, dir);
    this.open = false;
    this.requestUpdate();
    this.onPick(dir);
  }

  protected override render(): TemplateResult {
    const current = this.current;
    const browsing = this.browsing ?? current ?? '/';
    const pinned = hasPanelDir(this.panel);

    return html`
      <div class="dirpick">
        <button
          class="tiny dirpick-open"
          title=${pinned ? `Opening in ${current}. Click to change.` : 'Choose which folder this panel opens in'}
          @click=${() => void this.toggle()}
        >
          <span class="dirpick-path">${current ?? '/'}</span>
          <span class="dirpick-caret">▾</span>
        </button>

        ${this.open
          ? html`
              <div class="dirpick-menu">
                <div class="dirpick-head">
                  <button
                    class="tiny"
                    ?disabled=${browsing === '/'}
                    title="Up one level"
                    @click=${() => void this.browse(parentPath(browsing))}
                  >
                    ↑
                  </button>
                  <span class="dirpick-here" title=${browsing}>${browsing}</span>
                </div>

                ${this.error ? html`<div class="dirpick-error">${this.error}</div>` : nothing}
                ${this.loading ? html`<div class="empty">Reading…</div>` : nothing}

                <div class="dirpick-list">
                  ${this.entries.map(
                    (e) => html`
                      <button class="dirpick-item" @click=${() => void this.browse(e.path)}>
                        ▸ ${basename(e.path) || e.name}
                      </button>
                    `,
                  )}
                  ${!this.loading && !this.entries.length && !this.error
                    ? html`<div class="empty">No folders in here</div>`
                    : nothing}
                </div>

                <div class="dirpick-actions">
                  <button class="primary tiny" @click=${() => this.choose(browsing)}>
                    Open here
                  </button>
                  ${pinned
                    ? html`<button
                        class="tiny"
                        title=${`Go back to ${this.fallback ?? 'the controller default'}`}
                        @click=${() => this.choose(null)}
                      >
                        Reset
                      </button>`
                    : nothing}
                  <button class="tiny ghost" @click=${() => void this.toggle()}>Cancel</button>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-dir-picker', DirPicker);

/** Render one, bound to a panel. */
export function dirPicker(
  panel: string,
  fallback: string | null,
  onPick: (dir: string | null) => void,
): TemplateResult {
  return html`<cnc-dir-picker
    .panel=${panel}
    .fallback=${fallback}
    .onPick=${onPick}
  ></cnc-dir-picker>`;
}
