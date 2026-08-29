// The Jog pad's layout, at sizes a window actually gets to.
//
// This exists because of a bug that no unit test could have caught and that
// looked, in a screenshot from the machine, like two controls drawn on top of
// each other. The strip is 48:224 and took its width from `height: 100%`, so on
// a tall window the derived width grew without bound: with one strip it merely
// squeezed the stick, and with two — which is what a dust-shoe U axis adds —
// they overflowed their holders and overlapped.
//
// So the assertions are about geometry rather than appearance: nothing overlaps
// anything, no control is squeezed to nothing, and it holds from a laptop
// window up to a desk monitor.
//
// Playwright is not a dependency — see tools/prompt-browser.mjs. Skips when
// absent; set CHROME_PATH for a Chromium it did not download itself.
//
//   npm run jog-browser-check

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
const PORT = 8206;
const URL_ = `http://127.0.0.1:${PORT}`;
const mock = spawn(process.execPath, [join(ROOT, 'tools/mock-rrf.mjs'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { mock.kill(); } catch { /* already gone */ } });
for (let i = 0; i < 60; i++) {
  try { await fetch(`${URL_}/rr_connect?password=`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

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
await p.goto(`${URL_}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await p.waitForTimeout(3000);
await p.locator('button.tab-add').first().click({ force: true });
await p.waitForSelector('.picker-item', { timeout: 5000 });
await p.locator('.picker-item').filter({ has: p.locator('strong', { hasText: /^Jog$/ }) }).first().click();
await p.waitForTimeout(1500);

// The mock's machine has X, Y, Z and U, so there are two strips beside the
// stick — which is the case that broke. One strip hid the bug.
const measure = () =>
  p.evaluate(() => {
    const strips = [...document.querySelectorAll('.vjog-striph')].map((el) => {
      const svg = el.querySelector('svg').getBoundingClientRect();
      // The drawn face, which is the part an operator can see and aim at.
      const face = el.querySelector('.vjog-face')?.getBoundingClientRect();
      // And the whole column: the label, the slider and the home button. That
      // is the control, and it is what has to match the pad's height.
      const col = el.getBoundingClientRect();
      return { name: el.querySelector('.vjog-strip-name').textContent.trim(),
               x: svg.x, right: svg.x + svg.width, w: svg.width, h: svg.height,
               colH: col.height, colTop: col.y,
               faceH: face ? face.height : 0, faceW: face ? face.width : 0 };
    });
    const s = document.querySelector('svg.vjog-stick')?.getBoundingClientRect();
    const row = document.querySelector('.vjog-pads')?.getBoundingClientRect();
    return { strips, stick: s ? { x: s.x, right: s.x + s.width, w: s.width, h: s.height } : null,
             row: row ? { x: row.x, right: row.x + row.width, w: row.width } : null };
  });

// A phone, the iPad mini this was reported broken on, a laptop, and desk
// monitors. The two small ones are here because the panel that looked right on
// a 27-inch screen is the one that showed an iPad two strips and no pad.
for (const [w, h] of [[390, 844], [1024, 768], [900, 800], [1280, 1000], [1600, 1400], [2000, 1300]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(700);
  // Below 700px the app drops dockview for a one-panel-at-a-time stack, so on
  // a phone the Jog panel exists but something else is on screen. Pick it.
  const stackTab = p.locator('.stack-tab', { hasText: /^Jog$/ });
  if (await stackTab.count()) {
    await stackTab.first().click();
    await p.waitForTimeout(600);
  }
  const m = await measure();
  const where = `${w}x${h}`;

  ok(m.strips.length === 2, `${where}: both strips are there`, m.strips.map((s) => s.name).join(', '));
  for (let i = 1; i < m.strips.length; i++) {
    const a = m.strips[i - 1];
    const b = m.strips[i];
    ok(a.right <= b.x + 0.5, `${where}: ${a.name} does not overlap ${b.name}`,
       a.right > b.x ? `${(a.right - b.x).toFixed(0)}px of overlap` : 'clear');
  }
  ok(m.stick && m.strips.every((s) => m.stick.right <= s.x + 0.5),
     `${where}: the stick does not overlap a strip`);

  // The stick is the control this panel is for. A strip whose width follows the
  // panel's height can starve it without overlapping anything, which is how
  // this looked at 1600x1400 before the cap: strips 198px wide, stick 88.
  ok(m.stick.w >= 96, `${where}: the stick keeps a usable size`, `${m.stick.w.toFixed(0)}px`);
  // Square in pixels, not by aspect-ratio. Every pixel of the SVG is a pointer
  // target, so a box taller than the circle it draws is a full-deflection
  // command waiting for a stray thumb.
  ok(Math.abs(m.stick.w - m.stick.h) <= 1, `${where}: and is square, so its hit area is the pad`,
     `${m.stick.w.toFixed(0)}x${m.stick.h.toFixed(0)}`);
  // A strip is a slider. It is allowed to grow with the panel, but its
  // proportions are the drawing's, so beside a pad it stays a sliver — a strip
  // approaching the pad's width is a strip that has stopped being one.
  ok(m.strips.every((s) => s.w >= 24 && s.w <= 120 && s.w <= m.stick.w * 0.4),
     `${where}: strips stay a slider's width`,
     m.strips.map((s) => `${s.name} ${s.w.toFixed(0)}px`).join(', '));
  // The rule the whole layout exists to hold: three controls in a row, all the
  // same height. Not overlapping was never enough — a 475px pad beside 336px
  // strips does not overlap either, and it is what the last attempt shipped.
  ok(m.strips.every((s) => Math.abs(s.colH - m.stick.h) <= m.stick.h * 0.06 + 2),
     `${where}: pad and strips are the same height`,
     `pad ${m.stick.h.toFixed(0)}, ` + m.strips.map((s) => `${s.name} ${s.colH.toFixed(0)}`).join(', '));
  ok(m.row && m.strips.every((s) => s.right <= m.row.right + 0.5),
     `${where}: nothing spills out of the row`);

  // Every pixel of the SVG is a pointer target, so a box much taller than the
  // strip it draws is a control that answers to a touch nowhere near it — at
  // full deflection, because the handler clamps. On a tall panel the box was
  // 1839px for a 261px drawing before this was pinned.
  ok(m.strips.every((s) => s.faceH > 0 && s.h <= s.faceH * 1.35),
     `${where}: a strip's hit area is the strip, not the column it sits in`,
     m.strips.map((s) => `${s.name} box ${s.h.toFixed(0)} vs face ${s.faceH.toFixed(0)}`).join(', '));
}

// --- A narrow panel ---------------------------------------------------------
//
// The failure that reached an iPad: the strips could not shrink, so every pixel
// the row was short came out of the stick, and because the row centres its
// content the overflow was clipped on the left — where the stick is. The panel
// showed two strips and no pad. Squeezing the row directly is the only way to
// get there without reproducing somebody's saved dock layout.
await p.setViewportSize({ width: 1000, height: 900 });
await p.waitForTimeout(500);
for (const width of [240, 170, 130, 110]) {
  await p.addStyleTag({ content: `.vjog-pads { max-width: ${width}px !important; }` });
  await p.waitForTimeout(400);
  const m = await measure();
  ok(m.stick !== null && m.stick.w >= 96,
     `a ${width}px row still has a pad`, m.stick ? `${m.stick.w.toFixed(0)}px` : 'ABSENT');
  ok(m.stick !== null && Math.abs(m.stick.w - m.stick.h) <= 1,
     `  and it is still square`, m.stick ? `${m.stick.w.toFixed(0)}x${m.stick.h.toFixed(0)}` : '');
  ok(m.row !== null && m.stick !== null && m.stick.x >= m.row.x - 0.5,
     `  and none of it is clipped off the left edge`,
     m.stick && m.row ? `pad at x+${(m.stick.x - m.row.x).toFixed(0)}` : '');
  ok(m.strips.length === 2, `  with both strips still present`, String(m.strips.length));
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
