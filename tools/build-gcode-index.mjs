// Build the G-code reference the app ships with.
//
//   npm run gcode-index                 fetch docs.duet3d.com and parse it
//   npm run gcode-index -- --from f.html   parse a page already on disk
//
// Writes public/gcodes.json, which the build copies into dist/ and the
// installer therefore puts on the machine along with everything else.
//
// Why build time rather than runtime, which would always be fresher:
//
//   - docs.duet3d.com is wiki.js behind a CDN and sends no
//     Access-Control-Allow-Origin, so a page served off the Duet cannot read
//     it. The same wall the camera hit, and the same refusal to run a proxy.
//   - A machine in a workshop is often not on the internet at all, and a
//     reference that needs a network round trip is missing exactly when the
//     spindle is running and you want to check what M574's P parameter does.
//
// The page is one long document with a section per code, which is what makes
// this tractable: no crawling, one request, and the whole reference in a file
// that gzips to something a Duet can serve.
//
// A note on the parser below. It is written against the structure of a single
// entry as it renders — heading, an optional "Supported in" line, Parameters,
// Examples, Notes — and it reports what it found rather than trusting itself.
// If the page shape moves under it, `--check` fails the build instead of
// shipping an index that is quietly half empty.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/tools$/, '');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? true) : undefined;
};

const SOURCE = flag('--url') ?? 'https://docs.duet3d.com/User_manual/Reference/Gcodes';
const from = flag('--from');
const quiet = !!flag('--quiet');
const out = resolve(root, flag('--out') ?? 'public/gcodes.json');
/**
 * Where the request bookkeeping lives — deliberately NOT in the index.
 *
 * The index is committed, so it has to be a pure function of the page: two
 * people building from the same documentation must produce byte-identical
 * files, or every pull collides on a generated artefact nobody edited. A build
 * timestamp and an ETag are properties of the fetch, not of the reference, and
 * putting them in the shipped file is what made it churn on every build.
 */
const cacheFile = `${out.replace(/\.json$/, '')}.fetch.json`;
/** Below this many codes, assume the parse failed rather than the page shrank. */
const EXPECTED_MINIMUM = Number(flag('--min') ?? 200);

// --- Getting the page -------------------------------------------------------

/** What was built last time, so an unchanged page can be recognised. */
function previous() {
  if (!existsSync(cacheFile)) return null;
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    return null;
  }
}

/** The index as it stands, to compare a fresh parse against. */
function currentIndex() {
  if (!existsSync(out)) return null;
  try {
    return readFileSync(out, 'utf8');
  } catch {
    return null;
  }
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function loadPage() {
  if (from) {
    const path = resolve(process.cwd(), from);
    if (!existsSync(path)) throw new Error(`no such file: ${path}`);
    if (!quiet) console.log(`[gcode-index] reading ${from}`);
    return { html: readFileSync(path, 'utf8') };
  }
  const last = previous();
  const headers = {
    // wiki.js behind a CDN answers a bare programmatic request with a
    // challenge page rather than the document.
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    Accept: 'text/html,application/xhtml+xml',
  };
  // Ask the server whether it is worth sending 850KB. A 304 is the cheap
  // answer to "has the reference changed", and the common one — the page is
  // edited every few weeks and this runs on every build.
  if (last?.etag) headers['If-None-Match'] = last.etag;
  else if (last?.lastModified) headers['If-Modified-Since'] = last.lastModified;

  if (!quiet) console.log(`[gcode-index] fetching ${SOURCE}`);
  const res = await fetch(SOURCE, { headers });
  if (res.status === 304) return { unchanged: true };
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${SOURCE}`);
  return {
    html: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

// --- HTML, reduced to text --------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', deg: '°', times: '×', larr: '←', rarr: '→',
};

function decode(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip tags, keeping the text and collapsing whitespace. */
function text(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip tags but keep line breaks, for code blocks where they are the content. */
function block(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .map((l) => l.trim());
}

// --- The reference itself ---------------------------------------------------

/**
 * The code a heading names, if it names one.
 *
 * Headings read "M581.1: Configure external trigger on expression", and the
 * fraction is significant — M581 and M581.1 are different commands with
 * different parameters, and collapsing them would answer a question about one
 * with the documentation of the other.
 */
function headingCode(heading) {
  // T is one command whose number is the tool to select, so the page documents
  // it as "T: Select Tool" with no number — unlike G and M, where the number
  // *is* the command. Requiring digits dropped it entirely.
  const bare = /^\s*T\s*(?::|\s[-–—])\s*(.+)$/.exec(heading);
  if (bare) return { letter: 'T', number: null, fraction: null, title: bare[1].trim() };

  const match = /^\s*([GM])\s*(\d+)(?:\.(\d+))?\s*(?::|\s[-–—])\s*(.+)$/.exec(heading);
  if (!match) return null;
  return {
    letter: match[1].toUpperCase(),
    number: Number(match[2]),
    fraction: match[3] !== undefined ? Number(match[3]) : null,
    title: match[4].trim(),
  };
}

/**
 * Words that open a bullet in a Parameters list without being parameters.
 *
 * The shape of a placeholder and the shape of a short English word overlap —
 * `Lbb` and `All` are the same shape — so past two characters the only thing
 * that separates them is which words English has. This is that list, and it is
 * the honest way round: a name that turns out to be missing shows up as a
 * parameter appearing out of nowhere in the reference, whereas tightening the
 * shape instead silently drops real parameters like M950's Lbb.
 *
 * Being wrong in this direction is also the cheaper mistake. A parameter the
 * index never saw makes the config checker call a correct line unrecognised,
 * which is a false positive an operator sees and stops trusting; a stray word
 * in the reference is a line of noise on a page nobody reads twice.
 */
const PROSE_OPENERS = new Set([
  'a', 'add', 'all', 'an', 'and', 'any', 'as', 'at', 'be', 'both', 'by', 'can',
  'default', 'deprecated', 'do', 'does', 'duet', 'each', 'either', 'for', 'from',
  'here', 'how', 'if', 'in', 'is', 'it', 'its', 'may', 'must', 'no', 'not',
  'note', 'obsolete', 'off', 'on', 'one', 'only', 'optional', 'or', 'other',
  'reprapfirmware', 'required', 'see', 'set', 'she', 'so', 'some', 'supported',
  'the', 'their', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too',
  'unless', 'use', 'used', 'value', 'values', 'when', 'where', 'which', 'while',
  'with', 'you', 'your',
]);

/**
 * An English word rather than a parameter name.
 *
 * Length-guarded, because single letters are real parameters — `S`, `A`, `I` —
 * and one of them would otherwise be lost to the word "a".
 */
function isProse(head) {
  return head.length >= 2 && PROSE_OPENERS.has(head.toLowerCase());
}

/**
 * Whether a parameter's tail is made only of value placeholders.
 *
 * Every run of letters has to be two or more of the same character — `bb`,
 * `aaa`, `nnn` — with anything non-alphabetic between them, so `aaa:bbb` and
 * `nnn:nnn...` pass and `epRapFirmware` does not. Two rather than three
 * because the docs do write two-character placeholders, and PROSE_OPENERS
 * rather than a longer run is what keeps the English words out.
 */
function isPlaceholderRuns(tail) {
  const runs = tail.match(/[A-Za-z]+/g) ?? [];
  if (!runs.length) return false;
  return runs.every((run) => run.length >= 2 && new Set(run.toLowerCase()).size === 1);
}

/**
 * A parameter bullet, split into the letter and what it does.
 *
 * The docs write these as `Tnn (required) Logical trigger number…` or
 * `P"expression" Specifies…` — the letter runs into whatever syntax it takes,
 * so the split is at the first run of spaces after a leading non-space token,
 * not at a fixed width.
 */
function parseParam(bullet) {
  // The page bolds every parameter, and the bold run is the parameter — no
  // guessing about shape needed at all. This is the whole answer where the
  // markup is there: `<strong>Lbb</strong> Maximum spindle RPM` says which part
  // is the name, and a sentence that merely starts a bullet has no bold on it.
  //
  // Anchored at the start, so a sentence with a bold word in the middle of it
  // ("This <strong>must</strong> be set") does not become a parameter called
  // must. The heuristic below still runs when there is no bold: the page has
  // been through several rewrites, and a section that stops bolding should
  // degrade to the old behaviour rather than return nothing at all.
  const bold =
    /^\s*(?:<a\b[^>]*>[\s\S]*?<\/a>\s*)*<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>([\s\S]*)$/i.exec(bullet);
  if (bold) {
    const head = text(bold[2]).replace(/[,:]+$/, '');
    const rest = text(bold[3]);
    if (head && rest && /^[A-Za-z]/.test(head) && !/^[GgMmTt]\d/.test(head) && !isProse(head)) {
      return {
        letter: head,
        text: rest.replace(/^\(required\)\s*/i, '').trim(),
        required: /\(required\)/i.test(rest),
      };
    }
  }

  const line = text(bullet);
  const cleaned = line.replace(/^[*\-•]\s*/, '').trim();
  if (!cleaned) return null;
  const match = /^([A-Za-z][^\s]*)\s+(.*)$/.exec(cleaned);
  if (!match) return null;
  // Only a real parameter, not a sentence that happens to start a bullet.
  //
  // The Parameters list on these pages mixes the two: G1's begins "Not all
  // parameters need to be used…", G29's has one starting "If…", and several
  // start with the word RepRapFirmware. Taken at face value they became
  // parameters called Not, If and RepRapFirmware — 116 of 918 across the page,
  // which is noise in the reference and a wrong suggestion in the editor.
  //
  // A parameter is a letter and, at most, a placeholder for its value: Xnnn,
  // Tnn, R1, S, P"pin_name", E[0], Lbbb, Laaa:bbb. A second English word means
  // prose. Trailing punctuation is the docs' own, not the parameter's: several
  // are written "Pnn:" or "Xnnn," and dropping them for it would lose real ones.
  const head = match[1].replace(/[,:]+$/, '');
  const tail = head.slice(1);
  const isParam =
    /^[A-Za-z]"/.test(match[1]) ||
    (!/^[GgMmTt]\d/.test(head) &&
      !isProse(head) &&
      // Two shapes of placeholder, and the second was missing.
      //
      //   n-only:  Xnnn, Tnn, Dn, S, R1, Ennn:nnn...   the docs' usual form
      //   any run: Lbbb, Laaa:bbb, Sxxx                M950's spindle L, and
      //                                                anywhere else the page
      //                                                needed a second letter
      //                                                to name a second thing
      //
      // The n-only form allows a single n because Dn and En are real; the
      // general form needs two of the same character, and PROSE_OPENERS keeps
      // the English words that are also that shape out.
      (!/[a-mo-zA-MO-Z]/.test(tail) || isPlaceholderRuns(tail)));
  if (!isParam) return null;

  const required = /\(required\)/i.test(match[2]);
  return {
    letter: head,
    text: match[2].replace(/^\(required\)\s*/i, '').trim(),
    required,
  };
}

function parseIndex(rawHtml) {
  // wiki.js puts a permalink inside every heading:
  //
  //   <h2 id="m5811-..."><a class="toc-anchor" href="#m5811-...">¶</a> M581.1: …</h2>
  //
  // so the heading text begins "¶ M581.1: …" and no code heading matches, and
  // the section labels read "¶ Parameters" so no section is found either. One
  // pass over the document removing them is the whole fix — and it is why the
  // parser found exactly zero of 400-odd codes rather than some of them, which
  // is the shape of a structural miss rather than a fussy selector.
  const html = rawHtml.replace(/<a\b[^>]*class="[^"]*toc-anchor[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '');

  // Headings carry the code; everything until the next heading of the same or
  // higher level belongs to it.
  const headingRe = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  const found = [];
  let match;
  while ((match = headingRe.exec(html)) !== null) {
    // The heading's own id, which is the anchor the page scrolls to. Taken
    // rather than derived: wiki.js slugs the whole heading, so M581.1 is
    // "#m5811-configure-external-trigger-on-expression" and no rule you would
    // guess from the code alone produces that. Deriving it gave a link that
    // opened a 400-code page at the top — which is the thing the reference
    // exists to avoid.
    const id = /\bid="([^"]*)"/i.exec(match[2]);
    found.push({
      level: Number(match[1]),
      title: text(match[3]),
      id: id ? id[1] : null,
      at: match.index,
      end: headingRe.lastIndex,
    });
  }

  const entries = [];
  for (let i = 0; i < found.length; i++) {
    const code = headingCode(found[i].title);
    if (!code) continue;

    // Up to the next heading at the same level or above — a sub-heading inside
    // an entry (some have "Notes" as a real heading) is part of that entry.
    let stop = html.length;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j].level <= found[i].level) {
        stop = found[j].at;
        break;
      }
    }
    const body = html.slice(found[i].end, stop);

    // Sections, by the labels the page uses.
    const sectionOf = (label) => {
      // `s?` before the boundary, or "Example\b" fails to match "Examples"
      // — there is no word boundary between the e and the s, so every entry
      // silently loses its examples and its notes.
      const re = new RegExp(`(?:<h[1-6][^>]*>|<(?:strong|b)>)\\s*${label}s?\\b[^<]*(?:</h[1-6]>|</(?:strong|b)>)`, 'i');
      const start = re.exec(body);
      if (!start) return '';
      const rest = body.slice(start.index + start[0].length);
      const next = /(?:<h[1-6][^>]*>|<(?:strong|b)>)\s*(?:Parameters|Examples?|Notes?|Order dependence|Related)\b/i.exec(rest);
      return next ? rest.slice(0, next.index) : rest;
    };

    const bullets = (chunk) =>
      [...chunk.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => text(m[1])).filter(Boolean);
    // Parameters keep their markup: parseParam reads the bold run out of it.
    const rawBullets = (chunk) =>
      [...chunk.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]).filter((h) => text(h));

    const params = rawBullets(sectionOf('Parameters')).map(parseParam).filter(Boolean);

    const examplesChunk = sectionOf('Example');
    const examples = [
      ...[...examplesChunk.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)].flatMap((m) => block(m[1])),
      ...[...examplesChunk.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)].flatMap((m) => block(m[1])),
    ];

    const notes = bullets(sectionOf('Note'));

    // "Supported in RRF 3.7 and later" is its own paragraph between the
    // heading and the first section, and is the most useful line on the page
    // for anyone deciding whether the board in front of them can do the thing.
    //
    // Taken structurally, from that paragraph. Regexing it out of the
    // flattened text does not work: the terminator would have to be a full
    // stop, and the first one in an entry belongs to the version number.
    const support = (() => {
      for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
        const line = text(m[1]);
        if (/^Supported in\b/i.test(line)) return line;
        if (/^(Parameters|Examples?|Notes?)$/i.test(line)) break;
      }
      return null;
    })();

    entries.push({
      code: `${code.letter}${code.number ?? ''}${code.fraction !== null ? `.${code.fraction}` : ''}`,
      letter: code.letter,
      number: code.number,
      fraction: code.fraction,
      title: code.title,
      support,
      params,
      examples: [...new Set(examples)],
      notes,
      url: found[i].id ? `${SOURCE}#${found[i].id}` : SOURCE,
    });
  }

  // Later definitions win: the page occasionally repeats a heading in a
  // summary table before documenting it properly.
  const byCode = new Map();
  for (const entry of entries) {
    const existing = byCode.get(entry.code);
    if (!existing || entry.params.length + entry.notes.length > existing.params.length + existing.notes.length) {
      byCode.set(entry.code, entry);
    }
  }
  return [...byCode.values()].sort(
    (a, b) =>
      a.letter.localeCompare(b.letter) ||
      (a.number ?? -1) - (b.number ?? -1) ||
      (a.fraction ?? -1) - (b.fraction ?? -1),
  );
}

// --- Looking at the page ----------------------------------------------------

/**
 * Describe the document's shape instead of parsing it.
 *
 * For when the parser returns nothing and the page cannot be read from where
 * the parser is being written. Prints enough structure to rewrite the selectors
 * against, and nothing that would need a file to be sent anywhere.
 */
function inspect(html) {
  const count = (re) => (html.match(re) ?? []).length;
  console.log(`\n--- ${html.length} bytes ---`);
  console.log(`h1..h6 tags        : ${count(/<h[1-6][\s>]/gi)}`);
  console.log(`<li>               : ${count(/<li[\s>]/gi)}`);
  console.log(`<pre>              : ${count(/<pre[\s>]/gi)}`);
  console.log(`<table>            : ${count(/<table[\s>]/gi)}`);
  console.log(`"M581" occurrences : ${count(/M581/g)}`);
  console.log(`looks JS-rendered  : ${/<div id="app"|window\.__(NUXT|INITIAL)/.test(html) ? 'yes — content may be in a script tag' : 'no'}`);

  const heads = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]{0,200}?)<\/h\1>/gi)];
  console.log(`\n--- first 6 headings, raw ---`);
  for (const h of heads.slice(0, 6)) console.log(JSON.stringify(h[0].slice(0, 220)));

  const m581 = html.indexOf('M581.1');
  if (m581 >= 0) {
    console.log(`\n--- 700 bytes around the first "M581.1" ---`);
    console.log(html.slice(Math.max(0, m581 - 260), m581 + 440));
  }
  console.log('');
}

// --- Go ---------------------------------------------------------------------

// Importable for tools/gcode-params-check.mjs, which exercises parseParam
// against bullets copied from the page. Without this guard, importing it would
// fetch the docs and rewrite the committed index as a side effect of a test.
export { parseParam, isPlaceholderRuns };

// Run only when this file is the program. Imported — by the parser test — the
// definitions above are all that was wanted, and fetching the docs and
// rewriting the committed index as a side effect of a test would be a bad
// trade for a shorter file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {

const fetched = await loadPage();

// A change to this file changes the index even when the page has not moved, so
// it counts as an input. Without it, fixing the parser and rebuilding prints
// "unchanged" and quietly ships the old output — which is exactly what happened
// when the deep links turned out to be wrong.
const parserHash = sha(readFileSync(fileURLToPath(import.meta.url), 'utf8'));

// The server says it has not changed since the index was built. Nothing to do,
// and nothing written — rewriting an identical file on every build would put a
// diff in front of anyone running `git status` for no reason at all.
if (fetched.unchanged && previous()?.parserHash === parserHash) {
  if (!quiet) console.log('[gcode-index] unchanged since the index was built (HTTP 304)');
  process.exit(0);
}

if (flag('--inspect')) {
  inspect(fetched.html);
  process.exit(0);
}

// Not every server honours a conditional request, and a CDN can answer 200
// with the same bytes. Hashing the page catches that too, so "unchanged" means
// unchanged rather than "the server felt like telling us".
const pageHash = sha(fetched.html);
const before = previous();
if (before?.pageHash === pageHash && before?.parserHash === parserHash && currentIndex()) {
  if (!quiet) console.log(`[gcode-index] unchanged since the index was built (same ${pageHash})`);
  process.exit(0);
}

const codes = parseIndex(fetched.html);

const withParams = codes.filter((c) => c.params.length).length;
const withExamples = codes.filter((c) => c.examples.length).length;
console.log(
  `[gcode-index] ${codes.length} codes — ${withParams} with parameters, ${withExamples} with examples`,
);

if (codes.length < EXPECTED_MINIMUM) {
  console.error(
    `\n[gcode-index] only ${codes.length} codes, expected at least ${EXPECTED_MINIMUM}.\n` +
      `[gcode-index] The page shape has almost certainly changed. Save it and look:\n` +
      `[gcode-index]   curl -A Mozilla ${SOURCE} > page.html\n` +
      `[gcode-index]   npm run gcode-index -- --from page.html\n` +
      `[gcode-index] Refusing to write an index that is quietly half empty.\n`,
  );
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
// Source and codes only: everything here comes from the page, so the same
// documentation gives the same bytes on anyone's machine.
const body = `${JSON.stringify({ source: SOURCE, codes })}\n`;

// The bookkeeping goes beside it, gitignored. Written even when the index did
// not change, so the next build can still send a conditional request.
mkdirSync(dirname(cacheFile), { recursive: true });
writeFileSync(
  cacheFile,
  `${JSON.stringify({ pageHash, parserHash, etag: fetched.etag ?? null, lastModified: fetched.lastModified ?? null, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

if (currentIndex() === body) {
  if (!quiet) console.log('[gcode-index] the page moved but the reference did not — nothing rewritten');
  process.exit(0);
}

writeFileSync(out, body);
console.log(`[gcode-index] wrote ${out.replace(`${root}/`, '')}`);

}
