// The frame document, checked as a string before any browser sees it.
//
// tools/plugin-isolation-check.mjs proves the walls hold by attacking them
// from inside a real Chromium. This one covers what has to be true before the
// browser is even involved, and it runs everywhere:
//
//   - a plugin's source is put into a <script> without becoming markup. The
//     escape is the whole security story of src/plugins/guest.ts: get it wrong
//     and the plugin is not in a sandbox at all, it is writing HTML into the
//     document that holds the STOP button.
//   - the source comes back byte for byte. A sandbox that quietly rewrites the
//     code it runs is a bug that surfaces in somebody else's plugin, months
//     later, as "it works everywhere but in Axis Control".
//   - the CSP names an origin only when the operator granted it, and a
//     manifest cannot append a directive of its own to it.
//   - the theme tokens are the ones public/styles.css actually defines. A
//     renamed token is silent: the plugin goes on looking right until the day
//     somebody switches to the dark theme.
//
// Pure string work, no browser, no network.
//
// Run it with `npm run plugin-guest-check`.

import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'plugin-guest-'));
const entry = join(dir, 'entry.ts');
const out = join(dir, 'guest.mjs');
await writeFile(
  entry,
  `export * from ${JSON.stringify(join(root, 'src/plugins/guest.ts'))};\n` +
    `export { PROTOCOL_VERSION, METHOD_PERMISSIONS } from ${JSON.stringify(join(root, 'src/plugins/protocol.ts'))};\n`,
);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { GUEST_RUNTIME, frameHtml, themeTokens, THEME_TOKENS, PROTOCOL_VERSION, METHOD_PERMISSIONS } =
  await import(pathToFileURL(out).href);
process.on('exit', () => { void rm(dir, { recursive: true, force: true }); });

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };

const manifest = {
  id: 'net.example.hostile',
  name: 'Hostile',
  version: '1.0.0',
  api: 1,
  permissions: [],
  provides: [],
  uses: [],
};

const THEME = { '--bg': '#111', '--text': '#eee', 'color-scheme': 'dark' };

// Everything anyone has ever used to get out of a script element, plus the
// things that only break the document: an early end tag, an end tag inside a
// string and inside a comment, the comment opener that puts the tokenizer into
// its escaped state, the nested <script that hides the real end tag from it,
// the XML CDATA end that matters in XHTML and not here, and the two line
// separators that are legal JSON and were illegal JavaScript until ES2019.
const HOSTILE_CODE = [
  'const a = "</script><img src=x onerror=alert(1)>";',
  '// </script >',
  '/* <!-- <script> --> */',
  'const b = "]]>";',
  'const c = "\u2028\u2029";',
  'const d = String.raw`</script>`;',
  'const e = "</SCRIPT\t>";',
  'const f = 1 < 2 && 3 > 2;',
  'const g = "\\\\";',
  "const h = '\"';",
].join('\n');

const HOSTILE_CSS = '.x { content: "</style><script>window.__escaped=1;</script>"; }';

// --------------------------------------------------------------- the escape

{
  const doc = frameHtml(manifest, [], HOSTILE_CODE, HOSTILE_CSS, THEME);

  // One script element, one style-free way out of it. Counting is the check:
  // if any part of the plugin's source reached the tokenizer as markup, one of
  // these two numbers moves.
  const opens = doc.match(/<script\b/gi) ?? [];
  const closes = doc.match(/<\/script\b/gi) ?? [];
  ok(opens.length === 1 && closes.length === 1,
     'the document has exactly one script element', `${opens.length} open, ${closes.length} close`);

  ok(!doc.includes('</script><img src=x'), 'the plugin\'s </script> did not survive as markup');
  ok(!doc.includes('<!--'), 'and neither did its comment opener, which starts the escaped state');
  const styleOpens = doc.match(/<style\b/gi) ?? [];
  const styleCloses = doc.match(/<\/style\b/gi) ?? [];
  // Two style elements, both ours: the theme block and the base sheet. The
  // plugin's own stylesheet is carried in the boot call and attached by the
  // runtime, so `</style>` in it is text and never a tag. (The identifier
  // `window.__escaped` does still appear in the document — inside a JSON
  // string, which is the point: it round-trips and it does not run.)
  ok(styleOpens.length === 2 && styleCloses.length === 2 && !doc.includes('</style><script'),
     'a stylesheet that closes its own <style> element cannot get out either',
     `${styleOpens.length} open, ${styleCloses.length} close`);
  ok(doc.includes('\\u003c'), 'because every < in untrusted text is written as an escape');

  // The close tag the document does contain is ours, at the end.
  const close = doc.lastIndexOf('</script>');
  ok(doc.indexOf('</script>') === close, 'the only end tag is the one this file emits');

  // Byte for byte, both of them.
  const openParen = doc.lastIndexOf('__axisBoot(');
  const endParen = doc.lastIndexOf(');');
  const boot = JSON.parse(doc.slice(openParen + '__axisBoot('.length, endParen));
  ok(boot.code === HOSTILE_CODE, 'the plugin\'s source round-trips unchanged');
  ok(boot.css === HOSTILE_CSS, 'and so does its stylesheet');
  ok(boot.id === manifest.id, 'the boot call carries the plugin id', String(boot.id));
  ok(typeof boot.version?.api === 'number' && typeof boot.version?.app === 'string',
     'and the version axis.version reports', JSON.stringify(boot.version));

  // U+2028 and U+2029 are legal JSON and were a syntax error inside a
  // JavaScript string literal until ES2019 — an iPad on iOS 12 is older than
  // that, and would refuse the whole script.
  const body = doc.slice(doc.indexOf('<script>') + '<script>'.length, close);
  ok(!/[\u2028\u2029]/.test(body), 'the line separators are escaped, not carried literally');

  // The strongest statement available without a browser: what lands between
  // the tags parses as JavaScript.
  let compiled = true;
  let why = '';
  try { new Function(body); } catch (e) { compiled = false; why = e.message; }
  ok(compiled, 'the assembled script compiles', why);
}

{
  // Nothing else in the document may be able to end it either. The isolation
  // harness embeds this string in a srcdoc attribute escaping only & and ",
  // so a raw quote inside the CSP would be an attribute break-out.
  const doc = frameHtml(manifest, [], 'const x = 1;', undefined, THEME);
  const meta = doc.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  ok(meta !== null, 'the CSP survives as one well-formed meta element');
  ok(doc.indexOf('<meta http-equiv="Content-Security-Policy"') < doc.indexOf('<style'),
     'and comes before anything it has to cover');
}

// ------------------------------------------------------------------- the CSP

const cspOf = (granted) => {
  const doc = frameHtml(manifest, granted, 'const x = 1;', undefined, THEME);
  return (doc.match(/content="([^"]*)"/) ?? [, ''])[1];
};

{
  const csp = cspOf([]);
  ok(csp.includes("default-src 'none'"), 'default-src none', csp);
  ok(csp.includes("script-src 'unsafe-inline'"), 'script-src is inline and nothing else');
  ok(!csp.includes('unsafe-eval'), 'and does not allow eval');
  ok(csp.includes("style-src 'unsafe-inline'"), 'style-src is inline');
  ok(csp.includes('img-src data: blob:'), 'images are data: and blob: only — no beacon');
  ok(!/connect-src/.test(csp), 'a plugin granted nothing gets no connect-src at all', csp);
  ok(!/https?:\/\//.test(csp), 'and the policy names no origin whatsoever', csp);
}

{
  const csp = cspOf(['machine.read', 'network.https://example.com', 'ui.notify']);
  ok(/connect-src[^;]*\bhttps:\/\/example\.com\b/.test(csp), 'a granted origin appears in connect-src', csp);
  ok(!csp.includes('other.example'), 'and one that was not granted does not');
  ok((csp.match(/connect-src/g) ?? []).length === 1, 'connect-src is written once');
}

{
  const csp = cspOf(['network.https://a.example', 'network.wss://b.example:8443', 'network.http://192.168.1.9']);
  ok(csp.includes('https://a.example') && csp.includes('wss://b.example:8443') && csp.includes('http://192.168.1.9'),
     'every granted origin is listed, ports and schemes included', csp);
}

{
  // The permission string comes out of a manifest somebody else wrote. None of
  // these may become a directive, an attribute or an extra source.
  const nasty = [
    'network.https://evil.example; script-src *',
    'network.https://evil2.example" onload="alert(1)',
    'network.*',
    'network.https://evil3.example/path',
    'network.data:',
    'network.',
    "network.'self'",
    'network.https://evil4.example ws://evil5.example',
  ];
  const csp = cspOf(nasty);
  ok(!csp.includes('evil'), 'a malformed origin is dropped rather than repaired', csp);
  ok(!csp.includes('*') && !csp.includes("'self'") && !csp.includes('data:;'), 'wildcards and keywords are not origins');
  ok(!/connect-src/.test(csp), 'and dropping them all leaves no connect-src', csp);

  const doc = frameHtml(manifest, nasty, 'const x = 1;', undefined, THEME);
  ok(!doc.includes('onload='), 'a quote in a permission cannot open an attribute');
  ok((doc.match(/content="/g) ?? []).length >= 1 && !doc.includes('content=""'), 'the meta is intact');
}

// ------------------------------------------------------------------ the theme

{
  const doc = frameHtml(manifest, [], 'const x = 1;', undefined, {
    '--bg': '#111',
    'color-scheme': 'dark',
    '--evil': 'red; } body { display: none',
    '--comment': 'red /* } */',
    'bad name': 'red',
    '--nope': '</style><script>window.__escaped=1;</script>',
  });
  const block = doc.slice(doc.indexOf('<style id="axis-theme">'), doc.indexOf('</style>'));
  ok(block.includes('--bg: #111;'), 'a token reaches the frame', block.trim());
  ok(block.includes('color-scheme: dark;'), 'and so does color-scheme, which no stylesheet of ours can set');
  ok(!block.includes('display: none'), 'a value cannot close the block and write its own rule');
  ok(!block.includes('/*'), 'or comment the rest of it out');
  ok(!block.includes('bad name'), 'a name that is not a property is dropped');
  ok(!doc.includes('__escaped'), 'and a token cannot end the style element');
}

{
  // The names have to be the ones the app defines, not ones this file made up.
  const styles = readFileSync(join(root, 'public/styles.css'), 'utf8');
  const start = styles.indexOf(':root {');
  const block = styles.slice(start, styles.indexOf('\n}', start));
  const declared = [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]);
  const forwarded = new Set(THEME_TOKENS);
  const missing = declared.filter((n) => !forwarded.has(n));
  const invented = THEME_TOKENS.filter((n) => !declared.includes(n));
  ok(declared.length > 20, 'public/styles.css still declares its tokens in a :root block', String(declared.length));
  ok(missing.length === 0, 'every token the app defines is forwarded to plugins', missing.join(' '));
  ok(invented.length === 0, 'and every token forwarded is one the app defines', invented.join(' '));
  ok(JSON.stringify(themeTokens()) === '{}', 'themeTokens answers empty rather than throwing with no DOM');
}

// ----------------------------------------------------------------- the runtime

{
  let compiled = true;
  let why = '';
  try { new Function(GUEST_RUNTIME); } catch (e) { compiled = false; why = e.message; }
  ok(compiled, 'the guest runtime compiles on its own', why);
  ok(GUEST_RUNTIME.includes('__axisBoot'), 'and defines the one global frameHtml calls');
  ok(!/<\/script/i.test(GUEST_RUNTIME), 'the runtime itself contains no end tag');
  ok(GUEST_RUNTIME.includes(`var V = ${PROTOCOL_VERSION};`),
     'and speaks the protocol version protocol.ts declares', String(PROTOCOL_VERSION));
}

{
  // Nothing in here may reach for something a plugin frame does not have.
  // These are not walls — the browser's opaque origin is the wall — but a
  // runtime that touched one of them would be a runtime written against
  // assumptions that are false inside the frame.
  const banned = [
    [/(^|[^\w$.])localStorage\b/, 'localStorage'],
    [/(^|[^\w$.])sessionStorage\b/, 'sessionStorage'],
    [/(^|[^\w$.])indexedDB\b/, 'indexedDB'],
    [/(^|[^\w$.])caches\b/, 'caches'],
    [/document\.cookie/, 'document.cookie'],
    [/(^|[^\w$.])fetch\s*\(/, 'a call to the real fetch'],
    [/(^|[^\w$.])XMLHttpRequest\b/, 'XMLHttpRequest'],
    [/(^|[^\w$.])WebSocket\b/, 'WebSocket'],
    [/(^|[^\w$.])EventSource\b/, 'EventSource'],
    [/(^|[^\w$.])import\s*\(/, 'dynamic import'],
    [/(^|[^\w$.])require\s*\(/, 'require'],
    [/parent\s*\.\s*(document|location)/, 'the host document'],
    [/(^|[^\w$.])top\s*\./, 'top'],
    [/\.serviceWorker\b/, 'the service worker'],
    [/(^|[^\w$.])eval\s*\(/, 'eval'],
  ];
  const reached = banned.filter(([re]) => re.test(GUEST_RUNTIME)).map(([, name]) => name);
  ok(reached.length === 0, 'the runtime reaches for no host global', reached.join(', '));
  ok(/e\.source\s*!==\s*HOST/.test(GUEST_RUNTIME),
     'and answers only the host — a sibling frame can address it through parent.frames');
  ok(GUEST_RUNTIME.includes('freeze(') && /defineProp\(W, 'axis'/.test(GUEST_RUNTIME),
     'axis is frozen and cannot be replaced');
}

{
  // Every method the guest can ask for has to be one the bridge will dispatch.
  // An unknown method is refused there, which would make the call fail with a
  // message about the protocol rather than about the machine.
  const called = new Set([...GUEST_RUNTIME.matchAll(/(?:call|subscribeCall)\('([a-z][\w.]*)'/g)].map((m) => m[1]));
  const unknown = [...called].filter((m) => !(m in METHOD_PERMISSIONS));
  ok(called.size > 15, 'the runtime calls the API surface', String(called.size));
  ok(unknown.length === 0, 'and every method it calls is in METHOD_PERMISSIONS', unknown.join(', '));

  // The other direction is not an error — the bridge may serve more than the
  // guest wraps — but it is worth seeing.
  const unwrapped = Object.keys(METHOD_PERMISSIONS).filter((m) => !called.has(m));
  if (unwrapped.length) console.log(`      note: not wrapped by axis.*: ${unwrapped.join(', ')}`);
}

{
  // The protocol, both directions, as the guest speaks it.
  for (const [needle, what] of [
    ["t: 'ready'", 'ready on start'],
    ["t: 'req'", 'requests'],
    ["t: 'pong'", 'pong to a ping'],
    ["t: 'log'", 'logs'],
    ["t: 'subscribe'", 'subscribe'],
    ["t: 'unsubscribe'", 'unsubscribe'],
    ["m.t === 'init'", 'init'],
    ["m.t === 'event'", 'events'],
  ]) ok(GUEST_RUNTIME.includes(needle), `the runtime speaks ${what}`);

  for (const [needle, what] of [
    ["realConsole[name]", 'console'],
    ["addEventListener('error'", 'window.onerror'],
    ["addEventListener('unhandledrejection'", 'unhandled rejections'],
  ]) ok(GUEST_RUNTIME.includes(needle), `and captures ${what} — a plugin that fails silently is the worst outcome`);
}

// The legacy Window members that silently corrupt a plugin's own top-level
// variable. The scaffold tripped over `var status` the first time it ran: the
// node was coerced to a string by window.status's setter, nothing threw, and
// appendChild failed somewhere unrelated. The frame deletes them before the
// plugin runs, and this is the list.
for (const name of ['status', 'defaultStatus', 'name', 'origin', 'length']) {
  ok(new RegExp(`'${name}'`).test(GUEST_RUNTIME),
     `the frame clears window.${name} before the plugin runs`);
}
ok(/clearLegacyGlobals\(\);/.test(GUEST_RUNTIME) &&
   GUEST_RUNTIME.indexOf('clearLegacyGlobals();') < GUEST_RUNTIME.indexOf("doc.createElement('script')"),
   '  and clears them before the script element that runs it, not after');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
