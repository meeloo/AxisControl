// Base class for panels.
//
// Two jobs:
//  1. Opt out of Shadow DOM. Style encapsulation is friction for a single-dev
//     app: global CSS wouldn't reach in, theming would have to route through
//     custom properties, and querySelector would stop crossing the boundary.
//  2. Bridge signals to Lit. `bind()` runs a reactive effect that calls
//     requestUpdate() whenever any signal read inside it changes, and disposes
//     itself with the element.

import { LitElement } from 'lit';
import { effect } from '../core/signal.js';

export class PanelElement extends LitElement {
  private disposers: (() => void)[] = [];
  /** Panel instance id, assigned by the layout host. */
  instanceId = '';
  /** Which kind of panel this is, assigned by the layout host. */
  panelType = '';
  /** Page this instance lives on, assigned by the layout host. */
  pageId = '';

  /**
   * Key for anything this instance remembers of its own — see ui/folder.ts.
   *
   * Page and instance together, because an instance id is only unique within
   * its page: every page's first Files panel is called "files", so the page
   * has to be part of the name or two of them are one panel as far as their
   * settings are concerned.
   *
   * Falls back to the panel type for an element built outside the layout,
   * which is only tests — anything real is created by the layout host.
   */
  protected get panelKey(): string {
    const own = this.instanceId || this.panelType || this.tagName.toLowerCase();
    return this.pageId ? `${this.pageId}/${own}` : own;
  }

  /** Render into light DOM — see note above. */
  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  /**
   * Re-render whenever the element comes back.
   *
   * A panel that is not the visible tab gets detached, and detaching disposes
   * its effects — so everything that changed while it was away was missed, and
   * the DOM it still carries is a snapshot of whenever it was last on screen.
   * Lit does not re-render on reconnect by itself, and the panel's own
   * connectedCallback only re-subscribes, which fires on the NEXT change.
   *
   * The Console tab on a page laid out before the machine connected therefore
   * said "Not connected" for the rest of the session, with a disabled input,
   * while every panel that had been on screen at the time was live.
   */
  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate();
  }

  /**
   * Re-render this element whenever any signal read by `reader` changes.
   * Call from connectedCallback; disposal is automatic.
   */
  protected bind(reader: () => void): void {
    let first = true;
    this.disposers.push(
      effect(() => {
        reader();
        if (first) first = false;
        else this.requestUpdate();
      }),
    );
  }

  /** Register any other teardown to run on disconnect. */
  protected onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

/** Descriptor used by the layout host to build the panel picker. */
export interface PanelDefinition {
  id: string;
  title: string;
  /** Custom element tag. */
  tag: string;
  /** Default width in grid columns (of 12). */
  defaultWidth: number;
  /** Default height in px. */
  defaultHeight: number;
  /** Hide from the picker when this returns false for the active driver. */
  available?: (caps: import('../machine/types.js').Capabilities) => boolean;
  description?: string;
}

const registry = new Map<string, PanelDefinition>();

export function registerPanel(def: PanelDefinition): void {
  registry.set(def.id, def);
}

export function panelDefinitions(): PanelDefinition[] {
  return [...registry.values()];
}

export function panelDefinition(id: string): PanelDefinition | undefined {
  return registry.get(id);
}
