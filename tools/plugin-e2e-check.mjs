// A plugin, end to end, in a real browser: scaffold it, grant it, run it.
//
// The unit checks cover the pieces — the manifest rules, the CSP, the
// permission table, the storage backends — and tools/plugin-isolation-check.mjs
// covers the walls. None of them answer the only question an operator has,
// which is whether pressing "New plugin" produces something that works. This
// drives the app itself against the mock controller and watches a plugin
// install, ask for permission, render, receive live machine state through the
// bridge, be refused something it did not ask for, and keep its data across a
// reload.
//
// Playwright is not a dependency — see tools/prompt-browser.mjs. Skips when
// absent. Set CHROME_PATH if a Chromium is installed that playwright did not
// download itself.
//
//   npm run plugin-e2e-check

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed — skipping. See the note at the top of this file.');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8170, URL_ = `http://127.0.0.1:${PORT}`;
const mock = spawn(process.execPath, [`${ROOT}/tools/mock-rrf.mjs`, String(PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { mock.kill(); } catch {} });
for (let i=0;i<60;i++){ try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise(r=>setTimeout(r,100)); } }
const fails=[]; const ok=(c,w,x='')=>{ console.log(`${c?'PASS':'FAIL'}  ${w}${x?'  '+x:''}`); if(!c) fails.push(w); };

let b;
try {
  b = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log(`no browser to drive (${e.message.split('\n')[0]}) — skipping.`);
  process.exit(0);
}
const p = await b.newPage();
const errors=[]; p.on('pageerror',e=>errors.push(e.message));
await p.goto(`${URL_}/index.html`,{waitUntil:'domcontentloaded',timeout:20000});
await p.waitForTimeout(3000);

const openPanel = async (name) => {
  await p.locator('button.tab-add').first().click({ force: true });
  await p.waitForSelector('.picker-item', { timeout: 5000 });
  await p.locator('.picker-item').filter({ hasText: name }).first().click();
  await p.waitForTimeout(1200);
};
await openPanel('Plugins');

// Scaffold
await p.locator('button', { hasText: /New plugin/ }).first().click();
await p.waitForTimeout(1500);
const panelText = () => p.locator('cnc-plugins').innerText();
ok(/hello|Hello|example|Example/i.test(await panelText()), 'the scaffold installs and appears');

// Grant, if asked
const grant = p.locator('cnc-plugin-grant');
const askedFor = await grant.innerText().catch(()=> '');
ok(askedFor.length > 0, 'the grant dialog asks before the plugin runs', askedFor.slice(0,200).replace(/\n/g,' | '));
const grantBtn = grant.locator('button', { hasText: /Grant/ }).first();
if (await grantBtn.count()) { await grantBtn.click(); await p.waitForTimeout(1500); }
ok((await grant.innerText().catch(()=> '')).length === 0, 'and closes once answered');

// The plugin's own panel
await p.waitForTimeout(800);
await p.locator('button.tab-add').first().click({ force: true });
await p.waitForSelector('.picker-item', { timeout: 5000 });
const picks = await p.locator('.picker-item').allInnerTexts();
ok(picks.some(t => /hello|example/i.test(t)), 'the plugin offers its panel in the picker', picks.join(' / ').slice(0,200));
const pick = p.locator('.picker-item').filter({ hasText: /hello|example/i }).first();
if (await pick.count()) { await pick.click(); await p.waitForTimeout(2500); }

const frame = p.locator('cnc-plugin-panel iframe');
ok(await frame.count() === 1, 'its panel is a single sandboxed frame', String(await frame.count()));
ok(await frame.getAttribute('sandbox') === 'allow-scripts', 'with allow-scripts and nothing else',
   String(await frame.getAttribute('sandbox')));

const inner = p.frameLocator('cnc-plugin-panel iframe');
const body = await inner.locator('body').innerText().catch(()=> '(unreadable)');
ok(/\d/.test(body), 'and the plugin is rendering something live', body.slice(0,200).replace(/\n/g,' | '));

// Machine state actually reaches it: move the machine, watch the number change.
const before = body;
await fetch(`${URL_}/rr_gcode?gcode=${encodeURIComponent('G0 X123.456')}`);
await p.waitForTimeout(2500);
const after = await inner.locator('body').innerText().catch(()=> '');
ok(after !== before, 'a machine move reaches the plugin through the bridge',
   `${before.slice(0,60).replace(/\n/g,' ')} -> ${after.slice(0,60).replace(/\n/g,' ')}`);
ok(/123\.4/.test(after), '  and it is the position the machine actually moved to', after.slice(0,120).replace(/\n/g,' | '));


// --- the counter survives a reload ------------------------------------------

// Not a UI detail: it is the whole claim of the storage layer. The frame is
// rebuilt from scratch on a reload, so a count that comes back came out of
// IndexedDB and not out of a variable.
const counter = inner.locator('button.primary');
await counter.click();
await counter.click();
await p.waitForTimeout(1200);
ok(/Clicked 2 times/.test(await inner.locator('body').innerText()), 'the counter counts',
   (await inner.locator('body').innerText()).slice(-40).replace(/\n/g, ' '));

await p.reload({ waitUntil: 'domcontentloaded' });
// The plugin's frame is rebuilt from nothing, and the plugins it is rebuilt
// from are only readable once a driver has connected — so this waits for the
// text rather than for a fixed delay, which would be a flake waiting to happen.
await p.waitForSelector('cnc-plugin-panel iframe', { timeout: 20000 }).catch(() => {});
const revived = p.frameLocator('cnc-plugin-panel iframe');
let afterReload = '';
for (let i = 0; i < 40; i++) {
  afterReload = await revived.locator('body').innerText().catch(() => '');
  if (/Clicked/.test(afterReload)) break;
  await p.waitForTimeout(500);
}
ok(/Clicked 2 times/.test(afterReload), 'and the count is still there after a reload',
   afterReload.slice(-60).replace(/\n/g, ' '));

// --- a permission it did not ask for ----------------------------------------

// The scaffold holds machine.read and nothing else. A plugin that reaches past
// that has to be refused, and the refusal has to be visible — a plugin that
// silently does nothing is the failure this system must not produce.
const PROBER = `/* @plugin {
  "id": "com.example.prober",
  "name": "Prober",
  "version": "1.0.0",
  "api": 1,
  "panel": { "title": "Prober" },
  "permissions": ["machine.read"],
  "provides": [],
  "uses": []
} */
axis.machine.send('G0 X1').then(
  function () { axis.log.error('THE COMMAND WENT THROUGH'); },
  function (err) { axis.log.info('refused as it should be: ' + err.message); }
);
`;
// The reload restored the layout with the plugin's own panel in front, so the
// Plugins tab has to be brought back before its controls are reachable.
const pluginsTab = p.locator('.dv-tab, .tab', { hasText: 'Plugins' }).first();
if (await pluginsTab.count()) { await pluginsTab.click(); await p.waitForTimeout(800); }
await p.locator('cnc-plugins .plug-paste').fill(PROBER, { timeout: 15000 });
await p.locator('button', { hasText: 'Install pasted source' }).first().click();
await p.waitForTimeout(1500);
const g2 = p.locator('cnc-plugin-grant button', { hasText: /Grant/ }).first();
if (await g2.count()) { await g2.click(); await p.waitForTimeout(2000); }

// Its code does not run until a panel of its own is open: a plugin with no
// panel and no `background` permission has nowhere to execute, which is the
// design and not an accident. So open it, and only then look for the refusal.
await p.locator('button.tab-add').first().click({ force: true });
await p.waitForSelector('.picker-item', { timeout: 5000 });
const proberPick = p.locator('.picker-item').filter({ hasText: 'Prober' }).first();
ok(await proberPick.count() > 0, 'the prober offers its panel');
await proberPick.click();
await p.waitForTimeout(2500);

const pluginsTab2 = p.locator('.dv-tab, .tab', { hasText: 'Plugins' }).first();
if (await pluginsTab2.count()) { await pluginsTab2.click(); await p.waitForTimeout(800); }
const logText = await p.locator('cnc-plugins').innerText();
ok(/refused as it should be/i.test(logText), 'a call past the granted permissions is refused',
   (logText.match(/refused as it should be[^\n]*/) ?? [''])[0].slice(0, 140));
ok(/machine\.command/.test(logText), '  and the refusal names the permission that was missing');
ok(!/THE COMMAND WENT THROUGH/.test(logText), '  and the command did not reach the machine');

await p.screenshot({ path: join(ROOT, 'plugin-e2e.png') });
ok(errors.length === 0, 'no page errors throughout', errors.slice(0,2).join(' | '));
await b.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
