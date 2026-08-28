// The board's session table, and whether this app gives sessions back.
//
// RepRapFirmware keeps a small table of HTTP sessions and holds an abandoned
// one until it times out. A page reload does not close a session by itself —
// the tab is gone before anything it awaits can run — so a client that does not
// release on unload leaks one per reload. Reloading is exactly what anyone does
// when the interface stops responding, so the failure arrives at the worst
// moment and then looks like the board: rr_connect answers err:2, nothing
// connects, and the obvious next move is another reload.
//
// The mock models the table for this: a limit, err:2 when it is full, release
// on rr_disconnect, and expiry after the idle timeout the board reports. It did
// not before, which is why a leak could never have been caught here.
//
// Playwright is not a dependency — see tools/prompt-browser.mjs. Skips when
// absent; set CHROME_PATH for a Chromium it did not download itself.
//
//   npm run session-check

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
const PORT = 8216;
const URL_ = `http://127.0.0.1:${PORT}`;
const mock = spawn(process.execPath, [join(ROOT, 'tools/mock-rrf.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { mock.kill(); } catch { /* already gone */ } });
for (let i = 0; i < 60; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };
const sessions = () => fetch(`${URL_}/__sessions`).then((r) => r.json());

// --- The board's own behaviour, before any browser is involved --------------

await fetch(`${URL_}/rr_disconnect`); // release the probe above
let open = (await sessions()).open;
const max = (await sessions()).max;
for (let i = open; i < max; i++) await fetch(`${URL_}/rr_connect?password=&sessionKey=yes`);
ok((await sessions()).open === max, 'the table fills', `${(await sessions()).open}/${max}`);
const refused = await fetch(`${URL_}/rr_connect?password=`).then((r) => r.json());
ok(refused.err === 2, 'and a connect past the limit is refused with err:2, not err:1',
   `err ${refused.err}`);
// The two codes are different things and the app must not conflate them:
// err:1 is a wrong password, err:2 is a full table. Told the wrong story, an
// operator goes hunting for a password problem that was never there. The mock
// has no password set, so only the second is reachable here — the mapping
// itself is pinned in the client, which throws distinct messages for each.

for (let i = 0; i < max; i++) await fetch(`${URL_}/rr_disconnect`);
ok((await sessions()).open === 0, 'and disconnecting gives them all back');

// --- What the app does across reloads ---------------------------------------

let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log(`no browser to drive (${e.message.split('\n')[0]}) — skipping the rest.`);
  process.exit(fails.length ? 1 : 0);
}

const p = await browser.newPage();
await p.goto(`${URL_}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await p.waitForTimeout(2500);
const first = (await sessions()).open;
ok(first === 1, 'one page load takes one session', `${first}`);

// Nine, which is more than the table holds. The old client reached the limit
// here; the timeout is what stopped it looking even worse.
let peak = first;
for (let i = 0; i < 9; i++) {
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1100);
  peak = Math.max(peak, (await sessions()).open);
}
ok(peak <= 2, 'and nine reloads still take one — the session is handed back on unload',
   `peak ${peak} of ${max}`);

const body = await p.locator('body').innerText();
ok(!/no free sessions/i.test(body), 'so the app never talks itself out of connecting');

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
