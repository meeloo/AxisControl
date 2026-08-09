// Position and jogging on one phone screen.
//
// At the machine with a phone in one hand you are doing exactly two things:
// reading where the machine is, and moving it a bit. Every other panel is for
// sitting down. Position and Motion each work on a phone since the layout
// stacks, but you cannot see both at once — and jogging while watching the
// number is the whole job.
//
// So this is not a smaller Motion panel. It is the two of them with everything
// that does not serve that pair taken out: no rose with four rings and thirty-two
// sectors, no speed slider, no WCS row. A step size, eight directions, the
// other axes as columns, and the numbers big enough to read at arm's length.
//
// It has to work turned either way. Portrait puts the readout above the pad;
// landscape — about 330px of height on an iPhone once the top bar and the panel
// strip are gone — puts them side by side, because stacked they would leave the
// pad two centimetres tall.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, connected, machine } from '../core/store.js';
import { empty } from '../ui/widgets.js';

/**
 * Jog distances, in the numbers a person actually chooses.
 *
 * Fixed rather than derived: on a phone this is a row of five buttons and it
 * has to be the same five every time so the thumb learns where they are. The
 * Motion panel is where a considered distance gets picked.
 */
const STEPS = [0.1, 1, 5, 10, 50];

/** Eight directions as a 3x3 grid, with the step shown in the middle. */
const PAD: Array<{ dx: number; dy: number; glyph: string } | null> = [
  { dx: -1, dy: 1, glyph: '↖' },
  { dx: 0, dy: 1, glyph: '↑' },
  { dx: 1, dy: 1, glyph: '↗' },
  { dx: -1, dy: 0, glyph: '←' },
  null,
  { dx: 1, dy: 0, glyph: '→' },
  { dx: -1, dy: -1, glyph: '↙' },
  { dx: 0, dy: -1, glyph: '↓' },
  { dx: 1, dy: -1, glyph: '↘' },
];

export class HandPanel extends PanelElement {
  private step = 1;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
    });
  }

  /**
   * How fast a tap moves the machine.
   *
   * Half the slowest axis involved, so a jog is brisk without being the full
   * rapid — a phone tap is easy to make by accident and this is the number that
   * decides how much that costs. Never invented: it comes from the machine's
   * own M203, and falls back only when the controller does not report one.
   */
  private feedFor(letters: string[]): number {
    const axes = machine.peek().axes.filter((a) => letters.includes(a.letter));
    const maxima = axes.map((a) => a.maxFeed).filter((f) => f > 0);
    if (!maxima.length) return 1000;
    return Math.max(100, Math.round(Math.min(...maxima) / 2));
  }

  private jog(deltas: Record<string, number>): void {
    void actions.jog(deltas, this.feedFor(Object.keys(deltas)));
  }

  /** One axis: letter, work position large, machine position under it. */
  private renderAxis(letter: string): TemplateResult | typeof nothing {
    const axis = machine.get().axes.find((a) => a.letter === letter);
    if (!axis) return nothing;
    return html`
      <div class="hand-axis ${axis.homed ? '' : 'unhomed'}">
        <span class="hand-letter">${axis.letter}</span>
        <span class="hand-work">${axis.work.toFixed(2)}</span>
        <span class="hand-machine">${axis.machine.toFixed(2)}</span>
      </div>
    `;
  }

  /** An axis that is not X or Y gets a column of its own: up, home, down. */
  private renderColumn(letter: string, enabled: boolean): TemplateResult {
    return html`
      <div class="hand-col">
        <span class="hand-col-name">${letter}</span>
        <button
          class="hand-key"
          ?disabled=${!enabled}
          title=${`${letter} +${this.step}mm`}
          @click=${() => this.jog({ [letter]: this.step })}
        >
          ▲
        </button>
        <button
          class="hand-key"
          ?disabled=${!enabled}
          title=${`${letter} −${this.step}mm`}
          @click=${() => this.jog({ [letter]: -this.step })}
        >
          ▼
        </button>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!connected.get()) return empty('Not connected');
    const state = machine.get();
    const letters = state.axes.map((a) => a.letter);
    const others = letters.filter((l) => l !== 'X' && l !== 'Y');
    // Jogging an axis that has not been homed is how a gantry meets a hard
    // stop, and the machine may refuse it anyway — better the button says so.
    const homed = state.axes.every((a) => a.homed);
    const idle = state.status === 'idle';
    const enabled = homed && idle;

    return html`
      <div class="hand">
        <div class="hand-dro">${letters.map((l) => this.renderAxis(l))}</div>

        <div class="hand-controls">
          <div class="hand-pad">
            ${PAD.map((cell) =>
              cell === null
                ? html`<div class="hand-step-badge">${this.step}<em>mm</em></div>`
                : html`<button
                    class="hand-key"
                    ?disabled=${!enabled}
                    title=${`X${cell.dx ? (cell.dx > 0 ? '+' : '−') + this.step : ''} Y${
                      cell.dy ? (cell.dy > 0 ? '+' : '−') + this.step : ''
                    }`}
                    @click=${() => {
                      const d: Record<string, number> = {};
                      if (cell.dx) d.X = cell.dx * this.step;
                      if (cell.dy) d.Y = cell.dy * this.step;
                      this.jog(d);
                    }}
                  >
                    ${cell.glyph}
                  </button>`,
            )}
          </div>
          ${others.map((l) => this.renderColumn(l, enabled))}
        </div>

        <div class="hand-steps">
          ${STEPS.map(
            (mm) => html`<button
              class="hand-step ${mm === this.step ? 'on' : ''}"
              @click=${() => {
                this.step = mm;
                this.requestUpdate();
              }}
            >
              ${mm}
            </button>`,
          )}
        </div>

        ${!enabled
          ? html`<div class="hand-note">
              ${!homed ? 'Not homed — jogging is off until it is.' : 'The machine is busy.'}
            </div>`
          : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-hand', HandPanel);

registerPanel({
  id: 'hand',
  title: 'At the machine',
  tag: 'cnc-hand',
  defaultWidth: 3,
  defaultHeight: 420,
  description: 'Position and jogging on one screen, for a phone in your hand at the machine',
});
