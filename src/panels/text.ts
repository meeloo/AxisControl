// Engraving text, without going out to CAM for a label.
//
// The job this exists for is small and constant: a name on a fixture, a scale
// beside a slot, "MAX 24V" under a socket. Doing that through CAD and CAM is
// twenty minutes for something that ought to be thirty seconds, so it lives
// here.
//
// Three ways of cutting a letter, because a letter is three different shapes
// depending on what you have in the spindle:
//
//   Single stroke  — the toolpath IS the letter. A Hershey glyph is already a
//                    list of pen moves (src/text/hershey.ts), and a single-line
//                    font file is the same idea in a font file. Nothing to
//                    offset, nothing to fill.
//   Outline        — an ordinary font describes the boundary of the ink, so the
//                    boundary is what gets cut. Useful for cutting letters out
//                    of material, less so for labelling.
//   V-carve        — the boundary again, but cut with a V-bit that goes deeper
//                    where the letter is wider (src/cam/vcarve.ts). This is
//                    what makes an outline font look engraved rather than
//                    outlined, and it is the reason to bother with font files
//                    at all.
//
// The mode is offered by what the font can do rather than as a free choice. A
// single-stroke font has no inside to carve, and offering V-carve for one would
// be offering a mode that produces nothing.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { connected, machine } from '../core/store.js';
import { empty, numberField, selectField, textField } from '../ui/widgets.js';
import { AutoPreview, preview, saveAndRun } from '../ui/program.js';
import { Gcode, depthLevels, n, type GeneratedProgram } from '../cam/format.js';
import { faces, textToPolylines } from '../text/hershey.js';
import { parseFont, type ParsedFont } from '../text/outline.js';
import {
  fontsDir,
  listFonts,
  loadFont,
  removeFont,
  setFontValidator,
  storeFont,
  type StoredFont,
} from '../text/fontstore.js';
import { offsetPaths, orderForCut, orientForCut, type CutSide } from '../import/offset.js';
import { profile } from '../cam/profile.js';
import { vcarve } from '../cam/vcarve.js';
import type { Polyline } from '../import/types.js';

// Nothing unparseable reaches the SD card. Registered here rather than at the
// call site because fontstore is deliberately ignorant of what a font is, and a
// validator passed per call is only as good as the least careful caller.
setFontValidator((id, data) => {
  parseFont(id, data);
});

type Mode = 'stroke' | 'outline' | 'vcarve';

/**
 * Font ids carry where the font came from.
 *
 * `hershey:futural` and `file:/fonts/Roboto.ttf` cannot collide, and the prefix
 * is what decides which of the two layout engines runs. Bare ids would have
 * worked until the first person stored a font called `futural.ttf`.
 */
const HERSHEY = 'hershey:';
const FILE = 'file:';

interface Settings {
  text: string;
  font: string;
  size: number;
  rotation: number;
  tracking: number;
  align: 'left' | 'centre' | 'right';
  mode: Mode;

  // Stroke and outline
  depth: number;
  perPass: number;
  feed: number;
  plunge: number;
  safeZ: number;

  // Outline only
  side: CutSide;
  toolDiameter: number;
  rpm: number;
  spindleDwell: number;

  // V-carve only
  vAngle: number;
  tipWidth: number;
  vMaxDepth: number;
  vStepover: number;
}

export class TextPanel extends PanelElement {
  private s: Settings = {
    text: 'AXIS',
    font: HERSHEY + faces()[0]!.id,
    size: 10,
    rotation: 0,
    tracking: 0,
    align: 'left',
    mode: 'stroke',

    depth: 0.4,
    perPass: 0.4,
    feed: 600,
    plunge: 200,
    safeZ: 5,

    side: 'on',
    toolDiameter: 1,
    rpm: 18000,
    spindleDwell: 3,

    vAngle: 90,
    tipWidth: 0,
    vMaxDepth: 3,
    vStepover: 0.3,
  };

  private auto = new AutoPreview('text');

  /** Fonts on the controller. Null until the first listing has been asked for. */
  private stored: StoredFont[] | null = null;
  /** Parsed fonts, by path. Parsing a 400KB font is not something to redo per render. */
  private parsed = new Map<string, ParsedFont>();
  /** Paths currently being fetched, so a slow controller does not start twice. */
  private loading = new Set<string>();
  private fontError: string | null = null;
  private busy = false;
  private manage = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      // The font list lives on the controller, so it can only be read once
      // there is one. Reading on the signal rather than once at mount is what
      // makes the panel survive being opened before the app has connected.
      const live = connected.get();
      machine.get();
      if (live && this.stored === null) void this.refreshFonts();
    });
  }

  protected override updated(): void {
    this.auto.schedule(() => this.build());
  }

  private set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.s[key] = value;
    this.requestUpdate();
  }

  // --- Fonts ----------------------------------------------------------------

  private async refreshFonts(force = false): Promise<void> {
    this.busy = true;
    this.requestUpdate();
    try {
      this.stored = await listFonts(force);
    } catch (err) {
      this.fontError = (err as Error).message;
      this.stored = [];
    }
    this.busy = false;
    this.requestUpdate();
  }

  /**
   * The chosen font, parsed, or null while it is still coming off the card.
   *
   * Deliberately not async: render has to be synchronous, so the first call for
   * a font starts the fetch and returns null, and the render that follows the
   * fetch has it. A panel showing "loading" for a moment is the honest version
   * of that; awaiting inside render is not available.
   */
  private font(): ParsedFont | null {
    if (!this.s.font.startsWith(FILE)) return null;
    const path = this.s.font.slice(FILE.length);
    const have = this.parsed.get(path);
    if (have) return have;
    if (!this.loading.has(path)) {
      this.loading.add(path);
      void loadFont(path)
        .then((data) => {
          this.parsed.set(path, parseFont(path, data));
          this.fontError = null;
        })
        .catch((err: Error) => {
          this.fontError = err.message;
        })
        .finally(() => {
          this.loading.delete(path);
          this.requestUpdate();
        });
    }
    return null;
  }

  private async upload(file: File): Promise<void> {
    this.busy = true;
    this.requestUpdate();
    const stored = await storeFont(file);
    this.busy = false;
    if (stored) {
      await this.refreshFonts(true);
      // Selected straight away: somebody who has just uploaded a font wants to
      // type in it, and making them find it in the list again is a step that
      // exists only because the code was easier to write that way.
      this.set('font', FILE + stored.path);
    } else {
      // storeFont has already said why, in the console, in words.
      this.requestUpdate();
    }
  }

  private async deleteFont(font: StoredFont): Promise<void> {
    if (!confirm(`Delete ${font.name} from ${fontsDir()}?`)) return;
    if (!(await removeFont(font.path))) return;
    this.parsed.delete(font.path);
    if (this.s.font === FILE + font.path) this.s.font = HERSHEY + faces()[0]!.id;
    await this.refreshFonts(true);
  }

  /** Whether the chosen font draws strokes rather than outlines. */
  private get isStroke(): boolean {
    if (this.s.font.startsWith(HERSHEY)) return true;
    return this.font()?.info.singleLine ?? true;
  }

  /** The modes this font can actually do. */
  private get modes(): Mode[] {
    return this.isStroke ? ['stroke'] : ['outline', 'vcarve'];
  }

  /** The mode in force, which is not always the one that was chosen. */
  private get mode(): Mode {
    const allowed = this.modes;
    return allowed.includes(this.s.mode) ? this.s.mode : allowed[0]!;
  }

  // --- Geometry -------------------------------------------------------------

  /**
   * The laid-out text, in the one shape everything downstream understands.
   *
   * hershey.ts returns bare point arrays and outline.ts returns import/types
   * Polylines, because each is the natural form for what it does. They are
   * converged here rather than in either of them: the importer's Polyline is
   * the form the offsetter, the profiler and the V-carver all take, so it is
   * the one that has to survive.
   */
  private get geometry(): Polyline[] {
    const common = {
      size: this.s.size,
      rotation: this.s.rotation,
      tracking: this.s.tracking,
      align: this.s.align,
    };
    if (this.s.font.startsWith(HERSHEY)) {
      return textToPolylines(this.s.text, {
        ...common,
        face: this.s.font.slice(HERSHEY.length),
      }).map((stroke) => ({
        points: stroke.map((p) => [p.x, p.y] as [number, number]),
        closed: false,
      }));
    }
    return this.font()?.layout(this.s.text, common) ?? [];
  }

  private bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const path of this.geometry) {
      for (const [x, y] of path.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  // --- Programs -------------------------------------------------------------

  private build(): GeneratedProgram | null {
    const geometry = this.geometry;
    if (!geometry.length) return null;
    switch (this.mode) {
      case 'stroke':
        return this.buildStroke(geometry);
      case 'outline':
        return this.buildOutline(geometry);
      case 'vcarve':
        return this.buildVcarve(geometry);
    }
  }

  private get fontName(): string {
    if (this.s.font.startsWith(HERSHEY)) {
      const id = this.s.font.slice(HERSHEY.length);
      return faces().find((f) => f.id === id)?.name ?? id;
    }
    return this.font()?.info.name ?? this.s.font.slice(FILE.length);
  }

  private get jobName(): string {
    return this.s.text.trim().split(/\s+/)[0]?.replace(/[^\w-]/g, '') || 'text';
  }

  /**
   * Single-stroke, in work coordinates with Z0 at the surface.
   *
   * Every pass retraces every stroke rather than finishing each stroke to full
   * depth: an engraving bit is small and the cut is shallow, so the retract and
   * plunge between strokes costs more than the extra travel, and a stroke left
   * at full depth while its neighbour is untouched is where a fine tip snaps.
   */
  private buildStroke(lines: Polyline[]): GeneratedProgram {
    const box = this.bounds()!;

    const g = new Gcode();
    g.header(`Engrave: ${this.s.text.replace(/\n/g, ' / ')}`, [
      `${this.fontName}, ${n(this.s.size)}mm caps, ${n(this.s.depth)}mm deep, single stroke`,
      `X ${n(box.minX)}..${n(box.maxX)}  Y ${n(box.minY)}..${n(box.maxY)} in work coordinates`,
      'Z0 is the surface — set work zero on the top of the material',
    ]);
    g.blank();
    g.rapid({ z: this.s.safeZ });

    for (const z of depthLevels(0, this.s.depth, this.s.perPass)) {
      g.comment(`pass to Z${n(z)}`);
      for (const stroke of lines) {
        const pts = stroke.points;
        g.rapid({ z: this.s.safeZ });
        g.rapid({ x: pts[0]![0], y: pts[0]![1] });
        g.feed({ z, f: this.s.plunge });
        for (const [x, y] of pts.slice(1)) g.feed({ x, y, f: this.s.feed });
        // A single-line font's glyphs are closed rings in the file even when
        // they draw as strokes, so the closing edge has to be cut too or the
        // last segment of every letter is missing.
        if (stroke.closed) g.feed({ x: pts[0]![0], y: pts[0]![1], f: this.s.feed });
      }
    }

    g.rapid({ z: this.s.safeZ });
    g.blank();
    g.comment('done');

    const passes = depthLevels(0, this.s.depth, this.s.perPass).length;
    return {
      name: `engrave-${this.jobName}.nc`,
      gcode: g.toString(),
      summary:
        `${lines.length} strokes, ${passes} pass${passes === 1 ? '' : 'es'} to ${n(this.s.depth)}mm, ` +
        `${n(box.maxX - box.minX)} x ${n(box.maxY - box.minY)}mm`,
      warnings: this.commonWarnings(),
    };
  }

  /** The boundary of the ink, cut with an end mill. */
  private buildOutline(contours: Polyline[]): GeneratedProgram {
    const offset = offsetPaths(contours, {
      side: this.s.side,
      toolDiameter: this.s.toolDiameter,
      allowance: 0,
      tolerance: 0.02,
    });
    const loops = orderForCut(orientForCut(offset.loops, true, this.s.side));

    const program = profile(loops, {
      toolDiameter: this.s.toolDiameter,
      zTop: 0,
      depth: this.s.depth,
      depthPerPass: this.s.perPass,
      feedRate: this.s.feed,
      plungeFeed: this.s.plunge,
      rpm: this.s.rpm,
      safeZ: this.s.safeZ,
      tool: null,
      spindleDwell: this.s.spindleDwell,
      // No tabs: letters are not being cut free of a sheet here, and a tab
      // across the stem of an E is a repair job rather than a convenience.
      tabs: { count: 0, width: 0, height: 0 },
      rampLength: 0,
      sourceNote: `"${this.s.text.replace(/\n/g, ' / ')}" in ${this.fontName}, ${n(this.s.size)}mm caps`,
    });

    return {
      ...program,
      name: `outline-${this.jobName}.nc`,
      warnings: [...offset.warnings, ...program.warnings, ...this.commonWarnings()],
    };
  }

  /** The boundary again, cut with a V-bit so the groove follows the width. */
  private buildVcarve(contours: Polyline[]): GeneratedProgram {
    const result = vcarve(contours, {
      vAngle: this.s.vAngle,
      tipWidth: this.s.tipWidth,
      zTop: 0,
      maxDepth: this.s.vMaxDepth,
      stepover: this.s.vStepover,
      feedRate: this.s.feed,
      plungeFeed: this.s.plunge,
      rpm: this.s.rpm,
      safeZ: this.s.safeZ,
      spindleDwell: this.s.spindleDwell,
      tool: null,
      sourceNote: `"${this.s.text.replace(/\n/g, ' / ')}" in ${this.fontName}, ${n(this.s.size)}mm caps`,
    });
    this.rings = result.rings;
    return {
      ...result,
      name: `vcarve-${this.jobName}.nc`,
      warnings: [...result.warnings, ...this.commonWarnings()],
    };
  }

  /** Rings from the last V-carve, so the preview can show the depths. */
  private rings: Array<{ path: Polyline; depth: number }> = [];

  private commonWarnings(): string[] {
    const warnings: string[] = [];
    // The one that costs a workpiece: the program cuts to Z-depth from wherever
    // work zero is, and if that was set on the table rather than the surface it
    // cuts the whole depth into nothing, or through.
    warnings.push('Z0 must be the surface of the material, not the table.');
    if (this.mode === 'stroke' && this.s.depth > 2) {
      warnings.push(
        `${n(this.s.depth)}mm is deep for a single-line engraving — an engraving tip is fragile at depth.`,
      );
    }
    if (!this.fits()) {
      warnings.push('Some of the text falls outside the machine travel from where it is now.');
    }
    return warnings;
  }

  /**
   * Whether the text would stay inside the machine, cut from where it stands.
   *
   * Advisory, not a refusal: the operator may well be about to move the work
   * zero, and a panel that refused to generate until the machine was already in
   * the right place would be wrong more often than right.
   */
  private fits(): boolean {
    const box = this.bounds();
    if (!box) return true;
    const axes = machine.peek().axes;
    const x = axes.find((a) => a.letter === 'X');
    const y = axes.find((a) => a.letter === 'Y');
    if (!x || !y || !isFinite(x.max) || !isFinite(y.max)) return true;
    const offX = x.machine - x.work;
    const offY = y.machine - y.work;
    return (
      box.minX + offX >= x.min &&
      box.maxX + offX <= x.max &&
      box.minY + offY >= y.min &&
      box.maxY + offY <= y.max
    );
  }

  // --- Rendering ------------------------------------------------------------

  /** The shape to scale, so it is checked before it is cut. */
  private renderPreview(): TemplateResult {
    if (this.loading.size) return html`<div class="txt-preview empty">Reading the font…</div>`;
    const paths = this.geometry;
    const box = this.bounds();
    if (!box) return html`<div class="txt-preview empty">Nothing to cut</div>`;
    const pad = Math.max(1, this.s.size * 0.15);
    const w = Math.max(0.001, box.maxX - box.minX) + pad * 2;
    const h = Math.max(0.001, box.maxY - box.minY) + pad * 2;

    // V-carve is drawn as the rings it will actually cut, shaded by depth,
    // because the outline alone says nothing about how deep the middle goes —
    // which is the whole question a V-carve raises.
    const carving = this.mode === 'vcarve' && this.rings.length > 0;
    const deepest = carving ? Math.max(...this.rings.map((r) => r.depth)) : 1;

    return html`
      <svg
        class="txt-preview"
        viewBox=${`${box.minX - pad} ${-box.maxY - pad} ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <!-- Y is negated: SVG grows downward and the machine grows up. -->
        <!-- These children use Lit's svg tag, not its html tag. An html
             template creates children in the HTML namespace, and an SVG
             element in the XHTML namespace is in the DOM, has a bounding box,
             and draws nothing at all. (No backticks in this comment: it lives
             inside a template literal, and a pair of them ends the string.) -->
        ${paths.map(
          (path) =>
            svg`<polyline
              class=${carving ? 'txt-ghost' : ''}
              points=${path.points
                .concat(path.closed ? [path.points[0]!] : [])
                .map(([x, y]) => `${x},${-y}`)
                .join(' ')}
              vector-effect="non-scaling-stroke"
            />`,
        )}
        ${carving
          ? this.rings.map(
              (ring) =>
                svg`<polyline
                  class="txt-ring"
                  opacity=${(0.25 + 0.75 * (ring.depth / deepest)).toFixed(3)}
                  points=${ring.path.points
                    .concat([ring.path.points[0]!])
                    .map(([x, y]) => `${x},${-y}`)
                    .join(' ')}
                  vector-effect="non-scaling-stroke"
                />`,
            )
          : nothing}
        <!-- Where work zero is, so the alignment setting means something you
             can see rather than a word in a dropdown. -->
        ${svg`<circle cx="0" cy="0" r=${pad / 3} class="txt-origin" />`}
      </svg>
    `;
  }

  private renderFontPicker(): TemplateResult {
    const options = [
      ...faces().map((f) => ({ value: HERSHEY + f.id, label: `${f.name} (single stroke)` })),
      ...(this.stored ?? []).map((f) => ({ value: FILE + f.path, label: f.name })),
    ];
    return html`
      ${selectField('Font', this.s.font, options, (v) => this.set('font', v), {
        title: 'Built-in single-stroke faces, and any font files stored on the controller.',
      })}
    `;
  }

  private renderManager(): TemplateResult {
    const fonts = this.stored ?? [];
    return html`
      <div class="txt-fonts">
        <label
          class="txt-drop ${fonts.length ? 'compact' : ''}"
          @dragover=${(e: DragEvent) => e.preventDefault()}
          @drop=${(e: DragEvent) => {
            e.preventDefault();
            const file = e.dataTransfer?.files?.[0];
            if (file) void this.upload(file);
          }}
        >
          <input
            type="file"
            accept=".ttf,.otf,.woff,font/ttf,font/otf"
            @change=${(e: Event) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) void this.upload(file);
            }}
          />
          <strong>${this.busy ? 'Working…' : 'Drop a font file here'}</strong>
          <span class="hint">TTF, OTF or WOFF, kept in ${fontsDir()} on the controller</span>
        </label>

        ${this.fontError ? html`<div class="warn-banner">${this.fontError}</div>` : nothing}

        ${fonts.length === 0
          ? html`<div class="param-note">No fonts stored yet.</div>`
          : html`<ul class="txt-fontlist">
              ${fonts.map(
                (f) => html`<li>
                  <span class="txt-fontname">${f.name}</span>
                  <span class="hint">${Math.round(f.size / 1024)} KB</span>
                  <button class="tiny" @click=${() => void this.deleteFont(f)}>Delete</button>
                </li>`,
              )}
            </ul>`}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!connected.get()) return empty('Not connected');
    const program = this.build();
    const box = this.bounds();
    const mode = this.mode;
    const modes = this.modes;

    return html`
      <div class="pack txt">
        ${this.renderPreview()}

        <div class="param-grid">
          ${textField('Text', this.s.text, (v) => this.set('text', v), {
            title: 'One line per line. Characters the font has no glyph for are skipped.',
          })}
          ${this.renderFontPicker()}
          ${numberField('Cap height', this.s.size, (v) => this.set('size', v), { suffix: 'mm', min: 0.5 })}
          ${numberField('Rotation', this.s.rotation, (v) => this.set('rotation', v), { suffix: '°' })}
          ${numberField('Tracking', this.s.tracking, (v) => this.set('tracking', v), { suffix: 'mm' })}
          ${selectField(
            'Align',
            this.s.align,
            [
              { value: 'left', label: 'Left of the origin' },
              { value: 'centre', label: 'Centred on it' },
              { value: 'right', label: 'Right of it' },
            ],
            (v) => this.set('align', v as Settings['align']),
          )}
        </div>

        <div class="param-grid">
          ${modes.length > 1
            ? selectField(
                'Cut',
                mode,
                [
                  { value: 'vcarve', label: 'V-carve the letters' },
                  { value: 'outline', label: 'Cut round the outline' },
                ].filter((o) => modes.includes(o.value as Mode)),
                (v) => this.set('mode', v as Mode),
                { title: 'What the tool does with the shape of the letter.' },
              )
            : html`<div class="param-note">
                This font is single stroke, so the tool follows the letter itself.
              </div>`}

          ${mode === 'vcarve'
            ? html`
                ${numberField('Bit angle', this.s.vAngle, (v) => this.set('vAngle', v), {
                  suffix: '°',
                  min: 1,
                  title: 'Full included angle of the V-bit. 60 and 90 are the common ones.',
                })}
                ${numberField('Tip flat', this.s.tipWidth, (v) => this.set('tipWidth', v), {
                  suffix: 'mm',
                  min: 0,
                  title: '0 for a bit ground to a true point.',
                })}
                ${numberField('Depth limit', this.s.vMaxDepth, (v) => this.set('vMaxDepth', v), {
                  suffix: 'mm',
                  min: 0.1,
                  title: 'However wide the letter, the cut stops here.',
                })}
                ${numberField('Stepover', this.s.vStepover, (v) => this.set('vStepover', v), {
                  suffix: 'mm',
                  min: 0.02,
                  title: 'Smaller is a finer bottom and a longer program.',
                })}
              `
            : html`
                ${mode === 'outline'
                  ? html`
                      ${selectField(
                        'Side',
                        this.s.side,
                        [
                          { value: 'on', label: 'On the line' },
                          { value: 'outside', label: 'Outside — cuts letters out' },
                          { value: 'inside', label: 'Inside — cuts holes' },
                        ],
                        (v) => this.set('side', v as CutSide),
                      )}
                      ${numberField('Tool', this.s.toolDiameter, (v) => this.set('toolDiameter', v), {
                        suffix: 'mm',
                        min: 0.05,
                      })}
                    `
                  : nothing}
                ${numberField('Depth', this.s.depth, (v) => this.set('depth', v), { suffix: 'mm', min: 0 })}
                ${numberField('Per pass', this.s.perPass, (v) => this.set('perPass', v), { suffix: 'mm', min: 0.01 })}
              `}

          ${numberField('Feed', this.s.feed, (v) => this.set('feed', v), { suffix: 'mm/min', min: 1 })}
          ${numberField('Plunge', this.s.plunge, (v) => this.set('plunge', v), { suffix: 'mm/min', min: 1 })}
          ${numberField('Safe Z', this.s.safeZ, (v) => this.set('safeZ', v), { suffix: 'mm' })}
        </div>

        ${box
          ? html`<div class="param-note">
              ${n(box.maxX - box.minX)} × ${n(box.maxY - box.minY)}mm, from
              X${n(box.minX)} Y${n(box.minY)} in work coordinates. Z0 is the surface.
            </div>`
          : nothing}

        <div class="txt-manage">
          <button class="tiny" @click=${() => ((this.manage = !this.manage), this.requestUpdate())}>
            ${this.manage ? 'Hide fonts' : `Fonts on the machine (${(this.stored ?? []).length})`}
          </button>
        </div>
        ${this.manage ? this.renderManager() : nothing}

        ${program?.warnings.map((w) => html`<div class="warn-banner">${w}</div>`)}

        <div class="pack-actions">
          ${this.auto.field(() => this.requestUpdate())}
          <button ?disabled=${!program} @click=${() => program && preview(program)}>Preview</button>
          <button
            class="primary"
            ?disabled=${!program}
            @click=${() => program && void saveAndRun(program)}
          >
            Save and run
          </button>
        </div>
        ${program ? html`<div class="pack-note">${program.summary}</div>` : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-text', TextPanel);

registerPanel({
  id: 'text',
  title: 'Text',
  tag: 'cnc-text',
  defaultWidth: 4,
  defaultHeight: 560,
  description: 'Engrave or V-carve a line of text — no CAM step',
});
