// Digital readout.
//
// Shows work and machine coordinates side by side, which is the single thing
// DWC's printer-shaped UI makes hardest. Work coordinates are what you cut in;
// machine coordinates are what you need when something has gone wrong.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, appendLog, capabilities, connected, machine } from '../core/store.js';
import { fixed } from '../core/util.js';
import { handFeed } from '../core/motion.js';
import { empty } from '../ui/widgets.js';
import type { Axis } from '../machine/types.js';

const WCS_NAMES = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'];

/** Which column of the readout a value came from. */
type Column = 'work' | 'machine';

/**
 * One pass of filling in positions, across however many axes it touches.
 *
 * A session is per column, and that is the operator's own distinction: work
 * coordinates and machine coordinates are different numbers for the same place,
 * and Tab moving between them would change what the value means halfway through
 * typing a set of them.
 */
interface EditSession {
  column: Column;
  /** Axis whose box is open, or null when the values are typed but unsent. */
  editing: string | null;
  /** Axis letter → value in this session's column. Not yet sent anywhere. */
  pending: Map<string, number>;
}

/**
 * The axes Tab cycles between. See DroPanel.tabRing.
 *
 * Not derived from the object model's `visible` flag, which is about whether an
 * axis is shown at all rather than whether it is one of the three you fill in
 * together — the dust-shoe axis on this machine is perfectly visible.
 */
const PRIMARY = new Set(['X', 'Y', 'Z']);

/** Longest gap between two taps that still counts as a double tap, ms. */
const DOUBLE_TAP_MS = 400;
/** How far the second tap may land from the first, px. A finger is not a mouse. */
const DOUBLE_TAP_SLOP = 24;

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
  private session: EditSession | null = null;
  /**
   * The last tap that was not a drag, for spotting a double tap ourselves.
   *
   * iOS does not reliably deliver `dblclick` here. The cell captures the
   * pointer on pointerdown so a scrub can follow a finger that leaves the cell,
   * and a captured pointer breaks the chain Safari uses to synthesise the
   * double click — so the one gesture that opens the editor never arrived on
   * the device where typing a position is most useful.
   *
   * Two taps close together in time and place is not a hard thing to recognise,
   * and recognising it here costs nothing on a mouse: `dblclick` still fires
   * there and opening the editor twice is the same as opening it once.
   */
  private lastTap: { letter: string; column: Column; at: number; x: number; y: number } | null = null;

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
    // At the speed on the Motion panel's cursor, not at the axis maximum.
    // Driving the machine by typing a position is the same act as pressing a
    // jog sector, and a machine that answers one control at the speed you set
    // and the other at full tilt is a machine with two personalities.
    void actions.moveToMachine({ [axis.letter]: target }, handFeed([axis.letter]));
  }

  // --- Editing across axes --------------------------------------------------
  //
  // Tab keeps what was typed and moves to the next axis; Enter sends every
  // edited axis at once, as ONE coordinated move. That is the point of
  // collecting them rather than applying each as it is typed: three separate
  // moves trace a staircase through whatever is in the way, at positioning
  // speed, which is exactly the shape you were trying not to make. It is the
  // same reason jog takes a map of axes rather than one letter at a time.
  //
  // Nothing moves until Enter, so an edited-but-unsent value is shown in red.
  // A number on a readout that is not where the axis is is a lie unless it is
  // marked as one.

  /** Every axis on the readout, in the order it is drawn. */
  private get axes(): Axis[] {
    return machine.peek().axes;
  }

  /**
   * The axes Tab walks, which is not the same as the axes you can edit.
   *
   * X, Y and Z are the ones a position is set for together — you type all three
   * or you type two of them, and Tab is how you get from one to the next.
   * Anything else on the machine is an auxiliary: on this one U is the dust
   * shoe, set once and not touched again for hours, and putting it in the ring
   * costs a Tab press every time round for an axis nobody was filling in.
   *
   * It stays fully editable — double-click it, scrub it, it joins the same
   * pending set and goes out in the same coordinated move. It is just not on
   * the way from Z back to X.
   *
   * A machine with none of X, Y or Z falls back to all of its axes, because a
   * ring with nothing in it would make Tab do nothing at all.
   */
  private get tabRing(): Axis[] {
    const primary = this.axes.filter((a) => PRIMARY.has(a.letter.toUpperCase()));
    return primary.length ? primary : this.axes;
  }

  /** Take whatever is in the open box and remember it, without sending it. */
  private stash(raw: string): void {
    const s = this.session;
    if (!s || !s.editing) return;
    const axis = this.axes.find((a) => a.letter === s.editing);
    if (!axis) return;
    const v = Number(raw);
    // A box emptied and left empty is a cancelled edit for that axis, not a
    // move to zero. Zero is somewhere; blank is a change of mind.
    if (raw.trim() === '' || !isFinite(v)) {
      s.pending.delete(axis.letter);
      return;
    }
    s.pending.set(axis.letter, this.clamp(axis, s.column, v));
  }

  /** Move the open box to the next axis along, wrapping at the ends. */
  private step(raw: string, delta: 1 | -1): void {
    const s = this.session;
    if (!s || !s.editing) return;
    this.stash(raw);
    const letters = this.tabRing.map((a) => a.letter);
    const at = letters.indexOf(s.editing);
    // Tabbing out of an auxiliary axis joins the ring at its start rather than
    // doing nothing, which is what "not in the ring" would otherwise mean for
    // somebody who began the set by double-clicking U.
    if (at < 0) {
      s.editing = letters[delta > 0 ? 0 : letters.length - 1]!;
      this.requestUpdate();
      return;
    }
    // Wrapping, so Z leads back to X and X back to Z.
    s.editing = letters[(at + delta + letters.length) % letters.length]!;
    // Stay in the column the session started in. Tabbing from a machine
    // coordinate into a work coordinate would change what the number means
    // halfway through typing a set of them.
    this.requestUpdate();
  }

  /** Send every edited axis, in one move. */
  private apply(raw?: string): void {
    const s = this.session;
    if (!s) return;
    if (raw !== undefined) this.stash(raw);

    const targets: Record<string, number> = {};
    for (const [letter, value] of s.pending) {
      const axis = this.axes.find((a) => a.letter === letter);
      if (!axis) continue;
      const why = this.blocked(axis);
      if (why) {
        // Refuse the whole set rather than the part of it that would have
        // worked. Half a coordinated move is a different move.
        appendLog({ level: 'warning', text: `Not moving: ${why}`, time: new Date() });
        return;
      }
      const target = Math.min(axis.max, Math.max(axis.min, this.toMachine(axis, s.column, value)));
      if (Math.abs(target - axis.machine) < 0.001) continue;
      targets[letter] = target;
    }

    this.session = null;
    this.requestUpdate();
    const letters = Object.keys(targets);
    if (!letters.length) return;
    // The operator's chosen speed, capped by the slowest axis in the move: a
    // coordinated move runs at one rate, so asking for more than the slowest
    // can sustain would ask the others to exceed their own maximum on the way.
    void actions.moveToMachine(targets, handFeed(letters));
  }

  private cancel(): void {
    this.session = null;
    this.requestUpdate();
  }

  // --- Scrubbing ------------------------------------------------------------

  private onScrubStart(e: PointerEvent, axis: Axis, column: Column): void {
    if (this.blocked(axis)) return;
    const el = e.currentTarget as HTMLElement;
    // Guarded: a pointer that is no longer active — a synthetic event, or one
    // the browser has already released — throws here, and losing the capture
    // costs a scrub that stops at the edge of the cell rather than the whole
    // interaction.
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* scrub still works, it just will not follow the finger off the cell */
    }
    this.tapX = e.clientX;
    this.tapY = e.clientY;
    this.scrub = {
      letter: axis.letter,
      column,
      startX: e.clientX,
      from: column === 'machine' ? axis.machine : axis.work,
      value: column === 'machine' ? axis.machine : axis.work,
      moved: false,
    };
  }

  private tapX = 0;
  private tapY = 0;

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
    if (s.moved) {
      this.lastTap = null;
      this.goTo(axis, s.column, s.value);
      this.requestUpdate();
      return;
    }

    // Not a drag, so it was a tap. Two of them on the same number, close
    // together, open the editor — see lastTap.
    const now = Date.now();
    const prev = this.lastTap;
    const near =
      prev !== null &&
      prev.letter === axis.letter &&
      prev.column === s.column &&
      now - prev.at < DOUBLE_TAP_MS &&
      Math.abs(this.tapX - prev.x) < DOUBLE_TAP_SLOP &&
      Math.abs(this.tapY - prev.y) < DOUBLE_TAP_SLOP;

    if (near) {
      this.lastTap = null;
      this.openEditor(axis, s.column);
      return;
    }
    this.lastTap = { letter: axis.letter, column: s.column, at: now, x: this.tapX, y: this.tapY };
    this.requestUpdate();
  }

  /** Open the box on this cell, joining or starting a session. */
  private openEditor(axis: Axis, column: Column): void {
    if (!connected.peek() || this.blocked(axis)) return;
    // A session belongs to one column. Starting in the other one is a different
    // set of numbers meaning different things, so it starts over rather than
    // mixing the two.
    if (!this.session || this.session.column !== column) {
      this.session = { column, editing: axis.letter, pending: new Map() };
    } else {
      this.session.editing = axis.letter;
    }
    this.requestUpdate();
  }

  // --- Rendering ------------------------------------------------------------

  private renderValue(axis: Axis, column: Column): TemplateResult {
    const live0 = column === 'machine' ? axis.machine : axis.work;
    const why = this.blocked(axis);
    const s = this.session;
    const mine = s?.column === column;
    const pending = mine && s.pending.has(axis.letter) ? s.pending.get(axis.letter)! : null;
    const shown = pending ?? live0;
    const editing = mine && s.editing === axis.letter;

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
            const raw = (e.target as HTMLInputElement).value;
            if (e.key === 'Tab') {
              // Taken over from the browser. Its own Tab would leave the panel
              // for the next button on the page, and what is wanted is the next
              // axis — the readout is one thing being filled in, not four
              // controls that happen to be near each other.
              e.preventDefault();
              this.step(raw, e.shiftKey ? -1 : 1);
            }
            // Enter applies here rather than being left to the browser's own
            // change event. A number input only fires change on Enter under
            // conditions that vary by browser and do not exist at all on a
            // phone keyboard, and "I typed a position and pressed go and
            // nothing happened" is not a failure mode this control can have.
            if (e.key === 'Enter') this.apply(raw);
            if (e.key === 'Escape') this.cancel();
            // Whatever the key, it must not reach the page shortcuts — the
            // digits would switch page out from under the operator mid-number.
            e.stopPropagation();
          }}
          @change=${(e: Event) => this.stash((e.target as HTMLInputElement).value)}
          @blur=${(e: Event) => {
            // Keeps the value, does NOT end the session. Tab removes this input
            // and builds the next one, so blur fires on every step — treating it
            // as "done" would throw away the set on the first Tab.
            this.stash((e.target as HTMLInputElement).value);
          }}
        />
      </td>`;
    }

    const scrubbing = this.scrub?.letter === axis.letter && this.scrub.column === column;
    const value = scrubbing ? this.scrub!.value : shown;

    return html`<td
      class="num ${column} ${why ? '' : 'settable'} ${scrubbing ? 'scrubbing' : ''} ${
        pending !== null ? 'pending' : ''
      }"
      title=${why ??
      (pending !== null
        ? `${axis.letter} is set to ${fixed(pending)} but has not been sent. Enter to go, Escape to forget it.`
        : `Drag to scrub ${axis.letter}, double-click to type a position. Tab for the next axis, Enter to go.`)}
      @dblclick=${() => this.openEditor(axis, column)}
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
                  ${this.renderValue(axis, 'work')}
                  ${this.renderValue(axis, 'machine')}
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

        ${this.session?.pending.size
          ? html`<div class="dro-pending">
              <span>${this.session.pending.size} typed, not sent</span>
              <!-- Buttons as well as Enter and Escape. A phone keyboard has
                   neither, and this is the panel people use standing at the
                   machine. -->
              <button class="primary" @click=${() => this.apply()}>Go</button>
              <button class="ghost" @click=${() => this.cancel()}>Cancel</button>
            </div>`
          : nothing}

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
