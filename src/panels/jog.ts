// Motion control: a compass rose of distances.
//
// The old panel made every jog two decisions — pick a step, then pick a
// direction — and it only did four directions. This one puts distance and
// direction in the same press: concentric rings, eight octants each, so the
// sector you touch says both where and how far. Nearer the centre is finer.
//
// Three rules the layout follows.
//
//   Every distance is a number an operator could have chosen. The rings take
//   consecutive rungs off a 1–5 ladder, so they read 0.1 / 0.5 / 1 / 5 / 10 and
//   never 1.3467. Nothing here divides a maximum by a ring count.
//
//   A diagonal moves the ring's distance on BOTH axes — 5mm NE is X+5 Y+5, not
//   3.5355 each. That keeps the numbers honest, and it is what you want when
//   walking into a corner. It goes out as one G1, not two, so the path is the
//   diagonal rather than an L through whatever is in the way.
//
//   Nearer the centre is a fatter ring. The rings are equal in AREA, not in
//   thickness, which makes the innermost band the widest — and the finest step
//   is the one you press twenty times in a row while creeping up on an edge.
//
// Note on hold-to-jog: there is no continuous-jog command over HTTP polling, so
// holding a button fires repeated discrete relative moves, as DWC does. The
// repeat rate is deliberately conservative — queueing moves faster than the
// machine consumes them makes the button feel laggy and, worse, keeps moving
// after release.

import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, connected, loadSetting, machine, saveSetting } from '../core/store.js';
import { BUSY_STATES } from '../machine/types.js';
import { empty } from '../ui/widgets.js';
import {
  feedLadder,
  STEP_LADDER,
  nearestStep,
  ringSteps,
  stepAtMost,
  stepLabel,
  stepTick,
} from '../core/steps.js';

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 180;

/** Rose geometry, in viewBox units. */
const OUTER_R = 100;
const HUB_R = 30;

/**
 * How ring thickness is distributed, as the exponent in
 * r(k) = hub + (outer − hub) · (k/n)^E.
 *
 * E = 1 gives equal thickness; E = 0.5 gives equal area. Equal area is the
 * right instinct — the finest step is the one pressed twenty times while
 * creeping onto an edge, so it should be the fattest band — but it starves the
 * outer rings badly enough at six rings that their labels no longer fit between
 * them. 0.7 keeps the centre generous while leaving the thinnest band about
 * two-thirds the width of the widest.
 */
const RING_EXPONENT = 0.7;

/**
 * The eight octants, anticlockwise from +X.
 *
 * Integer deltas: a diagonal gets the full ring distance on each axis. `angle`
 * is measured the way maths does — anticlockwise from +X — and the projection
 * below flips it into SVG's downward Y so that "up on screen" is +Y on the
 * machine.
 */
const OCTANTS: Array<{ dx: number; dy: number; angle: number; name: string }> = [
  { dx: 1, dy: 0, angle: 0, name: 'X+' },
  { dx: 1, dy: 1, angle: 45, name: 'X+ Y+' },
  { dx: 0, dy: 1, angle: 90, name: 'Y+' },
  { dx: -1, dy: 1, angle: 135, name: 'X− Y+' },
  { dx: -1, dy: 0, angle: 180, name: 'X−' },
  { dx: -1, dy: -1, angle: 225, name: 'X− Y−' },
  { dx: 0, dy: -1, angle: 270, name: 'Y−' },
  { dx: 1, dy: -1, angle: 315, name: 'X+ Y−' },
];

interface JogSettings {
  /** Index into STEP_LADDER of the outermost ring. */
  maxStep: number;
  feed: number;
  rings: number;
}

const DEFAULTS: JogSettings = { maxStep: nearestStep(10), feed: 1000, rings: 4 };

/** Point on the rose at radius `r` and maths-convention angle `deg`. */
function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), -r * Math.sin(a)];
}

/**
 * SVG rotation that lays a label along its ring, upright.
 *
 * Tangential rather than horizontal, and not only for looks: horizontal labels
 * line up radially on the E and W spokes, so each one may be no WIDER than its
 * ring is thick — which is what forced the type down to near-illegible at six
 * rings. Along the arc, the constraint becomes font HEIGHT against ring
 * thickness, and the arc is far longer than the band is thick. Radial
 * collisions stop being possible and the type can grow.
 *
 * SVG angles run clockwise because Y points down, so the label's own angle is
 * −θ and the tangent is a further +90°. Anything that would end up reading
 * upside down — the whole southern half — is flipped by 180°, which is the same
 * line read from the other end.
 */
function labelRotation(deg: number): number {
  let r = -deg + 90;
  while (r > 90) r -= 180;
  while (r < -90) r += 180;
  return r;
}

/** Annular sector spanning `deg ± half`, as a path. */
function sectorPath(rInner: number, rOuter: number, deg: number, half: number): string {
  const [x1, y1] = polar(rOuter, deg - half);
  const [x2, y2] = polar(rOuter, deg + half);
  const [x3, y3] = polar(rInner, deg + half);
  const [x4, y4] = polar(rInner, deg - half);
  // sweep-flag 0 going out, 1 coming back: increasing maths angle is
  // anticlockwise on the machine, which is the negative sweep direction once
  // SVG's downward Y has flipped it.
  return (
    `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 0 0 ${x2} ${y2} ` +
    `L ${x3} ${y3} A ${rInner} ${rInner} 0 0 1 ${x4} ${y4} Z`
  );
}

export class JogPanel extends PanelElement {
  private settings: JogSettings = { ...DEFAULTS, ...loadSetting<Partial<JogSettings>>('jog', {}) };
  private repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatInterval: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
    });
    this.onDispose(() => this.stopRepeat());
  }

  private get canMove(): boolean {
    return connected.get() && !BUSY_STATES.has(machine.get().status);
  }

  /** Distances for each ring of the XY rose, innermost first. */
  private get steps(): number[] {
    return ringSteps(this.settings.maxStep, this.settings.rings);
  }

  /**
   * Distances for one of the vertical columns.
   *
   * Taken from the axis's own travel rather than from the Reach slider. Reach is
   * an XY idea — how far across the table you want one press to carry you — and
   * applying it to Z gave this machine a 500mm button on an axis with 135mm to
   * move in, and the same button on the dust shoe's U, which has 70. The ladder
   * still steps in the same 1–5 rungs, so the columns and the rose remain
   * comparable; only the top of the ladder differs.
   */
  private columnSteps(letter: string): number[] {
    const axis = machine.get().axes.find((a) => a.letter === letter);
    const travel = axis && isFinite(axis.min) && isFinite(axis.max) ? axis.max - axis.min : 0;
    // No travel reported is not the same as no travel: fall back to the rose's
    // ladder rather than offering a single 0.01mm button.
    if (!(travel > 0)) return this.steps;
    return ringSteps(stepAtMost(travel), this.settings.rings);
  }

  /**
   * How far an axis can still go that way before its soft limit.
   *
   * Null when the question is meaningless — an axis that has not been homed has
   * no machine position worth trusting, and the firmware is not enforcing limits
   * on it either.
   */
  private headroom(letter: string, sign: number): number | null {
    const axis = machine.get().axes.find((a) => a.letter === letter);
    if (!axis || !axis.homed) return null;
    if (!isFinite(axis.min) || !isFinite(axis.max) || axis.max <= axis.min) return null;
    return Math.max(0, sign > 0 ? axis.max - axis.machine : axis.machine - axis.min);
  }

  /**
   * What a press would actually do.
   *
   * The firmware will not run past a soft limit, so a 10mm button 3mm from the
   * end of the axis is a 3mm button — and it says 10. Naming the axis that runs
   * out first matters on a diagonal, where the number alone does not say which
   * of X and Y stopped it.
   *
   * The move sent is clamped to match. Displaying the truth and then asking for
   * something else would leave the firmware to refuse it, which on RRF is an
   * error in the console rather than a shorter move.
   */
  private reachable(deltas: Record<string, number>): { deltas: Record<string, number>; limit: string | null; mm: number } {
    const asked = Math.max(...Object.values(deltas).map((d) => Math.abs(d)));
    let room = Infinity;
    let limit: string | null = null;

    for (const [letter, delta] of Object.entries(deltas)) {
      const free = this.headroom(letter, Math.sign(delta));
      if (free === null) continue;
      if (free < room) {
        room = free;
        limit = letter;
      }
    }

    if (room >= asked) return { deltas, limit: null, mm: asked };

    // Rounded down, not to nearest: landing a hair past the limit is exactly
    // the refusal this is here to avoid.
    const mm = Math.floor(room * 1000) / 1000;
    const scaled: Record<string, number> = {};
    for (const [letter, delta] of Object.entries(deltas)) scaled[letter] = Math.sign(delta) * mm;
    return { deltas: scaled, limit, mm };
  }

  /** NOT `update` — that is a LitElement lifecycle method. */
  private patchSettings(patch: Partial<JogSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSetting('jog', this.settings);
    this.requestUpdate();
  }

  /**
   * Fastest feed every axis in the move can sustain.
   *
   * Asking for more than the slowest one does not go faster — the firmware
   * clamps to what the combination allows — but showing a number the machine
   * will not honour makes the cursor a lie.
   */
  private feedLimit(axes: string[]): number {
    const limits = machine
      .get()
      .axes.filter((a) => axes.includes(a.letter) && a.maxFeed > 0)
      .map((a) => a.maxFeed);
    return limits.length ? Math.min(...limits) : Infinity;
  }

  // --- Motion -------------------------------------------------------------

  private move(deltas: Record<string, number>): void {
    const { deltas: actual, mm } = this.reachable(deltas);
    if (!(mm > 0)) return;
    const feed = Math.min(this.settings.feed, this.feedLimit(Object.keys(actual)));
    void actions.jog(actual, feed);
  }

  private startRepeat(deltas: Record<string, number>): void {
    this.stopRepeat();
    this.move(deltas);
    this.repeatTimer = setTimeout(() => {
      this.repeatInterval = setInterval(() => this.move(deltas), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }

  private stopRepeat(): void {
    if (this.repeatTimer) clearTimeout(this.repeatTimer);
    if (this.repeatInterval) clearInterval(this.repeatInterval);
    this.repeatTimer = null;
    this.repeatInterval = null;
  }

  /** Pointer handlers shared by every motion control, rose or column. */
  private pressHandlers(deltas: Record<string, number>) {
    return {
      onDown: (e: PointerEvent) => {
        if (!this.canMove) return;
        e.preventDefault();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        this.startRepeat(deltas);
      },
      onUp: () => this.stopRepeat(),
    };
  }

  // --- Rose ---------------------------------------------------------------

  private renderRose(): SVGTemplateResult {
    const steps = this.steps;
    const enabled = this.canMove;

    const radius = (k: number) =>
      HUB_R + (OUTER_R - HUB_R) * (k / steps.length) ** RING_EXPONENT;

    const sectors: SVGTemplateResult[] = [];
    steps.forEach((mm, ring) => {
      const rInner = radius(ring);
      const rOuter = radius(ring + 1);
      // A hair of angular padding so neighbouring sectors read as separate
      // targets rather than one continuous band.
      const half = 22.5 - 1.2;
      const labelR = (rInner + rOuter) / 2;
      // Sized to the band. With the labels lying along their arc the limit is
      // the glyph height against the ring thickness, not the text width, so
      // this can be far more generous than it had to be when they were
      // horizontal.
      const fontSize = Math.max(5, Math.min(13, (rOuter - rInner) * 0.62));

      for (const octant of OCTANTS) {
        const [lx, ly] = polar(labelR, octant.angle);
        const deltas: Record<string, number> = {};
        if (octant.dx) deltas.X = octant.dx * mm;
        if (octant.dy) deltas.Y = octant.dy * mm;
        const { onDown, onUp } = this.pressHandlers(deltas);

        // What this sector would really do. Clamped sectors show the distance
        // they can reach, not the one they are named after.
        const reach = this.reachable(deltas);
        const stuck = reach.limit !== null && reach.mm <= 0;
        const short = reach.limit !== null && reach.mm > 0;
        const cls = `rose-cell${enabled ? '' : ' disabled'}${short ? ' short' : ''}${stuck ? ' stuck' : ''}`;

        sectors.push(svg`
          <g
            class=${cls}
            @pointerdown=${onDown}
            @pointerup=${onUp}
            @pointercancel=${onUp}
            @pointerleave=${onUp}
          >
            <title>${octant.name} ${stepLabel(mm)}mm${
              stuck
                ? ` — ${reach.limit} is at its limit, this would not move`
                : short
                  ? ` — ${reach.limit} max reached after ${stepLabel(reach.mm)}mm`
                  : ''
            }</title>
            <path d=${sectorPath(rInner, rOuter, octant.angle, half)} />
            <text
              x=${lx}
              y=${ly}
              dy="0.36em"
              transform=${`rotate(${labelRotation(octant.angle)} ${lx} ${ly})`}
              style="font-size:${fontSize}px"
            >${stuck ? 'max' : short ? stepTick(reach.mm) : stepTick(mm)}</text>
          </g>
        `);
      }
    });

    return svg`
      <svg class="rose" viewBox="-104 -104 208 208" role="group" aria-label="XY jog">
        ${sectors}
        <g
          class=${enabled ? 'rose-hub' : 'rose-hub disabled'}
          @click=${() => enabled && void actions.home(['X', 'Y'])}
        >
          <title>Home X and Y</title>
          <circle r=${HUB_R - 4} />
          <text y="4">⌂ XY</text>
        </g>
      </svg>
    `;
  }

  // --- Vertical axes ------------------------------------------------------

  /**
   * One axis as a column: largest step at the top, home in the middle, mirrored
   * below. The same ladder as the rose, so "the second cell out" means the same
   * distance whichever control you reach for.
   */
  private renderColumn(letter: string): TemplateResult {
    const steps = this.columnSteps(letter);
    const enabled = this.canMove;
    const button = (mm: number, sign: 1 | -1) => {
      const deltas = { [letter]: sign * mm };
      const { onDown, onUp } = this.pressHandlers(deltas);
      const reach = this.reachable(deltas);
      const stuck = reach.limit !== null && reach.mm <= 0;
      const short = reach.limit !== null && reach.mm > 0;
      const end = sign > 0 ? 'max' : 'min';
      return html`
        <button
          class="jog-cell${short ? ' short' : ''}${stuck ? ' stuck' : ''}"
          ?disabled=${!enabled || stuck}
          title=${stuck
            ? `${letter} is at its ${end} — this would not move`
            : short
              ? `${letter}${sign > 0 ? '+' : '−'} ${stepLabel(mm)}mm — only ${stepLabel(reach.mm)}mm to ${letter} ${end}`
              : `${letter}${sign > 0 ? '+' : '−'} ${stepLabel(mm)}mm`}
          @pointerdown=${onDown}
          @pointerup=${onUp}
          @pointercancel=${onUp}
          @pointerleave=${onUp}
        >
          <span class="jog-arrow">${sign > 0 ? '▲' : '▼'}</span>
          <span class="jog-mm">${stuck ? '—' : stepLabel(short ? reach.mm : mm)}</span>
          ${short || stuck
            ? html`<span class="jog-max">${letter} ${end}</span>`
            : nothing}
        </button>
      `;
    };

    return html`
      <div class="jog-column">
        <div class="jog-column-name">${letter}</div>
        ${[...steps].reverse().map((mm) => button(mm, 1))}
        <button
          class="jog-cell home"
          ?disabled=${!enabled}
          title="Home ${letter}"
          @click=${() => void actions.home([letter])}
        >
          ⌂
        </button>
        ${steps.map((mm) => button(mm, -1))}
      </div>
    `;
  }

  // --- Work zero ----------------------------------------------------------

  /**
   * Where work zero is in machine coordinates, so the tooltip can show it.
   *
   * Worth showing: the button goes to the origin of whichever WCS is active,
   * and the commonest way for this to surprise someone is that it is not the
   * WCS they thought.
   */
  private zeroAt(letter: string): number | null {
    const axis = machine.get().axes.find((a) => a.letter === letter);
    if (!axis || !axis.homed) return null;
    return Math.round((axis.machine - axis.work) * 1000) / 1000;
  }

  /**
   * Rapid to the work origin.
   *
   * Z goes up first, always, and that is not negotiable: X and Y moving with
   * the tool still down drags it through whatever is on the table, and "I was
   * already clear" is not something a button can know. It costs a rapid on an
   * axis that is 135mm long here, and it cannot crash.
   *
   * With Z, the descent comes last and lands on work zero — which is the whole
   * point of the button, and also the reason it is a separate one from XY.
   *
   * M120/M121 around it so the machine is left in whatever distance mode it was
   * in; jog moves are relative, and leaving G90 set behind would make the next
   * one absolute.
   *
   * G0 here and G1 for jogging, which is not an inconsistency. In CNC mode RRF
   * runs G0 at the M203 maximum and ignores any F, so G0 means "as fast as this
   * machine goes" — right for a button whose whole job is to get back to the
   * origin, wrong for a jog, where the speed slider has to be obeyed.
   */
  private goWorkZero(withZ: boolean): void {
    const z = machine.get().axes.find((a) => a.letter === 'Z');
    const lift = z && isFinite(z.max) ? `G53 G0 Z${z.max}\n` : '';
    const descend = withZ ? 'G0 Z0\n' : '';
    void actions.send(`M120\nG90\n${lift}G0 X0 Y0\n${descend}M121`);
  }

  /** Every axis the work-zero moves touch has to know where it is. */
  private get zeroReady(): boolean {
    const axes = machine.get().axes;
    return ['X', 'Y', 'Z'].every((l) => axes.find((a) => a.letter === l)?.homed === true);
  }

  private renderWorkZero(): TemplateResult {
    const ready = this.canMove && this.zeroReady;
    const at = (l: string) => {
      const v = this.zeroAt(l);
      return v === null ? '?' : String(v);
    };
    const where = `work zero is X${at('X')} Y${at('Y')} Z${at('Z')} in machine coordinates`;
    const why = !this.zeroReady
      ? 'Home X, Y and Z first — a work offset means nothing until the machine knows where it is.'
      : '';

    return html`
      <span class="label">Work zero</span>
      <div class="segmented">
        <button
          class="seg"
          ?disabled=${!ready}
          title=${why || `Lift Z clear, then rapid to X0 Y0 — ${where}`}
          @click=${() => this.goWorkZero(false)}
        >
          XY
        </button>
        <button
          class="seg"
          ?disabled=${!ready}
          title=${why || `Lift Z clear, rapid to X0 Y0, then down to Z0 — ${where}`}
          @click=${() => this.goWorkZero(true)}
        >
          XYZ
        </button>
      </div>
    `;
  }

  // --- Cursors ------------------------------------------------------------

  private renderCursors(): TemplateResult {
    const steps = this.steps;
    // Built from the machine's own limit rather than filtered from a list, so
    // the top rung IS the limit — see feedLadder. A fixed ladder could only
    // offer the nearest rung at or below it, which left an M203 of 12000
    // capped at 10000.
    const feedCap = this.feedLimit(['X', 'Y']);
    const feeds = feedLadder(feedCap);
    // Snap DOWN to the nearest rung, never up. The ladder changes with the
    // machine's limit now, so a saved 3000 can find itself between rungs — and
    // the old code answered that by selecting the last index, which is to say
    // the maximum. A preference that quietly becomes full speed is the one
    // direction this must not fail in.
    // A loop rather than findLastIndex, which is ES2023 — this bundle targets
    // safari12 and tsc caught it.
    const wanted = this.settings.feed;
    let feedIndex = 0;
    for (let i = 0; i < feeds.length; i++) if (feeds[i]! <= wanted) feedIndex = i;
    const chosen = feeds[feedIndex]!;

    return html`
      <div class="jog-cursors">
        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Reach</span>
            <strong>${stepLabel(steps[steps.length - 1])} mm</strong>
            <em class="jog-cursor-note">XY</em>
          </span>
          <input
            type="range"
            min="0"
            max=${STEP_LADDER.length - 1}
            step="1"
            .value=${String(this.settings.maxStep)}
            @input=${(e: Event) =>
              this.patchSettings({ maxStep: Number((e.target as HTMLInputElement).value) })}
          />
          <span class="jog-cursor-foot">
            <em>rings</em>${steps.map((s) => html`<em>${stepLabel(s)}</em>`)}
          </span>
        </label>

        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Speed</span>
            <strong>${chosen} mm/min</strong>
          </span>
          <input
            type="range"
            min="0"
            max=${feeds.length - 1}
            step="1"
            .value=${String(feedIndex)}
            @input=${(e: Event) =>
              this.patchSettings({ feed: feeds[Number((e.target as HTMLInputElement).value)] })}
          />
          <span class="jog-cursor-foot">
            <em>${isFinite(feedCap) ? `machine limit ${feedCap} mm/min` : ' '}</em>
          </span>
        </label>
      </div>
    `;
  }

  // --- Render -------------------------------------------------------------

  protected override render(): TemplateResult {
    const state = machine.get();
    if (!state.axes.length) return empty(connected.get() ? 'Waiting for axes…' : 'Not connected');

    const letters = new Set(state.axes.map((a) => a.letter));
    // Anything past X and Y — Z, and this machine's U dust shoe — gets its own
    // column beside the rose rather than being squeezed into it.
    const columns = state.axes.map((a) => a.letter).filter((l) => l !== 'X' && l !== 'Y');

    return html`
      <div class="jog">
        ${this.renderCursors()}

        <div class="jog-pads">
          ${letters.has('X') && letters.has('Y') ? this.renderRose() : nothing}
          ${columns.map((l) => this.renderColumn(l))}
        </div>

        <div class="jog-foot">
          ${this.renderWorkZero()}
          <span class="label">Rings</span>
          <div class="segmented">
            ${[2, 3, 4, 5, 6].map(
              (n) => html`
                <button
                  class=${n === this.settings.rings ? 'seg active' : 'seg'}
                  @click=${() => this.patchSettings({ rings: n })}
                >
                  ${n}
                </button>
              `,
            )}
          </div>
          ${!this.canMove && connected.get()
            ? html`<span class="jog-blocked">Machine busy — jogging disabled</span>`
            : nothing}
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-jog', JogPanel);

registerPanel({
  id: 'jog',
  title: 'Motion',
  tag: 'cnc-jog',
  defaultWidth: 4,
  defaultHeight: 460,
  description: 'Compass-rose jogging: direction and distance in one press',
});
