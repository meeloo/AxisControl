// The plugin sandbox, attacked from inside it, in a real browser.
//
// Every other check in this repo can run in node. This one cannot, because the
// thing being checked is not our code — it is the browser's enforcement of an
// opaque origin, and node has no opinion about that. The claim in
// docs/plugins.md is that a plugin cannot reach the host DOM, storage, cookies,
// the network, or the app's own origin. A claim like that is worth nothing
// until something hostile has tried.
//
// What this does NOT cover, deliberately: the permission checks in
// src/plugins/bridge.ts, which are our code and are covered from node by
// tools/plugin-bridge-check.mjs. This file is only about the walls.
//
// Playwright is not a dependency — see tools/prompt-browser.mjs. Skips when
// absent. Set CHROME_PATH if a Chromium is installed that playwright did not
// download itself.
//
//   npm run plugin-isolation-check

import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed — skipping. See the note at the top of this file.');
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'iso-'));
const out = join(dir, 'guest.mjs');
const entry = join(dir, 'entry.ts');
await writeFile(entry, `export * as guest from ${JSON.stringify(join(root, 'src/plugins/guest.ts'))};\n`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { guest } = await import(pathToFileURL(out).href);

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

// The plugin. Every probe is a thing a plugin should not be able to do; each
// records what happened rather than throwing, so one failure does not hide the
// rest. `escaped` is the </script> break-out: if the escaping in frameHtml is
// wrong, the injected script runs and sets window.__escaped before this does.
const HOSTILE = `
const results = {};
const probe = (name, fn) => {
  try {
    const v = fn();
    results[name] = v instanceof Promise ? 'pending' : { reached: true, value: String(v).slice(0, 60) };
    if (v instanceof Promise) v.then(() => (results[name] = { reached: true, value: 'resolved' }),
                                     (e) => (results[name] = { reached: false, error: String(e).slice(0, 80) }));
  } catch (e) {
    results[name] = { reached: false, error: String(e).slice(0, 80) };
  }
};

probe('parent.document', () => parent.document.title);
probe('parent.location.href', () => parent.location.href);
probe('top.location.href', () => top.location.href);
probe('parent.window.axisHostSecret', () => parent.axisHostSecret);
probe('localStorage', () => localStorage.getItem('cnc.controllerUrl'));
probe('sessionStorage', () => sessionStorage.length);
probe('document.cookie', () => document.cookie);
probe('indexedDB', () => indexedDB.open('axiscontrol-plugins'));
probe('caches', () => caches.keys());
probe('serviceWorker', () => navigator.serviceWorker.getRegistrations());
probe('fetch same-origin', () => fetch('/rr_model?key=state'));
probe('fetch absolute', () => fetch(HOST_ORIGIN + '/rr_model?key=state'));
probe('XHR', () => { const x = new XMLHttpRequest(); x.open('GET', HOST_ORIGIN + '/rr_model'); x.send(); return 'sent'; });
// A WebSocket is not blocked by throwing — Chrome constructs the object and
// then fails it. So the honest question is not "did the constructor throw" but
// "did anything reach the server", which the host side checks below.
probe('WebSocket', () => {
  const ws = new WebSocket(HOST_ORIGIN.replace('http:', 'ws:') + '/spy');
  ws.onopen = () => { results.wsOpened = true; try { ws.send('exfiltrated'); } catch {} };
  return 'constructed, state ' + ws.readyState;
});
probe('EventSource', () => new EventSource(HOST_ORIGIN + '/x'));
probe('image beacon', () => { const i = new Image(); i.src = HOST_ORIGIN + '/icon-180.png'; return 'set'; });
probe('dynamic import', () => import(HOST_ORIGIN + '/cnc.js'));
probe('top.postMessage cross', () => { top.postMessage('x', '*'); return 'sent'; });
probe('window.open', () => window.open(HOST_ORIGIN));

results.escaped = typeof window.__escaped !== 'undefined';
results.hasAxis = typeof axis === 'object' && axis !== null;
results.axisFrozen = (() => { try { axis.machine = null; return axis.machine !== null; } catch { return true; } })();
results.origin = String(location.origin);

// Give the async probes a moment, then report to whoever is listening.
setTimeout(() => parent.postMessage({ __probe: results }, '*'), 900);
`;

// The break-out attempt, appended to the hostile plugin's own source.
const BREAKOUT = `\n// </script><script>window.__escaped = true;</script>\n`;

const manifest = {
  id: 'net.example.hostile',
  name: 'Hostile',
  version: '1.0.0',
  api: 1,
  permissions: [],
  provides: [],
  uses: [],
  panel: { title: 'Hostile' },
};

const PORT = 8141;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const srcdoc = guest.frameHtml(
  manifest,
  [],
  `const HOST_ORIGIN = ${JSON.stringify(ORIGIN)};\n${HOSTILE}${BREAKOUT}`,
  undefined,
  { '--bg': '#111', '--text': '#eee' },
);

// A host page on a real origin, so the frame's opaque origin is opaque
// relative to something — about:blank would make the parent null too and the
// test would prove less than it appears to.
const page = `<!doctype html><meta charset="utf-8"><title>host</title>
<script>
  window.axisHostSecret = 'the-host-secret';
  window.__probe = null;
  addEventListener('message', (e) => { if (e.data && e.data.__probe) window.__probe = e.data.__probe; });
</script>
<iframe id="f" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${srcdoc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;

// Everything the frame manages to reach us by, recorded. This is the check
// that actually matters: a probe that "fails" in the frame while the request
// still leaves the browser is not a denial, it is a denial that did not happen.
const reached = [];
const server = createServer((req, res) => {
  // '/' is the harness's own page and '/favicon.ico' is the browser asking for
  // a favicon for it — both are the top-level document, not the frame.
  if (req.url !== '/' && req.url !== '/favicon.ico') reached.push(`${req.method} ${req.url}`);
  if (req.url.startsWith('/rr_model')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"result":{"status":"idle"}}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});
server.on('upgrade', (req, socket) => {
  reached.push(`UPGRADE ${req.url}`);
  socket.destroy();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log(`no browser to drive (${e.message.split('\n')[0]}) — skipping.`);
  server.close();
  process.exit(0);
}

const tab = await browser.newPage();
await tab.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 20000 });
await tab.waitForFunction('window.__probe !== null', null, { timeout: 15000 }).catch(() => {});
const r = await tab.evaluate('window.__probe');

if (!r) {
  console.log('FAIL  the plugin never reported — the frame did not run at all');
  await browser.close();
  server.close();
  process.exit(1);
}

const blocked = (name) => ok(r[name] && r[name].reached === false, `${name} is denied`, r[name]?.error ?? JSON.stringify(r[name]));

ok(r.hasAxis === true, 'the plugin gets its `axis` global');
ok(r.origin === 'null', 'and runs on an opaque origin', r.origin);
ok(r.escaped === false, 'a plugin containing </script> cannot break out of the element');
ok(r.axisFrozen === true, 'the axis object cannot be swapped out from under the plugin');

blocked('parent.document');
blocked('parent.location.href');
blocked('top.location.href');
blocked('parent.window.axisHostSecret');
blocked('localStorage');
blocked('sessionStorage');
blocked('indexedDB');
blocked('fetch same-origin');
blocked('fetch absolute');
blocked('dynamic import');

// Cookies and caches are absent rather than throwing in some engines; either is
// a denial, an empty string is not a leak.
ok(!r['document.cookie']?.value, 'cookies are not readable', JSON.stringify(r['document.cookie']));
ok(r['caches']?.reached === false || r['caches']?.value === 'undefined',
   'the app caches are not reachable', JSON.stringify(r['caches']));
ok(r['serviceWorker']?.reached === false || r['serviceWorker']?.value === 'undefined',
   'the service worker is not reachable', JSON.stringify(r['serviceWorker']));
ok(r['window.open']?.reached === false || r['window.open']?.value === 'null',
   'a plugin cannot open a window', JSON.stringify(r['window.open']));

// The server's own account, which is the one that cannot be talked out of.
// Every probe above aimed something at this origin; the page load itself is
// excluded, so anything here is something that got out.
ok(reached.length === 0, 'nothing the plugin aimed at the host origin ever arrived',
   reached.join(', ') || 'no requests');
ok(r.wsOpened !== true, '  and the WebSocket never opened, whatever the constructor did',
   String(r.wsOpened));

await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
