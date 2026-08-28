// Flashing a local file, driven through the panel in a real browser.
//
// tools/firmware-check.mjs covers the planner, which is where the refusals are
// decided. This covers the part a person actually touches: that choosing a file
// reads and describes it before anything is written, that a bad file is
// reported instead of staged, that the name check gates the button rather than
// merely printing a warning, and that "Put it on the card" really does put it
// on the card — under the name the board asked for, not the name it arrived
// with.
//
// It stops before M997. Nothing here tells the mock to flash: the value of
// asserting that a fake board accepts a fake flash is zero, and the risk of
// building the habit of clicking it is not.
//
// Playwright is not a dependency — see tools/prompt-browser.mjs. Skips when
// absent; set CHROME_PATH for a Chromium it did not download itself.
//
//   npm run firmware-browser-check

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
const PORT = 8180;
const URL_ = `http://127.0.0.1:${PORT}`;
const mock = spawn(process.execPath, [join(ROOT, 'tools/mock-rrf.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { mock.kill(); } catch { /* already gone */ } });
for (let i = 0; i < 60; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

// What this board asks for, read from the mock rather than assumed — the app
// uses whatever the board says, and so must the test.
const boards = await fetch(`${URL_}/rr_model?key=boards&flags=v99d99`).then((r) => r.json());
const board = boards.result[0];
const WANTED = board.firmwareFileName;
const IAP = board.iapFileNameSD;
ok(!!WANTED && !!IAP, 'the board names its image and its programmer', `${WANTED}, ${IAP}`);

const image = Buffer.alloc(400 * 1024);
for (let i = 0; i < image.length; i++) image[i] = (i * 7) & 0xff;

let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log(`no browser to drive (${e.message.split('\n')[0]}) — skipping.`);
  process.exit(0);
}

const p = await browser.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.goto(`${URL_}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await p.waitForTimeout(3000);

await p.locator('button.tab-add').first().click({ force: true });
await p.waitForSelector('.picker-item', { timeout: 5000 });
await p.locator('.picker-item').filter({ hasText: 'Firmware' }).first().click();
await p.waitForTimeout(1500);
ok(await p.locator('cnc-firmware').count() === 1, 'the Firmware panel opens');
ok(/From a file/.test(await p.locator('cnc-firmware').innerText()), 'and offers a file of your own');

const input = p.locator('cnc-firmware input[type=file]');
const stageBtn = p.locator('cnc-firmware button', { hasText: 'Put it on the card' }).first();
const choose = async (name, buffer) => {
  await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await p.waitForTimeout(1200);
};

// --- A file that is not firmware -------------------------------------------

await choose('tiny.bin', Buffer.alloc(2000));
ok(/No board image is that small/.test(await p.locator('cnc-firmware').innerText()),
   'a truncated file is described as such, in place, before anything is written');
ok(await stageBtn.isDisabled(), '  and cannot be staged');

await choose('lying.uf2', Buffer.alloc(400 * 1024));
ok(/does not begin with the UF2 magic/.test(await p.locator('cnc-firmware').innerText()),
   'a file named .uf2 that is not one is refused by name');
ok(await stageBtn.isDisabled(), '  and cannot be staged either');

// --- A file for the wrong board --------------------------------------------

const variant = WANTED.replace(/(\.\w+)$/, '_SBC$1');
await choose(variant, image);
const text = await p.locator('cnc-firmware').innerText();
ok(/not the file .* asks for/i.test(text) || /is not the file/i.test(text),
   'a variant of this board is flagged, not accepted', text.match(/This is not the file[^\n]*/)?.[0] ?? '');
ok(await stageBtn.isDisabled(), '  and the button stays disabled until it is acknowledged');
await p.locator('cnc-firmware .warn-banner input[type=checkbox]').check();
await p.waitForTimeout(400);
ok(!(await stageBtn.isDisabled()), '  the acknowledgement is what enables it');

// --- The right file, with no programmer on the card -------------------------

await choose(WANTED, image);
ok(!(await stageBtn.isDisabled()), 'the file the board asks for needs no acknowledgement');
await stageBtn.click();
await p.waitForTimeout(2500);
ok(/programmer the board copies into RAM/.test(await p.locator('cnc-firmware').innerText()),
   'with no IAP anywhere it refuses rather than staging half an update');

// Put one on the card, the way a full release would have.
await fetch(`${URL_}/rr_upload?name=/firmware/${IAP}&crc32=0`, { method: 'POST', body: Buffer.alloc(40000) });

await choose(WANTED, image);
await stageBtn.click();
for (let i = 0; i < 30; i++) {
  if (/not yet flashed/.test(await p.locator('cnc-firmware').innerText())) break;
  await p.waitForTimeout(500);
}
const staged = await p.locator('cnc-firmware').innerText();
ok(/not yet flashed/.test(staged), 'with the programmer present it stages, and stops there',
   staged.match(/[^\n]*not yet flashed[^\n]*/)?.[0] ?? '');
ok(/M997 S0/.test(staged) && !/M997 B/.test(staged),
   '  naming only the main board — one file is one board');

// The card is the thing that matters.
const onCard = await fetch(`${URL_}/rr_download?name=/firmware/${WANTED}`).then((r) => r.arrayBuffer());
ok(onCard.byteLength === image.length, 'the image is on the card, whole',
   `${onCard.byteLength} of ${image.length} bytes`);
ok(Buffer.from(onCard).equals(image), '  and byte for byte what was chosen');

const listing = await fetch(`${URL_}/rr_filelist?dir=/firmware`).then((r) => r.json());
ok((listing.files ?? []).some((f) => f.name === WANTED),
   '  and the firmware directory lists it', (listing.files ?? []).map((f) => f.name).join(', '));

ok(errors.length === 0, 'no page errors throughout', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
