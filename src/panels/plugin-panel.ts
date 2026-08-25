// The element behind every plugin panel.
//
// The layout builds a panel from a tag name, so there is one element type for
// all plugins and each instance works out which plugin it belongs to from
// `panelType` — `plugin:<id>`, the id plugins/host.ts registers its
// definitions under. PLUGIN_PANEL_TAG there says why there is not one custom
// element per plugin.
//
// Nearly everything below exists for a single hazard: this element is created
// once and then MOVED. ui/layout.ts keeps one element per panel instance and
// re-parents it when a stacked tab changes or the window crosses the phone
// breakpoint, so connect → disconnect → connect happens routinely, and both
// halves happen in the same task. Three ways to get that wrong, and this file
// is written against all three:
//
//   - a frame built on connect and not dropped on disconnect leaks a live
//     document, subscribed to the machine, per tab press;
//   - a frame dropped on disconnect and not rebuilt leaves a panel that is
//     blank until the page is reloaded;
//   - a frame dropped while the host is still holding it — plugins/host.ts
//     defers the element's removal by a task so the plugin's `onUnmount` hooks
//     have somewhere to be delivered — puts the new frame beside the dying one
//     until that timeout fires, two documents deep in one panel.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from '../ui/panel.js';
import { PLUGIN_PANEL_TAG, attachPanel, pluginIdOfPanel, plugins, recordFor } from '../plugins/host.js';
import type { PluginRecord } from '../plugins/types.js';

export class PluginPanel extends PanelElement {
  /** The host's handle on this panel's frame, or null when there is none. */
  private handle: { destroy: () => void } | null = null;
  /**
   * The record `handle` was opened against.
   *
   * Identity, not the id: `loadInstalled` replaces a record whose bytes
   * changed on the card, and plugins/host.ts abandons the old object's
   * attachments when it does. A handle held past that points at nothing, and
   * the panel would sit empty while a perfectly good plugin ran everywhere
   * else. Comparing the object is how this notices.
   */
  private attached: PluginRecord | null = null;

  private get pluginId(): string {
    return pluginIdOfPanel(this.panelType) ?? '';
  }

  /** The plugin this panel should be showing, or null when there is nothing to show. */
  private get runnable(): PluginRecord | null {
    const id = this.pluginId;
    if (!id) return null;
    const record = recordFor(id);
    // The same three conditions attachPanel checks. Asked here first so the
    // panel can say which one it is rather than render an empty box.
    return record && record.enabled && record.manifest.panel ? record : null;
  }

  /**
   * The plugin asking to be a certain height, refused.
   *
   * `axis.ui.resize()` is meant for a plugin embedded in something that grows.
   * Inside the dock the height is the layout's, and left unanswered the host
   * would set the frame's inline height and the panel would either scroll or
   * show a strip of background under the plugin. Cancelling the event is how
   * plugins/host.ts is told the layout has an opinion.
   *
   * `plugin-title` is deliberately not handled: bridge.ts has already put it
   * on the frame as a tooltip, and the event goes on bubbling for whatever
   * decides to name dock tabs after it one day.
   */
  private readonly refuseResize = (event: Event): void => {
    event.preventDefault();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    // Everything this panel shows about a plugin — gone, switched off, faulted,
    // reloaded — arrives as a touch on this one signal.
    this.bind(() => {
      plugins.get();
    });
    this.addEventListener('plugin-resize', this.refuseResize);
    this.onDispose(() => this.removeEventListener('plugin-resize', this.refuseResize));
    // PanelElement.connectedCallback requests an update when it has rendered
    // before, so `updated` runs after every reconnect and rebuilds the frame.
    // Nothing else here has to schedule that.
  }

  override disconnectedCallback(): void {
    // Before super, which runs the disposers. Dropping the frame is the one
    // thing that must not wait for a render that will never come.
    this.detach();
    super.disconnectedCallback();
  }

  protected override willUpdate(): void {
    // Before Lit takes the host element out of the document, not after.
    // plugins/host.ts can only deliver `lifecycle: unmount` to a frame that is
    // still connected, and a plugin whose panel is closing is exactly the one
    // that wants to save what the operator typed into it.
    if (this.handle && this.runnable !== this.attached) this.detach();
  }

  protected override updated(): void {
    this.sync();
  }

  /** Make the frame match what was just rendered. */
  private sync(): void {
    // Lit's update is a microtask, so an element detached between the request
    // and the render still gets here — and attaching then would build a frame
    // into a tree nobody is looking at, which disconnectedCallback has already
    // been past and will not visit again.
    if (!this.isConnected) return;

    const wanted = this.runnable;
    const host = this.querySelector<HTMLElement>('.plugin-frame');
    if (this.handle && (!host || wanted !== this.attached)) this.detach();
    if (this.handle || !host || !wanted) return;

    const handle = attachPanel(wanted.manifest.id, host);
    // Null means the host will not run it after all, in which case the record
    // has changed under us and the touch that changed it is already on its way
    // here. Leaving `attached` unset makes the next update try again rather
    // than treating an empty container as an attached one.
    if (!handle) return;
    this.handle = handle;
    this.attached = wanted;
  }

  private detach(): void {
    const handle = this.handle;
    this.handle = null;
    this.attached = null;
    if (!handle) return;
    handle.destroy();

    // The frame is still in the container: the host posts the unmount message
    // now and removes the element on the next task, so the hooks have a
    // document to run in. That is the right trade for the host and the wrong
    // one here, because the stacked layout detaches and re-attaches this
    // element within one task — the new frame would go in beside the old one.
    // Taking the leftovers out now costs the hooks nothing; their message was
    // posted before destroy() returned.
    //
    // A loop rather than replaceChildren(): the tablet this has to run on is
    // an iPad old enough not to have it.
    const host = this.querySelector<HTMLElement>('.plugin-frame');
    while (host?.firstChild) host.firstChild.remove();
  }

  /**
   * Why there is no plugin here.
   *
   * A layout outlives the plugins in it — a panel saved on a page is restored
   * whether or not its plugin still is — so this is a normal state and not an
   * error. It says which plugin, because the panel's tab is titled from a
   * definition that has gone with it and the id is the only name left.
   */
  private blank(heading: string, detail: string, fault?: string): TemplateResult {
    return html`
      <div class="plugin-blank">
        <strong>${heading}</strong>
        <p>${detail}</p>
        ${fault ? html`<p class="plugin-blank-fault">${fault}</p>` : nothing}
        <p class="plugin-blank-id">${this.pluginId || this.panelType}</p>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const id = this.pluginId;
    if (!id) {
      return this.blank(
        'Not a plugin panel',
        'This element is built from a panel type of the form "plugin:<id>", and this one is not.',
      );
    }

    const record = recordFor(id);
    if (!record) {
      return this.blank(
        'Not installed',
        'The layout still has a panel for this plugin, but the plugin is not installed. Install ' +
          'it again from the Plugins panel, or close this tab.',
      );
    }
    if (!record.manifest.panel) {
      return this.blank(
        `${record.manifest.name} has no panel`,
        'Its manifest declares no panel, so there is nothing to draw. It may still be running in ' +
          'the background — the Plugins panel says.',
      );
    }
    if (!record.enabled) {
      return this.blank(
        `${record.manifest.name} is switched off`,
        record.fault
          ? 'It stopped for the reason below. Fix it and enable the plugin again from the Plugins panel.'
          : 'Enable it from the Plugins panel to run it again.',
        record.fault,
      );
    }

    // One template, one <div>, for as long as this branch keeps being chosen:
    // Lit reuses the element it built from this literal, so the frame the host
    // put inside it survives every re-render. That is what lets the panel
    // re-render on a fault or a name change without restarting the plugin.
    return html`<div class="plugin-frame"></div>`;
  }
}

customElements.define(PLUGIN_PANEL_TAG, PluginPanel);
