// Digital readout.
//
// Shows work and machine coordinates side by side, which is the single thing
// DWC's printer-shaped UI makes hardest. Work coordinates are what you cut in;
// machine coordinates are what you need when something has gone wrong.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, appendLog, capabilities, connected, machine } from '../core/store.js';
import { fixed } from '../core/util.js';
import { empty } from '../ui/widgets.js';
import type { Axis } from '../machine/types.js';

const WCS_NAMES = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'];

/** Which column of the readout a value came from. */
type Column = 'work' | 'machine';

/** Statuses during which an axis must not be driven from the readout. */
const BUSY = new Set(['running', 'paused', 'pausing', 'resuming', 'homing', 'tool-change', 'halted']);

export class DroPanel extends PanelElement {
  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  /**
   * Driving the machine from the readout: double-click to type a position,
   * drag sideways to scrub to one.
   *
   * Both of these MOVE the axis. That is worth being certain about, because
   * the other reading of "edit the DRO" — redefine this position as that
   * number — is equally plausible and does the opposite. The rule here is that
   * the readout says where the axis IS, so changing it changes where it is.
   * Redefining a position is what the 0 button and the Coordinates panel are
   * for, and neither of them moves anything.
   *
   * Which is also why this is fenced. An axis that is not homed has no idea
   * where it is, so an absolute move is a guess at speed; a machine that is
   * running a job has no business being dragged sideways. Both are refused
   * rather than clamped into something that looks like it worked.
   */
  private editing: { letter: string; column: Column } | null = null;
  /** Live scrub state: null unless a drag is in progress. */
  private scrub: {
    letter: string;
    column: Column;
    startX: number;
    from: number;
    value: number;
    moved: boolean;
  } | null = null;

  protected override updated(): void {
    // Focus and select the box the moment it appears. Without this a
    // double-click opens a field the operator then has to click again, and the
    // number they meant to replace is still in it waiting to be selected by
    // hand.
    const box = this.querySelector<HTMLInputElement>('.num.editing input');
    if (box && document.activeElement !== box) {
      box.focus();
      box.select();
    }
  }

  private zeroAxis(letter: string): void {
    void actions.setWorkZero(letter, 0);
  }

  /** Whether this axis can be driven to a position right now, and why not. */
  private blocked(axis: Axis): string | null {
    if (!connected.peek()) return 'Not connected';
    if (!axis.homed) {
      return `${axis.letter} is not homed — it does not know where it is, so it cannot be sent anywhere.`;
    }
    if (BUSY.has(machine.peek().status)) {
      return `The machine is ${machine.peek().status}.`;
    }
    if (!isFinite(axis.min) || !isFinite(axis.max) || axis.max <= axis.min) {
      return `${axis.letter} has no travel limits, so there is no range to move within.`;
    }
    return null;
  }

  /** Machine coordinate for a value shown in `column`. */
  private toMachine(axis: Axis, column: Column, value: number): number {
    return column === 'machine' ? value : value + (axis.machine - axis.work);
  }

  private fromMachine(axis: Axis, column: Column, machineValue: number): number {
    return column === 'machine' ? machineValue : machineValue - (axis.machine - axis.work);
  }

  /** The value clamped so the machine target stays inside the axis travel. */
  private clamp(axis: Axis, column: Column, value: number): number {
    const target = Math.min(axis.max, Math.max(axis.min, this.toMachine(axis, column, value)));
    return this.fromMachine(axis, column, target);
  }

  /** Send the axis to `value` as shown in `column`. */
  private goTo(axis: Axis, column: Column, value: number): void {
    const why = this.blocked(axis);
    if (why) {
      appendLog({ level: 'warning', text: why, time: new Date() });
      return;
    }
    const target = Math.min(axis.max, Math.max(axis.min, this.toMachine(axis, column, value)));
    // Nothing to do, and worth not doing: an empty move still takes the
    // machine out of idle and back, which flickers every control gated on it.
    if (Math.abs(target - axis.machine) < 0.001) return;
    // The axis's own maximum, because this is a positioning move rather than a
    // cut and the operator is waiting for it. maxFeed is 0 when the controller
    // does not say, in which case the driver's own default applies.
    void actions.moveToMachine({ [axis.letter]: target }, axis.maxFeed || undefined);
  }

  /** Take what was typed and act on it, once. */
  private commit(axis: Axis, column: Column, raw: string): void {
    // Guarded because both Enter and the browser's own change can arrive for
    // one edit, and sending the move twice would be a second move from the
    // position the first one is still travelling to.
    if (!this.editing) return;
    this.editing = null;
    const v = Number(raw);
    if (isFinite(v)) this.goTo(axis, column, v);
    this.requestUpdate();
  }

  // --- Scrubbing ------------------------------------------------------------

  private onScrubStart(e: PointerEvent, axis: Axis, column: Column): void {
    if (this.blocked(axis)) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    this.scrub = {
      letter: axis.letter,
      column,
      startX: e.clientX,
      from: column === 'machine' ? axis.machine : axis.work,
      value: column === 'machine' ? axis.machine : axis.work,
      moved: false,
    };
  }

  private onScrubMove(e: PointerEvent, axis: Axis): void {
    const s = this.scrub;
    if (!s || s.letter !== axis.letter) return;
    const dx = e.clientX - s.startX;
    // A dead zone, so a slightly draggy click is still a click. Without it a
    // double-click on a trackpad starts a 2px scrub and commits a move nobody
    // asked for.
    if (!s.moved && Math.abs(dx) < 3) return;
    s.moved = true;
    // Shift for fine. The default is a millimetre per 4px, which crosses a
    // 500mm axis in about half a screen — coarse enough to be useful and far
    // too coarse to land on a number, which is what shift and the keyboard are
    // for.
    const perPixel = e.shiftKey ? 0.01 : 0.25;
    s.value = this.clamp(axis, s.column, s.from + dx * perPixel);
    this.requestUpdate();
  }

  private onScrubEnd(axis: Axis): void {
    const s = this.scrub;
    this.scrub = null;
    if (!s || s.letter !== axis.letter) return;
    // On release, never during. A move per pointermove event would stream
    // commands at the rate of a finger and leave the machine chasing a drag
    // that has already finished somewhere else.
    if (s.moved) this.goTo(axis, s.column, s.value);
    this.requestUpdate();
  }

  // --- Rendering ------------------------------------------------------------

  private renderValue(axis: Axis, column: Column, live: boolean): TemplateResult {
    const shown = column === 'machine' ? axis.machine : axis.work;
    const why = this.blocked(axis);
    const editing =
      this.editing && this.editing.letter === axis.letter && this.editing.column === column;

    if (editing) {
      // The value is bound as an ATTRIBUTE, not as a property, and that is
      // load-bearing rather than a style choice. This panel re-renders on every
      // object-model poll — four times a second — and a `.value` property
      // binding would rewrite the box with the live machine position between
      // one keystroke and the next. As an attribute it sets the default only,
      // so once the field is dirty the operator's typing is theirs.
      return html`<td class="num ${column} editing">
        <input
          type="number"
          step="0.001"
          value=${shown.toFixed(3)}
          min=${this.fromMachine(axis, column, axis.min)}
          max=${this.fromMachine(axis, column, axis.max)}
          @keydown=${(e: KeyboardEvent) => {
            // Enter commits here rather than being left to the browser's own
            // change event. A number input only fires change on Enter under
            // conditions that vary by browser and do not exist at all on a
            // phone keyboard, and "I typed a position and pressed go and
            // nothing happened" is not a failure mode this control can have.
            if (e.key === 'Enter') this.commit(axis, column, (e.target as HTMLInputElement).value);
            if (e.key === 'Escape') {
              this.editing = null;
              this.requestUpdate();
            }
            // Whatever the key, it must not reach the page shortcuts — the
            // digits would switch page out from under the operator mid-number.
            e.stopPropagation();
          }}
          @change=${(e: Event) => this.commit(axis, column, (e.target as HTMLInputElement).value)}
          @blur=${() => {
            this.editing = null;
            this.requestUpdate();
          }}
        />
      </td>`;
    }

    const scrubbing = this.scrub?.letter === axis.letter && this.scrub.column === column;
    const value = scrubbing ? this.scrub!.value : shown;

    return html`<td
      class="num ${column} ${why ? '' : 'settable'} ${scrubbing ? 'scrubbing' : ''}"
      title=${why ?? `Drag to scrub ${axis.letter}, double-click to type a position. Shift for fine.`}
      @dblclick=${() => {
        if (!live || why) return;
        this.editing = { letter: axis.letter, column };
        this.requestUpdate();
      }}
      @pointerdown=${(e: PointerEvent) => this.onScrubStart(e, axis, column)}
      @pointermove=${(e: PointerEvent) => this.onScrubMove(e, axis)}
      @pointerup=${() => this.onScrubEnd(axis)}
      @pointercancel=${() => this.onScrubEnd(axis)}
    >
      ${fixed(value)}${scrubbing
        ? html`<span class="scrub-delta"
            >${this.scrub!.value - this.scrub!.from >= 0 ? '+' : ''}${fixed(
              this.scrub!.value - this.scrub!.from,
              2,
            )}</span
          >`
        : nothing}
    </td>`;
  }

  private zeroAll(): void {
    const state = machine.peek();
    for (const axis of state.axes) {
      if (axis.visible) void actions.setWorkZero(axis.letter, 0);
    }
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    const caps = capabilities.get();
    const live = connected.get();

    if (!state.axes.length) {
      return empty(live ? 'Waiting for axis data…' : 'Not connected');
    }

    return html`
      <div class="dro">
        ${caps.workCoordinateSystems > 1
          ? html`
              <div class="dro-wcs">
                ${WCS_NAMES.slice(0, caps.workCoordinateSystems).map(
                  (name, i) => html`
                    <button
                      class=${state.wcs === i + 1 ? 'seg active' : 'seg'}
                      ?disabled=${!live}
                      @click=${() => void actions.selectWcs(i + 1)}
                    >
                      ${name}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}

        <table class="dro-table">
          <thead>
            <tr>
              <th class="axis-col">Axis</th>
              <th class="num">Work</th>
              <th class="num">Machine</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${state.axes.map(
              (axis) => html`
                <tr class=${axis.homed ? '' : 'unhomed'}>
                  <td class="axis-col">
                    <span class="axis-letter">${axis.letter}</span>
                    ${axis.homed
                      ? nothing
                      : html`<span class="unhomed-dot" title="Not homed">●</span>`}
                  </td>
                  ${this.renderValue(axis, 'work', live)}
                  ${this.renderValue(axis, 'machine', live)}
                  <td class="dro-actions">
                    <button
                      class="tiny"
                      title="Zero ${axis.letter} in the active work coordinate system"
                      ?disabled=${!live}
                      @click=${() => this.zeroAxis(axis.letter)}
                    >
                      0
                    </button>
                    <button
                      class="tiny"
                      title="Home ${axis.letter}"
                      ?disabled=${!live}
                      @click=${() => void actions.home([axis.letter])}
                    >
                      ⌂
                    </button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>

        <div class="dro-foot">
          <button ?disabled=${!live} @click=${() => this.zeroAll()}>Zero all</button>
          <button ?disabled=${!live} @click=${() => void actions.home()}>Home all</button>
          ${state.feedRate != null
            ? html`<span class="readout">F ${Math.round(state.feedRate)}</span>`
            : nothing}
          ${state.feedMultiplier !== 1
            ? html`<span class="readout warn">${Math.round(state.feedMultiplier * 100)}%</span>`
            : nothing}
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-dro', DroPanel);

registerPanel({
  id: 'dro',
  title: 'Position',
  tag: 'cnc-dro',
  defaultWidth: 5,
  defaultHeight: 320,
  description: 'Work and machine coordinates, WCS selection, zeroing',
});
