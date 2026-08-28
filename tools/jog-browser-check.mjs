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
      return { name: el.querySelector('.vjog-strip-name').textContent.trim(),
               x: svg.x, right: svg.x + svg.width, w: svg.width, h: svg.height,
               faceH: face ? face.height : 0, faceW: face ? face.width : 0 };
    });
    const s = document.querySelector('svg.vjog-stick')?.getBoundingClientRect();
    const row = document.querySelector('.vjog-pads')?.getBoundingClientRect();
    return { strips, stick: s ? { x: s.x, right: s.x + s.width, w: s.width } : null,
             row: row ? { x: row.x, right: row.x + row.width, w: row.width } : null };
  });

for (const [w, h] of [[900, 800], [1280, 1000], [1600, 1400], [2000, 1300]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(700);
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
  ok(m.stick.w >= 120, `${where}: the stick keeps a usable size`, `${m.stick.w.toFixed(0)}px`);
  ok(m.strips.every((s) => s.w >= 24 && s.w <= 80), `${where}: strips stay in a sane width`,
     m.strips.map((s) => `${s.name} ${s.w.toFixed(0)}px`).join(', '));
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

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
