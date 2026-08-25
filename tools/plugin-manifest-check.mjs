// A plugin's manifest, checked against the promises the rest of the system
// makes on the strength of it.
//
// Every failure here is a quiet one. A validator that accepts a typo'd key
// gives the author a panel that is the wrong width and no reason why. A header
// scanner that looks for the last `}` cuts a manifest in half the first time
// somebody writes a description with a brace in it, and reports it as their
// JSON being broken. A hash that changes when nothing changed re-opens the
// grant dialog until the operator learns to click through it — and that dialog
// is the only thing standing between somebody else's JavaScript and a spindle.
// A hash that does NOT change when the code did is worse in the same direction.
//
// So this checks the rules one at a time, and it checks the words: the two
// permissions that move the machine have to say so, in the sentence an
// operator reads.
//
// Run it with `npm run plugin-manifest-check`.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'plugin-manifest-'));
const out = join(dir, 'm.mjs');
await build({ entryPoints: [join(root, 'src/plugins/manifest.ts')], bundle: true, format: 'esm',
  outfile: out, logLevel: 'error' });
const {
  parseManifest, manifestFromHeader, permissionsOf, describePermission,
  hashPlugin, isCompatible, domainConflicts,
} = await import(pathToFileURL(out).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

// ---------------------------------------------------------------- good ones

// The manifest out of docs/plugins.md, which is the one an author copies.
const DOCS = {
  id: 'net.meeloo.surface-notes',
  name: 'Surface notes',
  version: '1.2.0',
  api: 1,
  panel: { title: 'Surface notes', width: 4, height: 320 },
  background: false,
  permissions: ['machine.read', 'ui.notify'],
  provides: [{ domain: 'net.meeloo.surface-notes', scope: 'machine' }],
  uses: [{ domain: 'org.axiscontrol.tools', access: 'read' }],
};

{
  const { manifest, problems } = parseManifest(JSON.stringify(DOCS));
  ok(manifest !== null && problems.length === 0, 'the manifest in docs/plugins.md parses',
     problems.map((p) => `${p.field}: ${p.message}`).join('; '));
  ok(manifest?.panel?.width === 4 && manifest?.panel?.height === 320, 'panel size survives');
  ok(manifest?.uses[0].access === 'read' && manifest?.provides[0].scope === 'machine', 'domains survive');
}

{
  // The smallest thing that is a plugin. The three list fields default rather
  // than coming back undefined, because every caller iterates them.
  const { manifest, problems } = parseManifest('{"id":"net.example.hello","name":"Hello","version":"1","api":1}');
  ok(problems.length === 0 && manifest !== null, 'a minimal manifest parses');
  ok(Array.isArray(manifest?.permissions) && manifest.permissions.length === 0
     && Array.isArray(manifest?.provides) && Array.isArray(manifest?.uses),
     'permissions, provides and uses default to empty lists');
}

{
  // Forward compatibility: a key from a later API version is not a reason to
  // refuse a plugin, because the alternative makes every addition breaking.
  const { manifest, problems } = parseManifest(
    '{"id":"net.example.hello","name":"Hello","version":"1.0","api":1,"schema":2,"icon":"x.svg"}');
  ok(manifest !== null && problems.length === 0, 'an unknown TOP-level key is not a problem',
     problems.map((p) => p.field).join(','));
  ok(manifest !== null && !('schema' in manifest), 'and is dropped rather than carried into the hash');
}

{
  // scope is optional and means `machine` — the card, which follows the
  // machine — per docs/plugins.md.
  const { manifest } = parseManifest(
    '{"id":"a.b","name":"n","version":"1","api":1,"provides":[{"domain":"c.d"}]}');
  ok(manifest?.provides[0].scope === 'machine', 'a domain with no scope is stored on the machine');
}

// ------------------------------------------------------------ each rule bites

const base = { id: 'net.example.hello', name: 'Hello', version: '1.0.0', api: 1 };
const withKey = (patch) => JSON.stringify({ ...base, ...patch });

const rejects = [
  ['id missing', JSON.stringify({ name: 'n', version: '1', api: 1 }), 'id'],
  ['id with one label', withKey({ id: 'hello' }), 'id'],
  ['id in mixed case', withKey({ id: 'Net.Example.Hello' }), 'id'],
  ['id with a leading dot', withKey({ id: '.net.example' }), 'id'],
  ['id with a trailing dot', withKey({ id: 'net.example.' }), 'id'],
  ['id with an empty label', withKey({ id: 'net..example' }), 'id'],
  ['id with an underscore', withKey({ id: 'net.example.my_plugin' }), 'id'],
  ['id that is a number', withKey({ id: 7 }), 'id'],
  ['name missing', JSON.stringify({ id: 'a.b', version: '1', api: 1 }), 'name'],
  ['name blank', withKey({ name: '   ' }), 'name'],
  ['version missing', JSON.stringify({ id: 'a.b', name: 'n', api: 1 }), 'version'],
  ['version with a suffix', withKey({ version: '1.2.0-beta' }), 'version'],
  ['version in words', withKey({ version: 'latest' }), 'version'],
  ['api missing', JSON.stringify({ id: 'a.b', name: 'n', version: '1' }), 'api'],
  ['api zero', withKey({ api: 0 }), 'api'],
  ['api fractional', withKey({ api: 1.5 }), 'api'],
  ['api as text', withKey({ api: '1' }), 'api'],
  ['background not a boolean', withKey({ background: 'yes' }), 'background'],
  ['permissions not a list', withKey({ permissions: 'machine.read' }), 'permissions'],
  ['a misspelled permission', withKey({ permissions: ['machine.reed'] }), 'permissions[0]'],
  ['a permission that is not text', withKey({ permissions: [3] }), 'permissions[0]'],
  ['storage of a non-domain', withKey({ permissions: ['storage.tools'] }), 'permissions[0]'],
  ['storage of nothing', withKey({ permissions: ['storage.'] }), 'permissions[0]'],
  ['network with no scheme', withKey({ permissions: ['network.example.com'] }), 'permissions[0]'],
  ['network of a path', withKey({ permissions: ['network.https://example.com/v1'] }), 'permissions[0]'],
  ['network of another scheme', withKey({ permissions: ['network.ftp://example.com'] }), 'permissions[0]'],
  ['network of a mail address', withKey({ permissions: ['network.mailto:a@example.com'] }), 'permissions[0]'],
  ['provides not a list', withKey({ provides: { domain: 'a.b', scope: 'machine' } }), 'provides'],
  ['a provided domain that is not one', withKey({ provides: [{ domain: 'tools', scope: 'machine' }] }), 'provides[0].domain'],
  ['a scope that is neither', withKey({ provides: [{ domain: 'a.b', scope: 'cloud' }] }), 'provides[0].scope'],
  ['a typo inside a provides entry', withKey({ provides: [{ domain: 'a.b', scpoe: 'machine' }] }), 'provides[0].scpoe'],
  ['the same domain claimed twice', withKey({ provides: [{ domain: 'a.b' }, { domain: 'a.b' }] }), 'provides[1].domain'],
  ['uses not a list', withKey({ uses: 'a.b' }), 'uses'],
  ['a used domain that is not one', withKey({ uses: [{ domain: 'tools', access: 'read' }] }), 'uses[0].domain'],
  ['access left out', withKey({ uses: [{ domain: 'a.b' }] }), 'uses[0].access'],
  ['access that is neither', withKey({ uses: [{ domain: 'a.b', access: 'append' }] }), 'uses[0].access'],
  ['a typo inside a uses entry', withKey({ uses: [{ domain: 'a.b', access: 'read', acces: 'write' }] }), 'uses[0].acces'],
  ['a panel with no title', withKey({ panel: { width: 4 } }), 'panel.title'],
  ['a typo inside panel', withKey({ panel: { title: 't', widht: 4 } }), 'panel.widht'],
  ['panel width of zero', withKey({ panel: { title: 't', width: 0 } }), 'panel.width'],
  ['panel width past the grid', withKey({ panel: { title: 't', width: 13 } }), 'panel.width'],
  ['panel width of half a column', withKey({ panel: { title: 't', width: 2.5 } }), 'panel.width'],
  ['panel height under 80', withKey({ panel: { title: 't', height: 79 } }), 'panel.height'],
  ['panel height over 2000', withKey({ panel: { title: 't', height: 2001 } }), 'panel.height'],
  ['a manifest that is a list', '[]', 'manifest'],
  ['a manifest that is a string', '"hello"', 'manifest'],
  ['a manifest that is not JSON', '{ id: "a.b" }', 'manifest'],
  ['an empty manifest', '   ', 'manifest'],
];

for (const [what, text, field] of rejects) {
  const { manifest, problems } = parseManifest(text);
  const named = problems.some((p) => p.field === field);
  ok(manifest === null && named, `rejects ${what}`,
     named ? '' : `wanted a problem on "${field}", got ${JSON.stringify(problems.map((p) => p.field))}`);
}

{
  // The promise the file is written to: four mistakes come back as four
  // problems, not as the first one four times.
  const { problems } = parseManifest(withKey({ id: 'nope', version: 'latest', permissions: ['machine.reed'], panel: { title: 't', widht: 3 } }));
  ok(problems.length >= 4, 'every problem in one manifest is reported at once', `${problems.length} problems`);
  ok(problems.every((p) => typeof p.message === 'string' && p.message.length > 10),
     'and each one says something an author can act on');
}

// ------------------------------------------------------------- the @plugin header

const HEADER_SRC = `// Surface notes — a plugin.
/* Copyright somebody. Licensed under Apache-2.0. */
/* @plugin {
  "id": "net.meeloo.surface-notes",
  "name": "Surface notes",
  "version": "1.2.0",
  "api": 1,
  "panel": { "title": "Surface notes", "width": 4, "height": 320 },
  "permissions": ["machine.read", "ui.notify"]
} */
axis.ui.onMount(() => { axis.log.info('hello'); });
`;

{
  const { manifest, problems } = manifestFromHeader(HEADER_SRC);
  ok(manifest !== null, 'a header under a licence comment is found',
     problems.map((p) => p.message).join('; '));
  // The nested `panel` object is the reason the scanner balances braces: the
  // last `}` in the header is the manifest's, but the first one after `panel`
  // is not the end of anything.
  ok(manifest?.panel?.width === 4, 'and the nested panel object survives the brace scan');
}

{
  // A brace inside a string is not a brace. Regex for the last `}` and this
  // manifest comes back as broken JSON, blaming the author's description.
  const src = '/* @plugin {"id":"a.b","name":"N","version":"1","api":1,"description":"closes with } and { too"} */\n0;';
  const { manifest, problems } = manifestFromHeader(src);
  ok(manifest?.description === 'closes with } and { too', 'a brace inside a string does not end the object',
     problems.map((p) => p.message).join('; '));
}

{
  // And an escaped quote does not open one.
  const src = '/* @plugin {"id":"a.b","name":"say \\"}\\" twice","version":"1","api":1} */\n0;';
  const { manifest } = manifestFromHeader(src);
  ok(manifest?.name === 'say "}" twice', 'an escaped quote inside a string is not the end of it');
}

{
  // The pathological one: the manifest's own text contains the comment
  // terminator. The brace scanner reads the file, not the comment, so it
  // walks straight past it.
  const src = '/* @plugin {"id":"a.b","name":"N","version":"1","api":1,"description":"cuts a */ shape"} */\n0;';
  const { manifest } = manifestFromHeader(src);
  ok(manifest?.description === 'cuts a */ shape', 'a comment terminator inside a string does not truncate the manifest');
}

{
  const { manifest, problems } = manifestFromHeader('export function main() {}\n');
  ok(manifest === null && problems.length === 1, 'source with no header is one problem, not none');
  ok(/@plugin/.test(problems[0].message) && /block comment/.test(problems[0].message),
     'and the message says what to write and where', problems[0]?.message);
}

{
  const { manifest, problems } = manifestFromHeader('const x = 1;\n/* @plugin {"id":"a.b","name":"N","version":"1","api":1} */\n');
  ok(manifest === null && /before any code/.test(problems[0]?.message ?? ''),
     'a header below the code says so rather than saying there is none', problems[0]?.message);
}

{
  const { manifest, problems } = manifestFromHeader('/* @plugin {"id":"a.b","name":"N"\n');
  ok(manifest === null && /closed|braces/.test(problems[0]?.message ?? ''),
     'an unterminated object is reported as unterminated', problems[0]?.message);
}

{
  const { manifest, problems } = manifestFromHeader('/* @plugin */\nconst x = 1;\n');
  ok(manifest === null && /JSON object/.test(problems[0]?.message ?? ''),
     'a header with no object after it is reported', problems[0]?.message);
}

{
  // A bad manifest in a header is reported as a manifest problem, not as a
  // header problem: the author needs to know which key is wrong.
  const { manifest, problems } = manifestFromHeader('/* @plugin {"id":"hello","name":"N","version":"1","api":1} */\n');
  ok(manifest === null && problems.some((p) => p.field === 'id'),
     'a header carrying a bad manifest reports the field, not the header');
}

// --------------------------------------------------------------- permissionsOf

{
  const asks = permissionsOf({
    ...DOCS,
    background: true,
    permissions: ['ui.notify', 'machine.read', 'ui.notify'],
    uses: [{ domain: 'org.axiscontrol.tools', access: 'read' }, { domain: 'net.other.thing', access: 'write' }],
  });
  ok(asks.includes('storage.org.axiscontrol.tools') && asks.includes('storage.net.other.thing'),
     'every used domain becomes a storage permission to ask about', asks.join(' '));
  ok(asks.includes('background'), 'a service frame is asked about even when the permission was not listed');
  ok(asks.filter((p) => p === 'ui.notify').length === 1, 'a permission listed twice is asked about once');
  ok(asks.join(',') === [...asks].sort().join(','), 'the list is in a canonical order', asks.join(' '));
  const same = permissionsOf({ ...DOCS, background: true, permissions: ['machine.read', 'ui.notify'],
    uses: [{ domain: 'net.other.thing', access: 'write' }, { domain: 'org.axiscontrol.tools', access: 'read' }] });
  ok(same.join(',') === asks.join(','), 'and does not depend on the order the author wrote');
}

{
  const asks = permissionsOf({ ...DOCS, background: false, permissions: ['machine.read'], uses: [] });
  ok(!asks.includes('background'), 'a plugin without a service frame is not asked for one');
  ok(!asks.some((p) => p.startsWith('storage.')), 'and owning a domain does not need a grant for it', asks.join(' '));
}

// ------------------------------------------------------------ describePermission

// The bare permissions in src/plugins/types.ts. Add one there and it has to
// appear here, or this check says its sentence is missing — which is the point:
// a permission with no sentence is one an operator cannot decide about.
const BARE = ['machine.read', 'machine.motion', 'machine.command', 'files.read', 'files.write',
  'ui.notify', 'background', 'unsafe.fullAccess'];

for (const p of BARE) {
  const s = describePermission(p);
  ok(typeof s === 'string' && s.length > 20 && !/does not recognise/.test(s) && /[.!]$/.test(s),
     `${p} has a sentence of its own`, s);
}
ok(new Set(BARE.map(describePermission)).size === BARE.length, 'no two permissions share a sentence');

{
  const s = describePermission('machine.command');
  ok(/move the machine/i.test(s) && /g-?code/i.test(s),
     'machine.command says plainly that it moves the machine and runs G-code', s);
}
{
  const s = describePermission('machine.motion');
  ok(/move/i.test(s), 'machine.motion says it moves the machine', s);
}
{
  const s = describePermission('unsafe.fullAccess');
  ok(/anything you can do/i.test(s) && /moving the machine/i.test(s) && /configuration/i.test(s),
     'unsafe.fullAccess says it can do anything you can, including moving the machine and changing its configuration', s);
}
{
  const s = describePermission('storage.org.axiscontrol.tools');
  ok(s.includes('org.axiscontrol.tools') && /another plugin/i.test(s), 'a storage sentence names the domain', s);
}
{
  const s = describePermission('network.https://example.com');
  ok(s.includes('https://example.com'), 'a network sentence names the origin', s);
}
{
  const s = describePermission('quantum.tunnel');
  ok(/does not recognise/i.test(s) && /refuse/i.test(s),
     'a permission this build does not know says so and says refuse', s);
}

// -------------------------------------------------------------------- hashing

{
  const CODE = 'axis.ui.onMount(() => {});';
  const h = await hashPlugin(DOCS, CODE);
  ok(/^[0-9a-f]{64}$/.test(h), 'the hash is SHA-256 hex where crypto.subtle exists', h);
  ok(await hashPlugin(structuredClone(DOCS), CODE) === h, 'and is the same for the same inputs');
  ok(await hashPlugin(DOCS, CODE + ' ') !== h, 'changed code changes it');
  ok(await hashPlugin({ ...DOCS, version: '1.2.1' }, CODE) !== h, 'a changed version changes it');
  ok(await hashPlugin({ ...DOCS, permissions: [...DOCS.permissions, 'machine.motion'] }, CODE) !== h,
     'a widened permission list changes it — which is what re-opens the dialog');
  ok(await hashPlugin({ ...DOCS, uses: [...DOCS.uses, { domain: 'net.other.thing', access: 'write' }] }, CODE) !== h,
     'a new used domain changes it');
  ok(await hashPlugin({ ...DOCS, permissions: [...DOCS.permissions].reverse() }, CODE) === h,
     'but reordering the permissions does not, so nobody is asked again for nothing');
  ok(await hashPlugin({ ...DOCS, provides: [] }, CODE) !== h, 'a dropped domain changes it');

  // The deployment this app is actually used in: served over plain http from
  // the controller, where crypto.subtle does not exist at all.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let swapped = false;
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    swapped = true;
  } catch { /* a node that will not let go of it; the assertions below are skipped */ }
  if (swapped) {
    const w = await hashPlugin(DOCS, CODE);
    ok(/^[0-9a-f]{16}$/.test(w), 'with no crypto.subtle there is still a hash, and it is hex', w);
    ok(await hashPlugin(structuredClone(DOCS), CODE) === w, 'the fallback is stable across runs');
    ok(await hashPlugin(DOCS, CODE + ' ') !== w, 'the fallback notices a one-character edit');
    ok(await hashPlugin({ ...DOCS, permissions: [...DOCS.permissions, 'machine.command'] }, CODE) !== w,
       'and notices a widened permission list');
    ok(w !== h, 'and is distinguishable from the SHA-256 of the same plugin');
    if (had) Object.defineProperty(globalThis, 'crypto', had);
  } else {
    ok(true, 'crypto.subtle could not be removed here; fallback assertions skipped');
  }
}

// ----------------------------------------------------------------- api version

ok(isCompatible({ ...DOCS, api: 1 }), 'the API version this build serves loads');
ok(!isCompatible({ ...DOCS, api: 2 }), 'a plugin written for a later API is refused rather than half-run');
ok(!isCompatible({ ...DOCS, api: 0 }), 'and so is one from before there was an API');

// -------------------------------------------------------------- domain owners

const record = (id, provides) => ({
  manifest: { ...base, id, provides, uses: [], permissions: [] },
  code: '', source: 'machine', hash: '', enabled: true,
});

{
  const conflicts = domainConflicts([
    record('net.a.tools', [{ domain: 'org.axiscontrol.tools', scope: 'machine' }]),
    record('net.b.tools', [{ domain: 'org.axiscontrol.tools', scope: 'machine' }]),
    record('net.c.notes', [{ domain: 'net.c.notes', scope: 'browser' }]),
  ]);
  ok(conflicts.length === 1 && conflicts[0].domain === 'org.axiscontrol.tools',
     'two plugins claiming one domain is a conflict', JSON.stringify(conflicts));
  ok(conflicts[0].claimants.join(',') === 'net.a.tools,net.b.tools',
     'and both names are in it, because the operator has to choose between them');
}
ok(domainConflicts([]).length === 0, 'nothing installed conflicts with nothing');
ok(domainConflicts([record('net.a.tools', [{ domain: 'x.y', scope: 'machine' }, { domain: 'x.z', scope: 'machine' }])]).length === 0,
   'one plugin owning two domains is not a conflict');
ok(domainConflicts([{ manifest: { ...base, provides: undefined }, code: '', source: 'machine', hash: '', enabled: true }]).length === 0,
   'a record with no provides at all does not throw');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
