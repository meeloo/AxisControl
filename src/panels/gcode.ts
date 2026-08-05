// The G-code reference.
//
// The index is shipped with the app (see docs/types.ts for why it cannot be
// fetched), so this panel is search over a local array — which is the point:
// it answers in a keystroke, with no network, standing at the machine.
//
// Arranged around the two questions that actually get asked, which are
// opposites. "What does M574's P do" starts from the code; "what was the code
// for endstops" starts from the words. One box does both, because deciding
// which mode you are in before you type is the friction being removed.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { searchCodes, type GcodeEntry, type GcodeIndex } from '../docs/types.js';
import { loadIndex } from '../docs/load.js';

export class GcodePanel extends PanelElement {
  private index: GcodeIndex | null = null;
  private error: string | null = null;
  private query = '';
  /** Which result the keyboard is on. */
  private cursor = 0;
  private selected: GcodeEntry | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void loadIndex().then(
      (index) => ((this.index = index), this.requestUpdate()),
      (err: Error) => ((this.error = err.message), this.requestUpdate()),
    );
  }

  private get results(): GcodeEntry[] {
    return this.index ? searchCodes(this.index.codes, this.query, 80) : [];
  }

  /**
   * Keys, from anywhere in the panel.
   *
   * Bound to the whole panel rather than to the search box, because clicking a
   * result moves focus onto that button and the arrows would stop working the
   * moment you used the mouse — which is exactly when you want to keep reading
   * down the list.
   */
  private onKey(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const results = this.results;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = this.cursor + (e.key === 'ArrowDown' ? 1 : -1);
      this.cursor = Math.max(0, Math.min(results.length - 1, next));
      // Show it, rather than only highlighting it. Browsing the reference is
      // reading one code after another; making Enter mandatory turned every
      // step into two keys for no gain.
      const hit = results[this.cursor];
      if (hit) this.selected = hit;
      this.requestUpdate();
      // Follow the cursor, or arrowing past the fold moves a highlight nobody
      // can see. Focus follows it too, but only when it was already in the
      // list: taking it out of the search box would mean the next character
      // typed went nowhere.
      const inList = document.activeElement?.classList.contains('gc-hit') ?? false;
      window.setTimeout(() => {
        const row = this.querySelector<HTMLElement>('.gc-hit.on');
        if (!row) return;
        if (inList) row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
      }, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[this.cursor];
      if (hit) this.pick(hit);
    } else if (e.key === 'Escape') {
      this.query = '';
      this.cursor = 0;
      this.requestUpdate();
      this.querySelector<HTMLInputElement>('.gc-search')?.focus();
    }
  }

  /**
   * Show a code, and put the keyboard where the eye is.
   *
   * The focus call is not decoration. Clicking a button does not focus it in
   * Safari — a macOS convention rather than a bug — so after picking a result
   * with the mouse the keys went to the document body, the panel never saw
   * them, and the arrows simply stopped working. Chromium focuses the button
   * for you, which is why the test I wrote first passed while the app did not.
   */
  private pick(entry: GcodeEntry, row?: HTMLElement): void {
    this.selected = entry;
    this.cursor = this.results.indexOf(entry);
    this.requestUpdate();
    row?.focus({ preventScroll: true });
  }

  private renderEntry(entry: GcodeEntry): TemplateResult {
    return html`
      <div class="gc-entry">
        <div class="gc-entry-head">
          <strong>${entry.code}</strong>
          <span>${entry.title}</span>
        </div>
        ${entry.support ? html`<div class="gc-support">${entry.support}</div>` : nothing}

        ${entry.params.length
          ? html`<div class="gc-section">Parameters</div>
              <div class="gc-params">
                ${entry.params.map(
                  (p) => html`
                    <code class="gc-param ${p.required ? 'req' : ''}">${p.letter}</code>
                    <span>${p.text}${p.required ? html`<em> — required</em>` : nothing}</span>
                  `,
                )}
              </div>`
          : nothing}

        ${entry.examples.length
          ? html`<div class="gc-section">Examples</div>
              <pre class="gc-examples">${entry.examples.join('\n')}</pre>`
          : nothing}

        ${entry.notes.length
          ? html`<div class="gc-section">Notes</div>
              <ul class="gc-notes">
                ${entry.notes.map((n) => html`<li>${n}</li>`)}
              </ul>`
          : nothing}

        ${entry.url
          ? html`<a class="hint gc-link" href=${entry.url} target="_blank" rel="noreferrer">
              Read it on docs.duet3d.com
            </a>`
          : nothing}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (this.error) {
      return html`<div class="pack gc">
        <div class="warn-banner bad">${this.error}</div>
        <div class="pack-note">
          The reference ships with the app. If this copy was installed before it existed, install
          again from the Install panel.
        </div>
      </div>`;
    }
    if (!this.index) return html`<div class="pack gc"><div class="pack-note">Loading…</div></div>`;

    const results = this.results;
    return html`
      <div class="pack gc" @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
        <input
          class="gc-search"
          type="search"
          placeholder="M574, 581.1, or endstop…"
          .value=${this.query}
          @input=${(e: Event) => {
            this.query = (e.target as HTMLInputElement).value;
            this.cursor = 0;
            this.requestUpdate();
          }}
        />
        <div class="gc-body">
          <div class="gc-hits">
            ${results.length
              ? results.map(
                  (entry, i) => html`
                    <button
                      class="gc-hit ${i === this.cursor ? 'on' : ''} ${entry === this.selected ? 'sel' : ''}"
                      @click=${(e: Event) => this.pick(entry, e.currentTarget as HTMLElement)}
                    >
                      <strong>${entry.code}</strong>
                      <span>${entry.title}</span>
                    </button>
                  `,
                )
              : html`<div class="pack-note">Nothing matches “${this.query}”.</div>`}
          </div>
          <div class="gc-detail">
            ${this.selected
              ? this.renderEntry(this.selected)
              : html`<div class="pack-note">
                  ${this.index.codes.length} codes. Type a number to look one up, or a word to find
                  out which one you want.
                </div>`}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-gcode', GcodePanel);

registerPanel({
  id: 'gcode',
  title: 'G-code reference',
  tag: 'cnc-gcode',
  defaultWidth: 6,
  defaultHeight: 520,
  description: 'Search the RepRapFirmware G-code dictionary, offline',
});
