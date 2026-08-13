// Installing Axis Control onto the machine, and keeping it up to date.
//
// The panel answers three questions at once, because the useful thing is the
// comparison rather than any one of them:
//
//   what is on the machine  ·  what this copy is  ·  what GitHub has
//
// and then offers the one or two moves that make sense given those three.
//
// It installs beside DWC, never over it. `/www/AxisControl` is its own
// directory and nothing outside it is written or deleted, so the fallback that
// matters — the stock web interface, reachable when this app is the thing that
// is broken — is never at risk.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, appendLog, connected, controllerUrl, machine, saveSetting, loadSetting } from '../core/store.js';
import { BUILD, describeBuild, isDirtyBuild } from '../core/build.js';
import {
  INSTALL_DIR,
  entryServesUs,
  entryUrl,
  fetchBuild,
  installBuild,
  installedUrl,
  isSameBuild,
  ownOrigin,
  probeManifest,
  readManifest,
  verifyInstalled,
  sealInstall,
  shortcutPath,
  shortcutUrl,
  totalBytes,
  writeShortcut,
  type BuildManifest,
} from '../machine/install.js';
import {
  CHECK_INTERVAL_MS,
  REPO,
  fetchRelease,
  isNewer,
  listReleases,
  newestInstallable,
  type Release,
} from '../machine/update.js';

/** Statuses during which nothing may be written to the machine. */
const BUSY_STATES = new Set(['running', 'paused', 'pausing', 'resuming', 'homing', 'tool-change']);

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}

interface Settings {
  /** Check GitHub for a newer version by itself. */
  autoCheck: boolean;
  /** Offer prereleases as well as stable releases. */
  betas: boolean;
  /** Write /www/AxisControl.html, so the short URL works. */
  shortcut: boolean;
  lastCheck: number;
}

export class InstallPanel extends PanelElement {
  private settings: Settings = {
    autoCheck: true,
    betas: false,
    shortcut: true,
    lastCheck: 0,
    ...loadSetting<Partial<Settings>>('install', {}),
  };

  /** What is on the machine, null for nothing, undefined for not looked yet. */
  private installed: BuildManifest | null | undefined = undefined;
  private releases: Release[] | null = null;
  private checking = false;
  private busy: string | null = null;
  private progress: { done: number; total: number; label: string } | null = null;
  private error: string | null = null;
  private done: string | null = null;
  /**
   * Something worth knowing about an install that nonetheless worked.
   *
   * Separate from `error` because it renders differently and, more to the
   * point, means something different: `error` says the install did not happen,
   * `caveat` says it did and here is what to watch out for. The two were one
   * field, and that is how "this browser cannot fetch the manifest" came out as
   * "the machine will not serve the files, check your SD card".
   */
  private caveat: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    let lastUrl = '';
    this.bind(() => {
      const live = connected.get();
      const url = controllerUrl.get();
      machine.get();
      // Read what is installed once there is something to read it from.
      //
      // The panel is rebuilt from the saved layout before auto-connect
      // finishes, so the read below found nothing and left the installed
      // version showing "…" for the rest of the session. `installed` is
      // undefined only until something has been read — readManifest answers
      // null rather than throwing, so this cannot spin.
      if (live && (this.installed === undefined || url !== lastUrl)) {
        lastUrl = url;
        void this.readInstalled();
      }
    });
    void this.refresh();
  }

  private save(): void {
    saveSetting('install', this.settings);
  }

  private get machineBusy(): boolean {
    return BUSY_STATES.has(machine.peek().status);
  }

  // --- Looking around -----------------------------------------------------

  private async refresh(): Promise<void> {
    await this.readInstalled();
    // Automatic, but at most daily: the unauthenticated rate limit is 60 an
    // hour for the whole address, and a check on every page load would spend it
    // on a question whose answer changes about once a week.
    if (this.settings.autoCheck && Date.now() - this.settings.lastCheck > CHECK_INTERVAL_MS) {
      await this.check(true);
    }
  }

  /**
   * What is on the machine, read off the card rather than fetched over HTTP.
   *
   * Same reasoning as the check after an install: the driver's file API is the
   * channel that is known to work whenever the panel is connected at all, while
   * a browser fetch to the machine's web server can fail for reasons that have
   * nothing to do with what is on the card. Reading it over HTTP is what used
   * to make an installed copy show as "not installed".
   */
  private async readInstalled(): Promise<void> {
    if (!connected.peek()) return;
    const driver = activeDriver();
    this.installed = driver ? (await verifyInstalled(driver, INSTALL_DIR)).manifest : null;
    this.requestUpdate();
  }

  private async check(quiet = false): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    if (!quiet) this.error = null;
    this.requestUpdate();
    try {
      this.releases = await listReleases();
      this.settings.lastCheck = Date.now();
      this.save();
    } catch (err) {
      // A failed automatic check is not worth a banner: the machine works, and
      // the operator did not ask.
      if (!quiet) this.error = (err as Error).message;
    } finally {
      this.checking = false;
      this.requestUpdate();
    }
  }

  private get available(): Release | null {
    return this.releases ? newestInstallable(this.releases, this.settings.betas) : null;
  }

  // --- Installing ---------------------------------------------------------

  private async run(label: string, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = label;
    this.error = null;
    this.caveat = null;
    this.done = null;
    this.progress = null;
    this.requestUpdate();
    try {
      await work();
    } catch (err) {
      this.error = (err as Error).message;
      appendLog({ level: 'error', text: `${label}: ${this.error}`, time: new Date() });
    } finally {
      this.busy = null;
      this.progress = null;
      this.requestUpdate();
    }
  }

  private step(label: string, done: number, total: number): void {
    this.progress = { label, done, total };
    this.requestUpdate();
  }

  /** Copy the running app onto the machine. */
  private installThisCopy(): void {
    void this.run('Install', async () => {
      const driver = activeDriver();
      if (!driver) throw new Error('Not connected');

      const base = ownOrigin();
      const manifest = await readManifest(base);
      if (!manifest) {
        throw new Error(
          'This copy has no build.json, so there is no list of files to install. Rebuild it with `npm run build` — a copy served straight out of src/ cannot be installed.',
        );
      }

      this.step('reading this copy', 0, manifest.files.length);
      const files = await fetchBuild(base, manifest, (_name, done, total) =>
        this.step('reading this copy', done, total),
      );

      await this.writeAndSeal(driver, manifest, files);
    });
  }

  /** Download a release from GitHub and put that on the machine. */
  private installRelease(release: Release): void {
    void this.run(`Install ${release.tag}`, async () => {
      const driver = activeDriver();
      if (!driver) throw new Error('Not connected');

      this.step(`downloading ${release.tag}`, 0, 100);
      const { manifest, files } = await fetchRelease(release, (loaded, total) =>
        this.step(`downloading ${release.tag}`, loaded, total ?? 0),
      );
      await this.writeAndSeal(driver, manifest, files);
    });
  }

  /**
   * Whether the machine serves the copy over HTTP, and what to say if not.
   *
   * Returns null when it does. Everything else is advice, not a verdict: the
   * files are on the card — that has already been confirmed through the driver —
   * so the worst case here is that this browser cannot reach them from where it
   * is standing, which is a thing the operator can check in a tab in two
   * seconds and which may not even be true of the tablet at the machine.
   *
   * Retried, because twenty-odd files have just gone onto the card and a board
   * still finishing with it answers the first request badly.
   */
  private async checkServed(): Promise<string | null> {
    const url = controllerUrl.peek();
    const entry = entryUrl(url);

    let probe = await probeManifest(installedUrl(url));
    for (let attempt = 0; !probe.manifest && attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      probe = await probeManifest(installedUrl(url));
    }
    if (!probe.manifest) {
      return (
        `The files are on the machine — that has been read back off the card. ` +
        `What could not be confirmed from this browser is that the machine serves them: ${probe.reason}. ` +
        `Open ${entry} in a tab; if it loads, there is nothing wrong.`
      );
    }

    if (!(await entryServesUs(entry))) {
      return (
        `The files are on the machine, but ${entry} is being answered by something else — ` +
        'almost certainly DWC. That is what a "404 page not found" drawn inside the DWC shell means.'
      );
    }
    return null;
  }

  private async writeAndSeal(
    driver: NonNullable<ReturnType<typeof activeDriver>>,
    manifest: BuildManifest,
    files: Map<string, Uint8Array>,
  ): Promise<void> {
    if (this.machineBusy) {
      throw new Error(
        `The machine is ${machine.peek().status}. Writing to the SD card during a job is not worth the risk — wait until it is idle.`,
      );
    }

    await installBuild(driver, INSTALL_DIR, files, (p) =>
      this.step(`writing ${p.file}`, p.done, p.total),
    );
    // Last, and only now: the manifest is what claims a complete copy is here.
    await sealInstall(driver, INSTALL_DIR, manifest);
    if (this.settings.shortcut) await writeShortcut(driver, INSTALL_DIR);

    // Did the bytes land? Asked through the driver, over the same channel the
    // uploads went through. This is the only question whose answer means the
    // install failed.
    this.step('confirming the copy on the machine', 1, 1);
    const written = await verifyInstalled(driver, INSTALL_DIR);
    if (!written.manifest) {
      throw new Error(`The upload finished but the copy is not readable: ${written.reason}`);
    }
    this.installed = written.manifest;
    this.done = `${describeBuild(this.installed)} is installed — ${mb(totalBytes(files))} written`;
    appendLog({ level: 'info', text: `Axis Control ${this.done}`, time: new Date() });

    // Does the machine SERVE it? A different question with its own ways to
    // fail, none of which means the install did not work — which is the whole
    // reason it is a caveat and not an error. The files are on the card either
    // way, and saying otherwise sent people looking for a fault in the SD card
    // that was never there.
    this.caveat = await this.checkServed();
  }

  // --- Render -------------------------------------------------------------

  private renderStatus(): TemplateResult {
    const url = entryUrl(controllerUrl.get());
    const installed = this.installed;
    const same = isSameBuild(installed ?? null, BUILD);

    return html`
      <div class="inst-grid">
        <div class="inst-cell">
          <span class="inst-label">On the machine</span>
          <strong>
            ${installed === undefined
              ? '—'
              : installed === null
                ? 'not installed'
                : describeBuild(installed)}
          </strong>
          ${installed
            ? html`<a class="inst-link" href=${url} target="_blank" rel="noreferrer">${url}</a>`
            : html`<span class="hint">will be served from ${url}</span>`}
        </div>
        <div class="inst-cell">
          <span class="inst-label">This copy</span>
          <strong>${describeBuild(BUILD)}</strong>
          <span class="hint">
            ${isDirtyBuild(BUILD) ? 'built from uncommitted changes' : 'running from ' + ownOrigin()}
          </span>
        </div>
        <div class="inst-cell">
          <span class="inst-label">On GitHub</span>
          <strong>${this.checking ? 'checking…' : (this.available?.tag ?? '—')}</strong>
          <span class="hint">
            ${this.available
              ? `${this.available.prerelease ? 'prerelease · ' : ''}${mb(this.available.zipBytes)}`
              : this.releases
                ? 'no release with a build attached'
                : 'not checked yet'}
          </span>
        </div>
      </div>
      ${same
        ? html`<div class="pack-note">The machine is running exactly this build.</div>`
        : nothing}
    `;
  }

  private renderActions(): TemplateResult {
    const live = connected.get();
    const available = this.available;
    const updateAvailable =
      available && (!this.installed || isNewer(available, this.installed));

    return html`
      <div class="pack-actions inst-actions">
        <button
          class="primary"
          ?disabled=${!live || !!this.busy || this.machineBusy}
          title=${this.machineBusy
            ? 'Not while the machine is running'
            : 'Copy the build this page is running from onto the machine'}
          @click=${() => this.installThisCopy()}
        >
          ${this.installed ? 'Replace with this copy' : 'Install on the machine'}
        </button>
        ${updateAvailable
          ? html`<button
              ?disabled=${!live || !!this.busy || this.machineBusy}
              @click=${() => this.installRelease(available)}
            >
              Install ${available.tag}
            </button>`
          : nothing}
        <button class="tiny" ?disabled=${this.checking} @click=${() => void this.check()}>
          Check GitHub
        </button>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const available = this.available;
    const updateAvailable =
      available && this.installed && isNewer(available, this.installed);

    return html`
      <div class="pack inst">
        <div class="pack-blurb">
          Serve this app from the machine itself, beside DWC, which stays exactly where it is. A
          tablet then needs nothing but the machine, and the controller is same-origin so no CORS
          setting is involved.
        </div>
        <div class="pack-blurb inst-urlnote">
          The address ends in <code>/index.html</code>. RepRapFirmware has no directory index:
          <code>${INSTALL_DIR.replace('/www', '')}</code> on its own resolves to no file, and the
          firmware answers an unresolvable path with DWC — which then shows its own
          <em>404 page not found</em>. That page means the address, not the install.
        </div>

        ${this.renderStatus()}

        ${updateAvailable
          ? html`<div class="warn-banner inst-update">
              <strong>${available.name}</strong> is newer than what is on the machine.
              <a href=${available.htmlUrl} target="_blank" rel="noreferrer">Release notes</a>
            </div>`
          : nothing}

        ${this.machineBusy
          ? html`<div class="warn-banner">
              The machine is ${machine.get().status}. Installing writes to the same SD card the job
              is reading from, so it waits until the machine is idle.
            </div>`
          : nothing}

        ${this.busy
          ? html`<div class="inst-progress">
              <span>${this.progress?.label ?? this.busy}…</span>
              <progress
                max=${this.progress?.total || 1}
                .value=${this.progress?.done ?? 0}
              ></progress>
              <em>${this.progress ? `${this.progress.done}/${this.progress.total}` : ''}</em>
            </div>`
          : nothing}

        ${this.error ? html`<div class="warn-banner bad">${this.error}</div>` : nothing}
        ${this.done ? html`<div class="pack-note good">${this.done}</div>` : nothing}
        ${this.caveat ? html`<div class="warn-banner">${this.caveat}</div>` : nothing}

        ${this.renderActions()}

        <div class="inst-options">
          <label class="check">
            <input
              type="checkbox"
              .checked=${this.settings.autoCheck}
              @change=${(e: Event) => {
                this.settings.autoCheck = (e.target as HTMLInputElement).checked;
                this.save();
                this.requestUpdate();
              }}
            />
            Check ${REPO} for updates, once a day
          </label>
          <label
            class="check"
            title="Writes ${shortcutPath()}, one line of HTML that redirects to the entry point. The only file written outside the install directory."
          >
            <input
              type="checkbox"
              .checked=${this.settings.shortcut}
              @change=${(e: Event) => {
                this.settings.shortcut = (e.target as HTMLInputElement).checked;
                this.save();
                this.requestUpdate();
              }}
            />
            Add a ${shortcutUrl(controllerUrl.get()).replace(/^https?:\/\//, '')} shortcut
          </label>
          <label class="check">
            <input
              type="checkbox"
              .checked=${this.settings.betas}
              @change=${(e: Event) => {
                this.settings.betas = (e.target as HTMLInputElement).checked;
                this.save();
                this.requestUpdate();
              }}
            />
            Include prereleases
          </label>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-install', InstallPanel);

registerPanel({
  id: 'install',
  title: 'Install',
  tag: 'cnc-install',
  defaultWidth: 5,
  defaultHeight: 420,
  available: (caps) => caps.fileWrite,
  description: 'Serve Axis Control from the machine, and keep it updated',
});
