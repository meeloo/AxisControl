// Updating the controller's firmware.
//
// The most destructive thing this app can be asked to do, so it is arranged to
// be hard to do by accident and easy to understand while it happens:
//
//   - Nothing is automatic. No background check, no "an update is available"
//     nudge. Firmware is changed when someone decides to change it.
//   - Only when idle. Never mid-job, mid-pause or mid-tool-change.
//   - The release has to contain the exact image the board named. A release
//     that does not is refused rather than substituted for.
//   - Downloading and uploading are separate from flashing. The files can be
//     put on the card and the M997 left for later.
//
// The procedure itself is Duet Web Control's — see machine/firmware.ts.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, appendLog, connected, machine } from '../core/store.js';
import type { GhRelease } from '../core/github.js';
import {
  FIRMWARE_REPO,
  isDowngrade,
  isNewerFirmware,
  listFirmware,
  planUpdate,
  type FirmwarePlan,
} from '../machine/firmware.js';

/** Statuses in which the SD card must not be written and M997 must not run. */
const BUSY = new Set(['running', 'paused', 'pausing', 'resuming', 'homing', 'tool-change']);

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}

export class FirmwarePanel extends PanelElement {
  private releases: GhRelease[] | null = null;
  private betas = false;
  private checking = false;
  private busy: string | null = null;
  private progress: { what: string; loaded: number; total: number | null } | null = null;
  private error: string | null = null;
  private note: string | null = null;
  /** Downloaded and uploaded, waiting for the operator to say go. */
  private staged: { release: GhRelease; plan: FirmwarePlan } | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      machine.get();
    });
  }

  private get boards() {
    return machine.get().firmware;
  }

  private get main() {
    return this.boards.find((b) => b.canAddress === 0) ?? this.boards[0] ?? null;
  }

  private get machineBusy(): boolean {
    return BUSY.has(machine.peek().status);
  }

  private get offered(): GhRelease[] {
    if (!this.releases) return [];
    return this.releases.filter((r) => this.betas || !r.prerelease);
  }

  // --- Doing things --------------------------------------------------------

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.error = null;
    this.requestUpdate();
    try {
      this.releases = await listFirmware();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.checking = false;
      this.requestUpdate();
    }
  }

  private async run(label: string, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = label;
    this.error = null;
    this.note = null;
    this.progress = null;
    this.requestUpdate();
    try {
      await work();
    } catch (err) {
      this.error = (err as Error).message;
      appendLog({ level: 'error', text: `Firmware: ${this.error}`, time: new Date() });
    } finally {
      this.busy = null;
      this.progress = null;
      this.requestUpdate();
    }
  }

  /** Download the release's files for this board and put them on the card. */
  private stage(release: GhRelease): void {
    void this.run(`Preparing ${release.tag}`, async () => {
      const driver = activeDriver();
      if (!driver) throw new Error('Not connected');
      if (this.machineBusy) {
        throw new Error(`The machine is ${machine.peek().status}. Firmware files are not written to the card mid-job.`);
      }

      const plan = await planUpdate(release, this.boards, (what, loaded, total) => {
        this.progress = { what, loaded, total };
        this.requestUpdate();
      });

      let done = 0;
      for (const [path, bytes] of plan.files) {
        this.progress = { what: `writing ${path}`, loaded: done, total: plan.files.size };
        this.requestUpdate();
        await driver.writeFile(path, bytes);
        done++;
      }

      this.staged = { release, plan };
      this.note = `${plan.found.join(', ')} written to ${this.main?.directory}. Nothing has been flashed yet.`;
      appendLog({ level: 'info', text: `Firmware ${release.tag} staged: ${plan.found.join(', ')}`, time: new Date() });
    });
  }

  /** Actually flash. The board reboots; the connection drops. */
  private flash(): void {
    const staged = this.staged;
    if (!staged) return;
    const board = this.main;
    if (
      !confirm(
        `Flash ${staged.release.tag} onto ${board?.boardName ?? 'the controller'}?\n\n` +
          `${staged.plan.commands.join(', then ')}\n\n` +
          'The board rewrites its own flash and reboots. This page will lose its connection for a minute or so. ' +
          'Do not cut the power while it is doing this.',
      )
    ) {
      return;
    }

    void this.run(`Flashing ${staged.release.tag}`, async () => {
      const driver = activeDriver();
      if (!driver) throw new Error('Not connected');
      if (this.machineBusy) throw new Error(`The machine is ${machine.peek().status}.`);

      for (const command of staged.plan.commands) {
        this.progress = { what: command, loaded: 0, total: null };
        this.requestUpdate();
        try {
          await driver.send(command);
        } catch (err) {
          // The main board's update reboots it mid-reply, so the request that
          // started it does not get answered. That is the update working, not
          // failing, and reporting it as an error is how a successful flash
          // looks like a broken one.
          const message = (err as Error).message;
          if (!/M997 S0/.test(command)) throw err;
          appendLog({ level: 'info', text: `M997 S0 sent; connection dropped (${message})`, time: new Date() });
        }
        // Expansion boards are updated one at a time and the next must not be
        // told to start while the last is still writing.
        if (/B\d/.test(command)) await new Promise((r) => window.setTimeout(r, 4000));
      }

      this.staged = null;
      this.note =
        'The board is rewriting its flash and will reboot. Reconnect in a minute — if the page does not come back on its own, reload it.';
      appendLog({ level: 'info', text: 'Firmware update started', time: new Date() });
    });
  }

  // --- Render --------------------------------------------------------------

  private renderBoards(): TemplateResult {
    const main = this.main;
    if (!main) {
      return html`<div class="warn-banner">
        The controller has not said what board it is, so there is nothing safe to offer. Connect
        first.
      </div>`;
    }
    return html`
      <div class="inst-grid">
        <div class="inst-cell">
          <span class="inst-label">Board</span>
          <strong>${main.boardName}</strong>
          <span class="hint">${main.board}${main.sbc ? ' · via SBC' : ''}</span>
        </div>
        <div class="inst-cell">
          <span class="inst-label">Running</span>
          <strong>${main.version || '—'}</strong>
          <span class="hint">${this.boards.length > 1 ? `${this.boards.length} boards on the bus` : 'standalone'}</span>
        </div>
        <div class="inst-cell">
          <span class="inst-label">Flashes from</span>
          <strong class="fw-file">${main.firmwareFile ?? '—'}</strong>
          <span class="hint">${main.iapFile ? `via ${main.iapFile}` : 'no programmer named'}</span>
        </div>
      </div>
    `;
  }

  private renderReleases(): TemplateResult {
    const main = this.main;
    const list = this.offered;
    if (!list.length) {
      return html`<div class="pack-note">
        ${this.checking ? 'Asking GitHub…' : `Nothing listed yet — check ${FIRMWARE_REPO}.`}
      </div>`;
    }
    return html`
      <div class="fw-list">
        ${list.slice(0, 8).map((r) => {
          const newer = main && isNewerFirmware(r, main);
          const older = main && isDowngrade(r, main);
          return html`
            <div class="fw-row ${newer ? 'newer' : ''}">
              <strong>${r.tag}</strong>
              <span class="hint">
                ${r.prerelease ? 'prerelease · ' : ''}${r.publishedAt.slice(0, 10)}
                ${older ? ' · older than what is running' : ''}
                ${main && r.tag.replace(/^v/, '') === main.version ? ' · installed' : ''}
              </span>
              <a class="hint" href=${r.htmlUrl} target="_blank" rel="noreferrer">notes</a>
              <button
                class="tiny"
                ?disabled=${!connected.get() || !!this.busy || this.machineBusy}
                title=${older
                  ? 'Older than what is running. Downgrades can be incompatible with an existing config.'
                  : 'Download this release and write it to the card. Nothing is flashed yet.'}
                @click=${() => this.stage(r)}
              >
                Prepare
              </button>
            </div>
          `;
        })}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const main = this.main;
    const staged = this.staged;

    return html`
      <div class="pack fw">
        <div class="pack-blurb">
          Firmware from ${FIRMWARE_REPO}. The board states which image it flashes from and where it
          belongs, and only a release containing that exact file is offered — one release carries
          images for a dozen boards.
        </div>

        ${this.renderBoards()}

        ${this.machineBusy
          ? html`<div class="warn-banner">
              The machine is ${machine.get().status}. Nothing is written or flashed until it is idle.
            </div>`
          : nothing}

        ${main?.sbc
          ? html`<div class="warn-banner">
              This machine runs from a Single Board Computer. Firmware there is updated through the
              Pi rather than by writing to the SD card, so this panel will not do it.
            </div>`
          : nothing}

        ${this.busy
          ? html`<div class="inst-progress">
              <span>${this.progress?.what ?? this.busy}…</span>
              <progress
                max=${this.progress?.total ?? 0}
                .value=${this.progress?.loaded ?? 0}
              ></progress>
              <em>
                ${this.progress?.total
                  ? `${size(this.progress.loaded)} / ${size(this.progress.total)}`
                  : ''}
              </em>
            </div>`
          : nothing}

        ${this.error ? html`<div class="warn-banner bad">${this.error}</div>` : nothing}
        ${this.note ? html`<div class="pack-note good">${this.note}</div>` : nothing}

        ${staged
          ? html`<div class="warn-banner fw-armed">
              <strong>${staged.release.tag} is on the card, not yet flashed.</strong>
              <div>
                ${staged.plan.commands.join(', then ')} — the board rewrites its own flash and
                reboots, and this page loses its connection while it does. Do not cut the power.
              </div>
              <div class="fw-armed-actions">
                <button
                  class="primary"
                  ?disabled=${!connected.get() || !!this.busy || this.machineBusy}
                  @click=${() => this.flash()}
                >
                  Flash it
                </button>
                <button class="tiny" @click=${() => ((this.staged = null), this.requestUpdate())}>
                  Leave it for later
                </button>
              </div>
            </div>`
          : nothing}

        ${this.renderReleases()}

        <div class="pack-actions">
          <button ?disabled=${this.checking} @click=${() => void this.check()}>
            ${this.releases ? 'Refresh list' : 'List releases'}
          </button>
          <label class="check">
            <input
              type="checkbox"
              .checked=${this.betas}
              @change=${(e: Event) => {
                this.betas = (e.target as HTMLInputElement).checked;
                this.requestUpdate();
              }}
            />
            Include betas
          </label>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-firmware', FirmwarePanel);

registerPanel({
  id: 'firmware',
  title: 'Firmware',
  tag: 'cnc-firmware',
  defaultWidth: 6,
  defaultHeight: 480,
  available: (caps) => caps.fileWrite,
  description: 'Update the controller firmware from Duet3D releases',
});
