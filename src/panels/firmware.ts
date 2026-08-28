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
//   - A file of your own is offered too, because a fork has no release to point
//     at — this machine runs one for M700 and M604. Nothing upstream vouches
//     for those bytes, so they are read and described before they are written,
//     and the name check that says which board a file belongs to is enforced
//     with its override in plain sight rather than assumed away.
//
// The procedure itself is Duet Web Control's — see machine/firmware.ts.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, appendLog, connected, machine } from '../core/store.js';
import type { GhRelease } from '../core/github.js';
import {
  FIRMWARE_REPO,
  inspectImage,
  matchesBoardFileStrictly,
  isDowngrade,
  isNewerFirmware,
  listFirmware,
  planLocalUpdate,
  planUpdate,
  type FirmwarePlan,
  type ImageCheck,
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
  /**
   * What is on the card and not yet flashed.
   *
   * `expectVersion` is what the board should report afterwards, which is the
   * release tag when there is one and nothing at all for a file somebody built:
   * a local image announces no version, and claiming to know one would make a
   * successful flash look like a failed one.
   */
  private staged: { label: string; plan: FirmwarePlan; expectVersion: string | null } | null = null;

  /** A file the operator picked, once it has been read and looked at. */
  private local:
    | { name: string; bytes: Uint8Array; check: ImageCheck | null; problem: string | null }
    | null = null;

  /** Ticked to proceed with a file that is not named what the board asked for. */
  private acceptMismatch = false;
  /**
   * The tag an M997 was sent for, until the board comes back reporting it.
   *
   * The message shown while a board is rewriting its flash is written in the
   * future tense, and the board reboots and reconnects without anything on this
   * page being told. Left alone it goes on promising a reboot that already
   * happened — so the running version is what retires it, which is also the
   * only evidence that the update actually took.
   */
  private awaiting: string | null = null;

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
    // Retired here as well as by the board coming back: otherwise "the board
    // came back running X" is true for ever and quietly shadows whatever the
    // next thing to happen has to say.
    this.awaiting = null;
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

      // What is already in the firmware directory. The programmer in
      // particular: Duet3D ship it rarely, so the one from the last update is
      // usually the one that will do the work, and a release without it is not
      // a release that cannot be installed.
      const present = await this.presentFiles();

      const plan = await planUpdate(release, this.boards, {
        present,
        onProgress: (what, loaded, total) => {
          this.progress = { what, loaded, total };
          this.requestUpdate();
        },
      });

      await this.writePlan(plan);

      this.staged = { label: release.tag, plan, expectVersion: release.tag };
      this.note = `${plan.found.join(', ')} written to ${this.main?.directory}. Nothing has been flashed yet.`;
      appendLog({ level: 'info', text: `Firmware ${release.tag} staged: ${plan.found.join(', ')}`, time: new Date() });
    });
  }

  /** Put a plan's files on the card. Shared by both ways of getting one. */
  private async writePlan(plan: FirmwarePlan): Promise<void> {
    const driver = activeDriver();
    if (!driver) throw new Error('Not connected');
    let done = 0;
    for (const [path, bytes] of plan.files) {
      this.progress = { what: `writing ${path}`, loaded: done, total: plan.files.size };
      this.requestUpdate();
      await driver.writeFile(path, bytes);
      done++;
    }
  }

  /** Whatever is already in the firmware directory — the programmer, mostly. */
  private async presentFiles(): Promise<Set<string>> {
    const present = new Set<string>();
    const driver = activeDriver();
    const dir = this.main?.directory;
    if (!driver || !dir) return present;
    try {
      for (const entry of await driver.listFiles(dir)) present.add(entry.name);
    } catch {
      // No such directory yet, most likely. Then nothing is present, which is
      // the safe reading.
    }
    return present;
  }

  /**
   * Read the chosen file and look at it, without writing anything.
   *
   * Deliberately two steps. Reading tells the operator what they actually
   * picked — a UF2 of so many blocks, a zip, a .bin nothing can vouch for —
   * before any of it goes near the card, and a file that fails inspection is
   * reported here rather than after it has been written.
   */
  private onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.acceptMismatch = false;
    if (!file) {
      this.local = null;
      this.requestUpdate();
      return;
    }
    void this.run(`Reading ${file.name}`, async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        this.local = { name: file.name, bytes, check: inspectImage(file.name, bytes), problem: null };
      } catch (err) {
        // Not thrown onward: a file that fails inspection is a thing to report
        // in place, beside the picker, not an error banner about the panel.
        this.local = { name: file.name, bytes, check: null, problem: (err as Error).message };
      }
    });
  }

  /** Plan and stage the operator's own file. */
  private stageLocal(): void {
    const local = this.local;
    if (!local) return;
    void this.run(`Preparing ${local.name}`, async () => {
      if (this.machineBusy) {
        throw new Error(
          `The machine is ${machine.peek().status}. Firmware files are not written to the card mid-job.`,
        );
      }
      const plan = await planLocalUpdate({ name: local.name, bytes: local.bytes }, this.boards, {
        present: await this.presentFiles(),
        acceptMismatchedName: this.acceptMismatch,
      });
      await this.writePlan(plan);
      this.staged = { label: local.name, plan, expectVersion: null };
      this.local = null;
      this.acceptMismatch = false;
      this.note = `${plan.found.join(', ')} written to ${this.main?.directory}. Nothing has been flashed yet.`;
      appendLog({
        level: 'info',
        text: `Firmware staged from a local file: ${plan.found.join(', ')}`,
        time: new Date(),
      });
    });
  }

  /** Actually flash. The board reboots; the connection drops. */
  private flash(): void {
    const staged = this.staged;
    if (!staged) return;
    const board = this.main;
    if (
      !confirm(
        `Flash ${staged.label} onto ${board?.boardName ?? 'the controller'}?\n\n` +
          `${staged.plan.commands.join(', then ')}\n\n` +
          'The board rewrites its own flash and reboots. This page will lose its connection for a minute or so. ' +
          'Do not cut the power while it is doing this.',
      )
    ) {
      return;
    }

    void this.run(`Flashing ${staged.label}`, async () => {
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
      this.awaiting = staged.expectVersion;
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

  /**
   * Flashing something the operator built or downloaded themselves.
   *
   * The reason it exists is this machine: it runs a fork of RepRapFirmware for
   * M700 and M604, and a fork has no release to point a list at. The reason it
   * is arranged like this is that nothing upstream has vouched for the bytes —
   * so the file is read and described before it is written, and the one check
   * that can actually be made about which board a file belongs to, its name, is
   * enforced with the override in plain sight rather than assumed away.
   */
  private renderLocal(): TemplateResult {
    const local = this.local;
    const main = this.main;
    const mismatch =
      local && local.check && main?.firmwareFile && local.check.kind !== 'zip'
        ? !matchesBoardFileStrictly(main.firmwareFile, local.name)
        : false;

    return html`
      <div class="fw-local">
        <h3>From a file</h3>
        <p class="hint">
          A board image you built or downloaded yourself — <code>.uf2</code>, <code>.bin</code>, or
          the combined firmware <code>.zip</code>. It is saved to
          ${main?.directory ?? 'the firmware directory'} under
          <code>${main?.firmwareFile ?? 'the name the board asks for'}</code>, which is the name the
          board opens. Only this board is flashed: one file is one board, and the expansion boards
          on the bus are left alone.
        </p>

        <label class="fw-file">
          <input
            type="file"
            accept=".uf2,.bin,.zip,application/octet-stream,application/zip"
            ?disabled=${!connected.get() || !!this.busy || this.machineBusy || !!main?.sbc}
            @change=${(e: Event) => this.onFile(e)}
          />
        </label>

        ${local
          ? html`
              <div class="fw-local-file ${local.problem ? 'bad' : ''}">
                <strong>${local.name}</strong>
                <span>${local.problem ?? local.check?.summary ?? ''}</span>
              </div>
            `
          : nothing}

        ${mismatch && local && !local.problem
          ? html`
              <div class="warn-banner">
                <strong>This is not the file ${main?.boardName} asks for.</strong>
                <div>
                  It loads <code>${main?.firmwareFile}</code>, and you have chosen
                  <code>${local.name}</code>. A name with a version in it is fine; a different name
                  is the only warning you get that this is another board's image, or the
                  <code>_SBC</code> build of this one — which comes up unable to answer over the
                  network. Nothing else in the file says which board it belongs to.
                </div>
                <label class="check">
                  <input
                    type="checkbox"
                    .checked=${this.acceptMismatch}
                    @change=${(e: Event) => {
                      this.acceptMismatch = (e.target as HTMLInputElement).checked;
                      this.requestUpdate();
                    }}
                  />
                  I have checked this is the right image for ${main?.boardName}
                </label>
              </div>
            `
          : nothing}

        <div class="pack-actions">
          <button
            class="primary"
            ?disabled=${!local ||
            !!local.problem ||
            !!this.busy ||
            !connected.get() ||
            this.machineBusy ||
            !!main?.sbc ||
            (mismatch && !this.acceptMismatch)}
            @click=${() => this.stageLocal()}
          >
            Put it on the card
          </button>
          ${local
            ? html`<button
                class="tiny"
                @click=${() => ((this.local = null), (this.acceptMismatch = false), this.requestUpdate())}
              >
                Forget it
              </button>`
            : nothing}
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const main = this.main;
    const staged = this.staged;

    // Computed, not stored: the board coming back on the new version is a
    // change in the machine state, and the panel re-renders on that anyway.
    const landed =
      this.awaiting && main?.version && main.version === this.awaiting.replace(/^v/i, '');

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
        ${landed
          ? html`<div class="pack-note good">
              The board came back running ${main?.version}. Check that it still homes and that
              config.g did not want anything new before cutting.
            </div>`
          : this.note
            ? html`<div class="pack-note good">${this.note}</div>`
            : nothing}

        ${staged
          ? html`<div class="warn-banner fw-armed">
              <strong>${staged.label} is on the card, not yet flashed.</strong>
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

        ${this.renderLocal()}

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
