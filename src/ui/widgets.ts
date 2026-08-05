// Shared render helpers. Not components — plain functions returning templates,
// which keeps them cheap and avoids a custom element per button.

import { html, nothing, type TemplateResult } from 'lit';
import type { MachineStatus } from '../machine/types.js';
import { captureButton, type Capture } from './capture.js';

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
  value: number,
  onChange: (v: number) => void,
  opts: {
    step?: number;
    min?: number;
    max?: number;
    suffix?: string;
    title?: string;
    capture?: Capture;
  } = {},
): TemplateResult {
  return paramRow(
    label,
    html`
      <input
        type="number"
        .value=${String(value)}
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
    { capture: opts.capture ? captureButton(opts.capture, onChange) : nothing, title: opts.title },
  );
}

/** Free-text parameter input — pin names, labels. Fires on change, not per key. */
export function textField(
  label: string,
  value: string,
  onChange: (v: string) => void,
  opts: { placeholder?: string; title?: string } = {},
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
    { title: opts.title },
  );
}

export function selectField<T extends string>(
  label: string,
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (v: T) => void,
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
