// Blocking-prompt dialog (RepRapFirmware M291, and equivalents on other drivers).
//
// This is not optional polish. Macros that prompt will sit and wait forever if
// nothing answers them, and the machine will simply look hung — which on this
// config means the ATC and probing macros. Any front end that skips this is
// unusable for real work.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from './panel.js';
import { actions, machine } from '../core/store.js';
import type { MachinePrompt } from '../machine/types.js';

/** The modes that are answered with a value rather than with a button. */
function needsValue(mode: MachinePrompt['mode']): boolean {
  return mode === 'input-int' || mode === 'input-float' || mode === 'input-string';
}

export class MessageBox extends PanelElement {
  private value = '';
  /** Prompt seq we last prefilled for, so typing isn't clobbered by polling. */
  private valueForSeq = -1;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => machine.get().prompt);
  }

  private answer(prompt: MachinePrompt, accept: boolean): void {
    if (!accept || !needsValue(prompt.mode)) {
      void actions.answerPrompt(prompt.seq, accept);
      return;
    }

    const raw = this.value;
    const value =
      prompt.mode === 'input-string'
        ? raw
        : prompt.mode === 'input-int'
          ? parseInt(raw, 10)
          : parseFloat(raw);

    if (typeof value === 'number' && !isFinite(value)) return; // reject empty/garbage
    // A number the firmware will refuse is worth refusing here, where the
    // operator can see why, rather than in a macro that aborts.
    if (typeof value === 'number' && prompt.min != null && value < prompt.min) return;
    if (typeof value === 'number' && prompt.max != null && value > prompt.max) return;
    void actions.answerPrompt(prompt.seq, true, value);
  }

  /** Mode 4 is answered by the index of the option, not by its text. */
  private choose(prompt: MachinePrompt, index: number): void {
    void actions.answerPrompt(prompt.seq, true, index);
  }

  protected override render(): TemplateResult | typeof nothing {
    const prompt = machine.get().prompt;
    if (!prompt) return nothing;

    if (this.valueForSeq !== prompt.seq) {
      this.valueForSeq = prompt.seq;
      this.value = prompt.defaultValue != null ? String(prompt.defaultValue) : '';
    }

    const wantsValue = needsValue(prompt.mode);
    const choices = prompt.mode === 'choice' ? (prompt.choices ?? []) : [];
    // The controller's own answer where it gave one, and the mode's default
    // where it did not. An input box the operator cannot escape is how a macro
    // strands the machine.
    const cancellable =
      prompt.cancelButton ??
      (prompt.mode === 'ok-cancel' || prompt.mode === 'close' || wantsValue || prompt.mode === 'choice');

    return html`
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <h2>${prompt.title || 'Message'}</h2>
          <p class="modal-message">${prompt.message}</p>

          ${prompt.axisControls.length
            ? html`
                <div class="modal-jog">
                  ${prompt.axisControls.map(
                    (axis) => html`
                      <div class="modal-jog-axis">
                        <span>${axis}</span>
                        ${[-1, -0.1, 0.1, 1].map(
                          (d) => html`
                            <button @click=${() => void actions.jog({ [axis]: d }, 600)}>
                              ${d > 0 ? `+${d}` : d}
                            </button>
                          `,
                        )}
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}

          ${choices.length
            ? html`
                <div class="modal-choices">
                  ${choices.map(
                    (choice, i) => html`
                      <button class="choice" @click=${() => this.choose(prompt, i)}>${choice}</button>
                    `,
                  )}
                </div>
              `
            : nothing}

          ${wantsValue
            ? html`
                <input
                  class="modal-input"
                  type=${prompt.mode === 'input-string' ? 'text' : 'number'}
                  step=${prompt.mode === 'input-float' ? 'any' : '1'}
                  min=${prompt.min ?? nothing}
                  max=${prompt.max ?? nothing}
                  .value=${this.value}
                  autofocus
                  @input=${(e: Event) => (this.value = (e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') this.answer(prompt, true);
                  }}
                />
              `
            : nothing}

          <div class="modal-buttons">
            ${cancellable
              ? html`<button class="ghost" @click=${() => this.answer(prompt, false)}>
                  Cancel
                </button>`
              : nothing}
            ${prompt.mode === 'none'
              ? html`<span class="hint">Waiting for the machine…</span>`
              : prompt.mode === 'choice'
                ? // The options are the buttons; an OK beside them would send
                  // no answer at all.
                  nothing
                : html`<button class="primary" @click=${() => this.answer(prompt, true)}>OK</button>`}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-messagebox', MessageBox);
