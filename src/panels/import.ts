// Import an SVG or DXF and cut it.
//
// The whole panel is arranged around one fact: **the file usually does not say
// how big it is.** An SVG sized in pixels and a DXF with $INSUNITS unset are
// both perfectly normal exports, and the difference between reading one as
// millimetres and as inches is a factor of 25.4. So the measured size in mm is
// shown large and permanently, the scale is always editable, and nothing can be
// cut without the size having been on screen first.
//
// Everything downstream of the drawing is deliberately somebody else's problem:
// offsetting is Clipper's, tabs and depth passes are the machining pack's, and
// the preview is the viewer's.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { connected, machine } from '../core/store.js';
import { theme } from '../core/theme.js';
import { checkField, numberField, selectField } from '../ui/widgets.js';
import { fromAxis, fromDepthBelow } from '../ui/capture.js';
import { preview, saveAndRun } from '../ui/program.js';
import { importSvg } from '../import/svg.js';
import { importDxf } from '../import/dxf.js';
import { chain, place } from '../import/geometry.js';
import { offsetPaths, orderForCut, orientForCut, type CutSide } from '../import/offset.js';
import { boundsOf, pathLength, type ImportedDrawing, type Polyline } from '../import/types.js';
import { profile } from '../cam/profile.js';
import type { GeneratedProgram } from '../cam/format.js';

/** Where to put the drawing's own bounding box in work coordinates. */
type Anchor = 'bottom-left' | 'centre' | 'as-drawn';

/** What the panel has worked out from the current settings. */
interface Built {
  program: GeneratedProgram;
  warnings: string[];
  /** The drawing as placed, before the tool was compensated for. */
  source: Polyline[];
  /** What the tool centre will actually follow. */
  cut: Polyline[];
}

/** Blank margin around the drawing in the preview, px. */
const PREVIEW_MARGIN = 16;

/**
 * A point some way along a path, with the direction of travel there.
 *
 * Used to put one arrowhead on each cut loop. Which way round a loop is cut is
 * the difference between climb and conventional milling, and it is set by a
 * checkbox two rows down — this is the only place it can be seen rather than
 * taken on trust.
 */
function alongPath(path: Polyline, fraction: number): { x: number; y: number; dx: number; dy: number } | null {
  const total = pathLength(path);
  if (!(total > 0)) return null;
  const target = total * fraction;
  const last = path.closed ? path.points.length : path.points.length - 1;
  let walked = 0;
  for (let i = 0; i < last; i++) {
    const a = path.points[i];
    const b = path.points[(i + 1) % path.points.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 0) continue;
    if (walked + len >= target) {
      const t = (target - walked) / len;
      return {
        x: a[0] + (b[0] - a[0]) * t,
        y: a[1] + (b[1] - a[1]) * t,
        dx: (b[0] - a[0]) / len,
        dy: (b[1] - a[1]) / len,
      };
    }
    walked += len;
  }
  return null;
}

export class ImportPanel extends PanelElement {
  private drawing: ImportedDrawing | null = null;
  private error: string | null = null;
  private busy = false;

  // Placement
  private scale = 1;
  private anchor: Anchor = 'bottom-left';
  private originX = 0;
  private originY = 0;
  /** Join segments whose ends are this close, mm. */
  private joinTolerance = 0.05;
  private curveTolerance = 0.02;

  // Cutting
  private side: CutSide = 'outside';
  private climb = true;
  private toolDiameter = 3;
  private allowance = 0;
  private zTop = 0;
  private depth = 6;
  private depthPerPass = 1.5;
  private feedRate = 1200;
  private plungeFeed = 300;
  private rpm = 18000;
  private safeZ = 5;
  private spindleDwell = 3;
  private rampLength = 20;
  private tabCount = 4;
  private tabWidth = 6;
  private tabHeight = 1.5;

  // Preview
  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Last result of build(), kept so the canvas draws what the buttons will run. */
  private built: Built | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      machine.get();
      // The preview draws in the stylesheet's colours, and a canvas does not
      // repaint itself when they change.
      theme.get();
    });
  }

  protected override updated(): void {
    const canvas = this.querySelector<HTMLCanvasElement>('canvas.import-canvas');
    if (canvas !== this.canvas) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.canvas = canvas;
      if (canvas) {
        // The panel is resizable in the dock, and the drawing is fitted to the
        // width it is given.
        this.resizeObserver = new ResizeObserver(() => this.draw());
        this.resizeObserver.observe(canvas);
        this.onDispose(() => this.resizeObserver?.disconnect());
      }
    }
    this.draw();
  }

  // --- Loading ------------------------------------------------------------

  private async loadFile(file: File): Promise<void> {
    this.busy = true;
    this.error = null;
    this.requestUpdate();
    try {
      const text = await file.text();
      const isDxf = /\.dxf$/i.test(file.name) || /^\s*0\s*[\r\n]+\s*SECTION/.test(text.slice(0, 200));
      this.drawing = isDxf
        ? importDxf(text, { tolerance: this.curveTolerance, name: file.name })
        : importSvg(text, { tolerance: this.curveTolerance, name: file.name });
      // Take the file at its word initially; the size readout below is what
      // tells the operator whether that word was worth anything.
      this.scale = this.drawing.mmPerUnit;
    } catch (err) {
      this.drawing = null;
      this.error = (err as Error).message;
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  // --- Geometry pipeline --------------------------------------------------

  /** Drawing units, joined into loops, scaled and placed into work coordinates. */
  private get placed(): Polyline[] {
    const drawing = this.drawing;
    if (!drawing) return [];

    // SVG's Y axis grows downward; the machine's grows up. Getting this wrong
    // mirrors the part, which is exactly the sort of mistake that survives a
    // glance at the preview and is only obvious in the material.
    const flipY = drawing.source === 'svg';
    const scaled = place(chain(drawing.paths, this.joinTolerance / Math.max(this.scale, 1e-9)), {
      scale: this.scale,
      flipY,
      offsetX: 0,
      offsetY: 0,
    });

    const box = boundsOf(scaled);
    if (!box) return scaled;

    let dx = this.originX;
    let dy = this.originY;
    if (this.anchor === 'bottom-left') {
      dx -= box.min[0];
      dy -= box.min[1];
    } else if (this.anchor === 'centre') {
      dx -= (box.min[0] + box.max[0]) / 2;
      dy -= (box.min[1] + box.max[1]) / 2;
    }
    return place(scaled, { scale: 1, flipY: false, offsetX: dx, offsetY: dy });
  }

  /**
   * Scale so the drawing comes out this wide.
   *
   * More useful than arguing with the file about units: whatever a pixel or an
   * unlabelled DXF unit was meant to be, the operator generally does know how
   * wide the part is supposed to end up.
   */
  private setWidth(mm: number): void {
    const current = this.size;
    if (!current || !(current.w > 1e-9) || !(mm > 0)) return;
    this.scale *= mm / current.w;
    this.requestUpdate();
  }

  private get size(): { w: number; h: number } | null {
    const box = boundsOf(this.placed);
    return box ? { w: box.max[0] - box.min[0], h: box.max[1] - box.min[1] } : null;
  }

  private build(): Built | null {
    const drawing = this.drawing;
    if (!drawing) return null;
    const paths = this.placed;
    if (!paths.length) return null;

    const { loops, warnings } = offsetPaths(paths, {
      side: this.side,
      toolDiameter: this.toolDiameter,
      allowance: this.allowance,
      tolerance: this.curveTolerance,
    });

    const ready = orderForCut(orientForCut(loops, this.climb, this.side));
    const size = this.size;

    const program = profile(ready, {
      toolDiameter: this.toolDiameter,
      zTop: this.zTop,
      depth: this.depth,
      depthPerPass: this.depthPerPass,
      feedRate: this.feedRate,
      plungeFeed: this.plungeFeed,
      rpm: this.rpm,
      safeZ: this.safeZ,
      spindleDwell: this.spindleDwell,
      tabs: { count: this.tabCount, width: this.tabWidth, height: this.tabHeight },
      rampLength: this.rampLength,
      sourceNote:
        `from ${drawing.name}` +
        (size ? `, ${size.w.toFixed(1)} x ${size.h.toFixed(1)}mm, ${this.side} of line` : ''),
    });

    return { program, warnings: [...warnings, ...program.warnings], source: paths, cut: ready };
  }

  // --- Preview ------------------------------------------------------------

  /**
   * Draw the placed drawing and the path the tool will follow.
   *
   * Everything on this panel is a number typed into a box, and three of those
   * numbers — scale, side of the line, and tool diameter — go wrong in ways
   * that are invisible until the cutter is in the material. A mirrored part, a
   * cut on the wrong side, a tool too fat for the slot: all of them are obvious
   * here and nowhere else.
   */
  private draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!(width > 0) || !(height > 0)) return;

    // Backing store only — the CSS size is 100% of the box, so this never
    // feeds back into layout and the ResizeObserver above cannot loop.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const css = getComputedStyle(canvas);
    const colour = (name: string, fallback: string): string =>
      css.getPropertyValue(name).trim() || fallback;

    const source = this.built?.source ?? this.placed;
    const cut = this.built?.cut ?? [];
    const box = boundsOf([...source, ...cut]);
    if (!box) return;

    let [minX, minY] = box.min;
    let [maxX, maxY] = box.max;
    // Where zero sits relative to the part is what the Place and Origin fields
    // above are for, so bring it into frame — but only when it is near. A part
    // parked a metre from zero would otherwise be shrunk to a speck to make
    // room for an empty field.
    const reach = Math.max(maxX - minX, maxY - minY, 1) * 0.6;
    const nearOrigin =
      0 >= minX - reach && 0 <= maxX + reach && 0 >= minY - reach && 0 <= maxY + reach;
    if (nearOrigin) {
      minX = Math.min(minX, 0);
      minY = Math.min(minY, 0);
      maxX = Math.max(maxX, 0);
      maxY = Math.max(maxY, 0);
    }

    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min(
      (width - 2 * PREVIEW_MARGIN) / spanX,
      (height - 2 * PREVIEW_MARGIN) / spanY,
    );
    if (!(scale > 0) || !isFinite(scale)) return;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // Machine Y grows up, canvas Y grows down. Getting this wrong here would
    // show a mirrored part as correct, which is the one mistake the preview
    // exists to catch.
    const px = (x: number): number => width / 2 + (x - cx) * scale;
    const py = (y: number): number => height / 2 - (y - cy) * scale;

    const trace = (path: Polyline): void => {
      const pts = path.points;
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(px(pts[0][0]), py(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i][0]), py(pts[i][1]));
      if (path.closed) ctx.closePath();
      ctx.stroke();
    };

    // The drawing, thin and faint: it is the reference, not the instruction.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colour('--text-faint', '#8a94a1');
    ctx.lineWidth = 1;
    for (const path of source) {
      // An open path cannot be offset, and is dashed to say so before the
      // warning underneath has to.
      ctx.setLineDash(path.closed ? [] : [3, 3]);
      trace(path);
    }
    ctx.setLineDash([]);

    if (nearOrigin) this.drawOrigin(ctx, px(0), py(0), colour('--text-dim', '#55606d'));

    // The tool path, over the top and in the accent colour: this is what will
    // actually run.
    ctx.strokeStyle = colour('--accent', '#0a63c9');
    ctx.lineWidth = 1.75;
    for (const loop of cut) trace(loop);

    ctx.fillStyle = colour('--accent', '#0a63c9');
    for (const loop of cut) {
      const at = alongPath(loop, 0.3);
      if (at) this.drawArrow(ctx, px(at.x), py(at.y), at.dx, -at.dy);
    }
  }

  /** The work origin: a quartered circle, the way a drawing datum is marked. */
  private drawOrigin(ctx: CanvasRenderingContext2D, x: number, y: number, colour: string): void {
    const r = 5;
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI / 2);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, Math.PI, Math.PI * 1.5);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number): void {
    const len = 6;
    const wide = 3.2;
    ctx.beginPath();
    ctx.moveTo(x + dx * len, y + dy * len);
    ctx.lineTo(x - dx * len * 0.4 - dy * wide, y - dy * len * 0.4 + dx * wide);
    ctx.lineTo(x - dx * len * 0.4 + dy * wide, y - dy * len * 0.4 - dx * wide);
    ctx.closePath();
    ctx.fill();
  }

  // --- Render -------------------------------------------------------------

  private renderDrop(): TemplateResult {
    return html`
      <label
        class="import-drop"
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          const file = e.dataTransfer?.files?.[0];
          if (file) void this.loadFile(file);
        }}
      >
        <input
          type="file"
          accept=".svg,.dxf,image/svg+xml"
          @change=${(e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) void this.loadFile(file);
          }}
        />
        <strong>${this.busy ? 'Reading…' : 'Drop an SVG or DXF here'}</strong>
        <span class="hint">or click to choose a file</span>
      </label>
    `;
  }

  private renderPlacement(): TemplateResult {
    const drawing = this.drawing!;
    const size = this.size;
    const paths = this.placed;
    const closed = paths.filter((p) => p.closed).length;

    return html`
      <div class="import-summary">
        <div class="import-file">
          <strong>${drawing.name}</strong>
          <span class="hint">${drawing.source.toUpperCase()} · ${paths.length} path(s), ${closed} closed</span>
        </div>
        <div class="import-size">
          ${size ? html`${size.w.toFixed(1)} × ${size.h.toFixed(1)} <em>mm</em>` : '—'}
        </div>
      </div>

      ${drawing.units === 'unknown'
        ? html`<div class="warn-banner">
            This file does not state its size. It is being read as
            ${drawing.mmPerUnit === 1 ? 'millimetres' : `${drawing.mmPerUnit.toFixed(4)}mm per unit`} —
            check the measurement above against the real part before cutting.
            ${drawing.mmPerUnit === 1
              ? html`<button
                  class="tiny"
                  title="For a file whose coordinates are in inches"
                  @click=${() => ((this.scale *= 25.4), this.requestUpdate())}
                >
                  ×25.4 (the numbers are inches)
                </button>`
              : nothing}
          </div>`
        : nothing}
      ${drawing.warnings.map((w) => html`<div class="warn-banner">${w}</div>`)}

      ${this.renderPreview()}

      <div class="param-grid">
        ${numberField('Scale', this.scale, (v) => ((this.scale = v), this.requestUpdate()), { suffix: 'mm/unit', step: 0.0001, title: 'Millimetres per unit of the source file. The size above updates as you change it.' })}
        ${size
          ? numberField('Make it wide', size.w, (v) => this.setWidth(v), { suffix: 'mm', min: 0.01, title: 'Type the width the finished part should be and the scale is worked out from it. Usually easier than knowing what a file\u2019s units were.' })
          : nothing}
        ${selectField('Place', this.anchor, [
          { value: 'bottom-left', label: 'Bottom-left at origin' },
          { value: 'centre', label: 'Centred on origin' },
          { value: 'as-drawn', label: 'As drawn' },
        ], (v) => ((this.anchor = v), this.requestUpdate()))}
        ${numberField('Origin X', this.originX, (v) => ((this.originX = v), this.requestUpdate()), { suffix: 'mm', capture: fromAxis('X', 'work') })}
        ${numberField('Origin Y', this.originY, (v) => ((this.originY = v), this.requestUpdate()), { suffix: 'mm', capture: fromAxis('Y', 'work') })}
        ${numberField('Curve tolerance', this.curveTolerance, (v) => ((this.curveTolerance = v), this.requestUpdate()), { suffix: 'mm', step: 0.005, title: 'How far a flattened curve may stray from the true one.' })}
        ${numberField('Join gap', this.joinTolerance, (v) => ((this.joinTolerance = v), this.requestUpdate()), { suffix: 'mm', step: 0.01, title: 'Segment ends this close are treated as joined. A DXF rectangle is four separate lines and needs this to become one loop.' })}
      </div>
    `;
  }

  private renderPreview(): TemplateResult {
    const cut = this.built?.cut.length ?? 0;
    return html`
      <div class="import-preview">
        <canvas class="import-canvas"></canvas>
        <div class="import-legend">
          <span class="import-key drawing">drawing</span>
          <span class="import-key cut">
            ${cut
              ? `tool path, ${this.side === 'on' ? 'on the line' : `${this.side} the line`}`
              : 'no tool path'}
          </span>
          <span class="hint">arrow shows cut direction</span>
        </div>
      </div>
    `;
  }

  private renderCutting(): TemplateResult {
    return html`
      <div class="param-grid">
        ${selectField('Side', this.side, [
          { value: 'outside', label: 'Outside the line' },
          { value: 'inside', label: 'Inside the line' },
          { value: 'on', label: 'On the line' },
        ], (v) => ((this.side = v), this.requestUpdate()))}
        ${checkField('Climb milling', this.climb, (v) => ((this.climb = v), this.requestUpdate()))}
        ${numberField('Tool ⌀', this.toolDiameter, (v) => ((this.toolDiameter = v), this.requestUpdate()), { suffix: 'mm', step: 0.1 })}
        ${this.side === 'on'
          ? nothing
          : numberField('Leave stock', this.allowance, (v) => ((this.allowance = v), this.requestUpdate()), { suffix: 'mm', step: 0.05, title: 'Extra material left on the wall for a finishing pass.' })}
        ${numberField('Z top', this.zTop, (v) => ((this.zTop = v), this.requestUpdate()), { suffix: 'mm', capture: fromAxis('Z', 'work') })}
        ${numberField('Depth', this.depth, (v) => ((this.depth = v), this.requestUpdate()), { suffix: 'mm', title: 'How far below Z top to cut. The crosshair takes it from where the tool is standing now.', capture: fromDepthBelow(() => this.zTop) })}
        ${numberField('Per pass', this.depthPerPass, (v) => ((this.depthPerPass = v), this.requestUpdate()), { suffix: 'mm' })}
        ${numberField('Ramp', this.rampLength, (v) => ((this.rampLength = v), this.requestUpdate()), { suffix: 'mm', min: 0, title: 'Descend over this much travel along the path instead of plunging.' })}
        ${numberField('Feed', this.feedRate, (v) => ((this.feedRate = v), this.requestUpdate()), { suffix: 'mm/min' })}
        ${numberField('Plunge', this.plungeFeed, (v) => ((this.plungeFeed = v), this.requestUpdate()), { suffix: 'mm/min' })}
        ${numberField('RPM', this.rpm, (v) => ((this.rpm = v), this.requestUpdate()))}
        ${numberField('Safe Z', this.safeZ, (v) => ((this.safeZ = v), this.requestUpdate()), { suffix: 'mm', capture: fromAxis('Z', 'work') })}
        ${numberField('Tabs', this.tabCount, (v) => ((this.tabCount = Math.max(0, Math.round(v))), this.requestUpdate()), { suffix: 'off at 0', min: 0, step: 1 })}
        ${this.tabCount > 0
          ? html`
              ${numberField('Tab width', this.tabWidth, (v) => ((this.tabWidth = v), this.requestUpdate()), { suffix: 'mm' })}
              ${numberField('Tab height', this.tabHeight, (v) => ((this.tabHeight = v), this.requestUpdate()), { suffix: 'mm', step: 0.1 })}
            `
          : nothing}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const live = connected.get();
    // Stashed, not just used here: the canvas is drawn after this returns and
    // has to show the same geometry the buttons below would run.
    const built = this.drawing ? this.build() : null;
    this.built = built;

    return html`
      <div class="pack import">
        ${this.error ? html`<div class="warn-banner">${this.error}</div>` : nothing}
        ${this.drawing === null
          ? this.renderDrop()
          : html`
              ${this.renderPlacement()}
              <div class="import-rule"></div>
              ${this.renderCutting()}
              ${built?.warnings.length
                ? html`<div class="warn-banner">${built.warnings.map((w) => html`<div>${w}</div>`)}</div>`
                : nothing}
              ${built ? html`<div class="pack-note">${built.program.summary}</div>` : nothing}
              <div class="pack-actions">
                <button class="tiny" @click=${() => ((this.drawing = null), this.requestUpdate())}>
                  Another file
                </button>
                <button ?disabled=${!built} @click=${() => built && preview(built.program)}>
                  Preview
                </button>
                <button
                  class="primary"
                  ?disabled=${!live || !built}
                  @click=${() => built && void saveAndRun(built.program)}
                >
                  Save &amp; run
                </button>
              </div>
            `}
      </div>
    `;
  }
}

customElements.define('cnc-import', ImportPanel);

registerPanel({
  id: 'import',
  title: 'Import',
  tag: 'cnc-import',
  defaultWidth: 5,
  defaultHeight: 560,
  description: 'Cut an SVG or DXF outline, offset for the tool',
});
