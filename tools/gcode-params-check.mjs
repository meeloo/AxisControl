// Which bullets on the G-code page are parameters, and which are prose.
//
// The Parameters list mixes the two. Real parameters — "Xnnn Maximum feedrate
// for X axis" — sit beside sentences that happen to start a bullet, like G1's
// "Not all parameters need to be used…". Taken at face value the sentences
// become parameters called Not, If and RepRapFirmware, which is noise in the
// reference and, worse, makes the config checker call a real parameter
// undocumented because it never saw it.
//
// The rule is a guess about English as much as about the docs, so it is worth
// writing down what it must and must not accept. Both halves matter equally:
// too strict and M950's L vanishes, too loose and every bullet starting with
// "All" becomes a parameter.
//
// Run it with `npm run gcode-params`.

import { parseParam } from './build-gcode-index.mjs';

const fails = [];
const ok = (c, w, x = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`);
  if (!c) fails.push(w);
};

const letterOf = (bullet) => parseParam(bullet)?.letter ?? null;

// --- Placeholders the page actually uses -----------------------------------
const PARAMS = [
  // [bullet as it appears, the letter it must yield]
  ['Xnnn Maximum feedrate for X axis', 'Xnnn'],
  ['Tnn (required) Logical trigger number', 'Tnn'],
  ['Dn (Duet 3 MB6HC only) SD slot number', 'Dn'],
  ['S Report the current settings', 'S'],
  ['R1 Reset the counter', 'R1'],
  ['P"pin_name" Pin name and optional inversion status', 'P"pin_name"'],
  ['C"name" Pin name(s), see Pin Names', 'C"name"'],
  ['Ennn:nnn... Maximum feedrates for extruder drives', 'Ennn:nnn...'],
  ['Pnn: Output/servo pin number', 'Pnn'],
  ['Xnnn, Maximum feedrate', 'Xnnn'],
  // The ones this was reported for. M950 writes its spindle L both ways.
  ['Lbbb Maximum spindle RPM', 'Lbbb'],
  ['Laaa:bbb Minimum and maximum spindle RPM', 'Laaa:bbb'],
  ['Sxxx Some other placeholder letter entirely', 'Sxxx'],
  ['Faaa:bbb A range written with two different letters', 'Faaa:bbb'],
];
for (const [bullet, expected] of PARAMS) {
  const got = letterOf(bullet);
  ok(got === expected, `"${bullet.slice(0, 34)}…" is the parameter ${expected}`, got ?? '(dropped)');
}

// --- Sentences that must not become parameters -----------------------------
//
// The doubled-letter words are the interesting ones: they are why the rule
// needs three of the same character rather than two.
const PROSE = [
  'Not all parameters need to be used, but at least one must be',
  'If the printer is not homed, this does nothing',
  'RepRapFirmware 3.5 and later supports this',
  'All parameters are optional unless stated',
  'See the Pin Names page for the full list',
  'Off is the default state for this pin',
  'Add the tool to the current selection',
  'Note: this changes behaviour in 3.6',
  'Only one of these may be given at a time',
  'Use M308 to configure the sensor first',
];
for (const bullet of PROSE) {
  const got = letterOf(bullet);
  ok(got === null, `"${bullet.slice(0, 34)}…" is prose, not a parameter`, got ?? '');
}

ok(letterOf('Lbb Something with a two-letter placeholder') === 'Lbb',
   'a two-character placeholder in another letter is a parameter too',
   letterOf('Lbb x') ?? '(dropped)');
ok(letterOf('Tnn Logical trigger number') === 'Tnn',
   'and two n characters, because Tnn is everywhere');

// --- The markup, which is better than any of the above ---------------------
//
// The page bolds every parameter, so where the bold is there is nothing to
// infer: the bold run IS the name. bullets() keeps the tags on the Parameters
// section for exactly this. The shape rules above are the fallback for a
// section that stops bolding, not the main path.
const BOLD = [
  ['<strong>Lbb</strong> Maximum spindle RPM', 'Lbb'],
  ['<strong>Laaa:bbb</strong> Minimum and maximum spindle RPM', 'Laaa:bbb'],
  ['<strong>Xnnn</strong> Maximum feedrate for X axis', 'Xnnn'],
  ['<strong>P"pin_name"</strong> Pin name and inversion status', 'P"pin_name"'],
  ['<a class="toc" href="#x"></a> <strong>Rnn</strong> Spindle number', 'Rnn'],
];
for (const [bullet, expected] of BOLD) {
  ok(letterOf(bullet) === expected, `bold markup names the parameter: ${expected}`,
     letterOf(bullet) ?? '(dropped)');
}

// A bold word inside a sentence is not a parameter called must. This is why
// the match is anchored at the start of the bullet rather than searching it.
ok(letterOf('This <strong>must</strong> be set before the axis is used') === null,
   'a bold word in the middle of a sentence is not a parameter',
   letterOf('This <strong>must</strong> be set') ?? '');
ok(letterOf('<strong>All</strong> parameters are optional unless stated') === null,
   'nor is a bolded sentence opener with nothing after it but prose... ',
   letterOf('<strong>All</strong> parameters are optional unless stated') ?? '');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
