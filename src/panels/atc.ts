// RapidChange ATC: set it up, and install the macros that drive it.
//
// A RapidChange is a row of pockets on the table. The spindle screws a tool on
// by descending onto a collet nut while turning slowly clockwise, and unscrews
// it by doing the same anticlockwise. Nothing actuates, nothing latches — which
// is why it works at all on a machine that has no tool-changer hardware, and
// why the entire installation is a handful of macros plus a set of coordinates.
//
// Three tabs, in the order the job is actually done:
//
//   Setup    the numbers
//   Pockets  where those numbers put every pocket, in machine coordinates
//   Install  exactly what will be written, and the button that writes it
//
// The Pockets tab is not decoration. Every value on the Setup tab ends up in a
// G53 rapid with the spindle running, and an origin or a pitch that is wrong by
// one pocket produces no warning from the firmware — it drives a spinning
// collet into the tool next door. Showing the resulting coordinates, and
// checking them against the machine's own travel limits, is the only feedback
// available short of running it.
//
// Nothing here runs a macro. Installing writes files; making the machine move
// is done deliberately, from the console or a tool change, by someone watching
// it with a hand on the stop.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import {
  activeDriver,
  appendLog,
  capabilities,
  connected,
  loadSetting,
  machine,
  run,
  saveSetting,
} from '../core/store.js';
import { checkField, numberField, selectField, textField } from '../ui/widgets.js';
import { fromAxis } from '../ui/capture.js';
import { formatBytes } from '../core/util.js';
import {
  adoptAtcConfig,
  defaultAtcBank,
  parseAtcConfig,
  probeFor,
  slotPosition,
  toolNumber,
  type AtcBank,
  type AtcConfig,
  type AtcProbe,
} from '../atc/config.js';
import { atcFiles, type AtcFile } from '../atc/files.js';
import { checkAtc, effectiveRetractZ, slotInEnvelope } from '../atc/check.js';

type Tab = 'setup' | 'pockets' | 'install';

/** The call that has to be in config.g for any of this to load. */
const CONFIG_CALL = 'M98 P"atcConfig.g"';

export class AtcPanel extends PanelElement {
  private config: AtcConfig = adoptAtcConfig(loadSetting('atcConfig', {}));
  private tab: Tab = 'setup';
  /** Which bank the Setup tab is editing. */
  private bankIndex = 0;

  /** Set once the operator has changed something, so a poll never overwrites it. */
  private edited = false;
  private busy = false;
  private status: string | null = null;
  private error: string | null = null;

  /** Names found in the config directory, or null when we have not looked. */
  private present: Set<string> | null = null;
  /** Whether config.g calls atcConfig.g; null when config.g could not be read. */
  private configCalls: boolean | null = null;
  /** Which file's contents are expanded on the install tab. */
  private expanded: string | null = null;

  private wasConnected = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      capabilities.get();
    });
    this.bind(() => {
      const now = connected.get();
      if (now && !this.wasConnected) void this.readBack(false);
      if (!now) {
        this.present = null;
        this.configCalls = null;
      }
      this.wasConnected = now;
    });
  }

  private get configRoot(): string | null {
    return capabilities.peek().configRoot;
  }

  private patch(patch: Partial<AtcConfig>): void {
    this.config = { ...this.config, ...patch };
    this.edited = true;
    saveSetting('atcConfig', this.config);
    this.requestUpdate();
  }

  private get bank(): AtcBank {
    return this.config.banks[this.bankIndex] ?? this.config.banks[0];
  }

  /** Change the bank being edited, leaving the others alone. */
  private patchBank(patch: Partial<AtcBank>): void {
    const banks = this.config.banks.map((b, i) => (i === this.bankIndex ? { ...b, ...patch } : b));
    this.patch({ banks });
  }

  private addBank(): void {
    // Copied from the current bank rather than started from defaults: a second
    // rail on the same machine shares the pocket height, the pitch and the
    // feeds with the first far more often than not, and the numbers that do
    // differ — where it is — are the ones nobody would leave unchecked.
    const source = this.bank;
    const bank: AtcBank = {
      ...(source ?? defaultAtcBank()),
      name: `Bank ${this.config.banks.length + 1}`,
      alignment: source && source.alignment === 0 ? 1 : 0,
      // Its own position has to be typed in, and starting it on top of the bank
      // it was copied from would be reported as an overlap immediately — which
      // is the intended nudge.
      probe: null,
      cover: null,
    };
    this.patch({ banks: [...this.config.banks, bank] });
    this.bankIndex = this.config.banks.length - 1;
    this.requestUpdate();
  }

  private removeBank(index: number): void {
    const bank = this.config.banks[index];
    if (!bank || this.config.banks.length < 2) return;
    const after = this.config.banks.filter((_, i) => i !== index);
    const renumbered = after.reduce((n, b) => n + b.count, 0);
    if (
      !confirm(
        `Remove ${bank.name} and its ${bank.count} pockets?\n\n` +
          `Tools renumber to T1..T${renumbered}, and the tpre/tpost/tfree files for the ` +
          'tools that no longer exist are left on the machine — delete them from the Files panel.',
      )
    ) {
      return;
    }
    // Every reference to a bank by number moves. A setter that lived in the
    // removed bank has nowhere to be; one in a later bank keeps its pocket but
    // that bank has shifted down the list.
    const reseat = (p: AtcProbe): AtcProbe => {
      if (!p.slot) return p;
      if (p.slot.bank === index) return { ...p, slot: null };
      if (p.slot.bank < index) return p;
      return { ...p, slot: { ...p.slot, bank: p.slot.bank - 1 } };
    };
    this.patch({
      banks: after.map((b) => (b.probe ? { ...b, probe: reseat(b.probe) } : b)),
      probe: reseat(this.config.probe),
    });
    this.bankIndex = Math.min(this.bankIndex, after.length - 1);
    this.requestUpdate();
  }

  // --- Reading the machine ------------------------------------------------

  /**
   * Load what is already installed.
   *
   * Called automatically on connect and by hand from the button. The automatic
   * call refuses to overwrite edits in progress: someone who has spent five
   * minutes typing pocket coordinates and then plugs the network back in should
   * not lose them to a file that is exactly what they are replacing.
   */
  private async readBack(force: boolean): Promise<void> {
    const driver = activeDriver();
    const root = this.configRoot;
    if (!driver || !root) return;

    this.busy = true;
    this.error = null;
    this.requestUpdate();
    try {
      const entries = await driver.listFiles(root);
      this.present = new Set(entries.filter((e) => !e.directory).map((e) => e.name));

      if (this.present.has('atcConfig.g') && (force || !this.edited)) {
        const bytes = await driver.readFile(`${root}/atcConfig.g`);
        const { config, found } = parseAtcConfig(new TextDecoder().decode(bytes));
        this.config = config;
        this.edited = false;
        saveSetting('atcConfig', this.config);
        this.status = `Read ${found.length} setting${found.length === 1 ? '' : 's'} from ${root}/atcConfig.g.`;
      } else if (!this.present.has('atcConfig.g')) {
        this.status = 'No ATC is installed on this machine yet.';
      }

      // Whether config.g actually loads it. Installed files that nothing calls
      // are the quietest possible failure: every tool change silently does
      // nothing, because global.atcEnabled does not exist.
      try {
        const cfg = await driver.readFile(`${root}/config.g`);
        const text = new TextDecoder().decode(cfg);
        this.configCalls = /^\s*M98\s+P"atcConfig\.g"/m.test(text);
      } catch {
        this.configCalls = null;
      }
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  // --- Installing ---------------------------------------------------------

  private async install(files: AtcFile[]): Promise<void> {
    const driver = activeDriver();
    const root = this.configRoot;
    if (!driver || !root) return;

    const overwriting = this.present ? files.filter((f) => this.present!.has(f.name)).length : 0;
    const detail =
      `Write ${files.length} file${files.length === 1 ? '' : 's'} to ${root}` +
      (overwriting ? `, overwriting ${overwriting} that already exist` : '') +
      '.\n\nNothing will move. The machine picks the new files up at the next tool change, ' +
      'or after M98 P"config.g".\n\nProceed?';
    if (!confirm(detail)) return;

    this.busy = true;
    this.error = null;
    this.status = null;
    this.requestUpdate();

    const encoder = new TextEncoder();
    let written = 0;
    for (const file of files) {
      const ok = await run(`write ${file.name}`, async (d) => {
        await d.writeFile(`${root}/${file.name}`, encoder.encode(file.content));
        return true;
      });
      if (!ok) {
        // Stop on the first failure rather than pressing on: a half-written
        // installation is worse than none, and it needs to be visible.
        this.error = `Stopped after ${written} of ${files.length} files. See the console for why.`;
        break;
      }
      written++;
      this.status = `Writing… ${written}/${files.length}`;
      this.requestUpdate();
    }

    // Verify against the directory rather than trusting the uploads: RRF
    // answers an upload before the write has necessarily landed, and a listing
    // is one request.
    try {
      const entries = await driver.listFiles(root);
      this.present = new Set(entries.filter((e) => !e.directory).map((e) => e.name));
      const missing = files.filter((f) => !this.present!.has(f.name)).map((f) => f.name);
      if (!this.error) {
        this.status = missing.length
          ? `Wrote ${written} files, but ${missing.length} are not on the machine: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`
          : `Installed ${written} files in ${root}.`;
      }
    } catch {
      /* the listing is a check, not the operation */
    }

    if (!this.error) {
      appendLog({ level: 'info', text: `ATC: installed ${written} files in ${root}`, time: new Date() });
    }
    this.busy = false;
    this.requestUpdate();
  }

  /**
   * Append the call to config.g.
   *
   * Appending rather than inserting is deliberate. The globals in atcConfig.g
   * depend on nothing else in config.g, and guessing at a position inside
   * someone's config — after the drives, before the tools, wherever — is how a
   * config editor eats a working machine. The end is always safe here.
   */
  private async addCallToConfigG(): Promise<void> {
    const driver = activeDriver();
    const root = this.configRoot;
    if (!driver || !root) return;
    if (!confirm(`Append these two lines to the end of ${root}/config.g?\n\n; Automatic tool changer\n${CONFIG_CALL}`)) {
      return;
    }

    this.busy = true;
    this.requestUpdate();
    await run('update config.g', async (d) => {
      const path = `${root}/config.g`;
      const text = new TextDecoder().decode(await d.readFile(path));
      const next = `${text.replace(/\s*$/, '')}\n\n; Automatic tool changer\n${CONFIG_CALL}\n`;
      await d.writeFile(path, new TextEncoder().encode(next));
      this.configCalls = true;
      this.status = `Added ${CONFIG_CALL} to config.g.`;
      return true;
    });
    this.busy = false;
    this.requestUpdate();
  }

  // --- Render: setup ------------------------------------------------------

  private group(title: string, note: string | TemplateResult, body: TemplateResult): TemplateResult {
    return html`
      <div class="atc-group">
        <h4>${title}</h4>
        <div class="atc-group-note">${note}</div>
        <div class="param-grid">${body}</div>
      </div>
    `;
  }

  /**
   * The bank selector.
   *
   * Present even with one bank, because the tool numbers it shows are the point:
   * which physical pocket answers to which T number is the thing that is hard to
   * hold in your head once there is more than one row, and it is exactly what a
   * posted program depends on.
   */
  private renderBankBar(): TemplateResult {
    const banks = this.config.banks;
    return html`
      <div class="atc-banks">
        ${banks.map((bank, i) => {
          const first = toolNumber(this.config, i, 1);
          return html`
            <button
              class=${i === this.bankIndex ? 'seg active' : 'seg'}
              title=${`${bank.count} pockets, T${first}–T${first + bank.count - 1}`}
              @click=${() => ((this.bankIndex = i), this.requestUpdate())}
            >
              ${bank.name} <em>T${first}–T${first + bank.count - 1}</em>
            </button>
          `;
        })}
        <button class="tiny" title="Add another row of pockets" @click=${() => this.addBank()}>+ Bank</button>
        ${banks.length > 1
          ? html`<button class="tiny" title="Remove this bank" @click=${() => this.removeBank(this.bankIndex)}>
              − ${this.bank.name}
            </button>`
          : nothing}
      </div>
    `;
  }

  /**
   * The fields describing one tool setter.
   *
   * Shared by the machine-wide setter and any a bank has of its own, because
   * they are the same four numbers and describing them twice is how the two
   * drift apart.
   */
  private renderProbeFields(probe: AtcProbe, apply: (p: AtcProbe) => void): TemplateResult {
    const banks = this.config.banks;
    const inPocket = probe.slot !== null;
    const bank = probe.slot ? banks[probe.slot.bank] : undefined;

    return html`
      ${checkField('The setter sits in one of the pockets', inPocket, (v) =>
        apply({ ...probe, slot: v ? { bank: this.bankIndex, slot: 1 } : null }),
      )}
      ${probe.slot
        ? html`
            ${banks.length > 1
              ? selectField(
                  'Setter bank',
                  String(probe.slot.bank),
                  banks.map((b, i) => ({ value: String(i), label: b.name })),
                  (v) => apply({ ...probe, slot: { bank: Number(v), slot: probe.slot!.slot } }),
                )
              : nothing}
            ${numberField(
              'Setter pocket',
              probe.slot.slot,
              (v) => apply({ ...probe, slot: { bank: probe.slot!.bank, slot: Math.round(v) } }),
              { min: 1, max: bank?.count ?? 1, step: 1, title: 'Its XY is then derived from the pocket geometry rather than typed in twice.' },
            )}
          `
        : html`
            ${numberField('Setter X', probe.x, (v) => apply({ ...probe, x: v }), { suffix: 'mm', step: 0.1, capture: fromAxis('X', 'machine') })}
            ${numberField('Setter Y', probe.y, (v) => apply({ ...probe, y: v }), { suffix: 'mm', step: 0.1, capture: fromAxis('Y', 'machine') })}
          `}
      ${numberField('Trigger Z', probe.z, (v) => apply({ ...probe, z: v }), { suffix: 'mm', step: 0.01, title: 'Machine Z at which the setter triggers. Every tool offset is measured against this one number.', capture: fromAxis('Z', 'machine') })}
      ${numberField('Probe input', probe.index, (v) => apply({ ...probe, index: Math.max(0, Math.round(v)) }), { min: 0, step: 1, title: 'The K number from the setter’s M558. On a machine with a workpiece probe as well, this is what keeps them apart.' })}
    `;
  }

  private renderSetup(): TemplateResult {
    const c = this.config;
    const b = this.bank;
    const many = c.banks.length > 1;
    const zMax = machine.peek().axes.find((a) => a.letter === 'Z')?.max;
    const first = toolNumber(c, this.bankIndex, 1);

    return html`
      <div class="atc-scroll">
        ${this.renderBankBar()}

        ${this.group(
          'Geometry',
          html`Where this bank's pockets are, holding
            <strong>T${first}–T${first + b.count - 1}</strong>. Set pocket 1 by jogging a tool over
            it, then check the
            <button class="link" @click=${() => ((this.tab = 'pockets'), this.requestUpdate())}>pocket list</button>.`,
          html`
            ${textField('Name', b.name, (v) => this.patchBank({ name: v }), { placeholder: 'X rail', title: 'Yours to choose. It appears in the macros and in the pocket list.' })}
            ${numberField('Pockets', b.count, (v) => this.patchBank({ count: Math.max(1, Math.round(v)) }), { min: 1, step: 1, title: 'How many pockets this row holds. Tool numbers continue from the bank before it.' })}
            ${numberField('Spacing', b.offset, (v) => this.patchBank({ offset: v }), { suffix: 'mm', step: 0.1, title: 'Centre to centre. 45 mm on the ER20 rail, 38 mm on the ER11.' })}
            ${selectField(
              'Row runs along',
              String(b.alignment) as '0' | '1',
              [
                { value: '0', label: 'X' },
                { value: '1', label: 'Y' },
              ],
              (v) => this.patchBank({ alignment: Number(v) === 1 ? 1 : 0 }),
            )}
            ${selectField(
              'Pocket 2 is',
              String(b.direction) as '1' | '-1',
              [
                { value: '1', label: `at a higher ${b.alignment === 0 ? 'X' : 'Y'}` },
                { value: '-1', label: `at a lower ${b.alignment === 0 ? 'X' : 'Y'}` },
              ],
              (v) => this.patchBank({ direction: Number(v) < 0 ? -1 : 1 }),
            )}
            ${numberField('Pocket 1 X', b.originX, (v) => this.patchBank({ originX: v }), { suffix: 'mm', step: 0.1, title: 'Machine coordinate of the centre of the first pocket.', capture: fromAxis('X', 'machine') })}
            ${numberField('Pocket 1 Y', b.originY, (v) => this.patchBank({ originY: v }), { suffix: 'mm', step: 0.1, capture: fromAxis('Y', 'machine') })}
          `,
        )}

        ${this.group(
          'Heights',
          html`This bank's engagement heights, all machine coordinates, all with the spindle over one
            of its pockets. Start is where the descent begins, end is where the nut is fully
            engaged.${many ? ' A second row usually sits at a different height, so these are per bank.' : ''}`,
          html`
            ${numberField('Pickup start Z', b.pickupStartZ, (v) => this.patchBank({ pickupStartZ: v }), { suffix: 'mm', step: 0.1, title: 'Just above the nut, before the spindle starts turning.', capture: fromAxis('Z', 'machine') })}
            ${numberField('Pickup end Z', b.pickupEndZ, (v) => this.patchBank({ pickupEndZ: v }), { suffix: 'mm', step: 0.1, title: 'Fully threaded on. Lower than the start.', capture: fromAxis('Z', 'machine') })}
            ${numberField('Re-engage lift', b.pickupReengage, (v) => this.patchBank({ pickupReengage: v }), { suffix: 'mm', step: 0.5, title: 'Lift and come back down once, to seat the threads. Skipping it cross-threads.' })}
            ${numberField('Pickup feed', b.pickupFeed, (v) => this.patchBank({ pickupFeed: v }), { suffix: 'mm/min', step: 10 })}
            ${numberField('Drop start Z', b.dropStartZ, (v) => this.patchBank({ dropStartZ: v }), { suffix: 'mm', step: 0.1, capture: fromAxis('Z', 'machine') })}
            ${numberField('Drop end Z', b.dropEndZ, (v) => this.patchBank({ dropEndZ: v }), { suffix: 'mm', step: 0.1, capture: fromAxis('Z', 'machine') })}
            ${numberField('Drop feed', b.dropFeed, (v) => this.patchBank({ dropFeed: v }), { suffix: 'mm/min', step: 10 })}
          `,
        )}

        ${this.group(
          'This bank’s hardware',
          'A cover over this row of pockets, and a setter of its own if it has one.',
          html`
            ${checkField('Pocket cover fitted', b.cover !== null, (v) =>
              this.patchBank({ cover: v ? { out: 6, pin: 'io6.out' } : null }),
            )}
            ${b.cover
              ? html`
                  ${numberField('Cover output', b.cover.out, (v) => this.patchBank({ cover: { ...b.cover!, out: Math.round(v) } }), { min: 0, step: 1, title: 'The P number in M950, used by M42. Each bank needs its own.' })}
                  ${textField('Cover pin', b.cover.pin, (v) => this.patchBank({ cover: { ...b.cover!, pin: v } }), { placeholder: 'io6.out' })}
                `
              : nothing}
            ${c.probingEnabled
              ? html`
                  ${checkField('This bank has its own tool setter', b.probe !== null, (v) =>
                    this.patchBank({ probe: v ? { ...probeFor(c, this.bankIndex), slot: null } : null }),
                  )}
                  ${b.probe
                    ? this.renderProbeFields(b.probe, (p) => this.patchBank({ probe: p }))
                    : html`<div class="param-note">
                        Tools from this bank are measured against the machine-wide setter below.
                      </div>`}
                `
              : nothing}
          `,
        )}

        ${this.group(
          'Machine',
          'The spindle and the height everything travels at — the same whichever bank a tool comes from.',
          html`
            ${checkField('ATC enabled', c.enabled, (v) => this.patch({ enabled: v }))}
            ${checkField('Retract to the Z maximum', c.retractZ === null, (v) =>
              this.patch({ retractZ: v ? null : (zMax ?? 0) }),
            )}
            ${c.retractZ !== null
              ? numberField('Retract Z', c.retractZ, (v) => this.patch({ retractZ: v }), { suffix: 'mm', step: 0.1, title: 'Height every move between pockets is made at. It has to clear the tools standing in them.', capture: fromAxis('Z', 'machine') })
              : html`<div class="param-note">
                  Every move between pockets happens at this height${zMax !== undefined ? html` — currently <code>Z${zMax}</code>` : nothing}.
                </div>`}
            ${numberField('Engagement RPM', c.rpm, (v) => this.patch({ rpm: v }), { suffix: 'rpm', step: 10, min: 0, title: 'A few hundred. A VFD often will not report this back accurately, which is normal.' })}
            ${numberField('Spin-up wait', c.spindlePause, (v) => this.patch({ spindlePause: v }), { suffix: 's', step: 0.5, min: 0, title: 'Time to reach speed before descending. Descending early strips the thread.' })}
            ${checkField('Tool-present sensor fitted', c.hasToolSensor, (v) => this.patch({ hasToolSensor: v }))}
            ${c.hasToolSensor
              ? html`
                  ${numberField('Sensor index', c.toolSensorIn, (v) => this.patch({ toolSensorIn: Math.round(v) }), { min: 0, step: 1, title: 'The J number in M950. The detection macro reads sensors.gpIn[this].' })}
                  ${textField('Sensor pin', c.toolSensorPin, (v) => this.patch({ toolSensorPin: v }), { placeholder: '^io7.in', title: 'Controller pin name. A leading ^ enables the pull-up.' })}
                  <div class="param-note">
                    Checked after every pickup and drop. Without it a tool that failed to screw on
                    is only discovered by the next cut. It is on the spindle, so one serves every bank.
                  </div>
                `
              : nothing}
          `,
        )}

        ${this.group(
          'Tool length probe',
          'Measured after every pickup, so a tool of any length arrives with the right Z offset.',
          html`
            ${checkField('Probe tool length after a change', c.probingEnabled, (v) => this.patch({ probingEnabled: v }))}
            ${c.probingEnabled
              ? html`
                  ${this.renderProbeFields(c.probe, (p) => this.patch({ probe: p }))}
                  <div class="param-note">
                    Used by every bank that does not have one of its own. The setter is a
                    <em>tool length</em> probe and nothing else — workpiece and feature probing use
                    their own probes, configured in the Probing panel.
                  </div>
                `
              : nothing}
          `,
        )}

        ${this.group(
          'Integration',
          'Optional hooks into the rest of this machine.',
          html`
            ${checkField('Retract a U-axis dust shoe around tool changes', c.dustShoe, (v) => this.patch({ dustShoe: v }))}
            ${c.dustShoe
              ? html`<div class="param-note">
                  Calls <code>dustShoeRetract.g</code> before the change and
                  <code>dustShoeEngage.g</code> after it, and follows the tool offset with U so the
                  brush stays level with the cutter. Both macros have to exist.
                </div>`
              : nothing}
          `,
        )}
      </div>
    `;
  }

  // --- Render: pockets ----------------------------------------------------

  private renderPockets(): TemplateResult {
    const c = this.config;
    const axes = machine.get().axes;
    const x = axes.find((a) => a.letter === 'X');
    const y = axes.find((a) => a.letter === 'Y');
    const known = !!x && !!y && x.max > x.min && y.max > y.min;
    const many = c.banks.length > 1;

    /** Which pocket, if any, holds a setter. */
    const setterAt = (bank: number, slot: number): boolean => {
      const p = probeFor(c, bank);
      return !!p.slot && p.slot.bank === bank && p.slot.slot === slot;
    };

    return html`
      <div class="atc-scroll">
        <div class="pack-note">
          Where the settings put each pocket, in machine coordinates, with the tool number that
          fetches it. Jog to one and check it before installing — this is the only chance to catch
          a wrong origin or pitch that does not involve a spinning tool.
        </div>

        ${c.banks.map((bank, b) => {
          const rows = Array.from({ length: bank.count }, (_, i) => {
            const slot = i + 1;
            return {
              slot,
              tool: toolNumber(c, b, slot),
              ...slotPosition(bank, slot),
              ok: slotInEnvelope(bank, slot, axes),
            };
          });
          const probe = probeFor(c, b);
          return html`
            ${many
              ? html`<h4 class="atc-bank-head">
                  ${bank.name}
                  <em>${bank.count} pockets along ${bank.alignment === 0 ? 'X' : 'Y'}, ${bank.offset} mm apart</em>
                </h4>`
              : nothing}
            <table class="atc-slots">
              <thead>
                <tr><th>Tool</th><th>Pocket</th><th>X</th><th>Y</th><th></th></tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) => html`
                    <tr class=${r.ok === false ? 'bad' : ''}>
                      <td>T${r.tool}</td>
                      <td>${r.slot}${setterAt(b, r.slot) ? html` <em>setter</em>` : nothing}</td>
                      <td>${r.x.toFixed(2)}</td>
                      <td>${r.y.toFixed(2)}</td>
                      <td>${r.ok === false ? 'outside travel' : ''}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
            ${c.probingEnabled && !probe.slot
              ? html`<div class="pack-note">
                  ${many ? html`${bank.name} is measured` : 'Tools are measured'} against the
                  ${c.banks[b].probe ? "bank's own" : 'machine-wide'} setter at
                  <code>X${probe.x.toFixed(2)} Y${probe.y.toFixed(2)}</code>, triggering at
                  <code>Z${probe.z.toFixed(2)}</code>.
                </div>`
              : nothing}
          `;
        })}

        <div class="pack-note">
          ${known
            ? html`Machine travel: X ${x!.min}…${x!.max}, Y ${y!.min}…${y!.max}.`
            : 'Not connected, so the pockets cannot be checked against the machine’s travel.'}
        </div>
      </div>
    `;
  }

  // --- Render: install ----------------------------------------------------

  private renderInstall(files: AtcFile[], blocking: number): TemplateResult {
    const root = this.configRoot;
    const live = connected.get();
    const bytes = files.reduce((n, f) => n + new TextEncoder().encode(f.content).length, 0);

    return html`
      <div class="atc-scroll">
        <div class="pack-note">
          ${files.length} files, ${formatBytes(bytes)}, into <code>${root ?? '(no config directory)'}</code>.
          ${this.present
            ? html`${files.filter((f) => this.present!.has(f.name)).length} of them already exist and
              will be overwritten.`
            : nothing}
        </div>

        ${this.configCalls === false
          ? html`
              <div class="warn-banner">
                <code>config.g</code> does not call <code>atcConfig.g</code>, so none of these
                settings will be loaded and every tool change will quietly do nothing.
                <button class="tiny" ?disabled=${this.busy} @click=${() => void this.addCallToConfigG()}>
                  Add the call
                </button>
              </div>
            `
          : nothing}

        <ul class="atc-files">
          ${files.map(
            (f) => html`
              <li>
                <div class="atc-file-row" @click=${() => ((this.expanded = this.expanded === f.name ? null : f.name), this.requestUpdate())}>
                  <span class="atc-file-name">${f.name}</span>
                  <span class="atc-file-purpose">${f.purpose}</span>
                  ${this.present?.has(f.name) ? html`<span class="atc-file-flag">replaces</span>` : nothing}
                </div>
                ${this.expanded === f.name ? html`<pre class="atc-file-body">${f.content}</pre>` : nothing}
              </li>
            `,
          )}
        </ul>
      </div>

      <div class="pack-actions">
        <button ?disabled=${!live || this.busy} @click=${() => void this.readBack(true)}>
          Re-read from machine
        </button>
        <button
          class="primary"
          ?disabled=${!live || this.busy || !root || blocking > 0}
          title=${blocking > 0 ? 'Fix the errors above first.' : `Write ${files.length} files to ${root ?? ''}`}
          @click=${() => void this.install(files)}
        >
          ${this.busy ? 'Working…' : `Install ${files.length} files`}
        </button>
      </div>
    `;
  }

  // --- Render -------------------------------------------------------------

  protected override render(): TemplateResult {
    const axes = machine.get().axes;
    const issues = checkAtc(this.config, axes);
    const blocking = issues.filter((i) => i.level === 'bad').length;
    const files = atcFiles(this.config);
    const retract = effectiveRetractZ(this.config, axes);

    const pockets = this.config.banks.reduce((n, b) => n + b.count, 0);
    const tabs: Array<[Tab, string]> = [
      ['setup', 'Setup'],
      ['pockets', `Pockets (${pockets})`],
      ['install', `Install (${files.length})`],
    ];

    return html`
      <div class="pack atc-panel">
        <div class="pack-bar">
          <div class="pack-tabs">
            ${tabs.map(
              ([id, label]) => html`
                <button class=${id === this.tab ? 'seg active' : 'seg'} @click=${() => ((this.tab = id), this.requestUpdate())}>
                  ${label}
                </button>
              `,
            )}
          </div>
          ${blocking > 0
            ? html`<span class="atc-badge bad">${blocking} error${blocking === 1 ? '' : 's'}</span>`
            : nothing}
        </div>

        ${this.error ? html`<div class="warn-banner">${this.error}</div>` : nothing}
        ${this.status && !this.error ? html`<div class="pack-note">${this.status}</div>` : nothing}

        ${issues.length
          ? html`
              <div class="atc-issues">
                ${issues.map((i) => html`<div class=${i.level === 'bad' ? 'atc-issue bad' : 'atc-issue'}>${i.text}</div>`)}
              </div>
            `
          : nothing}

        ${this.tab === 'setup'
          ? this.renderSetup()
          : this.tab === 'pockets'
            ? this.renderPockets()
            : this.renderInstall(files, blocking)}

        ${this.tab !== 'install'
          ? html`
              <div class="pack-actions">
                <span class="atc-summary">
                  ${this.config.banks.length > 1
                    ? `${this.config.banks.length} banks, ${pockets} pockets, T1–T${pockets}`
                    : `${pockets} pockets, ${this.bank.offset} mm apart along ${this.bank.alignment === 0 ? 'X' : 'Y'}`}${retract != null
                    ? `, retracting to Z${retract}`
                    : ''}
                </span>
                <button class="primary" @click=${() => ((this.tab = 'install'), this.requestUpdate())}>
                  Review &amp; install
                </button>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-atc', AtcPanel);

registerPanel({
  id: 'atc',
  title: 'Tool changer',
  tag: 'cnc-atc',
  defaultWidth: 6,
  defaultHeight: 520,
  available: (caps) => caps.fileWrite && caps.configRoot !== null,
  description: 'Set up and install the RapidChange ATC macros',
});
