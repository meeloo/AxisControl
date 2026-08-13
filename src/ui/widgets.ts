// Shared render helpers. Not components — plain functions returning templates,
// which keeps them cheap and avoids a custom element per button.

import { html, nothing, type TemplateResult } from 'lit';
import type { MachineStatus, Volume } from '../machine/types.js';
import { formatBytes } from '../core/util.js';
import { captureButton, pointCaptureButton, type Capture, type Frame } from './capture.js';

export function statusLabel(status: MachineStatus): string {
  switch (status) {
    case 'disconnected':
      return 'Disconnected';
    case 'connecting':
      return 'Connecting';
    case 'idle':
      return 'Idle';
    case 'busy':
      return 'Busy';
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'pausing':
      return 'Pausing';
    case 'resuming':
      return 'Resuming';
    case 'homing':
      return 'Homing';
    case 'tool-change':
      return 'Tool change';
    case 'halted':
      return 'HALTED';
    case 'off':
      return 'Off';
  }
}

/** Colour class for a status pill. */
export function statusClass(status: MachineStatus): string {
  if (status === 'halted') return 'bad';
  if (status === 'disconnected' || status === 'off') return 'dim';
  if (status === 'running' || status === 'tool-change') return 'active';
  if (status === 'paused' || status === 'pausing') return 'warn';
  if (status === 'idle') return 'good';
  return 'busy';
}

export function empty(message: string): TemplateResult {
  return html`<div class="empty">${message}</div>`;
}

export interface ButtonOptions {
  label: string | TemplateResult;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function button(o: ButtonOptions): TemplateResult {
  return html`
    <button
      class=${o.className ?? ''}
      title=${o.title ?? ''}
      ?disabled=${o.disabled ?? false}
      @click=${o.onClick}
    >
      ${o.label}
    </button>
  `;
}

/** Segmented selector — used for jog steps, WCS, spindle presets. */
export function segmented<T>(
  values: readonly T[],
  current: T,
  onSelect: (v: T) => void,
  format: (v: T) => string = String,
): TemplateResult {
  return html`
    <div class="segmented">
      ${values.map(
        (v) => html`
          <button class=${v === current ? 'seg active' : 'seg'} @click=${() => onSelect(v)}>
            ${format(v)}
          </button>
        `,
      )}
    </div>
  `;
}

export function field(label: string, control: TemplateResult): TemplateResult {
  return html`<label class="field"><span>${label}</span>${control}</label>`;
}

/**
 * Numeric parameter input. `onChange` fires on change, not on every keystroke.
 *
 * `capture` adds the crosshair button that fills the field from where the
 * machine is standing. It lives here rather than at the call sites so that
 * every position field in the app gets the same control, in the same place,
 * with the same guards — see ui/capture.ts.
 */
/**
 * One parameter row: label, capture button, control.
 *
 * Every field goes through this so the three columns line up down a panel. The
 * capture button sits BEFORE the control rather than after it, which is the
 * whole trick: after it, its position depended on the width of whatever came
 * before — a suffix of "mm" or "mm/min" or nothing at all — so no two rows
 * agreed and the column read as scattered.
 *
 * The empty span when a field has no capture is not decoration either. Grid
 * places children in order, so a row that skipped it would put its control in
 * the button's column and knock itself out of line with every other row.
 */
function paramRow(
  label: string,
  control: TemplateResult,
  opts: { capture?: TemplateResult | typeof nothing; title?: string; cls?: string } = {},
): TemplateResult {
  return html`
    <label class="param ${opts.cls ?? ''}" title=${opts.title ?? ''}>
      <span class="param-label">${label}</span>
      <span class="param-cap">${opts.capture ?? nothing}</span>
      <span class="param-input">${control}</span>
    </label>
  `;
}

export function numberField(
  label: string,
  /** null renders empty — for fields where blank means "work it out". */
  value: number | null,
  onChange: (v: number) => void,
  opts: {
    step?: number;
    min?: number;
    max?: number;
    suffix?: string;
    title?: string;
    capture?: Capture;
    placeholder?: string;
    cls?: string;
  } = {},
): TemplateResult {
  return paramRow(
    label,
    html`
      <input
        type="number"
        .value=${value === null ? '' : String(value)}
        placeholder=${opts.placeholder ?? ''}
        step=${opts.step ?? 'any'}
        min=${opts.min ?? ''}
        max=${opts.max ?? ''}
        @change=${(e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (isFinite(v)) onChange(v);
        }}
      />
      ${opts.suffix ? html`<em>${opts.suffix}</em>` : nothing}
    `,
    {
      capture: opts.capture ? captureButton(opts.capture, onChange) : nothing,
      title: opts.title,
      cls: opts.cls,
    },
  );
}

/** One axis of a point field: which letter it is, what it holds, where it goes. */
export interface PointAxis {
  letter: string;
  value: number;
  onChange: (v: number) => void;
}

/**
 * A point — one row, one crosshair, one input per axis.
 *
 * Two rows of "Centre X" and "Centre Y" were two rows too many. They read as
 * unrelated numbers, they took twice the height, and each had its own capture
 * button — which invited taking the X now and the Y after the next jog, giving
 * a centre the machine was never at. Here the button takes the whole point at
 * once, which is the only capture that means anything for a position.
 *
 * The label carries the letters ("Centre XY"), and each input repeats its own
 * letter in its tooltip and aria-label, since the boxes are otherwise
 * indistinguishable to anyone not counting from the left.
 */
export function pointField(
  label: string,
  axes: PointAxis[],
  opts: {
    frame?: Frame;
    step?: number;
    suffix?: string;
    title?: string;
    capture?: boolean;
    /**
     * Write the whole point in one go, instead of calling each axis in turn.
     *
     * Needed wherever the setter rebuilds a record from a value captured in the
     * closure — `apply({ ...probe, x: v })` — since the second call would spread
     * the record as it was before the first and quietly undo it.
     */
    onPoint?: (values: number[]) => void;
  } = {},
): TemplateResult {
  const frame = opts.frame ?? 'work';
  const letters = axes.map((a) => a.letter);
  const withCapture = opts.capture !== false;

  return paramRow(
    label,
    html`
      ${axes.map(
        (a) => html`
          <input
            type="number"
            title=${a.letter}
            aria-label=${`${label} ${a.letter}`}
            .value=${String(a.value)}
            step=${opts.step ?? 'any'}
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (isFinite(v)) a.onChange(v);
            }}
          />
        `,
      )}
      ${opts.suffix ? html`<em>${opts.suffix}</em>` : nothing}
    `,
    {
      capture: withCapture
        ? pointCaptureButton(letters, frame, (values) => {
            // Every axis, or none: a half-applied point is the failure this
            // whole widget exists to prevent.
            if (opts.onPoint) opts.onPoint(values);
            else axes.forEach((a, i) => a.onChange(values[i]!));
          })
        : nothing,
      title: opts.title,
      cls: `point point-${axes.length}`,
    },
  );
}

/** Free-text parameter input — pin names, labels. Fires on change, not per key. */
export function textField(
  label: string,
  value: string,
  onChange: (v: string) => void,
  opts: { placeholder?: string; title?: string; cls?: string } = {},
): TemplateResult {
  return paramRow(
    label,
    html`
      <input
        type="text"
        .value=${value}
        placeholder=${opts.placeholder ?? ''}
        @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
      />
    `,
    { title: opts.title, cls: opts.cls },
  );
}

export function selectField<T extends string>(
  label: string,
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (v: T) => void,
  opts: { title?: string; cls?: string } = {},
): TemplateResult {
  return paramRow(
    label,
    html`
      <select @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value as T)}>
        ${options.map(
          (o) => html`<option value=${o.value} ?selected=${o.value === value}>${o.label}</option>`,
        )}
      </select>
    `,
    { title: opts.title, cls: opts.cls },
  );
}

export function checkField(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
): TemplateResult {
  return html`
    <label class="param check-param">
      <input
        type="checkbox"
        .checked=${value}
        @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span>${label}</span>
    </label>
  `;
}

export function warnIf(condition: boolean, message: string): TemplateResult | typeof nothing {
  return condition ? html`<div class="warn-banner">${message}</div>` : nothing;
}

/**
 * A volume's free space, as a bar and a line of text.
 *
 * Shared by the Files and Diagnostics panels because they want the same answer
 * from opposite directions — "can I upload this job" and "what is the state of
 * this machine" — and two renderings of the same number that disagree about
 * rounding is the kind of thing that costs an afternoon.
 *
 * Three cases, and the boring one is the least common:
 *
 *  - An empty slot has no card. It says so, and draws no bar; an empty bar
 *    would read as a full card.
 *  - A mounted card whose free space the firmware has not computed shows its
 *    size with the free figure as "unknown". RRF genuinely does this — the
 *    figure costs a directory walk — and inventing a zero there would look
 *    like a card that is about to fail.
 *  - A card that reports both gets the bar, and the bar fills with what is
 *    USED rather than what is free, because a bar that empties as the card
 *    fills is the wrong way round for every progress bar anyone has seen.
 */
export function volumeBar(volume: Volume): TemplateResult {
  if (!volume.mounted) {
    return html`<div class="vol vol-empty">
      <span class="vol-name">${volume.name}</span>
      <span class="vol-text">no card</span>
    </div>`;
  }

  const { capacity, free } = volume;
  const known = capacity != null && capacity > 0 && free != null;
  // Clamped: a card that reports more free than it has capacity for is a
  // firmware quirk, not a reason to draw a bar off the end of its track.
  const usedFraction = known ? Math.min(1, Math.max(0, 1 - free / capacity)) : 0;

  return html`
    <div class="vol ${known && usedFraction > 0.9 ? 'vol-tight' : ''}">
      <span class="vol-name">${volume.name}</span>
      ${known
        ? html`
            <span class="vol-track"
              ><span class="vol-fill" style=${`width:${(usedFraction * 100).toFixed(1)}%`}></span
            ></span>
            <span class="vol-text">
              ${formatBytes(free)} free of ${formatBytes(capacity)}
            </span>
          `
        : html`<span class="vol-text">
            ${capacity != null ? formatBytes(capacity) : 'size unknown'}, free space not reported
          </span>`}
    </div>
  `;
}
