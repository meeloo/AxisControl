// Dashboard host, built on dockview-core.
//
// The previous hand-rolled grid worked but the interaction didn't: panels
// swapped on hover with no drop indicator, and two <select>s per header did the
// resizing. Rather than reimplement a docking engine badly, this delegates to
// one — dockview gives tabbed groups, drag between groups with a real drop
// overlay, and drag-to-resize splits, which is the whole of what was wanted.
//
// What stays hand-rolled:
//
//   Pages. Dockview is one docking surface; pages are separate surfaces you
//   switch between with number keys. Each page owns its OWN dockview instance
//   rather than swapping one instance's JSON, because reloading a layout
//   destroys and recreates panels — which would drop the viewer's WebGL context
//   and its parsed toolpath on every page change. Hidden pages keep their
//   panels alive and are re-laid-out when shown.
//
//   Panel lifetime. A panel element is created once per instance id and reused,
//   so dragging it between groups moves the same element rather than rebuilding
//   it. Lit re-runs connectedCallback on re-attach, so bindings re-establish
//   themselves.

import { html, nothing, type TemplateResult } from 'lit';
import { createDockview, type DockviewApi, type DockviewTheme, type IContentRenderer } from 'dockview-core';
import { PanelElement, panelDefinition, panelDefinitions, type PanelDefinition } from './panel.js';
import { capabilities, loadSetting, saveSetting } from '../core/store.js';
import { signal } from '../core/signal.js';
import { theme } from '../core/theme.js';

interface PageState {
  id: string;
  name: string;
  /** dockview's serialised layout, or null for a page never opened. */
  layout: unknown | null;
  /**
   * Every panel id this page has ever held.
   *
   * A saved layout would otherwise freeze the page at whatever the defaults
   * were the day it was saved, so a panel added to DEFAULT_PAGES later would
   * never reach anyone who had used the app before. Comparing against this
   * instead of against the current layout adds a genuinely new default once,
   * while a panel the operator closed on purpose stays closed.
   */
  known?: string[];
}

interface LayoutState {
  pages: PageState[];
  active: number;
}

interface PageSpec {
  id: string;
  name: string;
  /** Opened left to right. */
  panels: string[];
  /** panel id → the panel it should sit behind as a tab. */
  stacked?: Record<string, string>;
}

/**
 * Page state, published for the top bar.
 *
 * The tabs used to sit in their own row directly under the top bar, which meant
 * two full-width strips of chrome above a machine control. Merging them puts the
 * tabs in the top bar — but the pages themselves are still the dashboard's, so
 * rather than move the state, the dashboard publishes it here and the top bar
 * calls back in. There is exactly one dashboard, which is what makes a module
 * reference honest rather than a shortcut.
 */
export const pageTabs = signal<{ pages: Array<{ id: string; name: string }>; active: number }>({
  pages: [],
  active: 0,
});

/** Tab being renamed in place, by page id. */
export const renamingPage = signal<string | null>(null);

/** Whether the add-a-panel picker is showing. */
export const panelPickerOpen = signal(false);

/**
 * Which group a picked panel joins, by dockview group id.
 *
 * The button that opens the picker lives on a tab bar, so "add a panel" has an
 * obvious answer to "where" — beside these tabs. Null means the caller had no
 * particular group in mind and dockview should place it, which is what the
 * phone's single-panel stack wants: there is only one place it can go.
 */
let pickerGroup: string | null = null;

export function openPanelPicker(groupId: string | null): void {
  pickerGroup = groupId;
  panelPickerOpen.set(true);
}

export function closePanelPicker(): void {
  pickerGroup = null;
  panelPickerOpen.set(false);
}

let host: DashboardHost | null = null;

export function selectPage(index: number): void {
  host?.goToPage(index);
}
export function addPage(): void {
  host?.addPage();
}
export function removePage(index: number): void {
  host?.removePage(index);
}
export function renamePage(index: number, name: string): void {
  host?.renamePage(index, name);
}

const DEFAULT_PAGES: PageSpec[] = [
  { id: 'control', name: 'Control', panels: ['dro', 'jog', 'spindle'], stacked: { job: 'spindle', macros: 'spindle', console: 'spindle' } },
  {
    id: 'job',
    name: 'Job',
    panels: ['viewer', 'preflight'],
    // Preflight, overrides and run-from-line all act on the loaded program and
    // are never wanted simultaneously, so they share a group as tabs.
    stacked: { overrides: 'preflight', resume: 'preflight', files: 'preflight' },
  },
  // Coordinates beside probing on purpose: the skew routine writes a rotation
  // and the only place that rotation is visible is the Coordinates panel.
  { id: 'setup', name: 'Setup', panels: ['wcs', 'probe'], stacked: { machining: 'probe', surface: 'probe', import: 'probe', atc: 'probe' } },
  { id: 'advanced', name: 'Advanced', panels: ['diagnostics', 'om'], stacked: { console: 'om', files: 'om' } },
];

function defaultLayout(): LayoutState {
  return { active: 0, pages: DEFAULT_PAGES.map((p) => ({ id: p.id, name: p.name, layout: null })) };
}

export class DashboardHost extends PanelElement {
  private state: LayoutState = load();
  private views = new Map<string, { api: DockviewApi; host: HTMLElement }>();
  /** One element per panel instance id, reused across drags and page switches. */
  private elements = new Map<string, PanelElement>();
  private resizeObserver: ResizeObserver | null = null;
  /**
   * Below this the dashboard stops tiling and stacks instead.
   *
   * Width OR height, because a phone turned sideways is neither narrow nor big:
   * an iPhone in landscape is 844px wide, comfortably past any width-only
   * breakpoint, and 390px tall — so it was being handed the tiled desktop
   * layout on a phone. 700px wide is where tiling stops paying, a tiled panel
   * needing roughly 350px before its contents are cut; 500px tall is a
   * viewport no desktop window is, and every phone in landscape is.
   */
  private narrow = window.matchMedia('(max-width: 700px), (max-height: 500px)');
  private stacks = new Set<string>();
  /** Which panel each page is showing on a phone, by instance id. */
  private stackTab = new Map<string, string>();
  /** Redraws a page's phone strip, by page id. See createStack. */
  private stackRender = new Map<string, () => void>();

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => capabilities.get());
    this.bind(() => {
      const t = theme.get();
      for (const { api } of this.views.values()) api.updateOptions({ theme: dvTheme(t) });
    });
    host = this;
    this.publishTabs();
    this.bind(() => panelPickerOpen.get());
    window.addEventListener('keydown', this.onKeyDown);
    this.narrow.addEventListener('change', this.onBreakpoint);
    this.onDispose(() => this.narrow.removeEventListener('change', this.onBreakpoint));
    this.onDispose(() => {
      if (host === this) host = null;
      window.removeEventListener('keydown', this.onKeyDown);
      this.resizeObserver?.disconnect();
      for (const { api } of this.views.values()) api.dispose();
      this.views.clear();
    });
  }

  protected override updated(): void {
    this.syncViews();
  }

  private get page(): PageState {
    return this.state.pages[Math.min(this.state.active, this.state.pages.length - 1)];
  }

  private persist(): void {
    for (const [id, { api }] of this.views) {
      const page = this.state.pages.find((p) => p.id === id);
      if (!page) continue;
      page.layout = api.toJSON();
      page.known = [...new Set([...(page.known ?? []), ...api.panels.map((p) => p.id)])];
    }
    saveSetting('dockLayout', this.state);
    this.publishTabs();
    this.requestUpdate();
  }

  private publishTabs(): void {
    pageTabs.set({
      pages: this.state.pages.map((p) => ({ id: p.id, name: p.name })),
      active: Math.min(this.state.active, this.state.pages.length - 1),
    });
  }

  /** Switch page. Public because the top bar owns the tabs now. */
  goToPage(index: number): void {
    if (index < 0 || index >= this.state.pages.length) return;
    this.state.active = index;
    this.persist();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > this.state.pages.length) return;
    this.goToPage(n - 1);
  };

  // --- Dockview plumbing --------------------------------------------------

  /**
   * Wrap a panel custom element as a dockview content renderer.
   *
   * Cached by page AND instance id, not by instance id alone. Each page is its
   * own dockview, so ids are only unique within one: the Console sits on both
   * Control and Advanced and is called "console" on each. Keyed by id alone,
   * those two tabs shared a single element — and since an element can only be
   * in one place at a time, switching pages physically moved it. It looked
   * like it worked because only one page is on screen at once.
   */
  private renderer(pageId: string, instanceId: string, panelId: string): IContentRenderer {
    const def = panelDefinition(panelId);
    const wrapper = document.createElement('div');
    wrapper.className = 'dv-panel';

    if (def) {
      wrapper.appendChild(this.elementFor(pageId, instanceId, panelId));
    } else {
      wrapper.textContent = `Unknown panel: ${panelId}`;
    }

    return {
      element: wrapper,
      init: () => {
        /* the element is already populated */
      },
    };
  }

  /**
   * The element for one panel instance, created once and reused.
   *
   * Shared by the tiled layout and the stacked one, which is what lets a phone
   * rotate — or a window cross the breakpoint — without a panel losing what it
   * had read, typed or scrolled to.
   */
  private elementFor(pageId: string, instanceId: string, panelId: string): PanelElement {
    const key = `${pageId}/${instanceId}`;
    let el = this.elements.get(key);
    if (!el) {
      const def = panelDefinition(panelId)!;
      el = document.createElement(def.tag) as PanelElement;
      el.instanceId = instanceId;
      el.panelType = panelId;
      el.pageId = pageId;
      this.elements.set(key, el);
    }
    return el;
  }

  /**
   * Which panels a page holds, without needing a dockview to ask.
   *
   * On a phone there is never a dockview to ask, so this reads the saved
   * layout's own panel table — dockview serialises one keyed by instance id —
   * and falls back to the page's defaults on a first run.
   */
  private panelsOf(page: PageState): Array<{ instanceId: string; panelId: string; title: string }> {
    const saved = page.layout as {
      panels?: Record<string, { id: string; component?: string; title?: string }>;
    } | null;
    const entries = saved?.panels ? Object.values(saved.panels) : null;
    if (entries?.length) {
      return entries
        .map((p) => ({
          instanceId: p.id,
          panelId: p.component ?? p.id,
          title: p.title ?? p.id,
        }))
        .filter((p) => panelDefinition(p.panelId));
    }
    const def = DEFAULT_PAGES.find((d) => d.id === page.id);
    const ids = def ? [...def.panels, ...Object.keys(def.stacked ?? {})] : [];
    return ids
      .filter((id) => panelDefinition(id))
      .map((id) => ({ instanceId: id, panelId: id, title: panelDefinition(id)!.title }));
  }

  /**
   * The phone layout: one panel at a time, chosen from a strip of names.
   *
   * Not a dockview at all. Tiling is what does not work on a 390px screen — it
   * cut the DRO off mid-digit — and tiling is dockview's whole job, so below
   * the breakpoint it is simply not used. The saved tiled layout is left
   * untouched, so widening the window puts it back exactly as it was.
   *
   * One panel rather than a scrolling stack because of what this is for. On a
   * phone you are standing at the machine wanting the jog rose or the DRO now,
   * and scrolling past four other panels to reach it is the wrong shape for
   * that. The strip is the whole navigation: one tap, no menu, and the panel
   * you land on gets the entire screen.
   */
  private createStack(page: PageState, host: HTMLElement): void {
    host.className = 'stack-host';
    const render = (): void => {
      const panels = this.panelsOf(page);
      if (!panels.length) {
        host.textContent = '';
        return;
      }
      const chosen = this.stackTab.get(page.id);
      const current = panels.find((p) => p.instanceId === chosen) ?? panels[0]!;

      host.textContent = '';
      // Two elements, not one: the names scroll and the "+" does not. As one
      // scrolling row the button sat after the last tab, which on the Control
      // page put it 130px past the right edge of a 390px phone — present,
      // focusable, and impossible to see or reach without knowing to swipe the
      // strip first. That is the same bug as having it in the top bar, moved.
      const tabs = document.createElement('div');
      tabs.className = 'stack-tabs';
      const row = document.createElement('div');
      row.className = 'stack-tabrow';
      for (const p of panels) {
        const tab = document.createElement('button');
        tab.className = `stack-tab${p.instanceId === current.instanceId ? ' on' : ''}`;
        tab.textContent = p.title;
        tab.addEventListener('click', () => {
          this.stackTab.set(page.id, p.instanceId);
          render();
        });
        row.appendChild(tab);
      }
      // Same control the desktop tab bars get, at the same end of the strip.
      // There is only one group in this layout, so it has no group to name.
      tabs.append(row, this.addButton(() => null).element);

      const view = document.createElement('div');
      view.className = 'stack-view';
      view.appendChild(this.elementFor(page.id, current.instanceId, current.panelId));
      host.append(tabs, view);

      // Keep the chosen tab in sight — with nine panels the one you are on is
      // often off the end of the strip after a reload.
      const on = row.querySelector('.stack-tab.on');
      on?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    // Kept so anything that changes what the page holds can redraw the strip.
    // The host's own requestUpdate does not reach in here: this layout is built
    // by hand rather than by Lit, precisely so the panel elements survive.
    this.stackRender.set(page.id, render);
    render();
  }

  /**
   * The "+" that opens the panel picker, as a bare DOM element.
   *
   * Shared by dockview's header-actions slot and by the phone stack's own tab
   * strip, so the control is the same object in both layouts rather than two
   * that drift. `groupId` is a function because dockview builds this once per
   * group and the id is not interesting until it is pressed.
   */
  private addButton(groupId: () => string | null): {
    element: HTMLElement;
    init(): void;
    dispose(): void;
  } {
    const button = document.createElement('button');
    button.className = 'tab-add';
    button.type = 'button';
    button.title = 'Add a panel here';
    button.setAttribute('aria-label', 'Add a panel here');
    button.textContent = '+';
    button.addEventListener('click', (e) => {
      // The tab bar is a drag handle and a click target for selecting groups;
      // without this the press does both.
      e.stopPropagation();
      openPanelPicker(groupId());
    });
    return { element: button, init: () => {}, dispose: () => {} };
  }

  private createView(page: PageState, host: HTMLElement): DockviewApi {
    const api = createDockview(host, {
      // The panel id is the instance id; `name` carries the panel type.
      createComponent: (options) => this.renderer(page.id, options.id, options.name),
      // A "+" at the right of every tab bar, rather than one in the top bar.
      //
      // Two reasons. It says where the panel will go — the group you pressed —
      // instead of leaving that to dockview and to guesswork. And the top bar
      // is the one strip that has to hold the machine status, the stop button
      // and the page tabs at any width, so it was the wrong place for a control
      // that is per-group anyway: on a phone it was pushed off the end entirely
      // and the app could not be rearranged at all.
      createRightHeaderActionComponent: (group) => this.addButton(() => group.id),
      disableFloatingGroups: true,
      theme: dvTheme(theme.peek()),
    });

    let seeded = false;
    if (page.layout) {
      try {
        api.fromJSON(page.layout as never);
        seeded = true;
      } catch {
        // A stored layout referencing a panel that no longer exists would
        // otherwise leave a blank page.
        api.clear();
      }
    }
    if (!seeded) page.layout = null;
    this.ensureDefaults(page, api);

    api.onDidLayoutChange(() => this.persist());
    return api;
  }

  /**
   * Ensure a page holds its default panels, left to right with stacked ones as
   * tabs. Idempotent: anything already present, or recorded in `known`, is left
   * alone, so this can run on every update.
   *
   * It has to run repeatedly rather than once at creation for two reasons.
   *
   * Capabilities arrive asynchronously. A page shown before the driver has
   * connected would otherwise seed empty and stay empty for the session, since
   * `available()` rejects every panel while the capability set is still the
   * empty default — which is exactly what happens when the app reopens on the
   * Setup page.
   *
   * And a saved layout would otherwise freeze a page at whatever the defaults
   * were the day it was saved, so a panel added to DEFAULT_PAGES later would
   * never reach anyone who had used the app before.
   *
   * `known` is what stops it fighting the operator: a panel that has ever been
   * on this page is never re-added, so closing one makes it stay closed.
   */
  private ensureDefaults(page: PageState, api: DockviewApi): void {
    const spec = DEFAULT_PAGES.find((p) => p.id === page.id);
    if (!spec) return;
    const caps = capabilities.peek();
    const known = new Set(page.known ?? api.panels.map((p) => p.id));
    const usable = (id: string) => {
      const def = panelDefinition(id);
      return def && (!def.available || def.available(caps)) ? def : null;
    };

    let added = false;
    let previous: string | null = null;
    for (const id of spec.panels) {
      const def = usable(id);
      if (!def) continue;
      if (api.getPanel(id)) {
        previous = id;
        continue;
      }
      if (known.has(id)) continue;
      api.addPanel({
        id,
        component: id,
        title: def.title,
        ...(previous
          ? { position: { referencePanel: previous, direction: 'right' as const } }
          : {}),
      });
      previous = id;
      added = true;
    }

    for (const [id, behind] of Object.entries(spec.stacked ?? {})) {
      const def = usable(id);
      if (!def || api.getPanel(id) || known.has(id)) continue;
      const reference = api.getPanel(behind) ? behind : api.panels[0]?.id;
      api.addPanel({
        id,
        component: id,
        title: def.title,
        ...(reference ? { position: { referencePanel: reference } } : {}),
      });
      added = true;
    }

    // Leave the first tab of each stack showing, not the last one added — but
    // only when something was actually added, or this would yank the operator
    // back to the first tab on every poll.
    if (!added) return;
    for (const id of spec.panels) api.getPanel(id)?.api.setActive();
    api.getPanel(spec.panels[0])?.api.setActive();
    this.persist();
  }

  /** Create views lazily, and show exactly one. */
  private syncViews(): void {
    const container = this.querySelector('.dv-container');
    if (!container) return;

    const active = this.page;

    // Crossing the breakpoint tears everything down and builds the other kind.
    // The panel elements survive it — they live in `elements`, not in whichever
    // container is holding them — so nothing loses its state on a rotation.
    const wantStack = this.narrow.matches;
    if (wantStack !== this.stacks.has(active.id) && (this.views.has(active.id) || this.stacks.has(active.id))) {
      this.teardown(active.id);
    }

    if (wantStack) {
      if (!this.stacks.has(active.id)) {
        const host = document.createElement('div');
        container.appendChild(host);
        this.createStack(active, host);
        this.stacks.add(active.id);
        this.stackHosts.set(active.id, host);
      }
      for (const [id, h] of this.stackHosts) h.style.display = id === active.id ? '' : 'none';
      for (const v of this.views.values()) v.host.style.display = 'none';
      return;
    }
    for (const h of this.stackHosts.values()) h.style.display = 'none';

    if (!this.views.has(active.id)) {
      const host = document.createElement('div');
      host.className = 'dv-host';
      container.appendChild(host);
      this.views.set(active.id, { api: this.createView(active, host), host });

      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.layoutActive());
        this.resizeObserver.observe(container);
      }
    }

    for (const [id, v] of this.views) {
      v.host.style.display = id === active.id ? '' : 'none';
      // Capabilities may have arrived since this view was created; a page that
      // seeded empty because the driver had not connected yet fills in here.
      const page = this.state.pages.find((p) => p.id === id);
      if (page) this.ensureDefaults(page, v.api);
    }
    // A hidden dockview has no size, so it must be told its dimensions when it
    // becomes visible or it renders collapsed.
    requestAnimationFrame(() => this.layoutActive());
  }

  private stackHosts = new Map<string, HTMLElement>();

  /** Drop whichever container a page is currently using, keeping its panels. */
  private teardown(pageId: string): void {
    const view = this.views.get(pageId);
    if (view) {
      view.api.dispose();
      view.host.remove();
      this.views.delete(pageId);
    }
    const stack = this.stackHosts.get(pageId);
    if (stack) {
      stack.remove();
      this.stackHosts.delete(pageId);
      this.stacks.delete(pageId);
    }
  }

  /** Rotating a phone, or dragging a window past the breakpoint. */
  private onBreakpoint = (): void => {
    this.requestUpdate();
    // After the render, so syncViews sees the container it is going to fill.
    void this.updateComplete.then(() => this.syncViews());
  };

  private layoutActive(): void {
    const container = this.querySelector('.dv-container') as HTMLElement | null;
    const view = this.views.get(this.page.id);
    if (!container || !view) return;
    view.api.layout(container.clientWidth, container.clientHeight);
  }

  // --- Panels & pages -----------------------------------------------------

  /**
   * Add a panel to a page that has no live dockview — the phone layout.
   *
   * Below the breakpoint the page is a tab strip, not a dockview, so there is
   * no api to call. The layout is still dockview's format though, and hand
   * editing that JSON to splice in a panel would be inventing a second, worse
   * implementation of something dockview already does correctly.
   *
   * So it builds one offscreen, from the layout as saved, adds the panel
   * through the real API, takes the JSON back and throws the dockview away.
   * The page then re-renders its strip from the new layout. It is a heavier
   * operation than it looks, and it happens once per press.
   *
   * This is why adding a panel used to be hidden on a phone. Hiding it was the
   * honest thing to do while it did nothing, but "arrange the page on a big
   * screen" is not an answer for somebody standing at the machine with only a
   * phone in their hand.
   */
  private addPanelOffscreen(page: PageState, panelId: string, def: PanelDefinition): void {
    const scratch = document.createElement('div');
    // Off-screen rather than display:none — dockview measures itself on
    // construction, and a zero-sized container makes it lay out into nothing.
    scratch.style.cssText = 'position:absolute;left:-10000px;top:0;width:1200px;height:800px';
    document.body.appendChild(scratch);
    try {
      const api = createDockview(scratch, {
        createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
        disableFloatingGroups: true,
        theme: dvTheme(theme.peek()),
      });
      if (page.layout) {
        try {
          api.fromJSON(page.layout as never);
        } catch {
          api.clear();
        }
      }
      if (!api.panels.length) {
        // A page that has never been opened wide has no saved layout, only the
        // defaults its strip is showing. Seed those first, or adding one panel
        // would replace every panel the operator can currently see.
        for (const p of this.panelsOf(page)) {
          api.addPanel({ id: p.instanceId, component: p.panelId, title: p.title });
        }
      }
      const id = api.getPanel(panelId) ? `${panelId}~${Date.now().toString(36)}` : panelId;
      api.addPanel({ id, component: panelId, title: def.title });
      page.layout = api.toJSON() as unknown as PageState['layout'];
      this.stackTab.set(page.id, id);
      api.dispose();
    } finally {
      scratch.remove();
    }
  }

  private addPanel(panelId: string): void {
    const view = this.views.get(this.page.id);
    const def = panelDefinition(panelId);
    if (!def) return;
    if (!view) {
      // The stacked phone layout. See addPanelOffscreen.
      this.addPanelOffscreen(this.page, panelId, def);
      closePanelPicker();
      this.persist();
      this.stackRender.get(this.page.id)?.();
      return;
    }
    // A panel already on this page gets a fresh instance id so it can appear twice.
    const id = view.api.getPanel(panelId) ? `${panelId}~${Date.now().toString(36)}` : panelId;
    // Into the group whose "+" was pressed. Without this the panel lands
    // wherever dockview feels like putting it, which after a press on a
    // specific tab bar is the wrong answer to a question the operator has
    // already answered by choosing which "+" to press.
    // referenceGroup takes the id directly, so a group that has since been
    // closed simply falls through to dockview's own placement rather than
    // throwing on a stale handle.
    const group = pickerGroup && view.api.getGroup(pickerGroup) ? pickerGroup : null;
    view.api.addPanel({
      id,
      component: panelId,
      title: def.title,
      ...(group ? { position: { referenceGroup: group } } : {}),
    });
    closePanelPicker();
    this.persist();
  }

  addPage(): void {
    const id = `page-${Date.now().toString(36)}`;
    this.state.pages.push({ id, name: `Page ${this.state.pages.length + 1}`, layout: null });
    this.state.active = this.state.pages.length - 1;
    this.persist();
  }

  removePage(index: number): void {
    if (this.state.pages.length <= 1) return;
    const page = this.state.pages[index];
    if (!confirm(`Delete the "${page.name}" page?`)) return;
    const view = this.views.get(page.id);
    if (view) {
      view.api.dispose();
      view.host.remove();
      this.views.delete(page.id);
    }
    this.state.pages.splice(index, 1);
    this.state.active = Math.max(0, Math.min(this.state.active, this.state.pages.length - 1));
    this.persist();
  }

  renamePage(index: number, name: string): void {
    this.state.pages[index].name = name || this.state.pages[index].name;
    renamingPage.set(null);
    this.persist();
  }

  private resetAll(): void {
    for (const { api, host } of this.views.values()) {
      api.dispose();
      host.remove();
    }
    this.views.clear();
    this.elements.clear();
    this.state = defaultLayout();
    panelPickerOpen.set(false);
    this.persist();
  }

  // --- Render -------------------------------------------------------------

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const available = panelDefinitions().filter((d) => !d.available || d.available(caps));

    return html`
      <div class="dv-container"></div>

      ${panelPickerOpen.get()
        ? html`
            <div class="picker">
              <div class="picker-list">
                ${available.map(
                  (d) => html`
                    <button class="picker-item" @click=${() => this.addPanel(d.id)}>
                      <strong>${d.title}</strong>
                      ${d.description ? html`<small>${d.description}</small>` : nothing}
                    </button>
                  `,
                )}
              </div>
              <div class="picker-foot">
                <button class="ghost" @click=${() => this.resetAll()}>Reset all pages</button>
                <button class="ghost" @click=${() => panelPickerOpen.set(false)}>
                  Close
                </button>
              </div>
            </div>
          `
        : nothing}
    `;
  }
}

/**
 * dockview 7 applies its theme to an inner shell element it creates itself,
 * defaulting to `abyss` — so setting a theme class on the container does
 * nothing, and the container's own variables are shadowed by the shell's. It
 * has to come through the `theme` option instead.
 *
 * The class names here are dockview's own stylesheet; our overrides in
 * styles.css then re-point its variables at the app palette.
 */
function dvTheme(t: 'light' | 'dark'): DockviewTheme {
  return t === 'dark'
    ? { name: 'app-dark', className: 'dockview-theme-dark', colorScheme: 'dark' }
    : { name: 'app-light', className: 'dockview-theme-light', colorScheme: 'light' };
}

function load(): LayoutState {
  const stored = loadSetting<LayoutState | null>('dockLayout', null);
  if (stored && Array.isArray(stored.pages) && stored.pages.length) return stored;
  return defaultLayout();
}

customElements.define('cnc-dashboard', DashboardHost);
