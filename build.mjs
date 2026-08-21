// Build script. Single dependency: esbuild (one static binary, no transitive tree).
//
//   node build.mjs              -> production bundle in dist/
//   node build.mjs --watch      -> rebuild on change
//   node build.mjs --serve      -> dev server on :8000 (implies --watch)
//   node build.mjs --serve --port 9000        (or PORT=9000)
//
// Production output is written twice: `cnc.js` and `cnc.js.gz`. The Duet's web
// server prefers a `.gz` sibling when the client sends Accept-Encoding: gzip,
// which is how DWC's own bundles are shipped. Serving the gzipped copy matters
// because the board reads it off the SD card single-threaded.

import { gzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch') || process.argv.includes('--serve');
const serve = process.argv.includes('--serve');

/**
 * Port for the dev server.
 *
 * 8000 rather than 8080. On a Mac 8080 is the busiest port there is — Tomcat,
 * Jenkins, a dozen Docker containers and half the tutorials on the internet all
 * want it — and when something already holds it the failure is not obvious:
 * esbuild binds the next free port and prints it, so the browser tab you had
 * open is quietly pointed at somebody else's server.
 *
 * Overridable either way, because there is no port that is free everywhere.
 */
const PORT = Number(
  (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '') ||
    process.env.PORT ||
    8000,
);
const prod = !watch;

// Everything is relative to this file, not to wherever the build was invoked
// from, so `node web/build.mjs` from the repo root behaves the same as
// `npm run build` inside web/.
const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);

const require = createRequire(import.meta.url);

/**
 * Locate a file inside an installed dependency.
 *
 * Resolved through the package's own entry rather than by assuming
 * `node_modules/<name>/...`, which breaks under pnpm, workspaces, and hoisting.
 * A missing dependency reports what to do instead of an ENOENT stack trace —
 * `git pull` brings in a new dependency but does not install it, and that is
 * exactly when this fires.
 */
function depFile(pkg, relative) {
  let base;
  try {
    base = dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    fail(`dependency "${pkg}" is not installed`);
  }
  const path = join(base, relative);
  if (!existsSync(path)) {
    fail(`"${pkg}" is installed but ${relative} is missing (unexpected version?)`);
  }
  return path;
}

function fail(message) {
  console.error(`\n[build] ${message}`);
  console.error(`[build] run \`npm install\` in ${root} and try again\n`);
  process.exit(1);
}

if (!existsSync(resolve(root, 'node_modules'))) {
  fail('node_modules is missing');
}

/**
 * Check every declared dependency before esbuild gets a chance to.
 *
 * Guarding only the packages this script itself opens is not enough: a
 * dependency imported by `src/` fails inside the bundler, as a resolution error
 * with a stack trace and no mention of npm. Reading the manifest means a package
 * added later is covered without anyone remembering to add it here — which is
 * the whole failure mode, since `git pull` brings in a new dependency but never
 * installs it.
 */
function checkDependencies() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const missing = declared.filter((pkg) => {
    try {
      require.resolve(`${pkg}/package.json`);
      return false;
    } catch {
      // Some packages don't export their package.json; fall back to the entry.
      try {
        require.resolve(pkg);
        return false;
      } catch {
        return true;
      }
    }
  });
  if (missing.length) {
    fail(`not installed: ${missing.join(', ')}`);
  }
}

checkDependencies();

// Imported dynamically so a missing install is reported by fail() above rather
// than as an ERR_MODULE_NOT_FOUND stack trace before any of it runs.
const esbuild = await import('esbuild');

mkdirSync('dist', { recursive: true });

/** Copy public/ verbatim, then gzip every text asset for the Duet. */
function emitStatic() {
  cpSync('public', 'dist', { recursive: true });
  // dockview ships its own stylesheet; serve it beside ours rather than
  // inlining it, so it caches separately and stays easy to diff on upgrade.
  cpSync(depFile('dockview-core', 'dist/styles/dockview.css'), 'dist/dockview.css');
}

/**
 * Stamp the asset links in index.html with a hash of what they point at.
 *
 * Without this, a rebuild is invisible. `styles.css` and `cnc.js` keep their
 * names for ever, so a browser that has them cached — and the Duet serves
 * static files with nothing to say otherwise — carries on using the old ones.
 * That is not a theoretical problem: "I pulled and rebuilt and the change is
 * not there" is indistinguishable from a bug in the change.
 *
 * A content hash rather than a build timestamp, so an unchanged file keeps its
 * URL and stays cached. Rewritten from `public/index.html` every time rather
 * than edited in place, so repeated builds do not stack stamps.
 */
function stampHtml() {
  const stamp = (file) => {
    const path = join('dist', file);
    if (!existsSync(path)) return file;
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8);
    return `${file}?v=${hash}`;
  };
  let html = readFileSync(join('public', 'index.html'), 'utf8');
  for (const file of ['styles.css', 'dockview.css', 'cnc.js']) {
    html = html.replace(`"${file}"`, `"${stamp(file)}"`);
  }
  writeFileSync(join('dist', 'index.html'), html);
}

/**
 * What this build is, so a copy of the app can say whether it is out of date.
 *
 * Version and commit only — deliberately no timestamp. The build stamp goes
 * into the bundle, and a value that changes on every build would change the
 * bundle's content hash on every build, which is exactly what the stamping
 * below exists to avoid. The commit already changes when the code does.
 *
 * A `+` means the tree had uncommitted changes: a build that says it is
 * 3a4984a when it is 3a4984a plus whatever was being tried at the time is a
 * build that will refuse an update it needs.
 */
function buildStamp() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  let commit = 'unknown';
  try {
    const git = (...args) =>
      execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    commit = git('rev-parse', '--short', 'HEAD');
    if (git('status', '--porcelain')) commit += '+';
  } catch {
    // No git, or a source archive rather than a checkout. Not worth failing over.
  }
  return { version: manifest.version ?? '0.0.0', commit };
}

const BUILD = buildStamp();

/**
 * The list of files that make up a deployed copy, written into dist itself.
 *
 * The installer copies this list rather than guessing at names. Guessing is how
 * a deploy silently misses the file that was added last week — and on a machine
 * whose only feedback is a blank page, that is a bad way to find out.
 *
 * Written last, after the gzipping, so the .gz siblings are in it.
 */
function emitBuildJson() {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${entry}/`);
      // The manifest never lists itself, in either form: it is fetched by name
      // and a stale .gz of it from an earlier build would be installed as
      // gospel.
      else if (!/^build\.json/.test(entry)) files.push(`${prefix}${entry}`);
    }
  };
  walk('dist', '');
  writeFileSync(
    join('dist', 'build.json'),
    `${JSON.stringify({ ...BUILD, builtAt: new Date().toISOString(), files }, null, 2)}\n`,
  );
}

/** Write .gz siblings for anything the Duet will serve compressed. */
function gzipDist() {
  const compressible = /\.(js|css|html|svg|json|map)$/;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (compressible.test(p) && !p.endsWith('.gz')) {
        writeFileSync(p + '.gz', gzipSync(readFileSync(p), { level: 9 }));
      }
    }
  };
  walk('dist');
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  // The parser worker is a separate entry: it is loaded by URL at runtime, so
  // it must exist as its own file rather than being inlined into the bundle.
  // flv-entry is the video demuxer, 270KB of it, imported at runtime only when
  // live video is actually attempted — so the main bundle never carries it and
  // a browser that cannot play video never fetches it.
  entryPoints: {
    cnc: 'src/main.ts',
    'parse-worker': 'src/viewer/parse-worker.ts',
    'flv-entry': 'src/camera/flv-entry.ts',
  },
  outdir: 'dist',
  // esbuild captures process.cwd() when its module is loaded, which is before
  // the chdir above — so the paths in this object need the root spelled out.
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  // Safari 12 is the floor because an iPad mini 2 cannot go past iOS 12, and a
  // superseded tablet propped next to the machine is a good use for it. Nothing
  // subtle happens when the target is too high: the bundle uses syntax the
  // engine cannot parse, the module is rejected whole, and the page is blank.
  target: ['es2019', 'safari12'],
  // esbuild from 0.25 onwards marks destructuring as unsupported on Safari 13
  // and below, and it has no transform for it — so naming safari12 as a target
  // stops being a request to down-level and becomes a hard build failure, 183
  // errors deep, most of them inside lit and dockview. Newer esbuild, same
  // source, no build.
  //
  // Asserting support here is not wishful: the bundle that ran on the actual
  // iPad mini 2 was built by esbuild 0.24, which does not transform
  // destructuring either, and it ran. Whatever edge case the compatibility
  // table is guarding against, this code does not reach it.
  //
  // Everything else safari12 asks for still applies. With 0.24 the output is
  // byte-for-byte identical with and without this line.
  supported: { destructuring: true },
  sourcemap: prod ? false : 'inline',
  minify: prod,
  legalComments: 'none',
  loader: { '.css': 'text', '.glsl': 'text' },
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
    __BUILD__: JSON.stringify(BUILD),
  },
  // After every build, watch included: the hash can only be taken once the
  // bundle it names has been written.
  plugins: [
    {
      name: 'stamp-html',
      setup: (build) =>
        build.onEnd(() => {
          stampHtml();
          // Under --watch there is no gzip pass, but the installer still needs
          // the file list: installing from a dev server is the normal way to
          // put a new build on the machine.
          emitBuildJson();
        }),
    },
  ],
};

/**
 * Refresh the G-code reference before bundling.
 *
 * The script asks the server whether the page has changed and does nothing if
 * it has not, so this costs one conditional request on a normal build and
 * rewrites nothing — which matters, because a file rewritten on every build is
 * a diff in front of anyone running `git status`.
 *
 * Only for a production build. Under --watch this would fire on every
 * keystroke-triggered rebuild, and the reference does not change while you are
 * editing a panel.
 *
 * A failure here does not fail the build. The generated index is committed, so
 * no network means the reference is simply the one already in the tree — and a
 * machine that cannot reach docs.duet3d.com is exactly the machine this whole
 * approach exists for. A *parse* failure is different and does stop the build:
 * that is the page having changed shape, and shipping a half-empty reference
 * silently is the thing the script's own guard exists to prevent.
 */
function refreshGcodeIndex() {
  const run = spawnSync(process.execPath, ['tools/build-gcode-index.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.status === 0) {
    for (const line of output.split('\n').filter(Boolean)) console.log(line);
    return;
  }
  // The guard fires on a bad parse and says so; anything else is the network.
  if (/expected at least/.test(output)) {
    console.error(output);
    fail('the G-code reference could not be parsed — see above');
  }
  console.warn('[build] G-code reference not refreshed (offline?); using the committed one');
}

if (prod) refreshGcodeIndex();

emitStatic();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] watching…');
  if (serve) {
    // `host` on esbuild 0.24, `hosts` on 0.25+. Getting this wrong prints
    // "http://undefined:8000" as the first thing a new checkout ever says.
    const served = await ctx.serve({ servedir: 'dist', port: PORT });
    const host = served.host ?? served.hosts?.[0] ?? 'localhost';
    console.log(`[build] dev server → http://${host === '0.0.0.0' ? 'localhost' : host}:${served.port}`);
    // Said out loud, because esbuild silently takes the next free port when the
    // one asked for is busy — and a page served from a port you did not choose
    // is indistinguishable from the app being broken until you notice the
    // number in the address bar.
    if (served.port !== PORT) {
      console.log(`[build] NOTE: ${PORT} was busy, so this is on ${served.port} instead`);
    }
    console.log('[build] point the UI at your controller via the connect bar (CORS is enabled by M586 C"*")');
  }
} else {
  await esbuild.build(options);
  gzipDist();
  emitBuildJson();
  console.log(`[build] wrote dist/ (with .gz siblings) — ${BUILD.version} ${BUILD.commit}`);
}
