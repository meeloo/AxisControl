// The permission dialog: the one place a plugin's code is described to the
// person who will be standing next to the machine while it runs.
//
// It is deliberately a plain modal over the whole app rather than something
// inside the Plugins panel. A plugin starts at startup, when the operator may
// be looking at the job page, and a permission question they can miss is a
// question that gets answered by whoever clicks fastest.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from './panel.js';
import { describePermission } from '../plugins/manifest.js';
import { pendingGrant } from '../plugins/permissions.js';
import type { PermissionName } from '../plugins/types.js';

/**
 * How much of the machine a permission puts in somebody else's hands, most
 * first.
 *
 * The manifest's own order is alphabetical, which would put "read the live
 * state" above "run any G-code you could type". Whoever stops reading after
 * two lines should have read the two lines that can move a spindle.
 */
function severity(permission: PermissionName): number {
  switch (permission) {
    case 'machine.command':
      return 0;
    case 'machine.motion':
      return 1;
    case 'files.write':
      return 2;
    case 'files.read':
      return 3;
    case 'background':
      return 6;
    case 'machine.read':
      return 7;
    case 'ui.notify':
      return 8;
    default:
      // storage.<domain> and network.<origin>: somebody else's data, and the
      // network. Both above the read-only ones, below anything that moves.
      return permission.startsWith('network.') ? 4 : 5;
  }
}

export class PluginGrantDialog extends PanelElement {
  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => pendingGrant.get());
  }

  protected override render(): TemplateResult | typeof nothing {
    const ask = pendingGrant.get();
    if (!ask) return nothing;

    const { manifest } = ask.record;
    // Full access is not another line in the list — it is the absence of the
    // list — so it is taken out and said once, in its own words, above
    // everything the sandbox would otherwise have held back.
    const unsafe = ask.asking.includes('unsafe.fullAccess');
    const listed = ask.asking
      .filter((p) => p !== 'unsafe.fullAccess')
      .sort((a, b) => severity(a) - severity(b));

    return html`
      <div class="modal-backdrop">
        <div class="modal ${unsafe ? 'grant-unsafe-modal' : ''}" role="dialog" aria-modal="true">
          <h2>${manifest.name} is asking for permission</h2>
          <p class="grant-id selectable">
            ${manifest.id} · version ${manifest.version}${manifest.author ? ` · ${manifest.author}` : ''}
          </p>

          ${unsafe
            ? html`
                <div class="grant-unsafe">
                  <strong>This plugin runs outside the sandbox.</strong>
                  <p>
                    Every other plugin runs walled off from this app, and can only do what it
                    has been granted. This one does not: it loads as part of Axis Control
                    itself, with nothing between it and the machine. It will be able to do
                    anything you can do here — move the machine, run any G-code, read and
                    change the controller's configuration, and reach the network — and it will
                    never ask again for any of it. Grant this only to code you trust as much as
                    the app.
                  </p>
                </div>
              `
            : nothing}

          ${listed.length
            ? html`
                <ul class="grant-perms">
                  ${listed.map((p) => html`<li>${describePermission(p)}</li>`)}
                </ul>
              `
            : unsafe
              ? nothing
              : html`
                  <p class="grant-none">
                    It asks for no permissions at all: it can draw its own panel, and nothing
                    else.
                  </p>
                `}

          <p class="grant-refusal">
            Refuse and ${manifest.name} stays installed and disabled — nothing of it runs. You
            will not be asked again until its code changes.
          </p>

          <div class="modal-buttons">
            <button class="ghost" @click=${() => ask.answer(false)}>Refuse</button>
            <button class=${unsafe ? 'danger' : 'primary'} @click=${() => ask.answer(true)}>
              ${unsafe ? 'Grant full access' : 'Grant'}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-plugin-grant', PluginGrantDialog);
