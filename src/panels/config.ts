// The machine's configuration, read and explained.
//
// Everything here is about answering three questions that config.g cannot
// answer about itself:
//
//   What does this line do?          — the reference is already in the app
//   Is it actually in force?         — compare it against the object model
//   Is anything about it nonsense?   — see config/check.ts
//
// The third is the one that pays. RRF runs config.g top to bottom and mostly
// does not complain: set the same maximum speed twice and the second wins in
// silence, configure an axis before M584 creates it and the line is refused at
// boot with nobody watching, misspell a parameter and it is ignored. Each
// leaves a machine that runs, behaves differently from what the file appears to
// say, and offers no clue why.
//
// And then a fourth, which is the one that changes how tuning feels:
//
//   What if it were 3000 instead?  — send it and find out
//
// Values on the whitelist can be edited here and applied to the machine
// directly. Applying writes nothing: the edit lives in the running firmware
// until a restart forgets it. That is what collapses the edit / restart / feel
// it / edit again loop into seconds, and it is safe to play with precisely
// because M999 undoes all of it.
//
// Saving is the deliberate second step, and only for a value that has been
// applied — what goes into config.g is a number that has been felt, not one
// that has been typed. It edits the line in place; see config/save.ts.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, connected, machine } from '../core/store.js';
import { empty } from '../ui/widgets.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { checkConfig, type Finding } from '../config/check.js';
import {
  comparable,
  comparableCommands,
  compareLine,
  describe,
  type LiveValue,
} from '../config/live.js';
import { blockedBy, caution, commandFor, editKey, liveAppliable } from '../config/apply.js';
import { saveFile, type FileOp, type SaveReport } from '../config/save.js';
import {
  appendParams,
  commentColumn,
  findingsAdded,
  lineFor,
  missingAxes,
  missingCommands,
  placeFor,
  type Addition,
} from '../config/add.js';
import {
  editable,
  parseConfig,
  rewriteLine,
  type ConfigFile,
  type ConfigLine,
} from '../config/parse.js';
import { actions } from '../core/store.js';
import { loadIndex } from '../docs/load.js';
import type { GcodeIndex } from '../docs/types.js';

export class ConfigPanel extends PanelElement {
  private loaded: LoadedConfig | null = null;
  private index: GcodeIndex | null = null;
  private error: string | null = null;
  private loading = false;
  /** Files the operator has collapsed. */
  private closed = new Set<string>();
  /** Show every line, rather than only the commands. */
  private verbose = false;
  /** Values typed here but not yet sent, keyed by file:line:letter. */
  private edits = new Map<string, string>();
  /**
   * Values sent to the machine and not saved to any file.
   *
   * Each remembers the line it was applied to as it read at the time. A key is
   * only a path and a line number, and both of those mean something different
   * once somebody inserts a line above — so the text is what makes the entry
   * verifiable rather than merely plausible.
   */
  private applied = new Map<string, { value: string; raw: string }>();
  /** Each loaded file's text as last read, to notice one changing underneath. */
  private signatures = new Map<string, string>();
  private applying = false;
  private applyError: string | null = null;
  private saving = false;
  private saveError: string | null = null;
  /** What the last save actually did, so the panel can say it rather than imply it. */
  private saved: SaveReport[] = [];
  /** Parameters to append to an existing line, keyed by file:line. */
  private adding = new Map<string, Addition[]>();
  /** Commands to write a whole new line for. */
  private newCommands = new Set<string>();
  /** New lines typed by hand, keyed by the file:line they go after. */
  private inserts = new Map<string, string>();
  /** Lines to comment out, or to bring back, keyed by file:line. */
  private toggled = new Set<string>();
  /** Lines to remove entirely, keyed by file:line. */
  private removing = new Set<string>();
  /** Which line's insert field is open, and what has been typed into it. */
  private inserting: string | null = null;
  private draft = '';

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      const live = connected.get();
      machine.get();
      // Read as soon as there is a machine to read from, rather than once when
      // the element is built.
      //
      // On a page reload the panel is created from the saved layout while the
      // connection is still being made, so a single read here found no driver,
      // returned without saying anything, and left "No configuration read" on
      // screen for the rest of the session. This runs again on every machine
      // update; reload() itself decides there is nothing to do, which is what
      // keeps it from re-downloading six files a second.
      if (live) void this.reload();
    });
    void loadIndex().then((i) => ((this.index = i), this.requestUpdate()));
  }

  /** Lines whose values this panel is willing to touch. */
  private static readonly EDITABLE = new Set(['M92', 'M201', 'M203', 'M208', 'M566', 'M906']);

  /**
   * Lines a new axis-configuration line belongs beside.
   *
   * Wider than EDITABLE because it is answering a different question. This is
   * not "what may be changed" but "where do lines like this one live in this
   * particular file", and M584 and M350 mark that group just as well as M203
   * does — better, since a file may have no M203 at all, which is exactly the
   * case a new line is being added for.
   */
  private static readonly FAMILY = new Set([
    'M92', 'M201', 'M203', 'M208', 'M350', 'M566', 'M574', 'M584', 'M906',
  ]);

  private get axes() {
    return machine.get().axes;
  }

  /** Commands the machine can be read back for that no line ever sets. */
  private missing(): string[] {
    if (!this.loaded) return [];
    return missingCommands(this.loaded.files, new Set(comparableCommands()));
  }

  /**
   * A new line for `command`: where it goes, what it says, and what the checker
   * makes of it.
   *
   * The validation is the point. Rather than a second set of placement rules
   * written for this one job, the proposed file is re-checked by the same code
   * that reports on everything else — so a line put somewhere that would be
   * refused at boot is caught by the rule that already knows why.
   */
  private plan(command: string):
    | { path: string; op: Extract<FileOp, { kind: 'insert' }>; because: string; problems: string[] }
    | { refused: string } {
    const files = this.loaded?.files ?? [];
    const spot = placeFor(files, command, '', ConfigPanel.FAMILY);
    if ('refused' in spot) return spot;
    const file = files.find((f) => f.path === spot.path)!;
    const text = lineFor(command, this.axes, describe(command)?.label ?? command, commentColumn(file));
    if (!text) {
      return { refused: `The machine reports no ${describe(command)?.label ?? command} to write down.` };
    }
    const place = { ...spot, text };
    const problems = findingsAdded(files, place, this.index, this.axes.map((a) => a.letter));
    return { path: spot.path, op: { kind: 'insert', after: spot.after, text }, because: spot.because, problems };
  }

  /** Every pending edit, grouped into the lines they belong to. */
  private pendingLines(): Array<{ path: string; line: ConfigLine }> {
    const out: Array<{ path: string; line: ConfigLine }> = [];
    for (const file of this.loaded?.files ?? []) {
      for (const line of file.lines) {
        const touched = line.params.some((p) => this.edits.has(editKey(file.path, line, p.letter)));
        if (touched) out.push({ path: file.path, line });
      }
    }
    return out;
  }

  /**
   * Send the edited lines, in the order the file runs them.
   *
   * Sequentially rather than all at once: these are configuration commands and
   * a later one can depend on an earlier, so preserving the file's order is the
   * only thing that behaves the same as a restart would.
   */
  private async applyEdits(): Promise<void> {
    const pending = this.pendingLines();
    if (!pending.length || this.applying) return;
    const blocked = blockedBy(machine.peek().status);
    if (blocked) {
      this.applyError = blocked;
      this.requestUpdate();
      return;
    }
    this.applying = true;
    this.applyError = null;
    this.requestUpdate();
    try {
      for (const { path, line } of pending) {
        await actions.send(commandFor(line, this.edits, path));
        for (const p of line.params) {
          const key = editKey(path, line, p.letter);
          const value = this.edits.get(key);
          if (value !== undefined) this.applied.set(key, { value, raw: line.raw });
        }
      }
      this.edits.clear();
    } catch (err) {
      this.applyError = (err as Error).message;
    } finally {
      this.applying = false;
      this.requestUpdate();
    }
  }

  /** Put the machine back to what the file says, without writing anything. */
  private async revertAll(): Promise<void> {
    const lines: Array<{ path: string; line: ConfigLine }> = [];
    for (const file of this.loaded?.files ?? []) {
      for (const line of file.lines) {
        if (line.params.some((p) => this.applied.has(editKey(file.path, line, p.letter)))) {
          lines.push({ path: file.path, line });
        }
      }
    }
    this.edits.clear();
    this.applying = true;
    this.requestUpdate();
    try {
      // An empty edit map means "as written in the file", which is the point.
      for (const { path, line } of lines) await actions.send(commandFor(line, new Map(), path));
      this.applied.clear();
    } catch (err) {
      this.applyError = (err as Error).message;
    } finally {
      this.applying = false;
      this.requestUpdate();
    }
  }

  /**
   * The values running on the machine because of this panel, grouped by file.
   *
   * Deliberately built from `applied` and not from `edits`: what gets written
   * into config.g is a number that has been tried, not one that has been typed.
   * The two never overlap — applying moves a value from one map to the other.
   */
  private settled(): Array<{ file: ConfigFile; edits: FileOp[] }> {
    const out: Array<{ file: ConfigFile; edits: FileOp[] }> = [];
    for (const file of this.loaded?.files ?? []) {
      const edits: FileOp[] = [];
      for (const line of file.lines) {
        const key = `${file.path}:${line.index}`;
        // Removing, commenting out and inserting apply to any line at all, not
        // only the ones whose values this panel is willing to tune.
        if (this.removing.has(key)) {
          edits.push({ kind: 'delete', line });
          continue;
        }
        if (this.toggled.has(key)) edits.push({ kind: 'replace', line, text: this.toggledText(line) });
        const typed = this.inserts.get(key);
        if (typed) edits.push({ kind: 'insert', after: line, text: typed });
        if (!this.canEdit(line) || this.toggled.has(key)) continue;
        const values = new Map<string, string>();
        for (const p of line.params) {
          const v = this.applied.get(editKey(file.path, line, p.letter));
          if (v !== undefined) values.set(p.letter, v.value);
        }
        const extra = this.adding.get(`${file.path}:${line.index}`) ?? [];
        if (extra.length) {
          // Append first, then substitute. Appending only touches the line at
          // or after its last parameter, so every parameter offset still points
          // where it did — do it the other way round and a value that changed
          // width would have moved the end of the line out from under this.
          const appended = appendParams(line, extra);
          const text = values.size ? rewriteLine({ ...line, raw: appended }, values) : appended;
          edits.push({ kind: 'replace', line, text });
        } else if (values.size) {
          edits.push({ kind: 'set', line, values });
        }
      }
      for (const command of this.newCommands) {
        const planned = this.plan(command);
        if ('refused' in planned || planned.problems.length || planned.path !== file.path) continue;
        edits.push(planned.op);
      }
      if (edits.length) out.push({ file, edits });
    }
    return out;
  }

  /**
   * Write the settled values into the files they came from.
   *
   * One file at a time, and a failure stops the rest: if config-axes.g would not
   * verify, the operator needs to look at that before anything else is written.
   * Whatever did get written stays written and is reported by name — a save that
   * silently rolled part of itself back would be worse than one that stopped.
   */
  private async saveSettled(): Promise<void> {
    const driver = activeDriver();
    if (!driver || this.saving) return;
    const blocked = blockedBy(machine.peek().status);
    if (blocked) {
      this.saveError = blocked;
      this.requestUpdate();
      return;
    }
    // Anything typed but not yet sent goes to the machine first.
    //
    // Saving used to require applying by hand beforehand, on the reasoning that
    // what goes into config.g should be a number that has been felt. That is
    // still true, and it is still what happens — but it is this button's job to
    // do it, not the operator's to know it. Requiring the step only meant the
    // Save button was invisible until somebody had guessed at it.
    if (this.pendingLines().length) {
      await this.applyEdits();
      if (this.applyError) return;
    }
    const groups = this.settled();
    if (!groups.length) return;
    this.saving = true;
    this.saveError = null;
    this.saved = [];
    this.requestUpdate();
    try {
      for (const { file, edits } of groups) {
        this.saved.push(await saveFile(driver, file, edits));
        // Only the lines that made it to disk stop being "applied, not saved".
        for (const op of edits) {
          const at = `${file.path}:${anchorIndex(op)}`;
          this.inserts.delete(at);
          this.toggled.delete(at);
          this.removing.delete(at);
          if (op.kind === 'insert' || op.kind === 'delete') continue;
          this.adding.delete(`${file.path}:${op.line.index}`);
          const letters =
            op.kind === 'set'
              ? [...op.values.keys()]
              : op.line.params.map((prm) => prm.letter);
          for (const letter of letters) this.applied.delete(editKey(file.path, op.line, letter));
        }
        for (const op of edits) {
          if (op.kind !== 'insert') continue;
          const cmd = /^([GM]\d+(?:\.\d+)?)/.exec(op.text.trim())?.[1];
          if (cmd) this.newCommands.delete(cmd.toUpperCase());
        }
      }
    } catch (err) {
      this.saveError = (err as Error).message;
    } finally {
      this.saving = false;
      // Re-read either way. On success the file has changed underneath the
      // parsed copy; on failure the most useful thing to show is what the file
      // says now, which is how a refusal gets explained.
      await this.reload(true);
    }
  }

  /**
   * Read config.g and everything it runs.
   *
   * Called both by the Re-read button and by every machine update, so it has to
   * be the thing that decides whether there is anything to do. Without `force`
   * it reads once and then leaves it alone: re-downloading the whole
   * configuration on each model poll would be pointless traffic, and retrying a
   * read that just failed would replace the error and its Try again button with
   * a flicker.
   */
  private async reload(force = false): Promise<void> {
    const driver = activeDriver();
    if (!driver || this.loading) return;
    if (!force && (this.loaded || this.error)) return;
    this.loading = true;
    this.error = null;
    this.requestUpdate();
    try {
      this.loaded = await loadConfig(driver);
      this.forgetChangedFiles();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
      this.requestUpdate();
    }
  }

  /**
   * Drop what this panel was tracking in any file whose text has changed.
   *
   * Both maps are keyed by file and line number, and a line number stops
   * meaning the same thing the moment somebody inserts a line above it. Keeping
   * the entries would put an "applied, not saved" badge on a line that never
   * had one, and — much worse — offer to save a value into it. Whole file at a
   * time rather than line by line, because a shifted line still matches itself
   * and there is no way to tell the two apart from here.
   */
  private forgetChangedFiles(): void {
    const now = new Map<string, string>();
    for (const file of this.loaded?.files ?? []) {
      now.set(file.path, file.lines.map((l) => l.raw).join('\n'));
    }
    for (const [path, was] of this.signatures) {
      if (now.get(path) === was) continue;
      for (const key of [...this.edits.keys()]) {
        if (key.startsWith(`${path}:`)) this.edits.delete(key);
      }
      for (const key of [...this.applied.keys()]) {
        if (key.startsWith(`${path}:`)) this.applied.delete(key);
      }
    }
    this.signatures = now;
  }

  private get findings(): Finding[] {
    const axes = machine.get().axes.map((a) => a.letter);
    return this.loaded ? checkConfig(this.loaded.files, this.index, axes) : [];
  }

  /** Findings against one line, so they can be shown where the problem is. */
  private findingsFor(path: string, line: ConfigLine): Finding[] {
    return this.findings.filter((f) => f.path === path && f.line.index === line.index);
  }

  private renderLive(values: LiveValue[], command: string): TemplateResult | typeof nothing {
    if (!values.length) return nothing;
    const spec = describe(command);
    const off = values.filter((v) => !v.agrees);
    if (!off.length) {
      return html`<span class="cfg-live ok" title=${`The machine reports the same ${spec?.label ?? 'value'}`}
        >in force</span
      >`;
    }
    return html`<span
      class="cfg-live bad"
      title="The file and the machine disagree. Something has changed this since boot, or a later line, config-override.g or a conditional has replaced it."
      >machine says ${off.map((v) => `${v.letter}${v.machine}`).join(' ')}</span
    >`;
  }

  /** Whether this exact line's values may be edited and sent. */
  private canEdit(line: ConfigLine): boolean {
    return editable(line, ConfigPanel.EDITABLE) && liveAppliable(line.command);
  }

  private renderParam(
    path: string,
    line: ConfigLine,
    p: { letter: string; text: string; value: number | null },
    entry: { params: Array<{ letter: string; text: string }> } | undefined,
  ): TemplateResult {
    const help = paramHelp(entry, p.letter);
    // A parameter with no number — a pin name, a driver list — is shown as it
    // is written even on an editable line. There is nothing to nudge.
    if (!this.canEdit(line) || p.value === null) {
      return html`<code class="cfg-param" title=${help}>${p.letter}<em>${p.text}</em></code>`;
    }
    const key = editKey(path, line, p.letter);
    const pending = this.edits.get(key);
    const applied = this.applied.get(key);
    const shown = pending ?? applied?.value ?? p.text;
    return html`<code
      class="cfg-param edit ${pending !== undefined ? 'pending' : applied !== undefined ? 'applied' : ''}"
      title=${help}
      >${p.letter}<input
        type="number"
        step="any"
        style=${`width:${Math.min(12, Math.max(5, shown.length + 1.5))}ch`}
        .value=${shown}
        @wheel=${(e: WheelEvent) => {
          // A wheel over a focused number input changes it. Scrolling down a
          // config panel should not retune the machine on the way past.
          (e.target as HTMLInputElement).blur();
        }}
        @change=${(e: Event) => {
          const raw = (e.target as HTMLInputElement).value.trim();
          if (raw === '' || raw === p.text) this.edits.delete(key);
          else this.edits.set(key, raw);
          this.applyError = null;
          this.requestUpdate();
        }}
      /></code>`;
  }

  private renderLine(path: string, line: ConfigLine): TemplateResult | typeof nothing {
    const isCommand = line.kind === 'command' || line.kind === 'disabled';
    if (!isCommand && !this.verbose) return nothing;

    const entry = line.command ? this.index?.codes.find((c) => c.code === line.command) : undefined;
    const found = this.findingsFor(path, line);
    const live = line.kind === 'command' && comparable(line.command)
      ? compareLine(line, machine.get().axes)
      : [];

    return html`
      <div class="cfg-line ${line.kind} ${found.length ? 'flagged' : ''}">
        <span class="cfg-num">${line.index + 1}</span>
        <div class="cfg-body">
          <div class="cfg-code">
            ${line.command
              ? html`<code class="cfg-cmd" title=${entry?.title ?? ''}>${line.command}</code>`
              : nothing}
            ${line.params.map((p) => this.renderParam(path, line, p, entry))}
            ${!line.command ? html`<span class="cfg-raw">${line.raw.trim()}</span>` : nothing}
            ${line.kind === 'command' ? this.renderLive(live, line.command ?? '') : nothing}
            ${line.kind === 'disabled'
              ? html`<span class="cfg-off" title="Commented out — it does not run">off</span>`
              : nothing}
            ${line.expression
              ? html`<span class="cfg-off" title="This line computes its value, so it cannot be read as a number">expression</span>`
              : nothing}
            ${line.depth > 0
              ? html`<span class="cfg-off" title="Inside an if or while, so it may not run at all">conditional</span>`
              : nothing}
            ${this.lineState(path, line)}
            ${this.renderAdd(path, line)}
            ${this.renderOps(path, line)}
          </div>
          ${entry ? html`<div class="cfg-title">${entry.title}</div>` : nothing}
          ${line.comment && line.kind === 'command'
            ? html`<div class="cfg-comment">${line.comment}</div>`
            : nothing}
          ${this.renderDraft(path, line)}
          ${found.map(
            (f) => html`<div class="cfg-finding ${f.severity}">
              ${f.message}
              ${f.other
                ? html`<button
                    class="link"
                    @click=${() => this.jump(f.other!.path, f.other!.line.index)}
                  >
                    see line ${f.other.line.index + 1}
                  </button>`
                : nothing}
            </div>`,
          )}
        </div>
      </div>
    `;
  }

  /**
   * What has been done to this line, if anything.
   *
   * "applied" matters more than it looks: it is the difference between a value
   * the machine is running because somebody chose it on this screen, and one
   * that disagrees with the file for a reason nobody has explained. Without it
   * the live badge beside it would read as a fault.
   */
  private lineState(path: string, line: ConfigLine): TemplateResult | typeof nothing {
    const keys = line.params.map((p) => editKey(path, line, p.letter));
    if (keys.some((k) => this.edits.has(k))) {
      return html`<span class="cfg-state pending" title="Typed here, not sent yet">edited</span>`;
    }
    if (keys.some((k) => this.applied.has(k))) {
      return html`<span class="cfg-state applied" title="Sent to the machine and running now. Not saved — a restart forgets it."
        >applied, not saved</span
      >`;
    }
    return nothing;
  }

  /**
   * The offer to write down an axis this line says nothing about.
   *
   * Only ever an offer, and only for a value the machine is already running.
   * A file that sets X, Y and Z on a machine that has since grown a U axis is
   * not wrong so much as out of date, and the number to put there is not a
   * guess — it is what U is doing right now.
   */
  private renderAdd(path: string, line: ConfigLine): TemplateResult | typeof nothing {
    if (!this.canEdit(line)) return nothing;
    const key = `${path}:${line.index}`;
    const queued = this.adding.get(key);
    if (queued?.length) {
      return html`<button
        class="cfg-state pending"
        title="Written into the line when you save. Click to drop it."
        @click=${() => {
          this.adding.delete(key);
          this.requestUpdate();
        }}
      >
        adding ${queued.map((a) => a.letter + a.text).join(' ')}
      </button>`;
    }
    const gaps = missingAxes(line, this.axes);
    if (!gaps.length) return nothing;
    return html`<button
      class="cfg-add"
      title=${`This line says nothing about ${gaps.map((g) => g.letter).join(', ')}. The machine is running ${gaps
        .map((g) => g.letter + g.text)
        .join(' ')} — put that on the end of the line.`}
      @click=${() => {
        this.adding.set(key, gaps);
        this.requestUpdate();
      }}
    >
      + ${gaps.map((g) => g.letter).join(' ')}
    </button>`;
  }

  /**
   * Settings this configuration never makes at all.
   *
   * Each one is offered with the exact line that would be written and the
   * position it would go in, both visible before anything is agreed to. Where
   * the checker objects to the placement, the objection is shown in place of
   * the button: a line this cannot put somewhere defensible is one to add by
   * hand, and saying so is more use than putting it somewhere and hoping.
   */
  private renderMissing(): TemplateResult | typeof nothing {
    const missing = this.missing();
    if (!missing.length) return nothing;
    return html`
      <div class="cfg-missing">
        <strong>Never set in this configuration</strong>
        <div class="cfg-missing-note">
          The machine is running a value for each of these, set by a default or at the console. A
          restart takes them back to whatever RRF starts with.
        </div>
        ${missing.map((cmd) => {
          const planned = this.plan(cmd);
          const label = describe(cmd)?.label ?? cmd;
          const queued = this.newCommands.has(cmd);
          return html`<div class="cfg-missing-row">
            <code class="cfg-cmd">${cmd}</code>
            <span class="cfg-missing-label">${label}</span>
            ${'refused' in planned
              ? html`<span class="cfg-missing-no">${planned.refused}</span>`
              : planned.problems.length
                ? html`<span class="cfg-missing-no">
                    Not offered — putting it there would mean: ${planned.problems.join('; ')}
                  </span>`
                : queued
                  ? html`<span class="cfg-state pending">to be added ${planned.because}</span>
                      <button
                        class="tiny ghost"
                        @click=${() => {
                          this.newCommands.delete(cmd);
                          this.requestUpdate();
                        }}
                      >
                        Undo
                      </button>`
                  : html`<code class="cfg-new">${planned.op.text.trim()}</code>
                      <button
                        class="tiny"
                        title=${`Write it ${planned.because}`}
                        @click=${() => {
                          this.newCommands.add(cmd);
                          this.requestUpdate();
                        }}
                      >
                        Add
                      </button>`}
          </div>`;
        })}
      </div>
    `;
  }

  /**
   * Per-line actions: add a line under this one, comment it out, remove it.
   *
   * Quiet until the line is hovered or one of them is pending. A configuration
   * is read far more often than it is changed, and a row of controls on every
   * line of a file being read is noise — worse, it invites pressing one.
   */
  private renderOps(path: string, line: ConfigLine): TemplateResult | typeof nothing {
    if (line.kind === 'note' && !line.raw.trim()) return nothing;
    const key = `${path}:${line.index}`;
    if (this.removing.has(key)) {
      return html`<button class="cfg-state pending" title="Undo" @click=${() => {
        this.removing.delete(key);
        this.requestUpdate();
      }}>to be removed</button>`;
    }
    if (this.toggled.has(key)) {
      return html`<button class="cfg-state pending" title="Undo" @click=${() => {
        this.toggled.delete(key);
        this.requestUpdate();
      }}>
        ${line.kind === 'disabled' ? 'to be brought back' : 'to be commented out'}
      </button>`;
    }
    const live = line.kind === 'command';
    return html`<span class="cfg-ops">
      <button class="cfg-op" title="Add a line after this one" @click=${() => {
        this.inserting = this.inserting === key ? null : key;
        this.draft = '';
        this.requestUpdate();
      }}>+</button>
      ${line.kind === 'command' || line.kind === 'disabled'
        ? html`<button
            class="cfg-op"
            title=${live
              ? 'Comment it out — it stays in the file and stops running'
              : 'Bring it back — it starts running again at the next restart'}
            @click=${() => {
              this.toggled.add(key);
              this.requestUpdate();
            }}
          >
            ${live ? ';' : '↺'}
          </button>`
        : nothing}
      <button class="cfg-op bad" title="Remove the line from the file" @click=${() => {
        this.removing.add(key);
        this.requestUpdate();
      }}>✕</button>
    </span>`;
  }

  /**
   * The box for a line typed by hand, and what the checker makes of it.
   *
   * Validated on every keystroke against the position it would actually go in,
   * and refused rather than warned about: the whole argument for letting anyone
   * type anything here is that the result is checked as hard as the rest of the
   * file already is.
   */
  private renderDraft(path: string, line: ConfigLine): TemplateResult | typeof nothing {
    const key = `${path}:${line.index}`;
    const queued = this.inserts.get(key);
    if (queued !== undefined && this.inserting !== key) {
      return html`<div class="cfg-draft queued">
        <span class="cfg-state pending">to be added below</span>
        <code class="cfg-new">${queued}</code>
        <button class="tiny ghost" @click=${() => {
          this.inserts.delete(key);
          this.requestUpdate();
        }}>Undo</button>
      </div>`;
    }
    if (this.inserting !== key) return nothing;
    const problems = this.checkDraft(path, line, this.draft);
    const usable = this.draft.trim().length > 0 && problems.length === 0;
    return html`<div class="cfg-draft">
      <input
        class="cfg-draft-input"
        placeholder=${`A line to run after line ${line.index + 1}`}
        .value=${this.draft}
        @input=${(e: Event) => {
          this.draft = (e.target as HTMLInputElement).value;
          this.requestUpdate();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            this.inserting = null;
            this.requestUpdate();
          }
          if (e.key === 'Enter' && usable) {
            this.inserts.set(key, this.draft.trim());
            this.inserting = null;
            this.requestUpdate();
          }
        }}
      />
      <button class="tiny primary" ?disabled=${!usable} @click=${() => {
        this.inserts.set(key, this.draft.trim());
        this.inserting = null;
        this.requestUpdate();
      }}>Add</button>
      <button class="tiny ghost" @click=${() => {
        this.inserting = null;
        this.requestUpdate();
      }}>Cancel</button>
      ${problems.map((t) => html`<div class="cfg-missing-no">${t}</div>`)}
    </div>`;
  }

  /**
   * What is wrong with a line somebody has typed, before it goes anywhere.
   *
   * This is what makes a free-text insert defensible. The text is parsed by the
   * same parser, put into the file at the exact position it would occupy, and
   * run through the same checker — so it is judged by the rules that already
   * describe this configuration rather than by anything written for this box.
   * An empty answer means the checker has no objection to it there.
   */
  private checkDraft(path: string, after: ConfigLine, text: string): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const files = this.loaded?.files ?? [];
    const parsed = parseConfig(path, trimmed).lines[0];
    const problems: string[] = [];
    if (!parsed) return ['Nothing to add.'];
    if (parsed.kind === 'command' && parsed.command) {
      // A command the reference has never heard of is more often a typo than a
      // command the reference is missing, and RRF answers an unknown code with
      // an error at boot that nobody is watching for.
      if (this.index && !this.index.codes.some((c) => c.code === parsed.command)) {
        problems.push(`${parsed.command} is not in the G-code reference — check the spelling.`);
      }
    } else if (parsed.kind === 'note') {
      // A comment is always safe, and sometimes exactly what is wanted.
      return [];
    }
    problems.push(
      ...findingsAdded(
        files,
        { path, after, text: trimmed, because: '' },
        this.index,
        this.axes.map((a) => a.letter),
      ),
    );
    return problems;
  }

  /** A line's text with its comment marker put on or taken off. */
  private toggledText(line: ConfigLine): string {
    if (line.kind === 'disabled') return line.raw.replace(';', '');
    const at = line.raw.length - line.raw.trimStart().length;
    return `${line.raw.slice(0, at)};${line.raw.slice(at)}`;
  }

  private jump(path: string, index: number): void {
    this.closed.delete(path);
    this.requestUpdate();
    window.setTimeout(() => {
      this.querySelector(`[data-at="${path}:${index}"]`)?.scrollIntoView({ block: 'center' });
    }, 0);
  }

  /**
   * The tuning bar: what is pending, what is running, and the way back.
   *
   * Only appears once there is something to say. A row of disabled buttons at
   * the top of a panel that is usually just being read is noise, and the whole
   * point of this panel is that it is quiet until it has something.
   */
  private renderApplyBar(): TemplateResult | typeof nothing {
    const pending = this.pendingLines();
    const appliedCount = new Set(
      [...this.applied.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))),
    ).size;
    const adds =
      this.adding.size + this.newCommands.size + this.inserts.size +
      this.toggled.size + this.removing.size;
    if (
      !pending.length && !appliedCount && !adds &&
      !this.applyError && !this.saveError && !this.saved.length
    )
      return nothing;

    const cautions = [...new Set(pending.map((p) => caution(p.line.command)).filter(Boolean))];
    const blocked = blockedBy(machine.get().status);
    const saveFiles = [
      ...new Set([...this.settled().map((g) => g.file.path), ...pending.map((p) => p.path)]),
    ];

    return html`
      <div class="cfg-apply">
        <div class="cfg-apply-row">
          ${pending.length
            ? html`<strong>${pending.length} line${pending.length === 1 ? '' : 's'} edited</strong>`
            : nothing}
          ${appliedCount
            ? html`<span class="cfg-state applied">${appliedCount} running, not saved</span>`
            : nothing}
          <span class="topbar-spacer"></span>
          ${pending.length
            ? html`<button
                class="primary tiny"
                ?disabled=${this.applying || this.saving || blocked !== null}
                title=${blocked ?? 'Send these to the machine now. Nothing is written to /sys.'}
                @click=${() => void this.applyEdits()}
              >
                ${this.applying ? 'Sending…' : 'Try on the machine'}
              </button>`
            : nothing}
          <!-- Offered whenever there is anything to save, whether it has been
               tried yet or not. Gating this on having applied first meant the
               button did not exist until somebody had guessed that it would
               appear, which is not a discoverable way to save a file. -->
          ${adds
            ? html`<span class="cfg-state pending"
                >${adds} line${adds === 1 ? '' : 's'} to write</span
              >`
            : nothing}
          ${pending.length || appliedCount || adds
            ? html`<button
                class=${(appliedCount || adds) && !pending.length ? 'primary tiny' : 'tiny'}
                ?disabled=${this.saving || this.applying || blocked !== null}
                title=${blocked ??
                `Write ${saveFiles.join(', ')}${
                  pending.length ? ', after sending the edited lines to the machine' : ''
                } — only the edited values change, and the previous contents are kept alongside.`}
                @click=${() => void this.saveSettled()}
              >
                ${this.saving ? 'Saving…' : 'Save to the file'}
              </button>`
            : nothing}
          ${pending.length
            ? html`<button
                class="tiny ghost"
                ?disabled=${this.applying || this.saving}
                @click=${() => {
                  this.edits.clear();
                  this.requestUpdate();
                }}
              >
                Discard
              </button>`
            : nothing}
          ${appliedCount && !pending.length
            ? html`<button
                class="tiny"
                ?disabled=${this.applying || this.saving}
                title="Send the values as the file has them, undoing what was tried here"
                @click=${() => void this.revertAll()}
              >
                Back to the file
              </button>`
            : nothing}
        </div>
        ${blocked ? html`<div class="cfg-apply-note bad">${blocked}</div>` : nothing}
        ${this.applyError ? html`<div class="cfg-apply-note bad">${this.applyError}</div>` : nothing}
        ${this.saveError ? html`<div class="cfg-apply-note bad">${this.saveError}</div>` : nothing}
        ${cautions.map((c) => html`<div class="cfg-apply-note">${c}</div>`)}
        ${this.saved.map(
          (r) => html`<div class="cfg-apply-note ok">
            Saved ${r.path}${describeSave(r)}.
            ${r.backup ? html`Previous contents kept in <code>${r.backup}</code>.` : nothing}
          </div>`,
        )}
        ${pending.length || appliedCount || adds
          ? html`<div class="cfg-apply-note">
              Saving changes only the numbers you edited. Everything else on the line — the
              comment, the spacing, the other axes — is left exactly as it is, and the file as it
              was is kept alongside.
            </div>`
          : nothing}
        ${appliedCount
          ? html`<div class="cfg-apply-note">
              Running in the firmware only. A restart forgets all of it until it is saved.
            </div>`
          : nothing}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!connected.get()) return empty('Not connected');
    if (this.error) {
      return html`<div class="pack cfg">
        <div class="warn-banner bad">${this.error}</div>
        <div class="pack-actions"><button @click=${() => void this.reload(true)}>Try again</button></div>
      </div>`;
    }
    if (this.loading) return empty('Reading /sys/config.g…');
    // Connected, not loading, nothing read: the read should already have
    // happened, so this is a state nobody should see. It gets a button rather
    // than a sentence anyway — an empty panel with no way to act on it was
    // exactly what made the bug above look like the panel simply not working.
    if (!this.loaded) {
      return html`<div class="pack cfg">
        <div class="pack-actions">
          <button @click=${() => void this.reload(true)}>Read /sys/config.g</button>
        </div>
      </div>`;
    }

    const findings = this.findings;
    const counts = {
      conflict: findings.filter((f) => f.severity === 'conflict').length,
      order: findings.filter((f) => f.severity === 'order').length,
      unknown: findings.filter((f) => f.severity === 'unknown').length,
    };

    return html`
      <div class="pack cfg">
        <div class="cfg-bar">
          <button class="tiny" ?disabled=${this.loading} @click=${() => void this.reload(true)}>
            ${this.loading ? 'Reading…' : 'Re-read'}
          </button>
          <label class="cfg-toggle">
            <input
              type="checkbox"
              .checked=${this.verbose}
              @change=${(e: Event) => {
                this.verbose = (e.target as HTMLInputElement).checked;
                this.requestUpdate();
              }}
            />
            <span>All lines</span>
          </label>
          <span class="cfg-count">
            ${this.loaded.files.length} files ·
            ${this.loaded.files.reduce(
              (n, f) => n + f.lines.filter((l) => l.kind === 'command').length,
              0,
            )}
            commands
          </span>
        </div>

        ${this.renderApplyBar()}

        ${findings.length
          ? html`<div class="cfg-summary">
              <strong>${findings.length}</strong> thing${findings.length === 1 ? '' : 's'} worth a
              look:
              ${counts.conflict ? html`<span class="cfg-chip conflict">${counts.conflict} overwritten</span>` : nothing}
              ${counts.order ? html`<span class="cfg-chip order">${counts.order} out of order</span>` : nothing}
              ${counts.unknown ? html`<span class="cfg-chip unknown">${counts.unknown} unrecognised</span>` : nothing}
            </div>`
          : html`<div class="cfg-summary ok">Nothing looks contradictory.</div>`}

        ${this.loaded.missing.map(
          (m) => html`<div class="warn-banner">
            ${m.path} is run by an M98 but could not be read — ${m.reason}
          </div>`,
        )}

        <div class="cfg-files">
          ${this.loaded.files.map((file) => {
            const open = !this.closed.has(file.path);
            const flagged = findings.filter((f) => f.path === file.path).length;
            return html`
              <section class="cfg-file">
                <button
                  class="cfg-file-head"
                  @click=${() => {
                    if (open) this.closed.add(file.path);
                    else this.closed.delete(file.path);
                    this.requestUpdate();
                  }}
                >
                  <span class="cfg-caret">${open ? '▾' : '▸'}</span>
                  <strong>${file.path}</strong>
                  <em>${file.lines.filter((l) => l.kind === 'command').length} commands</em>
                  ${flagged ? html`<span class="cfg-chip conflict">${flagged}</span>` : nothing}
                </button>
                ${open
                  ? html`<div class="cfg-lines">
                      ${file.lines.map(
                        (line) => html`<div data-at=${`${file.path}:${line.index}`}>
                          ${this.renderLine(file.path, line)}
                        </div>`,
                      )}
                    </div>`
                  : nothing}
              </section>
            `;
          })}
        </div>

        ${this.renderMissing()}

        <div class="param-note cfg-note">
          Editing a value sends it to the machine and nothing more — a restart forgets it. Once a
          number is one worth keeping, saving writes it back into the line it came from, changing
          those characters and nothing else, after keeping a copy of the file as it was.
        </div>
      </div>
    `;
  }
}

/** The documented meaning of one parameter of one command. */
function paramHelp(entry: { params: Array<{ letter: string; text: string }> } | undefined, letter: string): string {
  if (!entry) return '';
  const p = entry.params.find((x) => x.letter.toUpperCase().startsWith(letter));
  return p ? `${p.letter} — ${p.text}` : '';
}

/**
 * What a save did, in words: "— line 3 changed, line 5 added, line 6 removed".
 *
 * Every number here is a line an operator can go and look at, which is the
 * point. "Saved config-axes.g" on its own is a claim; this is a receipt.
 */
function describeSave(r: SaveReport): string {
  const plural = (n: number) => (n === 1 ? 'line' : 'lines');
  const parts: string[] = [];
  if (r.lines.length) parts.push(`${plural(r.lines.length)} ${r.lines.join(', ')} changed`);
  if (r.added.length) parts.push(`${plural(r.added.length)} ${r.added.join(', ')} added`);
  // Removals get a count and no numbers. Changed and added lines can be gone
  // and looked at; a removed one has no number any more, and the number it had
  // is in the old file's numbering — printing both next to each other produced
  // "line 5 added, line 5 removed", which is two true statements that read as
  // one contradiction.
  if (r.removed.length) parts.push(`${r.removed.length} ${plural(r.removed.length)} removed`);
  return parts.length ? ` — ${parts.join(', ')}` : '';
}

/** The line an op is anchored to, by index. */
function anchorIndex(op: FileOp): number {
  return op.kind === 'insert' ? op.after.index : op.line.index;
}

customElements.define('cnc-config', ConfigPanel);

registerPanel({
  id: 'config',
  title: 'Configuration',
  tag: 'cnc-config',
  defaultWidth: 6,
  defaultHeight: 560,
  available: (caps) => caps.files,
  description: 'Read config.g and everything it runs, with the reference and what is actually in force',
});
