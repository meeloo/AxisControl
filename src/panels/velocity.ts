// Continuous jogging: a stick you push, not a distance you pick.
//
// The Motion panel's rose answers "move X by five millimetres". This one
// answers the other question an operator asks all day — "creep that way while I
// watch" — which no amount of picking distances gets you. Edge-finding by eye,
// walking a probe into a corner, sneaking up on a scribe line: those are one
// continuous motion under a thumb, and until M700 there was no way to say it.
// (What the app did instead was fire repeated short moves while the button was
// held, which is what DWC does and has the failure everyone knows: the queue
// fills, the control goes numb, and the machine keeps moving after release.)
//
// So the whole panel is one input: deflection is speed. Push further, go
// faster. Let go, stop.
//
// The parts that are not the pad are all there because velocity jogging has
// three ways of lying to you that distance jogging does not:
//
//   A commanded speed is silently clamped, never refused. Two separate ceilings
//   apply — the axis maximum, and one set by how far ahead motion is prepared —
//   and asking for more than either simply runs slower than asked. So the
//   ceiling is computed and shown, and the readout marks any axis that is
//   being held below what the pad is asking for.
//
//   A refused jog looks exactly like a working one. The refusals ("insufficient
//   axes homed", "cannot jog while a print is running") come back as console
//   text long after the command was accepted, so the pad would happily show a
//   velocity for a machine standing still. core/velocity.ts watches for them.
//
//   An axis that hits its soft limit stops while the others keep going. That is
//   correct firmware behaviour and it is invisible unless someone says so, so
//   the readout marks it.
//
// Holding is the deadman. There is no click-to-latch and there should never be
// one: every control here stops the moment it is released, loses focus, or is
// interrupted, and that property is the reason a velocity pad is safe to put on
// a touchscreen at all.

import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, capabilities, connected, machine } from '../core/store.js';
import { empty } from '../ui/widgets.js';
import {
  CHUNK_RANGE,
  DEFAULT_CHUNK_MS,
  RATE_RANGE,
  applyVelocitySettings,
  axisSpeedCeiling,
  canVelocityJog,
  fitToCeilings,
  jogHealth,
  jogRefusal,
  jogRunning,
  jogStatus,
  jogSupport,
  jogVector,
  loadVelocitySettings,
  probeSupport,
  setJogVector,
  shapeStick,
  speedCeiling,
  stopJog,
  type VelocitySettings,
} from '../core/velocity.js';

/** Pad geometry, in viewBox units. The pad's radius is 100. */
const PAD_R = 100;
/** Travel of a one-dimensional strip, in its own viewBox units. */
const STRIP_H = 100;

/**
 * Each control's viewBox and how much of it is travel.
 *
 * Kept beside the templates that use them because `deflection` has to agree
 * with the `viewBox` attribute exactly — a pad whose maths and whose picture
 * disagree puts the knob somewhere the finger is not.
 */
const STICK_VIEW = { w: 224, h: 224, travel: PAD_R };
const STRIP_VIEW = { w: 48, h: 224, travel: STRIP_H };

/**
 * How close to a soft limit counts as "at it", mm.
 *
 * Not zero: the axis stops a hair short of the limit and the reported position
 * is a poll or two old, so an exact comparison marks the limit only after the
 * machine has been sitting against it for a while — which is exactly when the
 * operator has already worked out why nothing is moving.
 */
const AT_LIMIT_MM = 0.2;

/**
 * Command rates on offer, Hz.
 *
 * Both ends are load-bearing. 20 is the slowest that leaves real margin against
 * a 250ms watchdog — five missed commands — and going below it means a dropped
 * request can stop the machine mid-jog. 50 is the fastest worth sending: past
 * it the board spends more of each command cycle parsing than moving and the
 * free-buffer figure starts trending down, which is the same problem arriving
 * as lag instead of as an error.
 */
const RATES = [RATE_RANGE.min, 30, RATE_RANGE.max];
const RATE_HELP =
  'How often the velocity is resent. Faster follows the thumb more closely; slower is easier on a ' +
  'busy board. The machine stops itself if nothing arrives for 250ms, so this is also the margin ' +
  'against a dropped request.';

/**
 * One axis's speed, in a form whose width does not depend on its value.
 *
 * Always one decimal below 100 and none above it, so the string is at most five
 * characters — and the box it sits in is sized for five, right-aligned. That is
 * the whole point: a readout that reflows as the numbers change moves
 * everything to the right of it, thirty times a second, while the operator's
 * thumb is on the pad. Reserving the space costs nothing and it cannot happen.
 */
function speedText(v: number): string {
  if (v === 0) return '0.0';
  const mag = Math.abs(v);
  return `${v > 0 ? '+' : '−'}${mag >= 100 ? mag.toFixed(0) : mag.toFixed(1)}`;
}

/** Which keys drive which axis, and which way. */
const KEY_AXES: Record<string, { axis: string; sign: 1 | -1 }> = {
  ArrowRight: { axis: 'X', sign: 1 },
  ArrowLeft: { axis: 'X', sign: -1 },
  ArrowUp: { axis: 'Y', sign: 1 },
  ArrowDown: { axis: 'Y', sign: -1 },
  PageUp: { axis: 'Z', sign: 1 },
  PageDown: { axis: 'Z', sign: -1 },
};

export class VelocityJogPanel extends PanelElement {
  private settings: VelocitySettings = loadVelocitySettings();
  /** Stick deflection, −1…1 per axis, +y up. Raw: shaping happens at emit. */
  private stick = { x: 0, y: 0 };
  /** Deflection of each single-axis strip, −1…1. */
  private strips: Record<string, number> = {};
  /** Keys currently held down, by their code. */
  private keys = new Set<string>();

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
      jogVector.get();
      jogRunning.get();
      jogSupport.get();
      jogStatus.get();
      jogHealth.get();
      jogRefusal.get();
    });
    void probeSupport();
    // A panel that goes away while the machine is moving must take the motion
    // with it. Switching tabs detaches the element — the pointer never comes
    // up, so nothing else in here would ever fire — and the ticker would go on
    // driving the machine from a panel that is no longer on screen.
    this.onDispose(() => this.release('the panel was closed'));
  }

  // --- Building the vector -------------------------------------------------

  /**
   * Turn every input's deflection into one velocity vector and send it.
   *
   * One place, one vector, every time — which is not a tidiness preference. In
   * M700 the axes named in a command ARE the whole vector and anything omitted
   * is commanded to zero, so a stick that sent only X and a strip that sent only
   * Z would spend the whole jog cancelling each other out at 30Hz.
   */
  /**
   * The speed a full push of THIS control should mean, mm/s.
   *
   * Each control is capped by the axes it drives rather than all of them
   * sharing one number, and the reason is how a pad feels when the chosen speed
   * is above the ceiling. Shape the travel against 25 mm/s on an axis that
   * cannot exceed 10 and the outer sixty per cent of the pad all does exactly
   * the same thing: the machine reaches full speed somewhere in the middle and
   * the rest of the travel is dead. Shaping against the ceiling instead spreads
   * the whole gesture over the range the machine actually has.
   *
   * The operator's chosen speed is kept as it was rather than written down to
   * the ceiling, so raising the lookahead — or the axis M201 — gives it back.
   */
  private reach(letters: string[]): number {
    const cap = speedCeiling(letters, this.settings.chunkMs);
    return isFinite(cap) ? Math.min(this.settings.maxSpeed, cap) : this.settings.maxSpeed;
  }

  private emit(): void {
    const out: Record<string, number> = {};

    const shaped = shapeStick(this.stick.x, this.stick.y, {
      ...this.settings,
      maxSpeed: this.reach(['X', 'Y']),
    });
    if (shaped.x) out.X = shaped.x;
    if (shaped.y) out.Y = shaped.y;

    for (const [letter, t] of Object.entries(this.strips)) {
      const v = shapeStick(0, t, { ...this.settings, maxSpeed: this.reach([letter]) }).y;
      if (v) out[letter] = v;
    }

    for (const code of this.keys) {
      const k = KEY_AXES[code];
      // Full deflection: a key is on or off, and the speed cursor is where the
      // operator already said how fast "on" should be.
      if (k) out[k.axis] = k.sign * this.reach([k.axis]);
    }

    // A backstop rather than the main event now that each control is shaped
    // against its own ceiling — but still needed, because a stick and a strip
    // held together make a vector neither of them checked, and because it is
    // the one place that guarantees nothing goes out above a limit. As one
    // scaled vector rather than axis by axis; see fitToCeilings for why that
    // distinction matters.
    setJogVector(fitToCeilings(out, this.settings.chunkMs));
  }

  /** Everything back to centre, and the machine stopped. */
  private release(reason?: string): void {
    this.stick = { x: 0, y: 0 };
    this.strips = {};
    this.keys.clear();
    stopJog(reason);
    this.requestUpdate();
  }

  // --- Pointer -------------------------------------------------------------

  /**
   * Where the pointer is, in units of the control's own travel.
   *
   * Measured against the DRAWN control, not against the element that holds it,
   * and that distinction is the whole reason this takes viewBox arguments. An
   * SVG scales its viewBox to fit and centres what is left over — so an element
   * laid out 227 wide and 447 tall draws a 227px circle with 110px of empty
   * space above and below it. Dividing by the element's half-height there gives
   * a pad where pushing to the very top reaches half speed, and where the knob
   * sits nowhere near the finger. Neither is visible in a screenshot; both are
   * immediately obvious with a hand on it.
   *
   * `travel` is full deflection in viewBox units, which is not the same as the
   * viewBox's own half-size: the pad is 100 units of travel inside a 224-unit
   * box, the margin being where the axis labels live.
   */
  private deflection(
    e: PointerEvent,
    el: Element,
    view: { w: number; h: number; travel: number },
  ): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    // preserveAspectRatio is left at its default, xMidYMid meet — scale to fit
    // and centre. This is that rule, restated.
    const scale = Math.min(rect.width / view.w, rect.height / view.h);
    const reach = view.travel * scale || 1;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Y negated: the pad's +y is up the screen, which is −y in client space,
    // and on this machine up the screen is Y+ on the table.
    return { x: (e.clientX - cx) / reach, y: -(e.clientY - cy) / reach };
  }

  private stickHandlers() {
    const grab = (e: PointerEvent) => {
      if (!canVelocityJog().ok) return;
      e.preventDefault();
      // Capture, so a thumb that slides off the pad keeps driving rather than
      // dropping the machine into a stop halfway through a cut-in. Losing the
      // capture fires pointercancel, which stops — see core/velocity.ts.
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        // Older Safari refuses capture on SVG. The pad still works; a thumb
        // that leaves it hits pointerleave and stops, which is the safe way to
        // be wrong.
      }
      this.stick = this.deflection(e, e.currentTarget as Element, STICK_VIEW);
      this.emit();
      this.requestUpdate();
    };

    const drag = (e: PointerEvent) => {
      // Only while a button is down. Without this the pad would drive the
      // machine from a mouse merely passing over it.
      if (!e.buttons) return;
      e.preventDefault();
      this.stick = this.deflection(e, e.currentTarget as Element, STICK_VIEW);
      this.emit();
      this.requestUpdate();
    };

    const drop = () => this.release();
    return { grab, drag, drop };
  }

  private stripHandlers(letter: string) {
    const set = (e: PointerEvent) => {
      const { y } = this.deflection(e, e.currentTarget as Element, STRIP_VIEW);
      this.strips = { ...this.strips, [letter]: Math.max(-1, Math.min(1, y)) };
      this.emit();
      this.requestUpdate();
    };
    return {
      grab: (e: PointerEvent) => {
        if (!canVelocityJog().ok) return;
        e.preventDefault();
        try {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        } catch {
          // See stickHandlers.
        }
        set(e);
      },
      drag: (e: PointerEvent) => {
        if (!e.buttons) return;
        e.preventDefault();
        set(e);
      },
      drop: () => this.release(),
    };
  }

  // --- Keyboard ------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    const k = KEY_AXES[e.key];
    if (!k) return;
    e.preventDefault();
    // Auto-repeat is the operating system re-sending a key that never came up.
    // Acting on it would rebuild and resend the vector at the repeat rate on top
    // of the ticker already sending it.
    if (e.repeat) return;
    if (!canVelocityJog().ok) return;
    this.keys.add(e.key);
    this.emit();
    this.requestUpdate();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (!KEY_AXES[e.key]) return;
    e.preventDefault();
    this.keys.delete(e.key);
    // Not `release()`: letting go of X while still holding Y has to leave Y
    // running. `emit` with an empty vector is the stop.
    this.emit();
    this.requestUpdate();
  }

  // --- What the machine can actually do ------------------------------------

  private get axisLetters(): string[] {
    return machine.get().axes.map((a) => a.letter);
  }

  /** Axes that are not the XY pad — Z, and this machine's U dust shoe. */
  private get stripAxes(): string[] {
    return this.axisLetters.filter((l) => l !== 'X' && l !== 'Y');
  }

  /**
   * Whether this axis is sitting against a soft limit, and which end.
   *
   * Null while unhomed, because an unhomed axis has no machine position worth
   * comparing and the firmware is not enforcing limits on it either.
   */
  private atLimit(letter: string): 'min' | 'max' | null {
    const axis = machine.get().axes.find((a) => a.letter === letter);
    if (!axis || !axis.homed) return null;
    if (!isFinite(axis.min) || !isFinite(axis.max) || axis.max <= axis.min) return null;
    if (axis.machine <= axis.min + AT_LIMIT_MM) return 'min';
    if (axis.machine >= axis.max - AT_LIMIT_MM) return 'max';
    return null;
  }

  private patch(next: Partial<VelocitySettings>): void {
    this.settings = { ...this.settings, ...next };
    applyVelocitySettings(this.settings);
    // Re-emitted rather than left until the next input, so a speed change made
    // mid-jog takes effect under the thumb instead of on the next press.
    if (jogRunning.peek()) this.emit();
    this.requestUpdate();
  }

  // --- Pad -----------------------------------------------------------------

  private renderStick(): SVGTemplateResult {
    const { grab, drag, drop } = this.stickHandlers();
    const enabled = canVelocityJog().ok;
    const dz = this.settings.deadzone * PAD_R;

    // The knob sits at the raw deflection, not the shaped speed: it is showing
    // where the thumb is, and a knob that lagged behind the finger because of
    // the response curve would read as the control being broken.
    const r = Math.hypot(this.stick.x, this.stick.y);
    const scale = r > 1 ? 1 / r : 1;
    const kx = this.stick.x * scale * PAD_R;
    const ky = -this.stick.y * scale * PAD_R;
    const live = jogRunning.get() && r > this.settings.deadzone;

    return svg`
      <svg
        class=${`vjog-stick${enabled ? '' : ' disabled'}${live ? ' live' : ''}`}
        viewBox="-112 -112 224 224"
        role="group"
        aria-label="XY velocity jog"
        @pointerdown=${grab}
        @pointermove=${drag}
        @pointerup=${drop}
        @pointercancel=${drop}
        @pointerleave=${drop}
      >
        <circle class="vjog-face" r=${PAD_R} />
        <circle class="vjog-dead" r=${dz} />
        <line class="vjog-axis" x1=${-PAD_R} y1="0" x2=${PAD_R} y2="0" />
        <line class="vjog-axis" x1="0" y1=${-PAD_R} x2="0" y2=${PAD_R} />
        <text class="vjog-rose-label" x="0" y=${-PAD_R - 2}>Y+</text>
        <text class="vjog-rose-label" x="0" y=${PAD_R + 10}>Y−</text>
        <text class="vjog-rose-label" x=${PAD_R + 2} y="4" text-anchor="start">X+</text>
        <text class="vjog-rose-label" x=${-PAD_R - 2} y="4" text-anchor="end">X−</text>
        ${live ? svg`<line class="vjog-vector" x1="0" y1="0" x2=${kx} y2=${ky} />` : nothing}
        <circle class="vjog-knob" cx=${kx} cy=${ky} r="13" />
      </svg>
    `;
  }

  private renderStrip(letter: string): TemplateResult {
    const { grab, drag, drop } = this.stripHandlers(letter);
    const enabled = canVelocityJog().ok;
    const t = this.strips[letter] ?? 0;
    const knob = -t * STRIP_H;
    const live = jogRunning.get() && Math.abs(t) > this.settings.deadzone;
    const limit = this.atLimit(letter);

    return html`
      <div class="vjog-striph">
        <div class="vjog-strip-name">${letter}</div>
        <svg
          class=${`vjog-strip${enabled ? '' : ' disabled'}${live ? ' live' : ''}`}
          viewBox="-24 -112 48 224"
          role="group"
          aria-label=${`${letter} velocity jog`}
          @pointerdown=${grab}
          @pointermove=${drag}
          @pointerup=${drop}
          @pointercancel=${drop}
          @pointerleave=${drop}
        >
          <rect class="vjog-face" x="-18" y=${-STRIP_H} width="36" height=${STRIP_H * 2} rx="18" />
          <rect
            class="vjog-dead"
            x="-18"
            y=${-this.settings.deadzone * STRIP_H}
            width="36"
            height=${this.settings.deadzone * STRIP_H * 2}
          />
          <line class="vjog-axis" x1="-18" y1="0" x2="18" y2="0" />
          ${live ? svg`<line class="vjog-vector" x1="0" y1="0" x2="0" y2=${knob} />` : nothing}
          <circle class="vjog-knob" cx="0" cy=${knob} r="13" />
        </svg>
        <button
          class="vjog-home"
          ?disabled=${!connected.get()}
          title=${`Home ${letter}`}
          @click=${() => void actions.home([letter])}
        >
          ⌂
        </button>
        <!-- Always rendered, empty when there is no limit to report. An axis
             reaching its stop is a thing that happens mid-jog, and a badge
             appearing then would grow the column and shove the pad sideways
             under the thumb that caused it. -->
        <span class="vjog-limit">${limit ?? ''}</span>
      </div>
    `;
  }

  // --- Readout -------------------------------------------------------------

  /**
   * The commanded velocity, per axis, with the two things that make it a lie
   * marked: an axis held at its ceiling, and an axis parked on a soft limit.
   */
  private renderReadout(): TemplateResult {
    const vector = jogVector.get();
    const letters = this.axisLetters;
    if (!letters.length) return html``;

    return html`
      <div class="vjog-readout">
        ${letters.map((letter) => {
          const v = vector[letter] ?? 0;
          const cap = axisSpeedCeiling(letter, this.settings.chunkMs);
          const capped = v !== 0 && isFinite(cap) && Math.abs(v) >= cap - 1e-6;
          const limit = this.atLimit(letter);
          // "Against its limit" only matters in the direction that is blocked:
          // an axis at Z max is free to go down and saying otherwise would be
          // wrong exactly when the operator is trying to get off the limit.
          const blocked = limit !== null && v !== 0 && (limit === 'max' ? v > 0 : v < 0);
          const cls = `vjog-val${blocked ? ' blocked' : capped ? ' capped' : v ? ' moving' : ''}`;
          return html`
            <span class=${cls}
              title=${blocked
                ? `${letter} is at its ${limit} limit — this direction will not move`
                : capped
                  ? `${letter} is held at its ceiling of ${cap.toFixed(1)} mm/s`
                  : ''}>
              <em>${letter}</em><b>${speedText(v)}</b>
            </span>
          `;
        })}
        <span class="vjog-units">mm/s</span>
      </div>
    `;
  }

  // --- Cursors -------------------------------------------------------------

  private renderCursors(): TemplateResult {
    const chunk = this.settings.chunkMs;
    const ceiling = speedCeiling(['X', 'Y'], chunk);
    // 100 mm/s when the controller has said nothing about limits — a number to
    // put on a slider, not a claim about the machine, which is why the foot
    // below says which of the two it is.
    const top = Math.max(1, Math.floor(isFinite(ceiling) ? ceiling : 100));
    // What a full push will ACTUALLY do, which is not always what was chosen.
    // A preference of 25 saved when the lookahead was longer survives into a
    // session where the ceiling is 10 — and showing the 25 there puts a number
    // on screen that nothing on the machine will ever produce. The preference is
    // kept rather than overwritten, because raising the lookahead should give it
    // back; it is just not what gets displayed as the speed.
    const effective = Math.min(this.settings.maxSpeed, top);
    const held = this.settings.maxSpeed > top + 1e-6;

    return html`
      <div class="jog-cursors">
        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Speed</span>
            <strong>${effective.toFixed(1)} mm/s</strong>
            <em class="jog-cursor-note">at full push</em>
          </span>
          <input
            type="range"
            min="0.5"
            max=${top}
            step="0.5"
            .value=${String(effective)}
            @input=${(e: Event) =>
              this.patch({ maxSpeed: Number((e.target as HTMLInputElement).value) })}
          />
          <span class="jog-cursor-foot">
            <em class=${held ? 'bad' : ''}>
              ${isFinite(ceiling) ? `XY ceiling ${ceiling.toFixed(1)} mm/s` : 'no limits reported'}
            </em>
            <em>${(effective * 60).toFixed(0)} mm/min</em>
            ${held
              ? html`<em class="bad" title="Raise Lookahead, or the axis M201, to get it back."
                    >held down from ${this.settings.maxSpeed.toFixed(1)}</em
                  >`
              : nothing}
          </span>
        </label>

        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Deadzone</span>
            <strong>${Math.round(this.settings.deadzone * 100)}%</strong>
          </span>
          <input
            type="range"
            min="0"
            max="0.4"
            step="0.01"
            .value=${String(this.settings.deadzone)}
            @input=${(e: Event) =>
              this.patch({ deadzone: Number((e.target as HTMLInputElement).value) })}
          />
          <span class="jog-cursor-foot"><em>slack around the centre, so it cannot creep</em></span>
        </label>

        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Response</span>
            <strong>${this.settings.expo === 1 ? 'linear' : `${this.settings.expo.toFixed(1)}×`}</strong>
          </span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.1"
            .value=${String(this.settings.expo)}
            @input=${(e: Event) => this.patch({ expo: Number((e.target as HTMLInputElement).value) })}
          />
          <span class="jog-cursor-foot"><em>higher gives more of the pad to slow speeds</em></span>
        </label>

        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Lookahead</span>
            <strong>${chunk} ms</strong>
          </span>
          <input
            type="range"
            min=${CHUNK_RANGE.min}
            max=${CHUNK_RANGE.max}
            step="5"
            .value=${String(chunk)}
            @input=${(e: Event) =>
              this.patch({ chunkMs: Number((e.target as HTMLInputElement).value) })}
          />
          <span class="jog-cursor-foot">
            <em
              >${chunk === DEFAULT_CHUNK_MS
                ? 'default — lowest latency'
                : `raises the ceiling, adds ~${chunk * 2 - 10}ms of lag`}</em
            >
          </span>
        </label>
      </div>
    `;
  }

  // --- Foot ----------------------------------------------------------------

  private renderFoot(): TemplateResult {
    const h = jogHealth.get();
    const status = jogStatus.get();
    const running = jogRunning.get();
    // Only worth mentioning once there is enough of a sample for the ratio to
    // mean something — one skip in the first three ticks is a slow first
    // request, not a machine falling behind.
    const behind = h.sent > 20 && h.skipped > h.sent * 0.3;

    // The live text is on a row of its own, below the controls rather than
    // among them. In the row it changed length as the jog ran — "firmware:
    // chunk 20ms, watchdog 250ms, queue 2" is far wider than "412 sent · buffer
    // 1024" — which moved the flex row's wrap points and threw the Rate buttons
    // onto a different line mid-jog. Nothing an operator is holding may move
    // because of what it is reporting.
    return html`
      <div class="vjog-foot">
        <button
          class="vjog-stop"
          ?disabled=${!running}
          title="Send M700 S0 — decelerates normally. For a real emergency use the estop."
          @click=${() => this.release('stopped by hand')}
        >
          Stop
        </button>
        <button
          class="vjog-estop"
          ?disabled=${!connected.get()}
          title="M112 — cuts everything now. This is the emergency stop; Stop is not."
          @click=${() => {
            this.release('emergency stop');
            void actions.estop();
          }}
        >
          E-stop
        </button>
        <span class="label">Rate</span>
        <div class="segmented" title=${RATE_HELP}>
          ${RATES.map(
            (hz) => html`
              <button
                class=${hz === this.settings.rateHz ? 'seg active' : 'seg'}
                @click=${() => this.patch({ rateHz: hz })}
              >
                ${hz}
              </button>
            `,
          )}
        </div>
        <button
          class="vjog-recheck"
          ?disabled=${!connected.get() || running}
          title="Ask the firmware what it thinks the jog state is"
          @click=${() => void probeSupport(true)}
        >
          Re-check
        </button>
      </div>
      <div class=${behind ? 'vjog-health warn' : 'vjog-health'}>
        ${behind
          ? 'Falling behind — try a lower rate'
          : running
            ? html`${h.sent} sent${h.skipped ? html` · ${h.skipped} skipped` : nothing}${h.buff !==
              null
                ? html` · buffer ${h.buff}`
                : nothing}`
            : status
              ? `firmware: chunk ${status.chunkMs}ms, watchdog ${status.watchdogMs}ms, queue ${status.queueDepth}`
              : ''}
      </div>
    `;
  }

  /** The one-line answer to "why is nothing happening". */
  private renderBanner(): TemplateResult | typeof nothing {
    const support = jogSupport.get();
    const refusal = jogRefusal.get();

    if (support === 'no') {
      return html`
        <div class="vjog-banner bad">
          This firmware has no <code>M700</code>. Velocity jogging is a fork —
          <code>meeloo/RepRapFirmware</code>, branch <code>feature/velocity-jog</code>. The Motion
          panel jogs by distance and works on any build.
        </div>
      `;
    }
    if (support === 'checking' || support === 'unknown') {
      return html`<div class="vjog-banner">Asking the controller whether it can do this…</div>`;
    }
    if (refusal) return html`<div class="vjog-banner warn">${refusal}</div>`;
    return nothing;
  }

  // --- Render --------------------------------------------------------------

  protected override render(): TemplateResult {
    if (!connected.get()) return empty('Not connected');
    if (!capabilities.get().velocityJog) {
      return empty('This controller does not do velocity jogging — use the Motion panel');
    }
    const state = machine.get();
    if (!state.axes.length) return empty('Waiting for axes…');

    const gate = canVelocityJog();
    const letters = new Set(this.axisLetters);

    return html`
      <div
        class="vjog"
        tabindex="0"
        @keydown=${(e: KeyboardEvent) => this.onKeyDown(e)}
        @keyup=${(e: KeyboardEvent) => this.onKeyUp(e)}
        @blur=${() => this.keys.size && this.release()}
      >
        ${this.renderBanner()}
        ${this.renderReadout()}

        <div class="vjog-pads">
          ${letters.has('X') && letters.has('Y') ? this.renderStick() : nothing}
          ${this.stripAxes.map((l) => this.renderStrip(l))}
        </div>

        ${this.renderCursors()} ${this.renderFoot()}
        ${!gate.ok && jogSupport.get() === 'yes'
          ? html`<div class="vjog-blocked">${gate.why}</div>`
          : nothing}
        <div class="vjog-hint">
          Hold to move — releasing stops. Arrow keys drive XY and PageUp/PageDown drive Z while this
          panel has focus. Sending at ${this.settings.rateHz}Hz; the machine stops itself if that
          stream is interrupted.
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-velocity-jog', VelocityJogPanel);

registerPanel({
  id: 'velocity',
  title: 'Jog',
  tag: 'cnc-velocity-jog',
  defaultWidth: 4,
  defaultHeight: 520,
  available: (caps) => caps.velocityJog,
  description: 'Continuous jogging: push the pad, the machine moves at that speed (M700)',
});
