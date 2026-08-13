// Preview / save / run pipeline shared by the probing and machining panels.
//
// Both packs produce a GeneratedProgram, and both want the same three things:
// look at it in the viewer before committing, write it to the controller, and
// run it. Keeping that in one place means a new operation is a generator plus a
// form, with no execution logic of its own.

import { html, type TemplateResult } from 'lit';
import { signal } from '../core/signal.js';
import {
  actions,
  activeDriver,
  appendLog,
  capabilities,
  loadSetting,
  run,
  saveSetting,
} from '../core/store.js';
import type { GeneratedProgram } from '../cam/format.js';

/** Set by a panel to ask the viewer to render a generated program. */
export const previewProgram = signal<{ name: string; gcode: string } | null>(null);

/** Byte offset chosen for run-from-line, set by clicking the toolpath. */
export const resumePoint = signal<{ offset: number; point: [number, number, number] } | null>(null);

/**
 * Whatever the viewer currently has parsed, published so other panels can work
 * on the same thing the operator is looking at. `controllerPath` is null for a
 * generated program that has not been written to the machine yet, which is what
 * tells preflight there is nothing to start.
 */
export const loadedProgram = signal<{
  name: string;
  controllerPath: string | null;
  path: import('../viewer/parse.js').ParsedToolpath;
} | null>(null);

export function preview(program: GeneratedProgram): void {
  previewProgram.set({ name: program.name, gcode: program.gcode });
  appendLog({ level: 'info', text: `Previewing ${program.name}`, time: new Date() });
}

/** Where a generated program belongs, by kind. */
function targetDir(program: GeneratedProgram): string {
  const caps = capabilities.peek();
  return program.name.endsWith('.g')
    ? `${caps.macroRoot ?? '/macros'}/generated`
    : `${caps.gcodeRoot ?? '/gcodes'}/generated`;
}

/** Write the program to the controller. Returns its full path, or null. */
export async function save(program: GeneratedProgram): Promise<string | null> {
  const driver = activeDriver();
  if (!driver) {
    appendLog({ level: 'error', text: 'Not connected', time: new Date() });
    return null;
  }

  const dir = targetDir(program);
  const path = `${dir}/${program.name}`;

  // The folder may not exist yet; a failure here is not fatal on its own, so
  // let the upload be the thing that actually reports a problem.
  try {
    await driver.makeDirectory(dir);
  } catch {
    /* already exists, or the controller doesn't need it */
  }

  const ok = await run(`save ${program.name}`, async (d) => {
    await d.writeFile(path, new TextEncoder().encode(program.gcode));
    return true;
  });
  if (!ok) return null;

  appendLog({ level: 'info', text: `Saved ${path}`, time: new Date() });
  return path;
}

/**
 * Save and run. Probe macros go through the macro path so they run inline;
 * machining programs start as a job so they get proper progress and pause.
 */
export async function saveAndRun(program: GeneratedProgram): Promise<void> {
  const isMacro = program.name.endsWith('.g');
  const detail = [program.summary, ...program.warnings].join('\n\n');
  if (!confirm(`${isMacro ? 'Run' : 'Start job'}:\n\n${detail}\n\nProceed?`)) return;

  const path = await save(program);
  if (!path) return;

  if (isMacro) await actions.runMacro(path);
  else await actions.startJob(path);
}

/**
 * "Update the preview as I type", for the panels that generate a program.
 *
 * Off by default and remembered per panel. Previewing replaces whatever is in
 * the toolpath viewer, so a panel that took it over the moment it was opened
 * would be rude to anyone who had a job loaded — but once somebody has asked
 * for it, they have asked for it, and being asked again every session is the
 * kind of thing that makes a checkbox not worth ticking.
 */
export class AutoPreview {
  private timer = 0;
  /** The G-code last sent to the viewer, so identical output is not re-sent. */
  private last = '';

  constructor(private readonly key: string) {}

  get on(): boolean {
    return loadSetting(`autoPreview.${this.key}`, false);
  }

  set on(value: boolean) {
    saveSetting(`autoPreview.${this.key}`, value);
    if (!value) this.last = '';
  }

  /**
   * Preview the program if it has changed, a moment after the last change.
   *
   * Safe to call from a panel's `updated()` — that is, after every render,
   * including the renders caused by the machine's position arriving four times
   * a second. Two things make that cheap enough: the debounce collapses a burst
   * of keystrokes into one, and the G-code is compared against what was last
   * previewed, so a render that changed nothing about the program sends
   * nothing. Wiring this into each panel's individual input handlers instead
   * would mean finding all of them, and missing one is a preview that silently
   * stops matching what is on screen.
   */
  schedule(build: () => GeneratedProgram | null): void {
    if (!this.on) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      let program: GeneratedProgram | null = null;
      try {
        program = build();
      } catch {
        // A half-typed number is not worth a console entry. The panel is
        // already showing whatever it thinks of the input.
        return;
      }
      if (!program || program.gcode === this.last) return;
      this.last = program.gcode;
      previewProgram.set({ name: program.name, gcode: program.gcode });
    }, 300);
  }

  /** The checkbox itself, so all four panels offer the same one. */
  field(onToggle: () => void): TemplateResult {
    return html`<label class="auto-preview" title="Redraw the toolpath viewer as these settings change">
      <input
        type="checkbox"
        .checked=${this.on}
        @change=${(e: Event) => {
          this.on = (e.target as HTMLInputElement).checked;
          onToggle();
        }}
      />
      <span>Live preview</span>
    </label>`;
  }
}
