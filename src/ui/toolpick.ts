// Choosing a tool on a machining panel.
//
// Every one of these panels used to start with the operator typing in a
// diameter, a feed, a plunge feed and an rpm — four numbers that are already
// written down in the tool library, against the tool that is going to cut the
// job. Typing them again is not just tedious: it is the step where a 6mm bit
// gets a 3mm diameter and the part comes out the wrong size, and nothing on
// screen contradicts it.
//
// So the picker does two separate things, and they are worth keeping apart:
//
//   1. It **fills in** what the library knows. Once, on selection. The fields
//      stay editable afterwards, because a feed is a function of the material
//      as much as of the cutter and the operator is the one who can see the
//      chips.
//   2. It **records which tool** the program is for, so the generated g-code
//      can start with a tool change instead of assuming whatever is in the
//      spindle happens to be right.
//
// It does not lock the fields to the tool. A panel whose numbers cannot be
// touched once a tool is chosen is a panel people work around by choosing no
// tool, and then nothing gets the tool change either.

import { html, nothing, type TemplateResult } from 'lit';
import { selectField } from './widgets.js';
import {
  activeLibrary,
  describeTool,
  formatDiameter,
  hasCuttingData,
  type ToolInfo,
} from '../tools/table.js';

/** What a panel can take from a tool. Absent fields are left alone. */
export interface ToolFill {
  diameter?: (mm: number) => void;
  feedRate?: (mmPerMin: number) => void;
  plungeFeed?: (mmPerMin: number) => void;
  rpm?: (rpm: number) => void;
  depthPerPass?: (mm: number) => void;
  /** Given as a fraction of the diameter, which is what the panels hold. */
  stepover?: (fraction: number) => void;
}

/** Tools worth offering: the ones that can actually fill something in. */
export function usableTools(): ToolInfo[] {
  return Object.values(activeLibrary().tools)
    .filter(hasCuttingData)
    .sort((a, b) => a.number - b.number);
}

/** What a fill did, and anything about it the operator should look at twice. */
export interface Filled {
  /** Field names that were actually set. */
  fields: string[];
  /** Something worth reading before pressing go, or null. */
  caution: string | null;
}

/**
 * Copy what the tool states into the panel, and nothing else.
 *
 * Zero means "the library does not say" throughout the tool table, so a tool
 * that carries only a diameter fills in only the diameter and leaves the feed
 * the operator set. Overwriting a considered feed with a zero would be worse
 * than not having the picker at all.
 */
export function applyTool(info: ToolInfo, into: ToolFill): Filled {
  const fields: string[] = [];
  const set = (
    label: string,
    value: number,
    apply: ((v: number) => void) | undefined,
  ): void => {
    if (!apply || !(value > 0)) return;
    apply(value);
    fields.push(label);
  };

  set('diameter', info.diameter, into.diameter);
  const c = info.cutting;
  let caution: string | null = null;
  if (c) {
    set('feed', c.feedRate, into.feedRate);
    set('plunge', c.plungeFeed, into.plungeFeed);
    set('rpm', c.rpm, into.rpm);
    set('per pass', c.depthPerPass, into.depthPerPass);
    // The library states a distance; the panels hold a fraction of the
    // diameter. Without a diameter there is nothing to take a fraction of.
    if (into.stepover && c.stepover > 0 && info.diameter > 0) {
      into.stepover(Math.min(1, c.stepover / info.diameter));
      fields.push('stepover');
    }

    // A depth of cut deeper than the tool is wide is an adaptive-clearing
    // number: Fusion's adaptive strategy takes the full flute length at a
    // small radial engagement, and the same figure handed to a pass that
    // clears the full width of the cutter breaks it. Real libraries carry
    // these — a 12mm roughing bit with a 21mm stepdown is an ordinary entry —
    // so the value is filled in as stated and flagged rather than quietly
    // altered to something the library never said.
    if (c.depthPerPass > 0 && info.diameter > 0 && c.depthPerPass > info.diameter) {
      caution =
        `the library's ${c.depthPerPass}mm per pass is deeper than the tool is wide — ` +
        'that is an adaptive-clearing figure, and these passes cut the full width. Check it.';
    }
  }
  return { fields, caution };
}

/** How a tool reads in the dropdown. */
function label(info: ToolInfo): string {
  const described = describeTool(info, null);
  return `T${info.number} · ${described === 'not configured' ? `⌀${formatDiameter(info.diameter)}` : described}`;
}

/**
 * The row itself.
 *
 * Renders nothing at all when there is no library worth picking from — a
 * dropdown with one entry reading "set by hand" is a control that does not do
 * anything, and this panel already has enough of them to read.
 */
export function toolPicker(opts: {
  /** Tool the panel is currently set up for, or null for by hand. */
  selected: number | null;
  /** Called with the tool, or null when the operator goes back to by hand. */
  onPick: (info: ToolInfo | null) => void;
  /** What the last fill did, for the note. */
  filled?: Filled | null;
  /** Extra sentence about what the tool number is used for in this panel. */
  note?: string;
}): TemplateResult | typeof nothing {
  const tools = usableTools();
  if (!tools.length) return nothing;

  const chosen = tools.find((t) => t.number === opts.selected) ?? null;

  return html`
    <div class="tool-pick">
      ${selectField(
        'Tool',
        chosen === null ? '' : String(chosen.number),
        [
          { value: '', label: 'Set by hand' },
          ...tools.map((t) => ({ value: String(t.number), label: label(t) })),
        ],
        (raw) => opts.onPick(raw === '' ? null : (tools.find((t) => String(t.number) === raw) ?? null)),
        {
          title:
            'Take the diameter, feeds and speeds from the tool library, and cut the job with this tool.',
        },
      )}
      ${chosen
        ? html`<span class="tool-pick-note hint">
            ${opts.filled?.fields.length
              ? `${opts.filled.fields.join(', ')} taken from the library — edit anything below to override`
              : 'the library states nothing about how to run this one'}${opts.note ? ` · ${opts.note}` : ''}
          </span>`
        : nothing}
      ${opts.filled?.caution
        ? html`<div class="warn-banner tool-pick-warn">${opts.filled.caution}</div>`
        : nothing}
    </div>
  `;
}
