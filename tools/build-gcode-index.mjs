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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/tools$/, '');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? true) : undefined;
};

const SOURCE = flag('--url') ?? 'https://docs.duet3d.com/User_manual/Reference/Gcodes';
const from = flag('--from');
const out = resolve(root, flag('--out') ?? 'public/gcodes.json');
/** Below this many codes, assume the parse failed rather than the page shrank. */
const EXPECTED_MINIMUM = Number(flag('--min') ?? 200);

// --- Getting the page -------------------------------------------------------

async function loadPage() {
  if (from) {
    const path = resolve(process.cwd(), from);
    if (!existsSync(path)) throw new Error(`no such file: ${path}`);
    console.log(`[gcode-index] reading ${from}`);
    return readFileSync(path, 'utf8');
  }
  console.log(`[gcode-index] fetching ${SOURCE}`);
  const res = await fetch(SOURCE, {
    headers: {
      // wiki.js behind a CDN answers a bare programmatic request with a
      // challenge page rather than the document.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${SOURCE}`);
  return res.text();
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
  const match = /^\s*([GMT])\s*(\d+)(?:\.(\d+))?\s*(?::|\s[-–—])\s*(.+)$/.exec(heading);
  if (!match) return null;
  return {
    letter: match[1].toUpperCase(),
    number: Number(match[2]),
    fraction: match[3] !== undefined ? Number(match[3]) : null,
    title: match[4].trim(),
  };
}

/**
 * A parameter bullet, split into the letter and what it does.
 *
 * The docs write these as `Tnn (required) Logical trigger number…` or
 * `P"expression" Specifies…` — the letter runs into whatever syntax it takes,
 * so the split is at the first run of spaces after a leading non-space token,
 * not at a fixed width.
 */
function parseParam(line) {
  const cleaned = line.replace(/^[*\-•]\s*/, '').trim();
  if (!cleaned) return null;
  const match = /^([A-Za-z][^\s]*)\s+(.*)$/.exec(cleaned);
  if (!match) return null;
  const required = /\(required\)/i.test(match[2]);
  return {
    letter: match[1],
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
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const found = [];
  let match;
  while ((match = headingRe.exec(html)) !== null) {
    found.push({ level: Number(match[1]), title: text(match[2]), at: match.index, end: headingRe.lastIndex });
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

    const params = bullets(sectionOf('Parameters')).map(parseParam).filter(Boolean);

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
      code: `${code.letter}${code.number}${code.fraction !== null ? `.${code.fraction}` : ''}`,
      letter: code.letter,
      number: code.number,
      fraction: code.fraction,
      title: code.title,
      support,
      params,
      examples: [...new Set(examples)],
      notes,
      url: `${SOURCE}#${code.letter.toLowerCase()}${code.number}${code.fraction !== null ? `-${code.fraction}` : ''}`,
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
    (a, b) => a.letter.localeCompare(b.letter) || a.number - b.number || (a.fraction ?? -1) - (b.fraction ?? -1),
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

const page = await loadPage();

if (flag('--inspect')) {
  inspect(page);
  process.exit(0);
}

const codes = parseIndex(page);

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
writeFileSync(
  out,
  `${JSON.stringify({ builtAt: new Date().toISOString(), source: SOURCE, codes })}\n`,
);
console.log(`[gcode-index] wrote ${out.replace(`${root}/`, '')}`);
