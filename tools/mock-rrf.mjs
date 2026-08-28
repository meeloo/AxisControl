// Mock RepRapFirmware controller for developing without the machine.
//
//   node tools/mock-rrf.mjs [port]      (default 8081)
//
// Serves the rr_* endpoints against a synthetic object model shaped like the
// real Ultimate Bee: X/Y/Z plus the U dust-shoe axis, a 0-24000 rpm VFD
// spindle, an 8-slot RapidChange ATC, and the atc*/dustShoe* globals from
// config/sys. Also serves dist/ so you can test same-origin as well as CORS.
//
// It simulates motion, so the DRO moves and the viewer's live cutter position
// actually tracks something.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8081);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

let sessionKey = 1000;
let replySeq = 0;
let pendingReply = '';
const seqs = {
  boards: 1, directories: 1, fans: 1, global: 1, heat: 1, inputs: 1,
  job: 1, move: 1, network: 1, reply: 0, sensors: 1, spindles: 1,
  state: 1, tools: 1, volumes: 1,
};

// babystep is what the dry-run Z lift rides on.
// Travel is the real machine's, from config-axes-limits.g. It matters that Z
// runs 0..135 rather than the more common -180..0: the ATC's heights are
// positive numbers in that frame, and a mock with the sign the other way round
// makes every one of them look impossible.
const axes = [
  { speed: 6000, letter: 'X', babystep: 0, acceleration: 250, jerk: 500, stepsPerMm: 80, current: 2400, machinePosition: 260, userPosition: 260, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: 0, max: 524, visible: true },
  { speed: 6000, letter: 'Y', babystep: 0, acceleration: 250, jerk: 500, stepsPerMm: 80, current: 2400, machinePosition: 600, userPosition: 600, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: 0, max: 1290, visible: true },
  { speed: 2000, letter: 'Z', babystep: 0, acceleration: 100, jerk: 50, stepsPerMm: 400, current: 2400, machinePosition: 115, userPosition: 115, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: 0, max: 135, visible: true },
  { speed: 8000, letter: 'U', babystep: 0, acceleration: 500, jerk: 1000, stepsPerMm: 800, current: 1500, machinePosition: 30, userPosition: 30, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: 0, max: 70, visible: true },
];

/**
 * Velocity jogging (M700), as the meeloo/RepRapFirmware fork implements it.
 *
 * Reproduced here rather than stubbed because the two properties a host has to
 * get right are both invisible without a machine that has them:
 *
 *   the watchdog — go quiet and this stops on its own, which is the only way
 *     to see whether a host is really resending rather than relying on it
 *   silent clamping — a speed above `2 × acceleration × chunkMs` or above M203
 *     is not refused, it is quietly run slower, so a host that never reads the
 *     status back cannot tell it asked for something impossible
 *
 * `commanded` is kept alongside `speeds` for the same reason: a test needs to
 * distinguish "the clamp fired" from "the host sent that".
 */
const jog = {
  active: false,
  chunkMs: 20,
  watchdogMs: 250,
  queueDepth: 2,
  /** Running speed per axis letter, mm/s, after clamping. */
  speeds: {},
  /** What was actually asked for, before clamping. */
  commanded: {},
  lastCommandAt: 0,
  /** Commands received since the last stop, for a test to check the cadence. */
  commands: 0,
  /** Why it last stopped on its own, or null. */
  stoppedBy: null,
};

/**
 * One axis following another inside the planner (M604), as the fork does it.
 *
 * This is what replaced the dust shoe's tracking loop. U is held to Z in
 * machine coordinates — `follower = scale × leader + offset` — so the two move
 * as one and the shoe stops lagging a move behind.
 *
 * Two behaviours here are load-bearing for anything testing against this. The
 * relationship is CAPTURED from wherever the axes happen to be when it is
 * engaged, rather than being given as an absolute target, so a host that
 * engages before positioning gets a correct rule about the wrong place. And the
 * follower is clamped to its own M208 range, which is how the real shoe
 * saturates: it tracks down until it reaches its stop and then rests there
 * while Z carries on into the work.
 */
const follow = { follower: null, leader: null, scale: -1, offset: 0, engaged: false };

/** Probing grid set by M557, and the compensation G29 turns on. */
let grid = { xMin: 0, xMax: 300, yMin: 0, yMax: 300, sx: 25, sy: 25 };
let compensation = { type: 'none' };

/** Active work coordinate system, 0 = G54, as move.workplaceNumber reports it. */
let workplaceNumber = 0;
/** G68 state. `centre` is machine coordinates, matching the firmware. */
const rotation = { angle: 0, centre: [0, 0] };

const state = {
  status: 'idle',
  currentTool: 1,
  machineMode: 'CNC',
  messageBox: null,
  upTime: 4210,
};

const spindle = { active: 0, current: 0, min: 0, max: 24000, state: 'stopped', canReverse: true };

const job = { file: null, filePosition: 0, duration: 0, timesLeft: {} };

const globals = {
  systemSettingsVersion: 1.2,
  atcEnabled: true,
  atcProbingEnabled: true,
  atcDirection: 1,
  atcAlignment: 0,
  atcOffset: 45,
  atcCount: 8,
  atcSpindlePause: 2,
  atcRPM: 250,
  atcOriginX: 107.5,
  atcOriginY: 1260,
  atcProbeX: 3,
  atcProbeY: 1260,
  atcProbeZ: 41.3,
  atcToolHasBeenDetected: false,
  dustShoeEngaged: true,
  dustShoePrevZ: 115,
  dustShoeEngagedU: 30,
};

// Indexed by tool NUMBER, not packed — exactly like the firmware. This config
// declares M563 P1..P9 with no P0, so slot 0 is a genuine null. A mock that
// returns a packed array hides every "read a field off a hole" bug.
const tools = [
  null,
  ...Array.from({ length: 9 }, (_, i) => ({
    number: i + 1,
    name: i === 8 ? 'Manual Tool 9' : `Spindle tool ${i + 1}`,
    offsets: [0, 0, -12.5 - i * 0.7, 0],
    spindle: 0,
    state: i + 1 === state.currentTool ? 'active' : 'off',
  })),
];

// Sizes are patched from FILE_CONTENT below so job progress is consistent with
// what the viewer actually parses.
const FILES = {
  // The card root. A real board lists its top-level directories here, and DWC
  // shows them; the mock did not, which quietly made "browse up from /gcodes"
  // untestable and looked like the app's fault rather than the fixture's.
  '/': [
    { type: 'd', name: 'sys', size: 0, date: '2026-06-20T09:00:00' },
    { type: 'd', name: 'macros', size: 0, date: '2026-06-20T09:00:00' },
    { type: 'd', name: 'gcodes', size: 0, date: '2026-06-20T09:00:00' },
    { type: 'd', name: 'filaments', size: 0, date: '2026-06-20T09:00:00' },
    { type: 'd', name: 'www', size: 0, date: '2026-06-20T09:00:00' },
  ],
  '/sys': [
    { type: 'f', name: 'config.g', size: 1042, date: '2026-07-01T10:12:00' },
    { type: 'f', name: 'atcConfig.g', size: 2310, date: '2026-07-02T18:40:00' },
    { type: 'f', name: 'dustShoeConfig.g', size: 340, date: '2026-07-02T18:41:00' },
    { type: 'f', name: 'config-axes.g', size: 900, date: '2026-06-20T09:00:00' },
    { type: 'f', name: 'homeall.g', size: 420, date: '2026-06-20T09:00:00' },
    // The ATC macros this machine already has, so an installer is replacing
    // files rather than writing into an empty directory.
    { type: 'f', name: 'atcPickup.g', size: 700, date: '2026-07-02T18:40:00' },
    { type: 'f', name: 'atcDrop.g', size: 640, date: '2026-07-02T18:40:00' },
    { type: 'f', name: 'atcProbeZ.g', size: 520, date: '2026-07-02T18:40:00' },
    { type: 'f', name: 'atcTestToolPresent.g', size: 380, date: '2026-07-02T18:40:00' },
    { type: 'f', name: 'atcOpenDustCover.g', size: 90, date: '2026-07-02T18:40:00' },
    { type: 'f', name: 'atcCloseDustCover.g', size: 90, date: '2026-07-02T18:40:00' },
    ...Array.from({ length: 10 }, (_, i) => [
      { type: 'f', name: `tfree${i}.g`, size: 120, date: '2026-07-02T18:40:00' },
      { type: 'f', name: `tpre${i}.g`, size: 90, date: '2026-07-02T18:40:00' },
      { type: 'f', name: `tpost${i}.g`, size: 150, date: '2026-07-02T18:40:00' },
    ]).flat(),
  ],
  '/macros': [
    { type: 'd', name: 'Setup', size: 0, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'Engage Dust Shoe.g', size: 120, date: '2026-07-01T10:00:00' },
    { type: 'f', name: 'ProbeZ.g', size: 260, date: '2026-07-01T10:00:00' },
    { type: 'f', name: 'Save Work State.g', size: 210, date: '2026-07-01T10:00:00' },
    { type: 'd', name: 'MinMax', size: 0, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'Go To Z Probe.g', size: 140, date: '2026-07-01T10:00:00' },
    { type: 'f', name: 'Retract Dust Shoe.g', size: 120, date: '2026-07-01T10:00:00' },
    { type: 'f', name: 'Tool 9.g', size: 80, date: '2026-07-01T10:00:00' },
    { type: 'f', name: 'Tool 10.g', size: 80, date: '2026-07-01T10:00:00' },
  ],
  '/macros/Setup': [
    { type: 'f', name: 'Plane Stock.g', size: 800, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'flattenSpoilboard.g', size: 640, date: '2026-06-01T09:00:00' },
  ],
  // Mirrors the real machine: a folder of corner-travel helpers, plus one level
  // deeper so the walk is actually exercised rather than assumed.
  '/macros/MinMax': [
    { type: 'd', name: 'Diagonals', size: 0, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'maxX.g', size: 60, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'maxY.g', size: 60, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'minX.g', size: 60, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'minY.g', size: 60, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'readme.txt', size: 20, date: '2026-06-01T09:00:00' },
  ],
  '/macros/MinMax/Diagonals': [
    { type: 'f', name: 'maxXmaxY.g', size: 60, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'minXmaxY.g', size: 60, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'minXminY.g', size: 60, date: '2026-06-01T09:00:00' },
  ],
  '/gcodes': [
    { type: 'f', name: 'bracket_roughing.nc', size: 48210, date: '2026-07-28T14:00:00' },
    { type: 'f', name: 'spoilboard_surface.nc', size: 9100, date: '2026-07-20T11:00:00' },
    { type: 'f', name: 'big_relief.nc', size: 3145728, date: '2026-08-01T09:00:00' },
    // A real machine's gcodes folder is long, and a list that fits its panel
    // never exercises the scrolling — which is exactly how a panel that cannot
    // be scrolled on a tablet got shipped.
    ...Array.from({ length: 40 }, (_, i) => ({
      type: 'f',
      name: `job_${String(i + 1).padStart(3, '0')}.nc`,
      size: 1000 + i * 137,
      date: '2026-07-01T10:00:00',
    })),
  ],
};

/** Split "/sys/atcConfig.g" into its directory and name. */
/**
 * One name for one file, whichever way the caller spells it.
 *
 * RepRapFirmware reports its own directories with a volume prefix —
 * `directories.firmware` is `0:/firmware/` — and accepts paths with or without
 * it: `0:/firmware/x`, `/firmware/x` and `0:/firmware//x` are the same file on
 * the card. This mock keyed a plain object by the string it was given, so they
 * were three different files. An app that writes where the board told it to and
 * then lists where the board told it to is consistent and passed; a test that
 * spelled it the other way saw an empty directory and a missing upload, and the
 * bug it appeared to have found was the fixture's.
 */
function normalisePath(raw) {
  let path = String(raw ?? '').replace(/^\d+:/, '');
  path = path.replace(/\/{2,}/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

function splitPath(full) {
  const cut = full.lastIndexOf('/');
  return { dir: cut <= 0 ? '/' : full.slice(0, cut), name: full.slice(cut + 1) };
}

/**
 * Make a directory exist in the listing, and its parents with it.
 *
 * A real card has no way to hold /plugins/net.example.thing/main.js without
 * also having /plugins and /plugins/net.example.thing to list. This mock did:
 * uploading created the file's own directory listing and nothing above it, so
 * the file could be downloaded by name but `rr_filelist?dir=/plugins` answered
 * "no such directory" forever. Anything that writes a tree and then walks it
 * back — which is exactly how plugins are discovered at startup — saw an empty
 * card and concluded, reasonably and wrongly, that its own write had failed.
 */
function ensureDirectory(rawDir) {
  const dir = normalisePath(rawDir);
  if (!dir || dir === '/') {
    FILES['/'] ??= [];
    return;
  }
  FILES[dir] ??= [];
  const { dir: parent, name } = splitPath(dir);
  ensureDirectory(parent);
  const list = FILES[parent];
  if (!list.some((e) => e.name === name && e.type === 'd')) {
    list.push({ type: 'd', name, size: 0, date: new Date().toISOString().slice(0, 19) });
  }
}

function addToListing(rawFull, size) {
  const { dir, name } = splitPath(normalisePath(rawFull));
  ensureDirectory(dir);
  const list = (FILES[dir] ??= []);
  const date = new Date().toISOString().slice(0, 19);
  const existing = list.find((e) => e.name === name && e.type === 'f');
  if (existing) {
    existing.size = size;
    existing.date = date;
  } else {
    list.push({ type: 'f', name, size, date });
  }
}

function removeFromListing(rawFull) {
  const { dir, name } = splitPath(normalisePath(rawFull));
  const list = FILES[dir];
  if (!list) return;
  const at = list.findIndex((e) => e.name === name);
  if (at >= 0) list.splice(at, 1);
}

/**
 * Paths written through rr_upload during this run.
 *
 * The mock serves dist/ as well as the card, and for a top-level name like
 * /index.html both have an answer. This is how it tells "the fixture" from
 * "something an install actually put there" — see the note at the static
 * handler.
 */
/**
 * Live HTTP sessions, keyed by the session key handed out, valued by the last
 * time that key was seen. RepRapFirmware's own limit is small — the point of
 * modelling it at all is that "no free sessions" is a state a client can talk
 * itself into and then misread as a dead board.
 */
const sessions = new Map();
const MAX_SESSIONS = 8;
const SESSION_TIMEOUT_MS = 8000;

function expireSessions() {
  const now = Date.now();
  for (const [key, seen] of sessions) {
    if (now - seen > SESSION_TIMEOUT_MS) sessions.delete(key);
  }
}

const uploaded = new Set();

const FILE_CONTENT = {
  // DWC, near enough: a single-page app at the root of /www. Present so a test
  // can tell "the machine served Axis Control" from "the machine served the
  // web interface that was already there and it had no such route".
  '/www/index.html':
    '<!doctype html><html><body><div id="app">404 page not found</div>' +
    '<!-- stand-in for Duet Web Control --></body></html>',

  // Includes the atcConfig.g call, because this machine has a working ATC.
  // Anything that checks whether the tool changer is actually loaded has to
  // see the normal case here, not a permanent warning.
  '/sys/config.g': `; Configuration file for Duet\nglobal systemSettingsVersion={1.2}\nM98 P"config-network.g"\nM98 P"config-axes.g"\nM98 P"config-axes-limits.g"\nM98 P"atcConfig.g"\nM98 P"dustShoeConfig.g"\nM453 ; CNC mode\nM501\n`,
  // Modelled on the real config-axes.g, quirks included: commented-out previous
  // values sitting directly above their live replacements, comments after the
  // parameters, and a driver list with dotted CAN addresses.
  //
  // With three faults planted for the checker, all of which occur in real
  // configs. M203 is set twice, so the first one silently does nothing. M92
  // runs before the M584 that creates the axes. And M201 carries a W parameter
  // no such command takes.
  '/sys/config-axes.g': [
    '; Axes configuration executed by config.g',
    'M92 X80 Y80 Z400 U800                  ; steps per mm',
    'M584 X0.0 Y0.1:0.2 Z0.3 U0.4           ; set drive mapping',
    'M906 X2400 Y2400 Z2400 U1500 I50       ; Set motor currents (mA)',
    'M350 X16 Y16 Z16 U16 I1                ; Configure microstepping',
    ';M203 X7000 Y7000 Z2500                ; Set maximum speeds (mm/min)',
    'M203 X4000 Y4000 Z2000.00 U8000.0      ; set maximum speeds (mm/min)',
    'M203 X6000.00 Y6000.00 Z2000.00 U8000.0',
    'M566 X500 Y500 Z50 U1000               ; set maximum instantaneous speed changes (mm/min)',
    'M201 X250 Y250 Z100 U500 W3            ; Set accelerations (mm/s^2)',
    ';M201 X500.00 Y500.00 Z100.00',
    'M84 S10                                ; Set idle timeout',
    '',
  ].join('\n'),
  '/sys/config-axes-limits.g': [
    '; Axis limits',
    'M208 X0 Y0 Z0 U0 S1                    ; set axis minima',
    'M208 X524 Y1290 Z135 U70 S0            ; set axis maxima',
    '',
  ].join('\n'),
  '/sys/config-network.g': [
    '; Network',
    'M550 P"sebscnc"                        ; set machine name',
    'M552 S1                                ; enable network',
    'M586 P0 S1                             ; enable HTTP',
    '',
  ].join('\n'),
  // The real file, near enough verbatim — comments after values, a trailing
  // `;` comment on the same line as a number, an expression where a literal
  // would be easier, and a commented-out atcProbeSlot. Anything that reads it
  // has to cope with all four.
  '/sys/atcConfig.g': [
    '; Define ATC dust cover output:',
    'M950 P6 C"io6.out" Q2000 ;M42 P6 S0',
    '',
    '; Define ATC tool detection input:',
    'M950 J6 C"^io7.in"',
    '',
    ';RapidChange globals:',
    'global atcEnabled = true',
    'global atcProbingEnabled = true',
    '',
    'global atcDirection = 1 ; -1 or 1 depending on the direction from tool 0 to tool N',
    'global atcAlignment = 0 ; 0 = along X, 1 = along Y',
    'global atcOffset = 45 ; ER11 ATCs have 38 mm offsets',
    'global atcCount = 8',
    'global atcSpindlePause = 2',
    '',
    'global atcDropStartZ = 27.5',
    'global atcDropEndZ = 10',
    'global atcDropFeed = 1800',
    'global atcToolHasBeenDetected = false',
    'global atcRPM = 250',
    'global atcDropRPM = {global.atcRPM}',
    'global atcPickupStartZ = 27.5',
    'global atcPickupEndZ = 10',
    'global atcPickupReengage = 20',
    'global atcPickupRPM = {global.atcRPM}',
    'global atcPickupFeed = 1700',
    '',
    ';global atcProbeSlot = 8 ; uncomment if the probe lives in a pocket',
    'global atcProbeX = 3',
    'global atcProbeY = 1260',
    'global atcProbeZ = 41.3',
    '',
    'global atcRetractZ = move.axes[2].max',
    'global atcOriginX = 107.5; {move.axes[0].min + 24}',
    'global atcOriginY = 1260 ; {move.axes[1].min + 24}',
    '',
    'global atcAlignmentX = {1 - global.atcAlignment}',
    'global atcAlignmentY = {global.atcAlignment}',
    'global atcOffsetX = {global.atcOffset * global.atcDirection * global.atcAlignmentX}',
    'global atcOffsetY = {global.atcOffset * global.atcDirection * global.atcAlignmentY}',
  ].join('\n') + '\n',
  '/sys/dustShoeConfig.g': [
    '; Dust shoe configuration',
    'global dustShoeEngaged    = false',
    'global dustShoePrevZ      = move.axes[2].machinePosition',
    'global dustShoeEngagedU   = 30',
    'global dustShoeUseTrigger = true',
    '; The real file registers its triggers inside a conditional, and the\n    ; expression it registers is a string full of braces. Both are here so that\n    ; anything reading a config has to meet them.',
    'if {global.dustShoeUseTrigger}',
    '\tM581.1 T2 P"global.dustShoeEngaged && abs(move.axes[2].machinePosition - global.dustShoePrevZ) > global.dustShoeBand" R0',
    'M564 S{global.dustShoeEngagedU > 0 ? 1 : 1} H1   ; limits on, written as an expression on purpose',
    '',
  ].join('\n'),
  '/gcodes/spoilboard_surface.nc': generateSurfacingProgram(),
  '/gcodes/bracket_roughing.nc': generateBracketProgram(),
  // A file the size of a real 3D carve, so the download and parse progress
  // bars have something to actually report. Small test files hide the whole
  // problem the worker exists to solve.
  '/gcodes/big_relief.nc': generateBigProgram(3 * 1024 * 1024),
  // Written by G29; replaced whenever a scan is "run".
  '/sys/heightmap.csv': generateHeightMap({ xMin: 0, xMax: 300, yMin: 0, yMax: 300, sx: 25, sy: 25 }),
};

/**
 * A height map with the shape a real spoilboard has — a gentle dish plus a
 * high corner — and one unprobed point, because the firmware writes bare `0`
 * for a point it could not reach and the parser has to tell that apart from a
 * measured 0.000.
 */
function generateHeightMap({ xMin, xMax, yMin, yMax, sx, sy }) {
  const xNum = Math.floor((xMax - xMin) / sx) + 1;
  const yNum = Math.floor((yMax - yMin) / sy) + 1;
  const rows = [];
  const all = [];
  for (let j = 0; j < yNum; j++) {
    const cells = [];
    for (let i = 0; i < xNum; i++) {
      if (i === 0 && j === yNum - 1) {
        cells.push('      0');
        continue;
      }
      const u = (i / (xNum - 1)) * 2 - 1;
      const v = (j / (yNum - 1)) * 2 - 1;
      const z = -0.22 * (u * u + v * v) + 0.18 * u * v + 0.05 * u + 0.12;
      all.push(z);
      cells.push(z.toFixed(3).padStart(7));
    }
    rows.push(cells.join(', '));
  }
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const dev = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length);
  return [
    `RepRapFirmware height map file v2, mean error ${mean.toFixed(2)}, deviation ${dev.toFixed(2)}`,
    'xmin,xmax,ymin,ymax,radius,xspacing,yspacing,xnum,ynum',
    `${xMin.toFixed(2)},${xMax.toFixed(2)},${yMin.toFixed(2)},${yMax.toFixed(2)},-1.00,${sx.toFixed(2)},${sy.toFixed(2)},${xNum},${yNum}`,
    ...rows,
  ].join('\n') + '\n';
}

// Keep listed sizes honest so filePosition/size progress means something.
for (const entries of Object.values(FILES)) {
  for (const e of entries) {
    const full = Object.keys(FILE_CONTENT).find((p) => p.endsWith(`/${e.name}`));
    if (full) e.size = Buffer.byteLength(FILE_CONTENT[full]);
  }
}

// What the card held before any test touched it, for /__reset_files. The mock
// outlives a test run, so a test that writes to /sys leaves the next run
// starting from its output — which has twice now produced a pass that only
// meant "the previous run already did this".
/** How many times each object-model key has been asked for. */
const keyRequests = {};

const PRISTINE_CONTENT = { ...FILE_CONTENT };
const PRISTINE_LISTING = JSON.stringify(FILES);

/** Nominal usable bytes on the mock's card, matching volumes[0].partitionSize. */
const CARD_BYTES = 3975151616;

/**
 * Free space that actually moves when something is written.
 *
 * A constant would have satisfied any test that only checks a number is shown,
 * and would have hidden the thing worth testing: that the figure is re-read
 * rather than cached from the connect. Subtracting what is on the card makes an
 * upload visible in the panel, which is the behaviour an operator relies on
 * before sending a large job.
 */
function freeSpace() {
  let used = 0;
  for (const text of Object.values(FILE_CONTENT)) used += Buffer.byteLength(text);
  for (const entries of Object.values(FILES)) {
    for (const e of entries) if (!e.type || e.type === 'f') used += e.size ?? 0;
  }
  return Math.max(0, CARD_BYTES - used);
}

/** A simple raster surfacing pass — exercises rapids, feeds and long paths. */
function generateSurfacingProgram() {
  const out = ['(spoilboard surfacing)', 'G21 G90', 'G17', 'T1 M6', 'M3 S18000', 'G0 Z5'];
  const stepover = 20;
  for (let i = 0, y = 20; y <= 400; y += stepover, i++) {
    const x0 = i % 2 === 0 ? 20 : 480;
    const x1 = i % 2 === 0 ? 480 : 20;
    out.push(`G0 X${x0} Y${y}`);
    out.push('G1 Z-0.5 F600');
    out.push(`G1 X${x1} F3000`);
    out.push('G0 Z5');
  }
  out.push('M5', 'G0 X0 Y0', 'M30');
  return out.join('\n');
}

/** Contains arcs so the G2/G3 tessellation gets exercised. */
function generateBracketProgram() {
  const out = ['(bracket roughing)', 'G21 G90 G17', 'T2 M6', 'M3 S16000', 'G0 Z5'];
  for (let depth = 1; depth <= 6; depth++) {
    const z = -depth * 1.5;
    out.push(`G0 X60 Y60`, `G1 Z${z} F400`);
    out.push(`G1 X180 Y60 F2400`);
    out.push(`G2 X200 Y80 I0 J20`);
    out.push(`G1 X200 Y180`);
    out.push(`G2 X180 Y200 I-20 J0`);
    out.push(`G1 X60 Y200`);
    out.push(`G2 X40 Y180 I0 J-20`);
    out.push(`G1 X40 Y80`);
    out.push(`G2 X60 Y60 I20 J0`);
    out.push('G0 Z5');
  }
  // A circular pocket, to check full-circle arcs.
  out.push('G0 X120 Y130', 'G1 Z-3 F400', 'G3 X120 Y130 I30 J0 F1800', 'G0 Z5');
  out.push('M5', 'G0 X0 Y0', 'M30');
  return out.join('\n');
}

/** Bulk 3D-carve-shaped output: many short G1 moves, occasional retracts. */
function generateBigProgram(targetBytes) {
  const out = ['(large relief)', 'G21 G90 G17', 'T3 M6', 'M3 S18000', 'G0 Z5'];
  let bytes = 60;
  let i = 0;
  while (bytes < targetBytes) {
    const x = (Math.sin(i * 0.017) * 180 + 220).toFixed(3);
    const y = (Math.cos(i * 0.013) * 320 + 400).toFixed(3);
    const z = (Math.sin(i * 0.005) * 3 - 4).toFixed(3);
    const line = i % 97 === 0 ? 'G0 Z5' : `G1 X${x} Y${y} Z${z} F2200`;
    out.push(line);
    bytes += line.length + 1;
    i++;
  }
  out.push('M5', 'G0 X0 Y0', 'M30');
  return out.join('\n');
}

// --- Simulated motion ----------------------------------------------------

let model_speedFactor = 1;
let t = 0;
setInterval(() => {
  t += 0.1;
  // A resume with no file loaded is a real sequence — pause, cancel (which
  // clears job.file), resume — and dereferencing it crashed the mock.
  if (state.status === 'processing' && job.file) {
    // Sweep through the loaded program so filePosition advances.
    // Pace the sweep so any file takes roughly 30 s, whatever its size.
    job.filePosition = Math.min(job.file.size, job.filePosition + job.file.size / 300);
    job.duration += 0.1;
    job.timesLeft = { file: Math.max(0, (job.file.size - job.filePosition) / 2200) };
    if (job.filePosition >= job.file.size) {
      state.status = 'idle';
      spindle.current = 0;
      spindle.active = 0;
      spindle.state = 'stopped';
      bumpSeq('job');
      bumpSeq('state');
    }
    axes[0].machinePosition = 260 + Math.sin(t * 0.7) * 180;
    axes[1].machinePosition = 600 + Math.cos(t * 0.4) * 200;
    axes[2].machinePosition = 115 + Math.sin(t * 2) * 3;
  }
  stepJog(100);
  applyFollow();
  settleMoving();
  for (const a of axes) {
    a.userPosition = a.machinePosition - a.workplaceOffsets[workplaceNumber];
  }
  if (spindle.state !== 'stopped') {
    // Drift toward the commanded RPM, like a real VFD ramping.
    spindle.current += (spindle.active - spindle.current) * 0.2;
  }
}, 100);

/** The speed this axis will actually run at, mm/s. See `jog` above. */
function clampJogSpeed(axis, asked) {
  const caps = [2 * axis.acceleration * (jog.chunkMs / 1000)];
  if (axis.speed > 0) caps.push(axis.speed / 60);
  const cap = Math.min(...caps);
  return Math.sign(asked) * Math.min(Math.abs(asked), cap);
}

function stopJog(why) {
  // The reason is recorded even when nothing was running. A refusal — "cannot
  // jog while a print is running" — arrives at an already-stopped machine, and
  // it is the one case where a test most needs to know WHY nothing moved.
  jog.stoppedBy = why;
  if (!jog.active) return;
  jog.active = false;
  jog.speeds = {};
  jog.commanded = {};
  // The status is not touched here and was not touched on the way in either: a
  // jog does not change it. If the machine reads busy at this moment it is
  // because of an ordinary move that has not finished, and settleMoving owns
  // when that ends.
  bumpSeq('move');
}

/** Advance a jog by `ms`, and let the watchdog stop it if the host went quiet. */
function stepJog(ms) {
  if (!jog.active) return;
  if (Date.now() - jog.lastCommandAt > jog.watchdogMs) {
    stopJog('watchdog');
    return;
  }
  let moved = false;
  for (const a of axes) {
    const v = jog.speeds[a.letter];
    if (!v) continue;
    // Clamped to the soft limits per axis, which is the firmware's behaviour and
    // the reason it is worth reproducing: the axis that runs out stops while the
    // others carry on at their commanded speed, so a diagonal turns into a
    // straight line rather than failing.
    const next = Math.max(a.min, Math.min(a.max, a.machinePosition + v * (ms / 1000)));
    if (next !== a.machinePosition) {
      a.machinePosition = next;
      moved = true;
    }
  }
  if (moved) bumpSeq('move');
}

function handleJog(upper) {
  // Bare M700 is a status report, not a command — the distinction that makes
  // `M700` with no axes a very different thing from `M700 S0`.
  if (/^M700$/.test(upper.trim())) {
    pushReply(
      `Jogging ${jog.active ? 'active' : 'inactive'}, chunk ${jog.chunkMs}ms, ` +
        `timeout ${jog.watchdogMs}ms, queue ${jog.queueDepth}, speeds ` +
        (Object.entries(jog.speeds)
          .map(([l, v]) => `${l}${v.toFixed(1)}`)
          .join(' ') || 'none'),
    );
    return;
  }

  const p = /\bP(\d+(?:\.\d+)?)/.exec(upper);
  const r = /\bR(\d+(?:\.\d+)?)/.exec(upper);
  const d = /\bD(\d+)/.exec(upper);
  if (p) jog.chunkMs = Math.min(200, Math.max(10, Number(p[1])));
  if (r) jog.watchdogMs = Number(r[1]);
  if (d) jog.queueDepth = Math.min(8, Math.max(2, Number(d[1])));

  if (/\bS0\b/.test(upper)) {
    stopJog('commanded');
    return;
  }

  if (state.status === 'processing') {
    pushReply('Error: Cannot jog while a print is running');
    stopJog('printing');
    return;
  }
  if (axes.some((a) => !a.homed)) {
    pushReply('Error: Insufficient axes homed');
    stopJog('unhomed');
    return;
  }

  const commanded = {};
  const speeds = {};
  for (const a of axes) {
    // P/R/D are consumed above and must not be read as axis letters; only real
    // axis letters are looked for, which is also how the firmware parses it.
    const m = new RegExp(`(?:^|\\s)${a.letter}(-?[\\d.]+)`).exec(upper);
    if (!m) continue;
    const asked = Number(m[1]);
    if (!Number.isFinite(asked) || asked === 0) continue;
    commanded[a.letter] = asked;
    speeds[a.letter] = clampJogSpeed(a, asked);
  }

  // An M700 naming no axis at all is a stop, because every axis it did not
  // name is commanded to zero and it named none of them.
  if (!Object.keys(speeds).length) {
    stopJog('commanded');
    return;
  }

  jog.commanded = commanded;
  jog.speeds = speeds;
  jog.active = true;
  jog.stoppedBy = null;
  jog.commands++;
  jog.lastCommandAt = Date.now();

  // Deliberately NOT markMoving(). The firmware leaves state.status at "idle"
  // for the whole of an M700 jog — it used to report "busy" and no longer does —
  // so a host cannot use the status to tell whether a jog is running and has to
  // track the stick itself. Reproduced exactly, because a mock that reports busy
  // here would let a host that depends on the status pass, and it would then
  // fail on the machine.
  //
  // Ordinary moves DO still report busy; see markMoving on the G0/G1 branch.
  // That is what keeps a running macro or print distinguishable.
}

function handleFollow(cmd, upper) {
  if (/^M604$/.test(upper.trim())) {
    pushReply(
      follow.follower
        ? `${follow.follower} follows ${follow.leader} as ${follow.scale.toFixed(3)} * ` +
            `${follow.leader} ${follow.offset < 0 ? '-' : '+'} ${Math.abs(follow.offset).toFixed(3)}, ` +
            `${follow.engaged ? 'engaged' : 'disengaged'}`
        : 'No axis following configured',
    );
    return;
  }

  // A"U" B"Z" — quoted, as RRF spells string parameters.
  const a = /\bA"([A-Za-z])"/.exec(cmd);
  const bAxis = /\bB"([A-Za-z])"/.exec(cmd);
  const s = /\bS(-?\d*\.?\d+)/.exec(upper);
  const e = /\bE([01])/.exec(upper);

  if (a) follow.follower = a[1].toUpperCase();
  if (bAxis) follow.leader = bAxis[1].toUpperCase();
  if (s) follow.scale = Number(s[1]);

  if (!e) return;

  if (e[1] === '0') {
    follow.engaged = false;
    pushReply('Axis following disengaged');
    return;
  }

  const f = axes.find((x) => x.letter === follow.follower);
  const l = axes.find((x) => x.letter === follow.leader);
  if (!f || !l) {
    pushReply('Error: M604: unknown axis');
    return;
  }
  // Refused unless the follower is homed, matching what the old daemon checked
  // — an unhomed axis has no machine position to capture a relationship from.
  if (!f.homed) {
    pushReply('Error: M604: follower axis is not homed');
    return;
  }
  // Captured, not commanded: offset is whatever makes the rule true right now.
  follow.offset = f.machinePosition - follow.scale * l.machinePosition;
  follow.engaged = true;
  pushReply(
    `${follow.follower} follows ${follow.leader} as ${follow.scale.toFixed(3)} * ` +
      `${follow.leader} ${follow.offset < 0 ? '-' : '+'} ${Math.abs(follow.offset).toFixed(3)}, engaged`,
  );
}

/** Drag the follower to wherever the rule says it should be, clamped to its limits. */
function applyFollow() {
  if (!follow.engaged) return;
  const f = axes.find((x) => x.letter === follow.follower);
  const l = axes.find((x) => x.letter === follow.leader);
  if (!f || !l) return;
  const want = follow.scale * l.machinePosition + follow.offset;
  const next = Math.max(f.min, Math.min(f.max, want));
  if (next !== f.machinePosition) {
    f.machinePosition = next;
    bumpSeq('move');
  }
}

/**
 * When the machine stops calling itself busy after an ordinary move.
 *
 * The move itself is instantaneous here — this mock does not simulate
 * trajectories — but the STATUS is not a detail a client can be spared. A real
 * board reports "busy" for as long as a move is executing, and a panel that
 * treats busy as a reason to grey itself out disables its own controls under
 * the operator's thumb. That shipped once already, in both jog panels, and it
 * passed every test here because the mock went from idle to idle.
 *
 * Long enough to be observed by a client polling at 250ms, short enough that a
 * test doing a move and then checking something is not left waiting on it.
 */
const MOVING_MS = 400;
let movingUntil = 0;

function markMoving() {
  // A running program owns the status; anything else is a hand-driven move.
  if (state.status !== 'idle' && state.status !== 'busy') return;
  movingUntil = Date.now() + MOVING_MS;
  if (state.status !== 'busy') {
    state.status = 'busy';
    bumpSeq('state');
  }
}

/** Drop back to idle once the move and any jog are done. Called from the tick. */
function settleMoving() {
  if (state.status !== 'busy') return;
  // Not gated on jog.active: a jog does not hold the status busy, so a jog
  // running past the end of an ordinary move must not keep reporting one.
  if (Date.now() < movingUntil) return;
  state.status = 'idle';
  bumpSeq('state');
}

function bumpSeq(key) {
  seqs[key] = (seqs[key] ?? 0) + 1;
}

function pushReply(text) {
  pendingReply += (pendingReply ? '\n' : '') + text;
  replySeq++;
  seqs.reply = replySeq;
}

/** The board, as one object, so M997 and the object model cannot disagree. */
const BOARD = {
  shortName: 'MB6HC',
  name: 'Duet 3 MB6HC',
  firmwareName: 'RepRapFirmware for Duet 3 MB6HC',
  firmwareVersion: '3.6.0',
  firmwareDate: '2025-04-01',
  uniqueId: '0JD0M-9P6M2-NW4SD-6JKF6-3S46L-TB1UA',
  canAddress: 0,
  // What the board says it will flash from. Anything updating firmware has to
  // take these rather than guess: one release carries images for a dozen
  // boards, and the wrong one written to flash is a board that does not boot.
  firmwareFileName: 'Duet3Firmware_MB6HC.bin',
  iapFileNameSD: 'Duet3_SDiap32_MB6HC.bin',
  iapFileNameSBC: 'Duet3_SBCiap32_MB6HC.bin',
  bootloaderFileName: '',
};

// --- Object model assembly ----------------------------------------------

function buildModel(liveOnly) {
  const model = {
    boards: [
      {
        ...BOARD,
        freeRam: 47320,
        // min/max are the extremes observed since boot, exactly as the firmware
        // reports them — not permitted limits.
        vIn: { current: round(23.8 + Math.sin(t * 0.3) * 0.4), min: 22.9, max: 24.4 },
        v12: { current: 12.1, min: 11.8, max: 12.3 },
        mcuTemp: { current: round(41.2 + Math.sin(t * 0.11) * 3), min: 24.6, max: 48.1 },
      },
    ],
    directories: {
      firmware: '0:/firmware/',
      gCodes: '0:/gcodes/',
      macros: '0:/macros/',
      system: '0:/sys/',
      web: '0:/www/',
    },
    // A 4GB card with a slot beside it that has nothing in it. The empty slot
    // is not padding: an unmounted volume reports no capacity and no free
    // space, and a panel that renders that as a full bar or as "0 B free" is
    // the bug worth having a fixture for.
    volumes: [
      {
        name: 'SD card',
        mounted: true,
        capacity: 3980394496,
        partitionSize: 3975151616,
        freeSpace: freeSpace(),
        path: '0:/',
        speed: 20000000,
      },
      { name: '', mounted: false, capacity: null, partitionSize: null, freeSpace: null, path: '1:/' },
    ],
    global: globals,
    job: { ...job },
    move: {
      axes: axes.map((a) =>
        liveOnly
          ? { machinePosition: round(a.machinePosition), userPosition: round(a.userPosition) }
          : { ...a, machinePosition: round(a.machinePosition), userPosition: round(a.userPosition) },
      ),
      workplaceNumber,
      rotation: { angle: rotation.angle, centre: [...rotation.centre] },
      compensation: { ...compensation },
      speedFactor: model_speedFactor,
      // mm/SECOND, like the real board — RRF reports currentMove per second
      // while axes[].speed is per minute. Reporting a friendly mm/min here is
      // exactly how a 60x error in the feed readout survived being looked at.
      // 40 mm/s is the 2400 mm/min the mock's programs ask for.
      currentMove: { requestedSpeed: state.status === 'processing' ? 40 : 0, topSpeed: 40 },
    },
    network: {
      name: 'Sebs CNC',
      hostname: 'sebscnc',
      interfaces: [
        { type: 'ethernet', state: 'active', actualIP: '192.168.1.42', mac: 'BE:EF:00:11:22:33',
          gateway: '192.168.1.1', subnet: '255.255.255.0', speed: 100, numReconnects: 0 },
      ],
    },
    // Two probes, matching config-probe.g: K0 tool setter, K1 workpiece.
    //
    // Fields exactly as the real object model has them, which for a probe
    // means a reading and a threshold and NO `triggered` — that field is on
    // endstops. Reported here once, this mock had the front end believing in a
    // field the board never sends, and the probes panel read "open" on real
    // hardware no matter what the probe was doing (issue #1). A mock that is
    // kinder than the firmware does not test anything.
    sensors: {
      probes: [
        { value: [probeTriggered(0) ? 1000 : 0], type: 8, threshold: 500 },
        { value: [probeTriggered(1) ? 1000 : 0], type: 8, threshold: 500 },
      ],
    },
    seqs,
    spindles: [{ ...spindle, current: Math.round(spindle.current) }],
    state: { ...state },
    tools,
  };
  return model;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Probe state. Toggled by rr_gcode "M999 PROBE<n>" so the diagnostics panel can
 * be exercised without a probe to poke — the real board reports this from the
 * input pin and nothing else changes it.
 */
/**
 * Message-box sequence. Monotonic for the life of the mock, because that is
 * what the board's is: it never goes back, and a client is entitled to treat a
 * repeat as the same box it already answered. Deriving it from the box that is
 * currently up made it reset to 1 after every M292, so two prompts in a row
 * looked like one and a dialog kept the previous box's answer in its input.
 */
let promptSeq = 0;

const probesTriggered = [false, false];

/** Every G-code the board has been sent, for the test hook below. */
const sent = [];
const probeTriggered = (i) => probesTriggered[i] === true;

// --- HTTP ----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Deliberately as limited as the real firmware.
//
// `M586 C"*"` makes RRF send Access-Control-Allow-Origin and nothing else — it
// does NOT answer a CORS preflight with Access-Control-Allow-Headers. An
// obliging mock that sends the full permissive set hides an entire class of bug:
// any request with a custom header or non-simple Content-Type works against the
// mock and dies against the machine. So we mirror the firmware's actual
// behaviour, and preflights fail here exactly as they do on the Duet.
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function sendJson(res, obj) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** Endpoint to answer with silence, for testing the connect timeout / cancel. */
const HANG = process.env.MOCK_HANG ?? '';
const hung = [];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Any request on a session keeps it alive, the way the board's own idle
  // timeout works. Without this an active client's session would expire out
  // from under it while it was plainly still there.
  const activeKey = Number(req.headers['x-session-key'] ?? NaN);
  if (Number.isFinite(activeKey) && sessions.has(activeKey)) sessions.set(activeKey, Date.now());
  const path = url.pathname;

  // RRF has no OPTIONS handler, so a preflighted request gets nothing usable and
  // the browser reports an opaque network failure. Reproduce that here.
  if (req.method === 'OPTIONS') {
    res.writeHead(405);
    return res.end();
  }

  // The worst failure a controller has: it accepts the connection and then says
  // nothing at all. Not an error, not a refusal, not a close — silence. A client
  // that trusts fetch to eventually settle waits forever, which is exactly the
  // limbo this reproduces. MOCK_HANG names the endpoint to go quiet on
  // ("rr_connect", "rr_model", "all").
  if (HANG && (HANG === 'all' || path === `/${HANG}`)) {
    hung.push(res); // held so the socket stays open rather than being GC'd
    return; // deliberately no response, ever
  }

  switch (path) {
    case '/rr_connect': {
      // A session table with a limit, because the board has one.
      //
      // This mock used to hand out a session for every rr_connect and free
      // nothing, so a client that reconnected without disconnecting — or one
      // whose page was reloaded, which is the same thing seen from here — could
      // never run out. On a real board it can, quickly: the table is small, and
      // an abandoned session is held until it times out. What that looks like
      // to an operator is a controller that has stopped answering, which is a
      // long way from what it is.
      //
      // Modelled: the limit, err:2 when it is reached, release on
      // rr_disconnect, and expiry after the same idle timeout the board
      // reports. NOT modelled: per-IP implicit sessions, which is what a
      // cross-origin client gets when it cannot send the key header back.
      expireSessions();
      if (sessions.size >= MAX_SESSIONS) {
        return sendJson(res, { err: 2 });
      }
      sessionKey++;
      sessions.set(sessionKey, Date.now());
      return sendJson(res, { err: 0, sessionTimeout: SESSION_TIMEOUT_MS, boardType: 'duet3mb6hc', sessionKey, apiLevel: 1 });
    }

    case '/rr_disconnect': {
      const key = Number(req.headers['x-session-key'] ?? url.searchParams.get('sessionKey') ?? NaN);
      if (Number.isFinite(key) && sessions.has(key)) sessions.delete(key);
      // A disconnect with no key still frees something: the firmware ends the
      // session the request arrived on, and here the oldest is the best guess.
      else if (sessions.size) sessions.delete([...sessions.keys()][0]);
      return sendJson(res, { err: 0 });
    }

    // Not a firmware route. How many sessions the board is holding, so a test
    // can assert that a client gives them back.
    case '/__sessions':
      expireSessions();
      return sendJson(res, { open: sessions.size, max: MAX_SESSIONS });

    case '/rr_model': {
      const key = url.searchParams.get('key') ?? '';
      const flags = url.searchParams.get('flags') ?? '';
      // Counted so a test can assert how often a client asks. Free space is the
      // one key whose cost is on the board rather than on the wire — it walks
      // the FAT — so "how many times was volumes requested during an upload" is
      // a question worth being able to answer.
      keyRequests[key] = (keyRequests[key] ?? 0) + 1;

      // Asking for the WHOLE model verbose is the largest response the firmware
      // can be made to produce, and a real board can simply fail to deliver it.
      // A mock that cheerfully returns it hides that, so drop the connection
      // exactly as the board does — clients must fetch per key instead.
      if (!key && flags.includes('v')) {
        req.destroy();
        return;
      }

      const live = flags.includes('f') && !flags.includes('v');
      const model = buildModel(live);
      const result = key ? key.split('.').reduce((o, k) => (o ? o[k] : undefined), model) : model;
      return sendJson(res, { key, flags, result: result ?? null });
    }

    case '/rr_gcode': {
      const gcode = url.searchParams.get('gcode') ?? '';
      // Kept so a test can ask what was actually sent, rather than inferring it
      // from where the axis ended up — the board clamps to its own limits, so
      // the position after a move cannot tell a clamped request from a clamped
      // result.
      sent.push(gcode);
      if (sent.length > 200) sent.shift();
      handleGcode(gcode);
      return sendJson(res, { buff: 1024 });
    }

    case '/rr_reply': {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const out = pendingReply;
      pendingReply = '';
      return res.end(out);
    }

    case '/rr_filelist': {
      const dir = url.searchParams.get('dir') ?? '/';
      // Normalised, so `0:/firmware/`, `/firmware` and `/firmware/` are one
      // directory here as they are on the card.
      const key = normalisePath(dir);
      const files = FILES[key] ?? null;
      if (!files) return sendJson(res, { dir, first: 0, files: [], next: 0, err: 2 });
      return sendJson(res, { dir, first: 0, files, next: 0, err: 0 });
    }

    // Not a firmware route. What the board has actually been sent, so a test
    // can assert on the G-code itself rather than on its effects. That is the
    // only way to catch a refactor that changes what goes on the wire while
    // leaving the machine in the same place — a clamped move and a clamped
    // request look identical from the outside.
    case '/__sent': {
      const since = Number(url.searchParams.get('since') ?? 0);
      return sendJson(res, { sent: sent.slice(since), total: sent.length });
    }

    // Not a firmware route. The velocity-jog state as the board holds it,
    // including the clamp and the watchdog — neither of which a client can see
    // from the object model, and both of which a jog host has to get right.
    // Not a firmware route. The axis-following relationship as the board holds
    // it, so a test can tell a captured rule from a commanded one.
    case '/__follow':
      return sendJson(res, { ...follow, positions: Object.fromEntries(axes.map((a) => [a.letter, a.machinePosition])) });

    case '/__jog': {
      // Stepped on read as well as on the timer, so a test that checks the
      // watchdog does not have to sleep for a tick boundary to see it fire.
      stepJog(0);
      return sendJson(res, { ...jog, positions: Object.fromEntries(axes.map((a) => [a.letter, a.machinePosition])) });
    }

    // Not a firmware route. Puts the SD card back to how it started so a test
    // that writes files can be run twice and mean the same thing both times.
    case '/__key_requests':
      return sendJson(res, keyRequests);

    case '/__reset_files': {
      for (const k of Object.keys(FILE_CONTENT)) delete FILE_CONTENT[k];
      Object.assign(FILE_CONTENT, PRISTINE_CONTENT);
      for (const k of Object.keys(FILES)) delete FILES[k];
      Object.assign(FILES, JSON.parse(PRISTINE_LISTING));
      return sendJson(res, { err: 0 });
    }

    case '/rr_download': {
      const name = normalisePath(url.searchParams.get('name') ?? '');
      const content = FILE_CONTENT[name];
      if (content === undefined) {
        cors(res);
        res.writeHead(404);
        return res.end('not found');
      }
      cors(res);
      // Content-Length matters: without it the browser gets a chunked response
      // and a client can only show an indeterminate bar. A real controller knows
      // the file size and sends it, so the mock must too — otherwise the
      // determinate progress path never gets exercised here.
      const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
      return res.end(body);
    }

    case '/rr_upload': {
      const name = normalisePath(url.searchParams.get('name') ?? '');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      // Kept as a Buffer, not decoded to a string: the app installer writes
      // PNGs and gzip streams, and a round trip through utf8 turns both into
      // rubbish that still looks like a successful upload.
      const body = Buffer.concat(chunks);
      FILE_CONTENT[name] = body;
      uploaded.add(name);
      // ...and it appears in the directory. Storing the content without
      // listing it is the mock being kinder than the firmware in the one
      // direction that matters: anything that writes files and then checks
      // they arrived would see them all missing, forever.
      addToListing(name, body.length);
      // The firmware bumps this when the card's contents change, and that is
      // what makes a client re-read free space instead of showing the figure it
      // saw at connect.
      seqs.volumes++;
      pushReply(`Uploaded ${name}`);
      return sendJson(res, { err: 0 });
    }

    case '/rr_delete': {
      const name = normalisePath(url.searchParams.get('name') ?? '');
      delete FILE_CONTENT[name];
      removeFromListing(name);
      seqs.volumes++;
      return sendJson(res, { err: 0 });
    }

    case '/rr_mkdir': {
      // Actually create it. Answering err:0 and doing nothing meant a client
      // could make a directory, list it, and be told it does not exist.
      const dir = url.searchParams.get('dir') ?? '';
      if (dir) ensureDirectory(dir);
      seqs.volumes++;
      return sendJson(res, { err: 0 });
    }

    case '/rr_move':
      return sendJson(res, { err: 0 });

    default:
      break;
  }

  // Test hooks. Not firmware behaviour — a way for a test to see what actually
  // landed on the card, and to start from an empty one.
  if (path === '/_gcode') {
    cors(res);
    if (url.searchParams.get('clear') !== null) sent.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(sent));
  }
  if (path === '/_files') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.keys(FILE_CONTENT).sort()));
  }
  // What the last M997 did, so a test can tell "the firmware accepted it"
  // from "the button was pressed".
  if (path === '/_m997') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state.m997 ?? null));
  }
  if (path === '/_wipe') {
    const dir = url.searchParams.get('dir') ?? '';
    for (const key of Object.keys(FILE_CONTENT)) {
      if (dir && key.startsWith(`${dir}/`)) {
        delete FILE_CONTENT[key];
        // And out of the directory listing. Deleting the content but leaving
        // the name listed is a card that reports files it cannot open — which
        // is not a state a real one can be in, and it quietly defeats any test
        // that asks "what is already on the card?".
        removeFromListing(key);
      }
    }
    cors(res);
    res.writeHead(200);
    return res.end('ok');
  }

  // Anything uploaded under /www is served from there, which is what makes an
  // installed copy of the app reachable at http://machine/AxisControl/ — and
  // the only way to test that the install produced something that actually
  // runs, rather than a directory of files that uploaded without complaint.
  //
  // The .gz preference is the firmware's, and it is the half of this most
  // likely to be got wrong: RRF serves `cnc.js.gz` in answer to a request for
  // `cnc.js`, with Content-Encoding set, and an installer that uploaded only
  // the plain files would work here and be slow on the real board — while one
  // that uploaded only the .gz files would work on the board and 404 against a
  // mock that did not do this.
  // Static: serve dist/ so same-origin can be tested too. Before the card,
  // because this mock also stands in for the app's own dev server — on a real
  // machine /index.html IS /www/index.html, but here it usually has to be the
  // build under test.
  //
  // Except once something has actually been uploaded to that path. A real board
  // has one file there and serves it; this mock has two and has to choose, and
  // choosing dist unconditionally makes an install to /www untestable — the
  // page served at / would be the build under test whether or not a single byte
  // reached the card. So an uploaded file wins, and the pre-seeded DWC stand-in
  // at /www/index.html does not, which keeps every existing test loading the
  // app from / exactly as before.
  const onCard = `/www${path === '/' ? '/index.html' : path}`;
  const file = join(DIST, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!uploaded.has(onCard) && !uploaded.has(`${onCard}.gz`)) {
    try {
      await stat(file);
      const body = await readFile(file);
      cors(res);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(body);
    } catch {
      // Not part of the build; fall through to what is on the card.
    }
  }

  // A file under /www, resolved the way the firmware resolves one.
  //
  // Exact names only. RRF does NOT turn `/AxisControl/` into
  // `/AxisControl/index.html` — there is no directory index — and pretending it
  // did is how an installer gets shipped that works against this mock and
  // serves DWC's 404 on the real board.
  //
  // The .gz preference IS the firmware's: it answers a request for `cnc.js`
  // with `cnc.js.gz` and Content-Encoding set.
  const wwwPath = `/www${path}`;
  const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  const zipped = FILE_CONTENT[`${wwwPath}.gz`];
  const plain = FILE_CONTENT[wwwPath];
  if (zipped !== undefined || plain !== undefined) {
    const useGz = zipped !== undefined && accepts;
    const raw = useGz ? zipped : (plain ?? zipped);
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    cors(res);
    const headers = {
      'Content-Type': MIME[extname(wwwPath)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    };
    if (useGz) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    return res.end(body);
  }

  // What the firmware does with a path it cannot resolve: serve /www's own
  // index page, so a single-page app can route it client-side. On a real
  // machine that page is DWC — which is why a request for /AxisControl comes
  // back as DWC's "404 page not found" rather than as an HTTP 404, and why
  // that symptom means "the request never reached your files".
  const spa = FILE_CONTENT['/www/index.html'];
  if (spa !== undefined) {
    const body = Buffer.isBuffer(spa) ? spa : Buffer.from(String(spa), 'utf8');
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  }
  cors(res);
  res.writeHead(404);
  res.end('not found');
});

/**
 * Per-axis tuning commands, applied for real.
 *
 * The config panel sends these to try a value out and then reads the object
 * model back to say whether it took. A mock that accepted them and changed
 * nothing would let that whole path pass while doing nothing on a real board.
 */
const AXIS_SETTERS = {
  M92: 'stepsPerMm',
  M201: 'acceleration',
  M203: 'speed',
  M566: 'jerk',
  M906: 'current',
};

function applyAxisSetting(upper) {
  const cmd = /^(M92|M201|M203|M566|M906)\b/.exec(upper);
  if (!cmd) return false;
  const field = AXIS_SETTERS[cmd[1]];
  for (const m of upper.matchAll(/([XYZUVWABC])(-?\d+(?:\.\d+)?)/g)) {
    const axis = axes.find((a) => a.letter === m[1]);
    if (axis) axis[field] = Number(m[2]);
  }
  // Speeds, accelerations and currents are not in the frequently-changing set,
  // so a client polling d99fn never sees them move. RRF answers that by
  // advancing move's sequence number, which is a client's signal to re-read the
  // whole key — without this the mock changes a value that no client can
  // observe, and anything testing "did it take" passes while doing nothing.
  bumpSeq('move');
  return true;
}

function handleGcode(gcode) {
  const cmds = gcode.split('\n').map((c) => c.trim()).filter(Boolean);
  for (const cmd of cmds) {
    const upper = cmd.toUpperCase();

    if (applyAxisSetting(upper)) continue;

    if (/^M700\b/.test(upper.trim())) {
      handleJog(upper);
    } else if (/^M604\b/.test(upper.trim())) {
      // `cmd` as well as `upper`, because the axis letters arrive quoted and
      // upper-casing a quoted string is fine but the regex reads cleaner
      // against the original.
      handleFollow(cmd, upper);
    } else if (upper.startsWith('M997')) {
      // The firmware refuses to flash unless the files it named are actually
      // on the card — which is the whole safety property, so the mock enforces
      // it rather than accepting anything and reporting success.
      const board = BOARD;
      const dir = '0:/firmware/';
      const wanted = [board.firmwareFileName, board.iapFileNameSD];
      const missing = wanted.filter((f) => FILE_CONTENT[`${dir}${f}`] === undefined
        && FILE_CONTENT[`/firmware/${f}`] === undefined);
      if (missing.length) {
        pushReply(`Error: M997: firmware file ${missing[0]} not found`);
        state.m997 = { ok: false, missing };
      } else {
        // Which version the staged image is, taken out of the image itself —
        // the same thing a real board does by flashing it and then reporting
        // what it now runs.
        const staged = FILE_CONTENT[`${dir}${board.firmwareFileName}`]
          ?? FILE_CONTENT[`/firmware/${board.firmwareFileName}`];
        const stamped = /(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/.exec(String(staged ?? ''));
        state.pendingVersion = stamped ? stamped[1] : null;
        state.m997 = { ok: true, command: cmd };
        state.status = 'updating';
        pushReply('Updating main firmware');
        // A real board reboots and comes back reporting the version it was
        // just given. The mock does the same, because "the running version
        // changed" is the only evidence an update actually took — and the
        // panel's finished message hangs off exactly that.
        setTimeout(() => {
          if (state.pendingVersion) {
            BOARD.firmwareVersion = state.pendingVersion;
            state.pendingVersion = null;
            bumpSeq('boards');
          }
          state.status = 'idle';
          bumpSeq('state');
        }, 3000);
      }
      bumpSeq('state');
    } else if (/^M999\b/.test(upper.trim()) && !/PROBE|PROMPT/.test(upper)) {
      // A restart. The real board reboots — it stops answering for a few
      // seconds and comes back with nothing homed — so the parts a client can
      // observe are reproduced: the halt clears and the reference is gone.
      state.status = 'idle';
      for (const a of axes) a.homed = false;
      pushReply('Resetting');
      bumpSeq('state');
      bumpSeq('move');
    } else if (upper.startsWith('M112')) {
      state.status = 'halted';
      spindle.state = 'stopped';
      spindle.active = spindle.current = 0;
      pushReply('Emergency stop');
      bumpSeq('state');
    } else if (upper.startsWith('G28')) {
      state.status = 'idle';
      for (const a of axes) a.homed = true;
      pushReply('Homing complete');
      bumpSeq('move');
    } else if (/^M(18|84)\b/.test(upper.trim())) {
      // Releasing the motors loses the reference. The firmware clears the homed
      // flags and keeps reporting a position, which is the trap: the numbers
      // look perfectly normal and mean nothing until the next G28. Anything
      // that reads a position has to notice.
      //
      // `M84 S<seconds>` only sets the idle timeout and moves nothing, so a
      // command with no axis letters and an S is left alone.
      const letters = (upper.trim().replace(/^M(18|84)/, '').match(/[XYZUVWABC]/g) ?? []);
      if (letters.length || !/\bS\d/.test(upper)) {
        for (const a of axes) if (!letters.length || letters.includes(a.letter)) a.homed = false;
        pushReply('Steppers disabled');
        bumpSeq('move');
      }
    } else if (/^M3\b/.test(upper) || /^M4\b/.test(upper)) {
      const s = /S(\d+)/.exec(upper);
      spindle.active = s ? Number(s[1]) : 12000;
      spindle.state = upper.startsWith('M4') ? 'reverse' : 'forward';
      bumpSeq('spindles');
    } else if (/^M5\b/.test(upper)) {
      spindle.active = 0;
      spindle.state = 'stopped';
      bumpSeq('spindles');
    } else if (upper.startsWith('M32')) {
      const m = /"([^"]+)"/.exec(cmd);
      if (m) {
        const size = (FILE_CONTENT[m[1]] ?? '').length || 48210;
        job.file = { fileName: m[1], size, generatedBy: 'Fusion 360' };
        job.filePosition = 0;
        job.duration = 0;
        state.status = 'processing';
        pushReply(`Started job ${m[1]}`);
        bumpSeq('job');
        bumpSeq('state');
      }
    } else if (upper.startsWith('M220')) {
      const m = /S([\d.]+)/.exec(upper);
      if (m) { model_speedFactor = Number(m[1]) / 100; bumpSeq('move'); }
      pushReply(`Speed factor ${Math.round(model_speedFactor * 100)}%`);
    } else if (upper.startsWith('M290')) {
      const m = /Z(-?[\d.]+)/.exec(upper);
      if (m) {
        const absolute = /R0/.test(upper);
        axes[2].babystep = absolute ? Number(m[1]) : axes[2].babystep + Number(m[1]);
        bumpSeq('move');
        pushReply(`Babystep Z ${axes[2].babystep}`);
      }
    } else if (upper.startsWith('M25')) {
      state.status = 'paused';
      bumpSeq('state');
    } else if (upper.startsWith('M24')) {
      if (!job.file) {
        pushReply('Error: M24: no file selected');
      } else {
        state.status = 'processing';
        bumpSeq('state');
      }
    } else if (upper.startsWith('M0')) {
      state.status = 'idle';
      job.file = null;
      bumpSeq('state');
      bumpSeq('job');
    } else if (upper.startsWith('G10 L20') || upper.startsWith('G10 L2 ')) {
      // L20 sets the offset so the current position reads the value; L2 writes
      // the offset itself. P selects the system, 1 = G54, and defaults to the
      // active one — the real firmware treats P0 as "the current workplace".
      const byPosition = upper.startsWith('G10 L20');
      const pm = /\bP(\d+)/.exec(upper);
      const p = pm && Number(pm[1]) > 0 ? Number(pm[1]) - 1 : workplaceNumber;
      if (p > 8) {
        pushReply(`Error: G10: P parameter out of range`);
      } else {
        for (const a of axes) {
          const m = new RegExp(`${a.letter}(-?[\\d.]+)`).exec(upper);
          if (m) a.workplaceOffsets[p] = byPosition ? a.machinePosition - Number(m[1]) : Number(m[1]);
        }
        pushReply('Work offset set');
        bumpSeq('move');
      }
    } else if (/^G5[4-9](\.[123])?$/.test(upper.trim())) {
      const m = /^G59\.([123])$/.exec(upper.trim());
      workplaceNumber = m ? 5 + Number(m[1]) : Number(upper.trim().slice(1)) - 54;
      bumpSeq('move');
    } else if (upper.startsWith('G68')) {
      // R, and one of A/X plus one of B/Y, are all mandatory in RRF.
      const r = /R(-?[\d.]+)/.exec(upper);
      const x = /[AX](-?[\d.]+)/.exec(upper);
      const y = /[BY](-?[\d.]+)/.exec(upper);
      if (!r || !x || !y) {
        pushReply('Error: G68: missing parameter');
      } else {
        const incremental = /\bI\b/.test(upper);
        rotation.angle = incremental ? rotation.angle + Number(r[1]) : Number(r[1]);
        // The firmware stores the centre in machine coordinates: G68 takes work
        // coordinates and adds the workplace offset before keeping it.
        rotation.centre = [
          Number(x[1]) + axes[0].workplaceOffsets[workplaceNumber],
          Number(y[1]) + axes[1].workplaceOffsets[workplaceNumber],
        ];
        pushReply(`Coordinate rotation ${rotation.angle} deg`);
        bumpSeq('move');
      }
    } else if (upper.startsWith('M557')) {
      const x = /X(-?[\d.]+):(-?[\d.]+)/.exec(upper);
      const y = /Y(-?[\d.]+):(-?[\d.]+)/.exec(upper);
      const sp = /S(-?[\d.]+)(?::(-?[\d.]+))?/.exec(upper);
      if (x && y && sp) {
        grid = {
          xMin: Number(x[1]), xMax: Number(x[2]),
          yMin: Number(y[1]), yMax: Number(y[2]),
          sx: Number(sp[1]), sy: Number(sp[2] ?? sp[1]),
        };
        pushReply(`Grid set: ${grid.xMin}..${grid.xMax} x ${grid.yMin}..${grid.yMax}`);
      } else {
        pushReply('Error: M557: bad grid definition');
      }
    } else if (upper.startsWith('G29')) {
      // RRF's ProbeGrid calls SetZProbeNumber(gb, 'K') first, so a bare G29
      // silently uses probe 0 — the tool setter on this machine. The mock is
      // deliberately strict about it so the UI can never get away with omitting K.
      const sm = /\bS(\d)/.exec(upper);
      const sparam = sm ? Number(sm[1]) : 0;
      if (sparam === 0) {
        const km = /\bK(\d+)/.exec(upper);
        if (!km) {
          pushReply('Warning: G29 with no K parameter uses probe 0');
        }
        FILE_CONTENT['/sys/heightmap.csv'] = generateHeightMap(grid);
        compensation = {
          type: 'mesh',
          file: '/sys/heightmap.csv',
          meshDeviation: { mean: 0.041, deviation: 0.118 },
        };
        pushReply(`${(Math.floor((grid.xMax - grid.xMin) / grid.sx) + 1) * (Math.floor((grid.yMax - grid.yMin) / grid.sy) + 1)} points probed, mean error 0.041, deviation 0.118`);
        bumpSeq('move');
      } else if (sparam === 1) {
        compensation = {
          type: 'mesh',
          file: '/sys/heightmap.csv',
          meshDeviation: { mean: 0.041, deviation: 0.118 },
        };
        pushReply('Height map loaded');
        bumpSeq('move');
      } else if (sparam === 2) {
        compensation = { type: 'none' };
        pushReply('Bed compensation disabled');
        bumpSeq('move');
      }
    } else if (upper.trim() === 'G69') {
      rotation.angle = 0;
      rotation.centre = [0, 0];
      bumpSeq('move');
    } else if (/^(?:G53\s+)?G[01](?![\d.])/.test(upper)) {
      // A move, with or without the G53 prefix. Matching only lines that START
      // with G0/G1 meant every "G53 G0 X…" — which is how the ATC macros and
      // anything else that works in machine coordinates are written — was
      // dropped on the floor without a word.
      const relative = cmds.some((c) => c.toUpperCase() === 'G91');
      // G53 means "this line is in machine coordinates"; without it an absolute
      // move is in the active workplace and the offset has to be added. Taking
      // the number as a machine coordinate regardless made "go to work zero"
      // land on the machine origin in the fixture while doing the right thing
      // on a real board — a mock that quietly disagrees with the firmware is
      // worse than no mock.
      // On this line, not on one of its own: G53 is a modifier that applies to
      // the move it prefixes — "G53 G0 X0" — and only to that one. G91 is the
      // opposite, a mode set on its own line, which is why the two are tested
      // differently.
      const machineCoords = /(?:^|\s)G53(?:\s|$)/.test(upper);
      for (const a of axes) {
        const m = new RegExp(`${a.letter}(-?[\\d.]+)`).exec(upper);
        if (m) {
          const v = Number(m[1]);
          const target = relative
            ? a.machinePosition + v
            : v + (machineCoords ? 0 : a.workplaceOffsets[workplaceNumber]);
          a.machinePosition = Math.max(a.min, Math.min(a.max, target));
        }
      }
      markMoving();
      bumpSeq('move');
    } else if (/^M999 PROBE([01])$/.test(upper.trim())) {
      // Test hook, not a real RRF command: flips a probe so the diagnostics
      // panel can be exercised without something to poke the probe with.
      const i = Number(/^M999 PROBE([01])$/.exec(upper.trim())[1]);
      probesTriggered[i] = !probesTriggered[i];
      pushReply(`probe ${i} ${probesTriggered[i] ? 'triggered' : 'open'}`);
      bumpSeq('sensors');
    } else if (upper.startsWith('SET GLOBAL.')) {
      const m = /^set global\.(\w+)\s*=\s*(.+)$/i.exec(cmd);
      if (m) {
        const raw = m[2].trim();
        globals[m[1]] =
          raw === 'true' ? true : raw === 'false' ? false :
          !isNaN(Number(raw)) ? Number(raw) : raw.replace(/^"|"$/g, '');
        pushReply(`global.${m[1]} = ${globals[m[1]]}`);
        bumpSeq('global');
      }
    } else if (upper.startsWith('M291')) {
      const msg = /P"([^"]*)"/.exec(cmd);
      const title = /R"([^"]*)"/.exec(cmd);
      const mode = /S(\d+)/.exec(cmd);
      state.messageBox = {
        mode: mode ? Number(mode[1]) : 2,
        seq: ++promptSeq,
        title: title ? title[1] : 'Message',
        message: msg ? msg[1] : '',
        timeout: 0,
        axisControls: 0,
      };
      bumpSeq('state');
    } else if (/^M999 PROMPT([0-7])$/.test(upper.trim())) {
      // Test hook, not a real RRF command: raise a message box of each mode
      // with the fields a real one carries, so the dialog can be exercised
      // without a macro that prompts.
      //
      // Deliberately NOT an M291 parser. The mapping from M291's parameter
      // letters to these fields is firmware detail this mock has no business
      // guessing at — what the app reads is the object model, and this is the
      // object model. The fields are the ones @duet3d/objectmodel declares:
      // every one of them used to be dropped on the way to the dialog.
      const mode = Number(/^M999 PROMPT([0-7])$/.exec(upper.trim())[1]);
      const wants = mode >= 5;
      state.messageBox = {
        mode,
        seq: ++promptSeq,
        title: `Mode ${mode}`,
        message: [
          'No buttons — the machine is working.', 'Close when you have read this.',
          'Confirm to continue.', 'Continue, or stop here?', 'Which one?',
          'How many?', 'How far, in mm?', 'What shall it be called?',
        ][mode],
        timeout: 0,
        axisControls: 0,
        cancelButton: mode !== 0,
        choices: mode === 4 ? ['The first one', 'The second one', 'Neither'] : null,
        default: wants ? (mode === 5 ? 3 : mode === 6 ? 12.5 : 'workpiece') : null,
        min: mode === 5 ? 1 : mode === 6 ? 0 : null,
        max: mode === 5 ? 8 : mode === 6 ? 50 : null,
      };
      pushReply(`prompt ${mode} raised`);
      bumpSeq('state');
    } else if (upper.startsWith('M292')) {
      state.messageBox = null;
      pushReply('Message acknowledged');
      bumpSeq('state');
    } else if (upper.startsWith('M98')) {
      pushReply(`Running macro ${cmd}`);
    } else if (upper.startsWith('M120') || upper.startsWith('M121') || upper.startsWith('G90') || upper.startsWith('G91')) {
      // Motion-stack bookkeeping; nothing to simulate.
    } else {
      pushReply(`ok (${cmd})`);
    }
  }

  // After the batch, not inside the loop: the point of putting following in the
  // planner is that the follower arrives WITH the leader rather than chasing it,
  // so there is no state in which one has moved and the other has not.
  applyFollow();
}

server.listen(PORT, () => {
  console.log(`mock RRF controller on http://localhost:${PORT}`);
  console.log(`serving dist/ from ${DIST}`);
});
