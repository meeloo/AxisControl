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
// Stored per panel INSTANCE, not per kind of panel. Opening a second Files
// panel is what you do precisely when you want two folders at once — /sys in
// one and /macros in the other, to copy between them — and a shared setting
// made the second panel drag the first along with it. Two of a kind are only
// the same thing if you never needed two.
//
// The key is the page and the instance id, both of which the layout persists,
// so a folder survives a reload. The page is part of it because an instance id
// is only unique within its page — every page's first Files panel is called
// "files".

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from './panel.js';
import { activeDriver, loadSetting, saveSetting } from '../core/store.js';
import { basename, parentPath } from '../core/util.js';
import type { FileEntry } from '../machine/types.js';

const KEY = (panel: string) => `dir.${panel}`;

/** The key this panel used before folders were per page: the instance id alone. */
function legacyKey(panel: string): string | null {
  const slash = panel.indexOf('/');
  return slash < 0 ? null : KEY(panel.slice(slash + 1));
}

/**
 * What is stored for this panel, or null.
 *
 * Reads the old key when the new one has never been written, so a folder
 * pinned before the key gained a page is still there afterwards. Every page's
 * panel of that kind inherits it, which is what they shared before anyway;
 * they part company the moment one of them is changed.
 */
function stored(panel: string): string | null {
  const own = loadSetting<string | null>(KEY(panel), null);
  if (typeof own === 'string') return own;
  const old = legacyKey(panel);
  const legacy = old ? loadSetting<string | null>(old, null) : null;
  return typeof legacy === 'string' ? legacy : null;
}

/** The folder this panel should open in, or `fallback` when none was chosen. */
export function panelDir(panel: string, fallback: string | null): string | null {
  const saved = stored(panel);
  return saved && saved.startsWith('/') ? saved : fallback;
}

/** Remember a folder for this panel; null goes back to the controller's default. */
export function setPanelDir(panel: string, dir: string | null): void {
  saveSetting(KEY(panel), dir);
  // Drop the pre-page key as well, or Reset would clear this panel's folder and
  // then read the old one straight back and look like it had done nothing.
  const old = legacyKey(panel);
  if (old) saveSetting(old, null);
}

export function hasPanelDir(panel: string): boolean {
  return stored(panel) !== null;
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
