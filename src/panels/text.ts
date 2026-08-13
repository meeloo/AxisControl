// Engraving text, without going out to CAM for a label.
//
// The job this exists for is small and constant: a name on a fixture, a scale
// beside a slot, "MAX 24V" under a socket. Doing that through CAD and CAM is
// twenty minutes for something that ought to be thirty seconds, so it lives
// here.
//
// Single-line only for now, and that is a decision rather than a stage. A
// Hershey glyph IS a toolpath — see src/text/hershey.ts — so what gets cut is
// the letter itself, which is what engraving means. Outline fonts and V-carving
// are a different operation on the same panel later; they need glyph outlines,
// offsetting and a depth computed from the bit angle, none of which this needs.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { connected, machine } from '../core/store.js';
import { empty, numberField, selectField, textField } from '../ui/widgets.js';
import { AutoPreview, preview, saveAndRun } from '../ui/program.js';
import { Gcode, depthLevels, n, type GeneratedProgram } from '../cam/format.js';
import { boundsOf, faces, textToPolylines, type Polyline } from '../text/hershey.js';

interface Settings {
  text: string;
  face: string;
  size: number;
  rotation: number;
  tracking: number;
  align: 'left' | 'centre' | 'right';
  depth: number;
  perPass: number;
  feed: number;
  plunge: number;
  safeZ: number;
}

export class TextPanel extends PanelElement {
  private s: Settings = {
    text: 'AXIS',
    face: faces()[0]!.id,
    size: 10,
    rotation: 0,
    tracking: 0,
    align: 'left',
    depth: 0.4,
    perPass: 0.4,
    feed: 600,
    plunge: 200,
    safeZ: 5,
  };

  private auto = new AutoPreview('text');

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      machine.get();
    });
  }

  protected override updated(): void {
    this.auto.schedule(() => this.build());
  }

  private set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.s[key] = value;
    this.requestUpdate();
  }

  private get lines(): Polyline[] {
    return textToPolylines(this.s.text, {
      size: this.s.size,
      rotation: this.s.rotation,
      tracking: this.s.tracking,
      align: this.s.align,
      face: this.s.face,
    });
  }

  /**
   * The program, in work coordinates with Z0 at the surface.
   *
   * Every pass retraces every stroke rather than finishing each stroke to full
   * depth: an engraving bit is small and the cut is shallow, so the retract and
   * plunge between strokes costs more than the extra travel, and a stroke left
   * at full depth while its neighbour is untouched is where a fine tip snaps.
   */
  private build(): GeneratedProgram | null {
    const lines = this.lines;
    if (!lines.length) return null;
    const box = boundsOf(lines)!;

    const g = new Gcode();
    g.header(`Engrave: ${this.s.text.replace(/\n/g, ' / ')}`, [
      `${faces().find((f) => f.id === this.s.face)?.name ?? this.s.face}, ` +
        `${n(this.s.size)}mm caps, ${n(this.s.depth)}mm deep`,
      `X ${n(box.minX)}..${n(box.maxX)}  Y ${n(box.minY)}..${n(box.maxY)} in work coordinates`,
      'Z0 is the surface — set work zero on the top of the material',
    ]);
    g.blank();
    g.rapid({ z: this.s.safeZ });

    for (const z of depthLevels(0, this.s.depth, this.s.perPass)) {
      g.comment(`pass to Z${n(z)}`);
      for (const stroke of lines) {
        const first = stroke[0]!;
        g.rapid({ z: this.s.safeZ });
        g.rapid({ x: first.x, y: first.y });
        g.feed({ z, f: this.s.plunge });
        for (const p of stroke.slice(1)) g.feed({ x: p.x, y: p.y, f: this.s.feed });
      }
    }

    g.rapid({ z: this.s.safeZ });
    g.blank();
    g.comment('done');

    const passes = depthLevels(0, this.s.depth, this.s.perPass).length;
    const warnings: string[] = [];
    // The one that costs a workpiece: the program cuts to Z-depth from wherever
    // work zero is, and if that was set on the table rather than the surface it
    // cuts the whole depth into nothing, or through.
    warnings.push('Z0 must be the surface of the material, not the table.');
    if (this.s.depth > 2) {
      warnings.push(
        `${n(this.s.depth)}mm is deep for a single-line engraving — an engraving tip is fragile at depth.`,
      );
    }
    if (!this.strokesFit()) {
      warnings.push('Some of the text falls outside the machine travel from where it is now.');
    }

    return {
      name: `engrave-${this.s.text.trim().split(/\s+/)[0]?.replace(/[^\w-]/g, '') || 'text'}.nc`,
      gcode: g.toString(),
      summary:
        `${lines.length} strokes, ${passes} pass${passes === 1 ? '' : 'es'} to ${n(this.s.depth)}mm, ` +
        `${n(box.maxX - box.minX)} x ${n(box.maxY - box.minY)}mm`,
      warnings,
    };
  }

  /**
   * Whether the text would stay inside the machine, cut from where it stands.
   *
   * Advisory, not a refusal: the operator may well be about to move the work
   * zero, and a panel that refused to generate until the machine was already in
   * the right place would be wrong more often than right.
   */
  private strokesFit(): boolean {
    const box = boundsOf(this.lines);
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

  /** The strokes drawn to scale, so the shape is checked before it is cut. */
  private renderPreview(): TemplateResult {
    const lines = this.lines;
    const box = boundsOf(lines);
    if (!box) return html`<div class="txt-preview empty">Nothing to cut</div>`;
    const pad = Math.max(1, this.s.size * 0.15);
    const w = Math.max(0.001, box.maxX - box.minX) + pad * 2;
    const h = Math.max(0.001, box.maxY - box.minY) + pad * 2;
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
        ${lines.map(
          (stroke) =>
            svg`<polyline
              points=${stroke.map((p) => `${p.x},${-p.y}`).join(' ')}
              vector-effect="non-scaling-stroke"
            />`,
        )}
        <!-- Where work zero is, so the alignment setting means something you
             can see rather than a word in a dropdown. -->
        ${svg`<circle cx="0" cy="0" r=${pad / 3} class="txt-origin" />`}
      </svg>
    `;
  }

  protected override render(): TemplateResult {
    if (!connected.get()) return empty('Not connected');
    const program = this.build();
    const box = boundsOf(this.lines);

    return html`
      <div class="pack txt">
        ${this.renderPreview()}

        <div class="param-grid">
          ${textField('Text', this.s.text, (v) => this.set('text', v), {
            title: 'One line per line. Characters the face has no glyph for are skipped.',
          })}
          ${selectField(
            'Face',
            this.s.face,
            faces().map((f) => ({ value: f.id, label: f.name })),
            (v) => this.set('face', v),
            { title: faces().find((f) => f.id === this.s.face)?.note ?? '' },
          )}
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
          ${numberField('Depth', this.s.depth, (v) => this.set('depth', v), { suffix: 'mm', min: 0 })}
          ${numberField('Per pass', this.s.perPass, (v) => this.set('perPass', v), { suffix: 'mm', min: 0.01 })}
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
  defaultHeight: 520,
  description: 'Engrave a line of text — single-stroke, no CAM',
});
