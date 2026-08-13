// Jog step labels, checked against the promise they make.
//
// A label in the jog rose says how far that press will travel. Two properties
// follow, and neither is visible in a screenshot:
//
//   it must never round UP — a label reading 50 on an axis with 49.9mm left
//     promises a millimetre that does not exist
//   it must stay short — the sectors were drawn for the ladder's own labels,
//     four glyphs at most, and a clamped distance is whatever is left over
//
// Run it with `npm run steps-check`.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'steps-'));
const out = join(dir, 's.mjs');
await build({ entryPoints: [join(root, 'src/core/steps.ts')], bundle: true, format: 'esm',
  outfile: out, logLevel: 'error' });
const { shortDistance, stepTick, stepLabel } = await import(pathToFileURL(out).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

// Never rounds up, across the whole range a clamped distance can land in.
let worstOver = 0;
let worstAt = 0;
let longest = '';
for (let mm = 0.001; mm < 1500; mm *= 1.0007) {
  const shown = Number(shortDistance(mm));
  if (shown > mm) {
    const over = shown - mm;
    if (over > worstOver) { worstOver = over; worstAt = mm; }
  }
  const s = shortDistance(mm);
  if (s.length > longest.length) longest = s;
}
ok(worstOver === 0, 'a clamped label never reads higher than the distance it stands for',
   worstOver ? `${shortDistance(worstAt)} shown for ${worstAt}` : 'checked ~10000 distances');
ok(longest.length <= 5, 'and is never more than five glyphs', `longest "${longest}"`);

// The ladder's own labels are what the sectors were sized for; a clamped one
// must not be dramatically longer or the geometry argument stops holding.
const ladder = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
const ladderMax = Math.max(...ladder.map((m) => stepTick(m).length));
ok(longest.length <= ladderMax + 1, 'within a glyph of the longest ladder label',
   `clamped "${longest}" vs ladder ${ladderMax} glyphs`);

// Spot checks, including the exact number from the report that started this.
for (const [mm, want] of [[50.028471, '50.0'], [1200, '1200'], [523.9999, '523'], [0.4999, '.49'], [9.99, '9.9']]) {
  ok(shortDistance(mm) === want, `${mm} reads as ${want}`, shortDistance(mm));
}
ok(stepLabel(0.5) === '0.5' && stepTick(0.5) === '.5', 'the ladder labels are unchanged');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
