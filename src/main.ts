// Entry point.

// First import, deliberately: an old Safari is missing APIs that dockview
// constructs unguarded, and the failure is a blank page. Imports are evaluated
// in order, so this module's side effect lands before any other module runs —
// a call placed here instead would not, because imports are hoisted above it.
import './core/compat.js';

import './panels/index.js';
import './ui/topbar.js';
import './ui/messagebox.js';
import './ui/grant.js';
import './ui/layout.js';

import {
  actions,
  appendLog,
  connect,
  controllerUrl,
  driverId,
  loadSetting,
  machine,
} from './core/store.js';
import { syncOnConnect } from './core/settings.js';
import { loadInstalled, registerCachedPanels } from './plugins/host.js';
import { initTheme } from './core/theme.js';
import { suppressDoubleTapZoom } from './ui/touch.js';

// Before first paint, so there is no flash of the wrong theme.
initTheme();
suppressDoubleTapZoom();

// Before the dashboard is built, not after: the layout drops a saved panel
// whose definition it cannot find, and then persists what is left. A plugin
// panel registered a second later — which is as fast as the card can be read —
// would already have been erased from the layout it was arranged into.
registerCachedPanels();

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

root.innerHTML = `
  <cnc-topbar></cnc-topbar>
  <cnc-dashboard></cnc-dashboard>
  <cnc-messagebox></cnc-messagebox>
  <cnc-plugin-grant></cnc-plugin-grant>
`;

// Reconnect on load if enabled. Served from the controller itself, this makes
// the page usable with no interaction at all.
if (loadSetting('autoConnect', true)) {
  void connect(controllerUrl.peek(), driverId.peek())
    .then(adoptMachineSettings)
    .then(startPlugins)
    .catch(() => {
      // Already surfaced in the top bar.
    });
}

// Plugins, once and then again when there is a machine to read them from.
//
// Most of them live on the controller's card, which is unreadable until a
// driver is connected — but a browser-stored plugin is not, and someone
// working on one with the machine switched off should still see it. So this
// runs regardless, and again on connect; loadInstalled is written to be safe
// to call twice.
void startPlugins();

async function startPlugins(): Promise<void> {
  try {
    await loadInstalled();
  } catch (err) {
    appendLog({
      level: 'error',
      text: `Plugins failed to load: ${(err as Error).message}`,
      time: new Date(),
    });
  }
}

/**
 * If this browser has opted in, take the controller's copy of the UI settings.
 *
 * One-way and idempotent — after applying, the two agree, so the next
 * connection finds nothing to do and there is no reload loop. The reload is
 * because the dock layout is read once when the dashboard is built; writing new
 * values into storage would otherwise change nothing visible until the next
 * time the page happened to be opened.
 */
async function adoptMachineSettings(): Promise<void> {
  const changed = await syncOnConnect();
  if (!changed.length) return;
  appendLog({
    level: 'info',
    text: `Adopted the machine's settings (${changed.join(', ')}) — reloading`,
    time: new Date(),
  });
  // A beat, so the log line is actually written before the page goes away.
  setTimeout(() => location.reload(), 250);
}

// Global E-stop: Escape twice within 500 ms. Deliberately not a single press —
// Escape also dismisses dialogs, and an accidental halt mid-cut is its own kind
// of damage.
let lastEscape = 0;
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const now = performance.now();
  if (now - lastEscape < 500) {
    lastEscape = 0;
    void actions.estop();
  } else {
    lastEscape = now;
  }
});

// Warn before navigating away mid-job.
window.addEventListener('beforeunload', (e) => {
  const status = machine.peek().status;
  if (status === 'running' || status === 'tool-change' || status === 'paused') {
    e.preventDefault();
    e.returnValue = '';
  }
});
