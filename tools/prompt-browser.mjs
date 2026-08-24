// The blocking-prompt dialog, driven in a real browser against the mock.
//
// This is the first browser-driven check in the repo, and it is here because
// the M291 modes could not be checked any other way: om-check proves the mode
// numbers map to the right names, but only a browser proves that mode 6 draws
// a number field and answers `R12.5` rather than drawing a text box and
// answering `R"12.5"`, which the firmware refuses and which left the macro
// waiting forever.
//
// Playwright is NOT a dependency of this project — one browser download is a
// lot to impose on everyone for one test file. If it is not installed this
// skips rather than fails. To run it:
//
//   npm i -D playwright && npx playwright install chromium
//   npm run prompt-check
//
// The mock raises each prompt through its own `M999 PROMPT<n>` hook. That hook
// deliberately does not parse M291: what this app consumes is the object
// model, so the hook writes the object model, and the mapping from M291's
// parameter letters to those fields stays the firmware's business.

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
const PORT = 8139;
const URL_ = `http://127.0.0.1:${PORT}`;
const mock = spawn(process.execPath, [`${ROOT}/tools/mock-rrf.mjs`, String(PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { mock.kill(); } catch {} });
for (let i = 0; i < 60; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

let browser;
try {
  // CHROME_PATH covers the case where a Chromium is present but not the build
  // this Playwright would download for itself — CI images and sandboxes both
  // do that, and downloading a second browser to run one test is silly.
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log(`no browser to drive (${e.message.split('\n')[0]}) — skipping.`);
  process.exit(0);
}
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${URL_}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(2500);

const sent = async () => (await fetch(`${URL_}/__sent`).then((r) => r.json()));
const raise = async (mode) => {
  await fetch(`${URL_}/rr_gcode?gcode=${encodeURIComponent(`M999 PROMPT${mode}`)}`);
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.waitForTimeout(400);
};
const lastM292 = async () => {
  const s = await sent();
  const list = Array.isArray(s) ? s : (s.sent ?? s.commands ?? []);
  return [...list].reverse().find((c) => String(c).startsWith('M292')) ?? null;
};

// --- Mode 5: integer, prefilled, bounded ------------------------------------
await raise(5);
ok(await page.locator('.modal-input').count() === 1, 'S5 shows an input');
ok(await page.locator('.modal-input').inputValue() === '3', 'S5 is prefilled from the prompt default',
   await page.locator('.modal-input').inputValue());
ok(await page.locator('.modal-input').getAttribute('type') === 'number', '  as a number field');
ok(await page.locator('.modal-input').getAttribute('step') === '1', '  stepping by 1, because it is an integer');
ok(await page.locator('.modal-input').getAttribute('min') === '1'
   && await page.locator('.modal-input').getAttribute('max') === '8', '  and carrying the bounds');
await page.locator('.modal-buttons button.primary').click();
await page.waitForTimeout(500);
ok(/^M292 P0 S\d+ R3$/.test(await lastM292() ?? ''), 'answering S5 sends a bare number', await lastM292());

// --- Mode 6: float, which used to be a text box answered with a quoted string
await raise(6);
ok(await page.locator('.modal-input').getAttribute('type') === 'number', 'S6 is a number field, not text');
ok(await page.locator('.modal-input').getAttribute('step') === 'any', '  stepping freely, because it is a float');
ok(await page.locator('.modal-input').inputValue() === '12.5', '  prefilled', await page.locator('.modal-input').inputValue());
await page.locator('.modal-buttons button.primary').click();
await page.waitForTimeout(500);
const m6 = await lastM292();
ok(/^M292 P0 S\d+ R12\.5$/.test(m6 ?? ''), 'answering S6 sends an unquoted number', m6);
ok(!/"/.test(m6 ?? ''), '  and not the quoted string the firmware refuses');

// --- Mode 4: multiple choice -------------------------------------------------
await raise(4);
const choices = page.locator('.modal-choices .choice');
ok(await choices.count() === 3, 'S4 shows the choices', String(await choices.count()));
ok(await choices.nth(1).textContent() === 'The second one', '  with their own labels');
ok(await page.locator('.modal-buttons button.primary').count() === 0, '  and no OK button beside them');
ok(await page.locator('.modal-input').count() === 0, '  and no number box, which is what it used to be');
await choices.nth(1).click();
await page.waitForTimeout(500);
ok(/^M292 P0 S\d+ R1$/.test(await lastM292() ?? ''), 'choosing sends the index', await lastM292());

// --- Mode 7 and mode 0 -------------------------------------------------------
await raise(7);
ok(await page.locator('.modal-input').getAttribute('type') === 'text', 'S7 is a text field');
ok(await page.locator('.modal-input').inputValue() === 'workpiece', '  prefilled');
await page.locator('.modal-buttons button.primary').click();
await page.waitForTimeout(500);
ok(/^M292 P0 S\d+ R"workpiece"$/.test(await lastM292() ?? ''), 'answering S7 quotes the string', await lastM292());

await raise(0);
ok(await page.locator('.modal-buttons button.primary').count() === 0, 'S0 offers no OK');
ok(await page.locator('.modal-buttons .hint').count() === 1, '  just the waiting note');
ok(await page.locator('.modal-buttons button.ghost').count() === 0, '  and no cancel, because the box says there is none');

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
