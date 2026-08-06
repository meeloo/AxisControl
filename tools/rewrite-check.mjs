// The in-place line rewrite, checked where it is easiest to get wrong.
//
// parse.ts records a start and an end for every parameter, and save.ts writes a
// value back by replacing exactly those characters. That is only correct while
// two things hold, and both of them are quiet when they break:
//
//   raw.slice(p.start, p.end) === p.text     for every parameter of every line
//   replacing several of them leaves the untouched ones where they were
//
// The second is the trap. Change M203's X from "6000.00" to "3500" and every
// offset to its right is now three characters too far; do the replacements left
// to right and the second one lands inside its neighbour. Nothing throws — the
// file is written, it parses, and an axis has a speed nobody typed.
//
// The e2e test drives this through the panel, which can only reach the cases
// the mock's config happens to contain: one parameter per line. This reaches
// the rest — several parameters at once, values that grow, values that shrink,
// tabs, alignment padding, trailing comments, quoted strings, CRLF.
//
// Pass a directory to also sweep real config files for the offset invariant:
//   node tools/rewrite-check.mjs ../Duet3Config/config/sys
//
// Run it with `npm run rewrite-check`. It compiles parse.ts itself.

import { build } from 'esbuild';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'rewrite-check-'));
const out = join(dir, 'parse.mjs');
await build({
  entryPoints: [join(root, 'src/config/parse.ts')],
  bundle: true, format: 'esm', outfile: out, logLevel: 'error',
});
const { parseConfig, rewriteLine } = await import(pathToFileURL(out).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`);
  if (!c) fails.push(w);
};

/** Parse a single line and rewrite it. `values` is {X: '3500', …}. */
function rewrite(text, values) {
  const line = parseConfig('/t.g', text).lines[0];
  return rewriteLine(line, new Map(Object.entries(values)));
}

const shows = (s) => JSON.stringify(s);

// --- The offset invariant --------------------------------------------------
//
// Everything else here depends on this one holding, so it is checked first and
// on the awkward shapes rather than the tidy ones.
const SHAPES = [
  'M203 X6000 Y6000 Z2000 U8000',
  'M203   X6000.00    Y6000.00  Z2000.00 U8000.0',
  '\tM906 X2400 Y2400 Z2400 U1500 I50       ; Set motor currents (mA)',
  '  M584 X0.0 Y0.1:0.2 Z0.3 U0.4           ; set drive mapping',
  'M550 P"Seb\'s CNC; not a comment"         ; the name has a semicolon in it',
  'M569 P0.0 S1 D3 V40                      ; driver 0 goes forwards',
  'M208 X-5.5 Y-0.25 Z-160 S1',
  'M92 X80 Y80 Z400 U800',
  ';M203 X7000 Y7000 Z2500                  ; the previous value, commented out',
  'M950 R0 C"nil" L0:24000',
];
let bad = 0;
for (const text of SHAPES) {
  for (const p of parseConfig('/t.g', text).lines[0].params) {
    if (text.slice(p.start, p.end) !== p.text) {
      bad++;
      console.log(`      ${shows(text)}  ${p.letter}: ${shows(p.text)} vs ${shows(text.slice(p.start, p.end))}`);
    }
  }
}
ok(bad === 0, 'every parameter is found again at the offsets recorded for it', `${bad} wrong`);

// --- Several values on one line, all changing width ------------------------
//
// The one that catches a left-to-right rewrite. X grows by one, Y shrinks by
// four, Z grows by two, U shrinks by five; done in the wrong order the second
// replacement lands in the middle of the third.
ok(
  rewrite('M203 X6000.00 Y6000.00 Z2000.00 U8000.0', { X: '12000', Y: '800', Z: '2000.125', U: '9' })
    === 'M203 X12000 Y800 Z2000.125 U9',
  'four values of four different widths all land in their own places',
  shows(rewrite('M203 X6000.00 Y6000.00 Z2000.00 U8000.0', { X: '12000', Y: '800', Z: '2000.125', U: '9' })),
);

// Same line, edited one parameter at a time, must reach the same place. If the
// offsets were being invalidated by a neighbour, these two would differ.
let stepwise = 'M203 X6000.00 Y6000.00 Z2000.00 U8000.0';
for (const [letter, value] of [['X', '12000'], ['Y', '800'], ['Z', '2000.125'], ['U', '9']]) {
  stepwise = rewrite(stepwise, { [letter]: value });
}
ok(stepwise === 'M203 X12000 Y800 Z2000.125 U9',
   'and one at a time, re-parsing between, gives the same line', shows(stepwise));

// --- Only the value changes ------------------------------------------------
ok(
  rewrite('\tM906 X2400 Y2400 Z2400 U1500 I50       ; Set motor currents (mA)', { X: '2000', U: '1750' })
    === '\tM906 X2000 Y2400 Z2400 U1750 I50       ; Set motor currents (mA)',
  'the leading tab, the padding before the comment and the comment all survive',
);
ok(
  rewrite('M92 X80 Y80 Z400 U800                  ; steps per mm', { X: '80.5', Z: '400.125' })
    === 'M92 X80.5 Y80 Z400.125 U800                  ; steps per mm',
  'a value that grows pushes the rest of the line right, comment included',
  shows(rewrite('M92 X80 Y80 Z400 U800                  ; steps per mm', { X: '80.5', Z: '400.125' })),
);
ok(
  rewrite('M203   X6000.00    Y6000.00  Z2000.00 U8000.0', { Y: '4000' })
    === 'M203   X6000.00    Y4000  Z2000.00 U8000.0',
  'irregular spacing between parameters is left as it was found',
  shows(rewrite('M203   X6000.00    Y6000.00  Z2000.00 U8000.0', { Y: '4000' })),
);
ok(
  rewrite('M208 X-5.5 Y-0.25 Z-160 S1', { X: '-6', Z: '-155.75' })
    === 'M208 X-6 Y-0.25 Z-155.75 S1',
  'negative values are values like any other',
  shows(rewrite('M208 X-5.5 Y-0.25 Z-160 S1', { X: '-6', Z: '-155.75' })),
);

// A parameter this panel would never edit, sitting next to ones it would.
// Rewriting X must not disturb the quoted string or the driver list.
ok(
  rewrite('M584 X0.0 Y0.1:0.2 Z0.3 U0.4           ; set drive mapping', { Z: '0.5' })
    === 'M584 X0.0 Y0.1:0.2 Z0.5 U0.4           ; set drive mapping',
  'a driver list beside the edited value is not touched',
  shows(rewrite('M584 X0.0 Y0.1:0.2 Z0.3 U0.4           ; set drive mapping', { Z: '0.5' })),
);

// --- Nothing to do ---------------------------------------------------------
ok(rewrite('M203 X6000 Y6000', {}) === 'M203 X6000 Y6000', 'no values means no change');
ok(rewrite('M203 X6000 Y6000', { Q: '1' }) === 'M203 X6000 Y6000',
   'a letter the line does not have is not invented');

// --- Refusing rather than guessing -----------------------------------------
//
// The guard that stands between a stale ConfigLine and a value written into
// whatever now sits at those offsets.
const stale = parseConfig('/t.g', 'M203 X6000.00 Y6000.00 Z2000.00 U8000.0').lines[0];
stale.raw = 'M203 X4000 Y4000 Z2000.00 U8000.0'; // as if the file had changed underneath
let threw = null;
try { rewriteLine(stale, new Map([['Z', '1500']])); } catch (e) { threw = e.message; }
ok(threw !== null && /does not read as it was parsed/.test(threw),
   'a line that no longer reads as parsed is refused, not rewritten', threw ?? '(wrote it anyway)');

// --- Line endings and file shape -------------------------------------------
//
// parseConfig strips \r\n but not a lone \r, and save.ts has to split the same
// way or line 8 means two different things. Checked here because a file with
// mixed endings is exactly what an SD card edited on three machines contains.
const crlf = parseConfig('/t.g', 'M92 X80\r\nM203 X6000 Y6000\r\nM84 S10\r\n');
ok(crlf.lines.length === 4 && crlf.lines[1].raw === 'M203 X6000 Y6000',
   'CRLF files are split into the same lines as LF ones', shows(crlf.lines[1]?.raw));
ok(rewriteLine(crlf.lines[1], new Map([['Y', '12000']])) === 'M203 X6000 Y12000',
   'and rewriting one does not leave a stray carriage return in the middle');

const loneCr = parseConfig('/t.g', 'M92 X80\rM203 X6000\n');
ok(loneCr.lines.length === 2,
   'a lone carriage return is not a line break, here or in save.ts',
   `${loneCr.lines.length} lines`);

// --- Real configuration files ----------------------------------------------
//
// The invariant above, over whatever a real machine actually has on its card.
// Every G-code file, every line, every parameter — including the ones nothing
// is allowed to edit, since a wrong offset on those is still a wrong offset.
const sweep = process.argv[2];
if (sweep) {
  let files = 0, params = 0, wrong = 0;
  const walk = async (at) => {
    for (const e of await readdir(at, { withFileTypes: true })) {
      const full = join(at, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.g')) continue;
      files++;
      for (const line of parseConfig(full, await readFile(full, 'utf8')).lines) {
        for (const p of line.params) {
          params++;
          if (line.raw.slice(p.start, p.end) !== p.text) {
            wrong++;
            if (wrong <= 5) console.log(`      ${full}:${line.index + 1}  ${p.letter}${shows(p.text)}`);
          }
        }
      }
    }
  };
  await walk(sweep);
  ok(files > 0, `${sweep} has G-code files in it`, `${files} files`);
  ok(wrong === 0, `every parameter in ${files} real files is where it says it is`,
     `${params} parameters, ${wrong} wrong`);
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
