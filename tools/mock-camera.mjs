// A stand-in Reolink camera.
//
// The camera panel is otherwise untestable without hardware, and the part that
// is easiest to get wrong is not the request bodies — it is the two modes the
// browser puts us in. So this serves the same endpoints twice over:
//
//   node tools/mock-camera.mjs 8090          no CORS headers  → "blind" mode,
//                                            replies unreadable, image still loads
//   node tools/mock-camera.mjs 8091 --cors   CORS headers     → "readable" mode
//
// Running both at once is the point: the same panel code has to work against
// each, and the difference is exactly what a real camera on the LAN does versus
// one behind a proxy that adds the headers.
//
// Frames are SVG rather than JPEG. An <img> renders them identically, they are
// a few hundred bytes, and having the frame number and clock drawn into the
// picture makes it obvious at a glance whether the panel is actually polling.
//
// MOCK_NO_ZOOM_POS=1 makes GetZoomFocus/StartZoomFocus unsupported, which is
// the other kind of camera: one that can be told to zoom in and out but cannot
// say where its lens is. The panel has to fall back to the buttons alone
// there, and that fallback is only ever exercised if the mock can be that
// camera on request.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8090);
const CORS = process.argv.includes('--cors');

/** Milliseconds to sit on a snapshot before answering, to imitate a LAN camera. */
const LATENCY = Number(process.env.MOCK_LATENCY ?? 0);

/**
 * What this model calls its status-LED states.
 *
 * MOCK_POWER_LED=On,KeepOff to be the other kind of Reolink — which is the
 * point: a client that hardcodes one spelling works on one of them and fails
 * silently on the other.
 */
const POWER_LED_STATES = (process.env.MOCK_POWER_LED ?? 'On,Off').split(',');

/**
 * Milliseconds a zoom takes, during which another zoom is refused.
 *
 * The lens is a motor. Told to go somewhere while it is still going somewhere
 * else, a real camera answers "ability error" — the same two words it uses for
 * a permission problem, which is what makes it worth reproducing rather than
 * imagining.
 */
const ZOOM_BUSY_MS = Number(process.env.MOCK_ZOOM_BUSY_MS ?? 0);
let zoomBusyUntil = 0;

/** Answer every setting change with the refusal a non-admin account gets. */
const LIMITED_USER = process.env.MOCK_LIMITED_USER === '1';

/** Pretend to be a camera with no absolute zoom. */
const NO_ZOOM_POS = process.env.MOCK_NO_ZOOM_POS === '1';

/**
 * Pretend to be a camera with a fixed-focus lens.
 *
 * Plenty are: a motorised zoom does not imply a motorised focus, and one that
 * answers GetAutoFocus with "not support" must leave no checkbox behind.
 */
const NO_AUTOFOCUS = process.env.MOCK_NO_AUTOFOCUS === '1';

/**
 * Commands to refuse, comma separated: MOCK_REFUSE=SetWhiteLed,SetIrLights
 *
 * Real cameras refuse things — a command this model does not implement, a
 * setting it will not take in the current mode — and they say so in the reply.
 * A mock that accepts everything cannot show whether the app notices.
 */
const REFUSE = new Set((process.env.MOCK_REFUSE ?? '').split(',').filter(Boolean));

/** What the lens can do, in the camera's own units — Reolink reports a range.
 *  Focus travels much further than zoom, which is why nothing may assume the
 *  two share a scale. */
const ZOOM_MIN = 0;
const ZOOM_MAX = 32;
const FOCUS_MIN = 0;
const FOCUS_MAX = 248;

/**
 * A real H.264 FLV, served the way the camera serves one.
 *
 * Generated with ffmpeg rather than faked: the point of testing this path is
 * that mpegts.js can demux what arrives and hand it to Media Source
 * Extensions, and a stub that is not actually H.264 in an FLV container
 * proves none of that.
 */
const FLV_PATH = fileURLToPath(new URL('fixtures/test-stream.flv', import.meta.url));
let FLV = null;
try {
  FLV = readFileSync(FLV_PATH);
} catch {
  // Only the /flv endpoint needs it; everything else runs without.
  console.log('  (no FLV fixture — run tools/make-flv-fixture.mjs for the video path)');
}

const USER = 'admin';
let PASSWORD = process.env.MOCK_PASSWORD ?? 'cnc';

/** Mutable camera state, so a command can be seen to have had an effect. */
const state = {
  pan: 0,
  tilt: 0,
  zoom: 0, // ZOOM_MIN..ZOOM_MAX
  focus: 12, // FOCUS_MIN..FOCUS_MAX
  /** The camera reports `disable`, so 0 means autofocus is ON. */
  autoFocusDisable: 1,
  moving: 'Stop',
  ir: 'Auto',
  whiteLed: { state: 0, mode: 1, bright: 100 },
  /** "On" or "KeepOff" — the camera's own words. */
  powerLed: 'On',
  isp: { channel: 0, dayNight: 'Auto', exposure: 'Auto', antiFlicker: 'Off', backLight: 'Off' },
  // `hue` is here and has no slider: it is the field that proves a write kept
  // the rest of the block instead of letting the camera default it.
  image: { channel: 0, bright: 128, contrast: 128, saturation: 100, sharpen: 64, hue: 128 },
  commands: [],
  /**
   * Every command with the moment it arrived.
   *
   * Timestamps because click-to-aim is a duration: the panel starts a motor and
   * stops it a while later, and the only way to check it ran for the right
   * length of time is to look at when the two requests landed.
   */
  log: [],
};

let frame = 0;
/** Snapshot requests served or refused, so a client's retrying can be counted. */
let snapCount = 0;

function cors(res) {
  if (!CORS) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, body) {
  const text = JSON.stringify(body);
  cors(res);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Authenticate against the *raw* query, not the decoded one.
 *
 * This is the camera's behaviour and it matters: `URLSearchParams` escapes `!`
 * as `%21`, which a decoding server would accept and this one does not. A mock
 * that decodes accepts both spellings, hides the difference, and the bug ships
 * — as it did, and then locked the account.
 */
function rawParam(url, name) {
  const match = new RegExp(`[?&]${name}=([^&]*)`).exec(url.search);
  return match ? match[1] : null;
}

/**
 * Failed logins are counted, and too many lock the account for a while, which
 * is exactly what a client that retries a bad password forever discovers.
 */
const auth = { failures: 0, lockedUntil: 0 };
const LOCK_AFTER = 5;
const LOCK_MS = 60_000;

function authOk(url) {
  if (Date.now() < auth.lockedUntil) return false;
  const ok = rawParam(url, 'user') === USER && rawParam(url, 'password') === PASSWORD;
  if (ok) {
    auth.failures = 0;
  } else if (++auth.failures >= LOCK_AFTER) {
    auth.lockedUntil = Date.now() + LOCK_MS;
    console.log('  [mock] account locked after repeated bad credentials');
  }
  return ok;
}

/**
 * SVG is XML, so text drawn into a frame has to be escaped.
 *
 * Not hypothetical: the day/night mode is literally "Black&White", and an
 * unescaped ampersand makes the whole frame fail to parse — which looks exactly
 * like a camera that has stopped sending.
 */
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function snapshot() {
  frame++;
  const now = new Date().toISOString().slice(11, 23);
  // Something that visibly moves with the PTZ state, so a pan command can be
  // confirmed from the picture alone.
  const cx = 320 + state.pan * 4;
  const cy = 180 + state.tilt * 4;
  const r = 40 + state.zoom * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#101418"/>
  <g stroke="#2a3340" stroke-width="1">
    ${Array.from({ length: 12 }, (_, i) => `<line x1="${i * 55}" y1="0" x2="${i * 55}" y2="360"/>`).join('')}
    ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${i * 55}" x2="640" y2="${i * 55}"/>`).join('')}
  </g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffbe2e" stroke-width="3"/>
  <text x="16" y="30" fill="#8cc7ff" font-family="monospace" font-size="18">mock camera — frame ${frame}</text>
  <text x="16" y="54" fill="#6a7482" font-family="monospace" font-size="14">${now}</text>
  <text x="16" y="340" fill="#6a7482" font-family="monospace" font-size="13">${xml(`pan ${state.pan} tilt ${state.tilt} zoom ${state.zoom} · ir ${state.ir} · led ${state.whiteLed.mode}/${state.whiteLed.bright} · ${state.isp.dayNight}`)}</text>
</svg>`;
}

/**
 * Content type of the POST being handled.
 *
 * Recorded because it turned out to matter: the real camera obeys a command
 * sent as application/x-www-form-urlencoded and ignores the same command sent
 * as text/plain, which from a page that cannot read replies is indistinguishable
 * from a control that does not work. The mock accepts either — it is not the
 * camera — but it remembers which was used, so the app can be held to sending
 * the shape that is known to work.
 */
let contentType = '';

function handleCommand(entry) {
  const cmd = entry?.cmd;
  const param = entry?.param ?? {};
  state.commands.push(cmd);
  state.log.push({ cmd, op: param.op ?? null, at: Date.now(), contentType });
  if (state.log.length > 200) state.log.shift();

  if (REFUSE.has(cmd)) {
    return { cmd, code: 1, error: { detail: 'not support', rspCode: -9 } };
  }

  // A user without administrator rights may watch and may drive the PTZ, and
  // may not change a setting. The camera says "ability error" — the same words
  // it uses for a command the model does not have, which is why the panel has
  // to explain the difference rather than quote it.
  if (LIMITED_USER && /^Set|^StartZoomFocus$/.test(cmd)) {
    return { cmd, code: 1, error: { detail: 'ability error', rspCode: -26 } };
  }

  switch (cmd) {
    case 'GetDevInfo':
      return {
        cmd,
        code: 0,
        value: {
          DevInfo: {
            model: 'E1 Outdoor Pro',
            name: 'Workshop',
            firmVer: 'v3.1.0.4066_23122801',
            hardVer: 'IPC_566SD164MP',
            channelNum: 1,
          },
        },
      };

    case 'PtzCtrl': {
      const op = param.op;
      const step = Math.max(1, Math.round((param.speed ?? 16) / 16));
      if (op === 'Left') state.pan -= step;
      else if (op === 'Right') state.pan += step;
      else if (op === 'Up') state.tilt -= step;
      else if (op === 'Down') state.tilt += step;
      else if (op === 'LeftUp') (state.pan -= step), (state.tilt -= step);
      else if (op === 'RightUp') (state.pan += step), (state.tilt -= step);
      else if (op === 'LeftDown') (state.pan -= step), (state.tilt += step);
      else if (op === 'RightDown') (state.pan += step), (state.tilt += step);
      else if (op === 'ZoomInc') state.zoom = Math.min(ZOOM_MAX, state.zoom + 4);
      else if (op === 'ZoomDec') state.zoom = Math.max(ZOOM_MIN, state.zoom - 4);
      else if (op === 'FocusInc') state.focus = Math.min(FOCUS_MAX, state.focus + 6);
      else if (op === 'FocusDec') state.focus = Math.max(FOCUS_MIN, state.focus - 6);
      else if (op === 'ToPos') (state.pan = (param.id ?? 0) * 10), (state.tilt = 0);
      state.moving = op;
      return { cmd, code: 0, value: { rspCode: 200 } };
    }

    case 'GetPtzPreset':
      return {
        cmd,
        code: 0,
        value: {
          PtzPreset: [
            { id: 1, enable: 1, name: 'Spindle' },
            { id: 2, enable: 1, name: 'Table' },
            { id: 3, enable: 0, name: '' },
          ],
        },
      };

    case 'GetZoomFocus':
      if (NO_ZOOM_POS) break;
      // action 1 asks for the limits as well as the value, and the limits are
      // the whole point: a slider cannot span a travel nobody has stated.
      return {
        cmd,
        code: 0,
        value: {
          ZoomFocus: { channel: 0, zoom: { pos: state.zoom }, focus: { pos: state.focus } },
        },
        range: {
          ZoomFocus: {
            zoom: { pos: { min: ZOOM_MIN, max: ZOOM_MAX } },
            focus: { pos: { min: FOCUS_MIN, max: FOCUS_MAX } },
          },
        },
      };

    case 'GetAutoFocus':
      if (NO_AUTOFOCUS) break;
      return { cmd, code: 0, value: { AutoFocus: { channel: 0, disable: state.autoFocusDisable } } };

    case 'SetAutoFocus': {
      if (NO_AUTOFOCUS) break;
      const af = param.AutoFocus ?? {};
      if (af.disable !== 0 && af.disable !== 1) {
        return { cmd, code: 1, error: { detail: 'set config failed', rspCode: -13 } };
      }
      state.autoFocusDisable = af.disable;
      return { cmd, code: 0, value: { rspCode: 200 } };
    }

    case 'StartZoomFocus': {
      if (NO_ZOOM_POS) break;
      if (ZOOM_BUSY_MS && Date.now() < zoomBusyUntil) {
        return { cmd, code: 1, error: { detail: 'ability error', rspCode: -26 } };
      }
      zoomBusyUntil = Date.now() + ZOOM_BUSY_MS;
      const zf = param.ZoomFocus ?? {};
      if (zf.op === 'ZoomPos' && typeof zf.pos === 'number') {
        state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zf.pos)));
      } else if (zf.op === 'FocusPos' && typeof zf.pos === 'number') {
        // A lens the camera is focusing itself will not be positioned by hand.
        if (!NO_AUTOFOCUS && state.autoFocusDisable === 0) {
          return { cmd, code: 1, error: { detail: 'ability error', rspCode: -26 } };
        }
        state.focus = Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, Math.round(zf.pos)));
      }
      return { cmd, code: 0, value: { rspCode: 200 } };
    }

    case 'GetImage':
      // The ranges come back only when asked with action 1 — which is exactly
      // what a real E1 Outdoor Pro does, and why anything that needs them has
      // to ask that way.
      return {
        cmd,
        code: 0,
        value: { Image: { ...state.image } },
        ...(entry?.action === 1
          ? {
              range: {
                Image: {
                  bright: { min: 0, max: 255 },
                  contrast: { min: 0, max: 255 },
                  saturation: { min: 0, max: 255 },
                  sharpen: { min: 0, max: 255 },
                  hue: { min: 0, max: 255 },
                },
              },
            }
          : {}),
      };

    case 'SetImage':
      // Replaces the whole block, like the real one. Sending a single field
      // therefore loses the others — which is the bug this reproduces rather
      // than hides.
      state.image = { ...(param.Image ?? {}) };
      return { cmd, code: 0, value: { rspCode: 200 } };

    case 'GetIrLights':
      return { cmd, code: 0, value: { IrLights: { channel: 0, state: state.ir } } };
    case 'SetIrLights':
      state.ir = param.IrLights?.state ?? state.ir;
      return { cmd, code: 0, value: { rspCode: 200 } };

    case 'GetWhiteLed':
      return { cmd, code: 0, value: { WhiteLed: { channel: 0, ...state.whiteLed } } };
    case 'SetWhiteLed':
      Object.assign(state.whiteLed, param.WhiteLed ?? {});
      return { cmd, code: 0, value: { rspCode: 200 } };

    case 'GetIsp':
      return { cmd, code: 0, value: { Isp: { ...state.isp } } };
    case 'SetIsp':
      // The real camera replaces the whole block; losing a field here is the
      // bug this reproduces, so record exactly what arrived.
      state.isp = { ...(param.Isp ?? {}) };
      return { cmd, code: 0, value: { rspCode: 200 } };

    case 'GetPowerLed':
      // The allowed words are in the range block — and this camera's off is
      // "Off", not the "KeepOff" other Reolinks use. That difference is not
      // cosmetic: sending the wrong one is refused, having changed nothing.
      return {
        cmd,
        code: 0,
        value: { PowerLed: { channel: 0, state: state.powerLed } },
        ...(entry?.action === 1 ? { range: { PowerLed: { state: POWER_LED_STATES } } } : {}),
      };

    case 'SetPowerLed': {
      const wanted = param.PowerLed?.state;
      if (!POWER_LED_STATES.includes(wanted)) {
        // Verbatim from an E1 Outdoor Pro asked for "KeepOff".
        return { cmd, code: 1, error: { detail: 'set config failed', rspCode: -13 } };
      }
      state.powerLed = wanted;
      return { cmd, code: 0, value: { rspCode: 200 } };
    }

    default:
      break;
  }
  // What a real camera does with a command this model lacks — also where the
  // two zoom commands land when MOCK_NO_ZOOM_POS is set.
  return { cmd, code: 1, error: { detail: 'not support', rspCode: -9 } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    cors(res);
    // Without --cors this is the wall a preflighted request hits.
    res.writeHead(CORS ? 204 : 405);
    return res.end();
  }

  if (url.searchParams.get('cmd') === 'Snap') snapCount++;

  // A debug hook for the test harness: what has the camera actually been told?
  if (url.pathname === '/_state') {
    state.authFailures = auth.failures;
    state.snaps = snapCount;
    // Change the password out from under a running client, which is what
    // happens in the field when someone edits the credentials on a live panel.
    if (url.searchParams.has('password')) {
      PASSWORD = url.searchParams.get('password');
      auth.failures = 0;
      auth.lockedUntil = 0;
    }
    if (url.searchParams.has('reset')) {
      state.log = [];
      state.commands = [];
    }
    return sendJson(res, state);
  }

  // HTTP-FLV: the RTMP stream, wrapped in HTTP so a browser can fetch it.
  // Reolink's own URL shape, port and app included.
  if (url.pathname === '/flv') {
    if (!authOk(url)) {
      cors(res);
      res.writeHead(401);
      return res.end('unauthorized');
    }
    if (!FLV) {
      res.writeHead(503);
      return res.end('no FLV fixture built');
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-store' });
    // Paced in chunks rather than dumped at once, so it behaves like a live
    // stream — which is what the player is configured for.
    let at = 0;
    const CHUNK = 32 * 1024;
    const pump = () => {
      if (res.writableEnded || at >= FLV.length) return res.end();
      res.write(FLV.subarray(at, at + CHUNK));
      at += CHUNK;
      setTimeout(pump, 25);
    };
    req.on('close', () => { at = FLV.length; });
    pump();
    return;
  }

  if (url.pathname !== '/cgi-bin/api.cgi') {
    res.writeHead(404);
    return res.end('not found');
  }

  if (!authOk(url)) {
    cors(res);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([{ cmd: 'Login', code: 1, error: { detail: 'login failed', rspCode: -6 } }]));
  }

  if (url.searchParams.get('cmd') === 'Snap') {
    // A real camera takes time to produce a frame, and that time is exactly
    // what a request-wait-request loop pays for on every frame.
    if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));
    const svg = snapshot();
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Length': Buffer.byteLength(svg),
      'Cache-Control': 'no-store',
    });
    return res.end(svg);
  }

  if (req.method === 'POST') {
    contentType = String(req.headers['content-type'] ?? '');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      return res.end('bad json');
    }
    const list = Array.isArray(body) ? body : [body];
    return sendJson(res, list.map(handleCommand));
  }

  res.writeHead(400);
  res.end('unsupported');
});

server.listen(PORT, () => {
  console.log(`mock camera on http://localhost:${PORT} (${CORS ? 'CORS enabled → readable' : 'no CORS → blind'})`);
  console.log(`  user "${USER}" password "${PASSWORD}"`);
  console.log('  credentials are compared raw — %21 is not ! here, exactly as the real one');
});
