// Reading and judging a plugin's manifest.
//
// Everything here except the hash is pure and synchronous, so the Plugins
// panel can judge something somebody just pasted without installing it first,
// and so the rules can be checked from node — `npm run plugin-manifest-check`.
//
// The rule the whole file is written to: a problem is data, never an
// exception. Somebody pasting a manifest with four mistakes in it should be
// told about four mistakes once, rather than about the first one four times,
// because each retry costs them a round trip through the editor.

import { API_VERSION, type Manifest, type PermissionName, type PluginRecord } from './types.js';

export interface ManifestProblem {
  field: string;
  message: string;
}

export interface ParseResult {
  manifest: Manifest | null;
  problems: ManifestProblem[];
}

/** `field` for a problem with the document as a whole rather than one key. */
const DOC = 'manifest';

/** `field` for a problem with the `@plugin` header comment. */
const HEADER = '@plugin';

/**
 * The permissions that are a bare name; `storage.*` and `network.*` carry an
 * argument and are checked by prefix below.
 *
 * Typed as PermissionName so that a typo here does not compile. Adding a
 * permission means adding it in three places — types.ts, this list, and
 * describePermission — and that is deliberate: a permission with no sentence
 * is a permission an operator cannot make a decision about.
 */
const BARE_PERMISSIONS: readonly PermissionName[] = [
  'machine.read',
  'machine.motion',
  'machine.command',
  'files.read',
  'files.write',
  'ui.notify',
  'background',
  'unsafe.fullAccess',
];

/**
 * Reverse-DNS, which is the shape of both a plugin id and a storage domain:
 * two or more dot-separated labels of lowercase letters, digits and dashes,
 * no empty label, no leading or trailing dot, no dash at either end of a
 * label.
 *
 * Lower case is required rather than folded because the id is a path segment
 * on the controller's SD card (`/plugins/<id>/`), and a card's filesystem is
 * case insensitive but case preserving: `Net.Example.Tool` and
 * `net.example.tool` would be one directory and two plugins.
 */
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Digits and dots. Enough to sort releases, and nothing here relies on more. */
const VERSION_RE = /^[0-9]+(?:\.[0-9]+)*$/;

const PANEL_KEYS = new Set(['title', 'width', 'height', 'description']);
const PROVIDES_KEYS = new Set(['domain', 'scope']);
const USES_KEYS = new Set(['domain', 'access']);

function isDomain(value: unknown): value is string {
  return typeof value === 'string' && DOMAIN_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a value is, in the words of the person who typed it. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}

/**
 * Why an origin is not one, or null when it is.
 *
 * A grant covers a whole origin, so a path in the permission is a mistake
 * worth naming: the author who writes `network.https://api.example.com/v1`
 * believes they have asked for less than they have.
 */
function originProblem(origin: string): string | null {
  if (origin === '') return 'name the origin, as in "network.https://example.com"';
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return `"${origin}" is not a URL — the scheme is part of it, as in "network.https://example.com"`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `"${origin}" is not http or https, and nothing else can be fetched from a plugin frame`;
  }
  if (origin.replace(/\/+$/, '') !== url.origin) {
    return `a grant covers a whole origin, so write "network.${url.origin}" rather than a path or a user name`;
  }
  return null;
}

/** Why a permission is not one, or null when it is. */
function permissionProblem(value: string): string | null {
  if ((BARE_PERMISSIONS as readonly string[]).includes(value)) return null;
  if (value.startsWith('storage.')) {
    const domain = value.slice('storage.'.length);
    return isDomain(domain)
      ? null
      : `"${domain}" is not a storage domain: reverse-DNS, as in "storage.org.axiscontrol.tools"`;
  }
  if (value.startsWith('network.')) return originProblem(value.slice('network.'.length));
  return `unknown permission "${value}" — this build knows ${BARE_PERMISSIONS.join(', ')}, "storage.<domain>" and "network.<origin>"`;
}

/**
 * Parse and validate `plugin.json`. Never throws; problems come back listed.
 *
 * `manifest` is null whenever `problems` is non-empty — there is no
 * half-valid manifest, on purpose. An unknown key inside a known object counts
 * as a problem for the same reason: `"widht": 4` is a panel that silently
 * comes out the default width, and a plugin that quietly does the wrong thing
 * is worse than one that refuses to install with the typo named.
 *
 * An unknown key at the TOP level is not a problem. That is where a later API
 * version will add things, and an old build refusing a plugin because it
 * carries a key from a newer one would make every addition a breaking change.
 * Such keys are dropped rather than kept, so they never reach the hash either:
 * the build that understands them is the build that asks about them.
 */
export function parseManifest(text: string): ParseResult {
  const problems: ManifestProblem[] = [];
  const note = (field: string, message: string): void => {
    problems.push({ field, message });
  };

  if (text.trim() === '') {
    return { manifest: null, problems: [{ field: DOC, message: 'the manifest is empty' }] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // JSON.parse names the offset it gave up at, which is the only thing that
    // makes a missing comma findable in a file the operator is looking at in a
    // textarea rather than in an editor.
    return {
      manifest: null,
      problems: [{ field: DOC, message: `not valid JSON: ${(err as Error).message}` }],
    };
  }

  if (!isPlainObject(raw)) {
    return {
      manifest: null,
      problems: [
        {
          field: DOC,
          message: `a manifest is a JSON object with at least id, name, version and api; this is ${describeValue(raw)}`,
        },
      ],
    };
  }

  let id = '';
  const rawId = raw['id'];
  if (typeof rawId !== 'string' || rawId === '') {
    note('id', 'required: a reverse-DNS id like "net.example.surface-notes"');
  } else if (!isDomain(rawId)) {
    note(
      'id',
      `"${rawId}" is not reverse-DNS: two or more dot-separated labels of lowercase letters, digits and dashes, with no leading or trailing dot`,
    );
  } else {
    id = rawId;
  }

  let name = '';
  const rawName = raw['name'];
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    note('name', 'required: the name the operator sees in the Plugins panel');
  } else {
    name = rawName;
  }

  let version = '';
  const rawVersion = raw['version'];
  if (typeof rawVersion !== 'string' || rawVersion.trim() === '') {
    note('version', 'required: a version like "1.2.0"');
  } else if (!VERSION_RE.test(rawVersion)) {
    note('version', `"${rawVersion}" is not a version: digits and dots, as in "1.2.0"`);
  } else {
    version = rawVersion;
  }

  let api = 0;
  const rawApi = raw['api'];
  if (typeof rawApi !== 'number' || !Number.isInteger(rawApi) || rawApi < 1) {
    note(
      'api',
      `required: the plugin API version this code was written against, a whole number 1 or more (this build serves ${API_VERSION})`,
    );
  } else {
    api = rawApi;
  }

  let description: string | undefined;
  if (raw['description'] !== undefined) {
    if (typeof raw['description'] !== 'string') note('description', 'must be text');
    else description = raw['description'];
  }

  let author: string | undefined;
  if (raw['author'] !== undefined) {
    if (typeof raw['author'] !== 'string') note('author', 'must be text');
    else author = raw['author'];
  }

  let background = false;
  if (raw['background'] !== undefined) {
    if (typeof raw['background'] !== 'boolean') note('background', 'must be true or false');
    else background = raw['background'];
  }

  let panel: Manifest['panel'];
  if (raw['panel'] !== undefined) {
    if (!isPlainObject(raw['panel'])) {
      note('panel', `must be an object with a title, not ${describeValue(raw['panel'])}`);
    } else {
      const p = raw['panel'];
      for (const key of Object.keys(p)) {
        if (!PANEL_KEYS.has(key)) {
          note(`panel.${key}`, `unknown key "${key}" — panel takes title, width, height and description`);
        }
      }
      let title = '';
      if (typeof p['title'] !== 'string' || p['title'].trim() === '') {
        note('panel.title', 'required when a plugin has a panel: the name in the panel picker');
      } else {
        title = p['title'];
      }
      let width: number | undefined;
      if (p['width'] !== undefined) {
        // Whole columns only: the layout grid is twelve of them, and a
        // fractional column is a panel that never lines up with another panel.
        if (
          typeof p['width'] !== 'number' ||
          !Number.isInteger(p['width']) ||
          p['width'] < 1 ||
          p['width'] > 12
        ) {
          note('panel.width', 'is in columns of a twelve-column grid: a whole number from 1 to 12');
        } else {
          width = p['width'];
        }
      }
      let height: number | undefined;
      if (p['height'] !== undefined) {
        if (
          typeof p['height'] !== 'number' ||
          !Number.isFinite(p['height']) ||
          p['height'] < 80 ||
          p['height'] > 2000
        ) {
          note('panel.height', 'is in pixels, from 80 to 2000');
        } else {
          height = p['height'];
        }
      }
      let panelDescription: string | undefined;
      if (p['description'] !== undefined) {
        if (typeof p['description'] !== 'string') note('panel.description', 'must be text');
        else panelDescription = p['description'];
      }
      panel = {
        title,
        ...(width !== undefined && { width }),
        ...(height !== undefined && { height }),
        ...(panelDescription !== undefined && { description: panelDescription }),
      };
    }
  }

  const permissions: PermissionName[] = [];
  if (raw['permissions'] !== undefined) {
    if (!Array.isArray(raw['permissions'])) {
      note('permissions', `must be a list of permission names, not ${describeValue(raw['permissions'])}`);
    } else {
      raw['permissions'].forEach((entry: unknown, i: number) => {
        if (typeof entry !== 'string') {
          note(`permissions[${i}]`, `must be a permission name, not ${describeValue(entry)}`);
          return;
        }
        const why = permissionProblem(entry);
        if (why) note(`permissions[${i}]`, why);
        else permissions.push(entry as PermissionName);
      });
    }
  }

  const provides: Manifest['provides'] = [];
  if (raw['provides'] !== undefined) {
    if (!Array.isArray(raw['provides'])) {
      note('provides', `must be a list of { domain, scope }, not ${describeValue(raw['provides'])}`);
    } else {
      raw['provides'].forEach((entry: unknown, i: number) => {
        if (!isPlainObject(entry)) {
          note(
            `provides[${i}]`,
            `must be an object like { "domain": "org.example.tools", "scope": "machine" }, not ${describeValue(entry)}`,
          );
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!PROVIDES_KEYS.has(key)) {
            note(`provides[${i}].${key}`, `unknown key "${key}" — an entry takes domain and scope`);
          }
        }
        let ok = true;
        const domain = entry['domain'];
        if (!isDomain(domain)) {
          note(`provides[${i}].domain`, 'required: a reverse-DNS domain like "org.axiscontrol.tools"');
          ok = false;
        } else if (provides.some((seen) => seen.domain === domain)) {
          note(`provides[${i}].domain`, `"${domain}" is claimed twice in this manifest`);
          ok = false;
        }
        // Absent means `machine`: the card is what survives a new laptop and a
        // cleared browser profile, which is the same argument text/fontstore.ts
        // makes for fonts. A wrong value is still a problem, because it is a
        // plugin asking for one thing and being given the other.
        const scope = entry['scope'] === undefined ? 'machine' : entry['scope'];
        if (scope !== 'machine' && scope !== 'browser') {
          note(
            `provides[${i}].scope`,
            '"machine" (a file on the controller\'s card, which follows the machine) or "browser" (IndexedDB here, gone when site data is cleared)',
          );
          ok = false;
        }
        if (ok && isDomain(domain) && (scope === 'machine' || scope === 'browser')) {
          provides.push({ domain, scope });
        }
      });
    }
  }

  const uses: Manifest['uses'] = [];
  if (raw['uses'] !== undefined) {
    if (!Array.isArray(raw['uses'])) {
      note('uses', `must be a list of { domain, access }, not ${describeValue(raw['uses'])}`);
    } else {
      raw['uses'].forEach((entry: unknown, i: number) => {
        if (!isPlainObject(entry)) {
          note(
            `uses[${i}]`,
            `must be an object like { "domain": "org.example.tools", "access": "read" }, not ${describeValue(entry)}`,
          );
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!USES_KEYS.has(key)) {
            note(`uses[${i}].${key}`, `unknown key "${key}" — an entry takes domain and access`);
          }
        }
        let ok = true;
        const domain = entry['domain'];
        if (!isDomain(domain)) {
          note(`uses[${i}].domain`, 'required: a reverse-DNS domain like "org.axiscontrol.tools"');
          ok = false;
        }
        // No default. A plugin that meant `write` and was given `read` finds
        // out when a write is denied, halfway through doing something — the
        // silent half-working failure this whole design exists to avoid.
        const access = entry['access'];
        if (access !== 'read' && access !== 'write') {
          note(`uses[${i}].access`, 'required: "read" or "write"');
          ok = false;
        }
        if (ok && isDomain(domain) && (access === 'read' || access === 'write')) {
          uses.push({ domain, access });
        }
      });
    }
  }

  if (problems.length > 0) return { manifest: null, problems };

  return {
    manifest: {
      id,
      name,
      version,
      api,
      ...(description !== undefined && { description }),
      ...(author !== undefined && { author }),
      ...(panel !== undefined && { panel }),
      ...(background && { background }),
      permissions,
      provides,
      uses,
    },
    problems,
  };
}

/**
 * The other way a plugin arrives: a single `main.js` with its manifest in a
 * leading block comment, which is what a plugin looks like while it is being
 * written.
 *
 *   /* @plugin { "id": "net.example.hello", ... } *␀/
 *
 * The header is looked for in the file's prologue — whitespace, line comments
 * and any other block comments, so a licence header above it is fine — and the
 * JSON is found by balancing braces while skipping the insides of strings,
 * never by looking for the last `}`. A manifest with a nested object in it
 * (`panel` always is one) or a `}` inside a description would otherwise be cut
 * in the wrong place, and what the author would see for it is a JSON syntax
 * error pointing at their description.
 */
export function manifestFromHeader(code: string): ParseResult {
  const found = findHeaderJson(code);
  if ('error' in found) return { manifest: null, problems: [{ field: HEADER, message: found.error }] };
  return parseManifest(found.json);
}

/** The JSON text of the `@plugin` header, or why there is none. */
function findHeaderJson(code: string): { json: string } | { error: string } {
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ';') {
      i++;
      continue;
    }
    if (code.startsWith('//', i)) {
      const nl = code.indexOf('\n', i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      const body = end < 0 ? code.slice(i + 2) : code.slice(i + 2, end);
      const marker = body.indexOf('@plugin');
      if (marker < 0) {
        // Somebody else's comment — a licence, a description of the file.
        // Keep walking rather than giving up, because that comment is where a
        // careful author puts the copyright and the header goes under it.
        if (end < 0) break;
        i = end + 2;
        continue;
      }
      // Scan the JSON out of the whole file rather than out of the comment
      // body: a `*/` inside one of the manifest's own strings ends the comment
      // early here, while the brace scanner walks straight past it.
      const from = i + 2 + marker + '@plugin'.length;
      const open = code.indexOf('{', from);
      if (open < 0) return { error: 'the @plugin header has no JSON object after it' };
      const close = scanObject(code, open);
      if (close < 0) {
        return { error: "the @plugin header's JSON object is never closed — count the braces" };
      }
      return { json: code.slice(open, close) };
    }
    break;
  }
  if (code.includes('@plugin')) {
    return {
      error:
        'the @plugin header has to come before any code: it is read out of a block comment in the opening lines of the file',
    };
  }
  return {
    error:
      'no @plugin header. A pasted plugin carries its manifest in a block comment at the top of the file, starting with @plugin and followed by the JSON object that would otherwise be in plugin.json',
  };
}

/**
 * The index just past the object that starts at `open`, or -1 if it never
 * closes. Braces inside strings do not count, and neither does an escaped
 * quote — `{ "note": "closes with }" }` is one object, not a syntax error.
 */
function scanObject(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Every permission the operator has to be asked about: the ones declared, plus
 * the `storage.<domain>` for each entry in `uses`, plus `background` when the
 * manifest asks for a service frame.
 *
 * Sorted and deduplicated, so the same set of permissions always produces the
 * same array however the author ordered the manifest. permissions.ts compares
 * what a new version asks for against what the last one was granted; without a
 * canonical order that comparison re-prompts for a manifest whose only change
 * was moving a line, and an operator taught to click through the dialog is an
 * operator who will click through the one that matters.
 *
 * A domain the plugin declares in `provides` is its own and does not appear
 * here, because `uses` is by definition somebody else's data.
 */
export function permissionsOf(manifest: Manifest): PermissionName[] {
  const all = new Set<PermissionName>(manifest.permissions ?? []);
  for (const use of manifest.uses ?? []) all.add(`storage.${use.domain}`);
  // A frame that runs with no panel open is exactly what a badly behaved
  // plugin wants, so declaring `background` asks for the permission whether or
  // not the author remembered to list it.
  if (manifest.background) all.add('background');
  return [...all].sort();
}

/**
 * One sentence, in the operator's terms, for the grant dialog.
 *
 * These are the words somebody decides on, usually standing at a machine,
 * once. They say what the plugin will be able to DO rather than which API it
 * unlocks — "read the machine's live state", not "machine.read" — and the two
 * that move a spindle say so in the first half of the sentence, before anyone
 * has stopped reading.
 */
export function describePermission(permission: PermissionName): string {
  switch (permission) {
    case 'machine.read':
      return "Read the machine's live state: where it is, what it is doing, which tool and spindle speed, and what this controller can do.";
    case 'machine.motion':
      return 'Move the machine: jog it, send it to a position, home it, or send it to the work origin.';
    case 'machine.command':
      return 'Move the machine and run G-code. This plugin can send any command you could type — motion, spindle, tool changes, and starting or stopping a job.';
    case 'files.read':
      return "Read the files on the controller's SD card, including your G-code and the machine's configuration.";
    case 'files.write':
      return "Write, replace and delete files on the controller's SD card, including the machine's configuration.";
    case 'ui.notify':
      return 'Show messages in this app and write to its log.';
    case 'background':
      return 'Keep running whenever it is enabled, with no panel of its own open.';
    case 'unsafe.fullAccess':
      return 'Do anything you can do, including moving the machine and changing its configuration. This plugin runs outside the sandbox, so nothing after this asks again.';
    default:
      break;
  }
  if (permission.startsWith('storage.')) {
    // The read/write split lives in `uses` and is enforced call by call, but
    // the dialog names the wider of the two: what the operator is agreeing to
    // is this plugin reaching data another plugin owns at all.
    return `Read and change the shared data in "${permission.slice('storage.'.length)}", which another plugin owns.`;
  }
  if (permission.startsWith('network.')) {
    return `Send and receive data over the network with ${permission.slice('network.'.length)}, and no other address.`;
  }
  return `Something this build of Axis Control does not recognise ("${permission}"). It cannot say what agreeing would allow, so refuse it.`;
}

/**
 * Stable identity for manifest + code, so a changed plugin re-asks.
 *
 * This is a change detector for re-prompting, NOT a security boundary. A
 * matching hash means "these are the same bytes the operator looked at last
 * time" and nothing else; no caller should read more into it, because a plugin
 * that means harm already holds whatever it was granted.
 *
 * That is what makes the fallback acceptable. `crypto.subtle` exists only in a
 * secure context, and this app is routinely served over plain http by the
 * controller on the workshop LAN — the deployment the whole project is built
 * around — so on the machine that matters most there is no SHA-256 to call.
 * Failing there would mean no hash, and no hash means either refusing to
 * install anything or never re-prompting again; both are worse than a weaker
 * digest. The fallback is two 32-bit FNV-1a passes, 16 hex characters instead
 * of 64, which is also how you can tell after the fact which one produced a
 * stored hash. It notices an edit. It would not survive somebody constructing
 * a collision on purpose, and nothing here asks it to.
 */
export async function hashPlugin(manifest: Manifest, code: string): Promise<string> {
  // A NUL between the two halves: JSON.stringify never emits a raw one, so no
  // manifest can be written to look like the beginning of the code.
  const material = `${canonicalManifest(manifest)}\u0000${code}`;
  const bytes = new TextEncoder().encode(material);
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return weakHash(bytes);
}

/**
 * The manifest as one canonical string: the known keys in a fixed order, the
 * lists in a fixed order, the optional ones present either way.
 *
 * Reordering a permission list or moving `author` above `name` is not a change
 * in what the plugin asks for, and re-prompting for it teaches the operator
 * that the dialog is noise.
 */
function canonicalManifest(manifest: Manifest): string {
  const byDomain = <T extends { domain: string }>(a: T, b: T): number =>
    a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
  return JSON.stringify([
    manifest.id,
    manifest.name,
    manifest.version,
    manifest.api,
    manifest.description ?? '',
    manifest.author ?? '',
    manifest.panel
      ? [manifest.panel.title, manifest.panel.width ?? 0, manifest.panel.height ?? 0, manifest.panel.description ?? '']
      : null,
    manifest.background === true,
    permissionsOf(manifest),
    [...(manifest.provides ?? [])].sort(byDomain).map((d) => [d.domain, d.scope]),
    [...(manifest.uses ?? [])].sort(byDomain).map((d) => [d.domain, d.access]),
  ]);
}

/** Two 32-bit FNV-1a passes, hex, 64 bits in all — see hashPlugin. */
function weakHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0xdeadbeef;
  for (const byte of bytes) {
    // Different multipliers, not just different starting values: two passes
    // that differ only in their seed fail on much the same inputs, which would
    // make the second one decoration.
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * True when this build serves the API version the plugin was written against.
 *
 * Exact equality, in both directions, and a newer plugin is refused rather
 * than attempted. A plugin written for API 2 calls methods this build does not
 * have; loading it anyway means it runs until the first missing one and then
 * stops — halfway through whatever it was doing, which on this app can be
 * halfway through a tool change. One refusal at the door is the kinder
 * failure. An older plugin is refused for the mirror-image reason: serving it
 * means keeping a compatibility shim, which is a decision to take deliberately
 * on the day API 2 exists rather than one to fall into by having written `>=`.
 */
export function isCompatible(manifest: Manifest): boolean {
  return manifest.api === API_VERSION;
}

/**
 * Domains claimed by more than one installed plugin.
 *
 * A domain has exactly one owner — that is what makes a schema possible at
 * all, and what lets a second plugin trust the tool table it reads. Two claims
 * is not a merge to resolve; it is an install to refuse, with both names in
 * the message so the operator knows which pair they are choosing between.
 */
export function domainConflicts(records: PluginRecord[]): Array<{ domain: string; claimants: string[] }> {
  const claims = new Map<string, Set<string>>();
  for (const record of records) {
    for (const spec of record.manifest.provides ?? []) {
      let claimants = claims.get(spec.domain);
      if (!claimants) claims.set(spec.domain, (claimants = new Set<string>()));
      // Keyed by plugin id, so a manifest that lists a domain twice does not
      // come back as a plugin in conflict with itself.
      claimants.add(record.manifest.id);
    }
  }
  return [...claims.entries()]
    .filter(([, claimants]) => claimants.size > 1)
    .map(([domain, claimants]) => ({ domain, claimants: [...claimants].sort() }))
    .sort((x, y) => (x.domain < y.domain ? -1 : 1));
}
