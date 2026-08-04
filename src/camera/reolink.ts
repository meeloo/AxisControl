// Reolink's HTTP API.
//
// Everything is POST /cgi-bin/api.cgi with a JSON array of commands, except the
// snapshot, which is a GET that returns a JPEG — and it is the GET that matters
// most here, because it is the only part that works unconditionally from
// another origin (see types.ts).
//
// Request shapes below are taken from the reolink_aio library, which is what
// Home Assistant drives these cameras with, rather than from guesswork:
//
//   PtzCtrl      {"cmd":"PtzCtrl","action":0,"param":{"channel":0,"op":"Left","speed":32}}
//   goto preset  op "ToPos" plus "id": <preset number>
//   SetIrLights  {"cmd":"SetIrLights","action":0,"param":{"IrLights":{"channel":0,"state":"Auto"}}}
//   SetWhiteLed  {"cmd":"SetWhiteLed","param":{"WhiteLed":{"channel":0,"state":1,"bright":100,"mode":1}}}
//   SetPowerLed  {"cmd":"SetPowerLed","action":0,"param":{"PowerLed":{"channel":0,"state":"On"}}}
//   GetZoomFocus {"cmd":"GetZoomFocus","action":1,"param":{"channel":0}}
//   StartZoomFocus {"cmd":"StartZoomFocus","action":0,
//                   "param":{"ZoomFocus":{"channel":0,"op":"ZoomPos","pos":17}}}
//   SetIsp       {"cmd":"SetIsp","action":0,"param":{"Isp":{...everything GetIsp returned..., "dayNight":"Auto"}}}
//
// Note the shape of that last one: SetIsp does not take one field, it takes the
// whole ISP block back. Sending a partial block is how you discover that the
// camera has quietly reset its exposure settings. That read-modify-write is why
// day/night is the one control that cannot work blind.
//
// Saving a preset is deliberately absent. Going *to* a preset is verified;
// creating one is not, and a wrong body written to a PTZ camera's stored
// positions is not a good way to find out. Set them in the Reolink app.

import {
  normaliseCameraUrl,
  type CameraConfig,
  type CameraCredentials,
  IMAGE_FIELDS,
  type CameraControls,
  type ImageField,
  type ImageSettings,
  type ZoomState,
} from './types.js';

export type PtzOp =
  | 'Stop'
  | 'Left'
  | 'Right'
  | 'Up'
  | 'Down'
  | 'LeftUp'
  | 'LeftDown'
  | 'RightUp'
  | 'RightDown'
  | 'ZoomInc'
  | 'ZoomDec'
  | 'Auto';

/** Reolink's own spotlight modes. */
export const SPOTLIGHT_MODES = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Auto' },
  { value: 2, label: 'On at night' },
  { value: 3, label: 'Schedule' },
] as const;

export const DAY_NIGHT = [
  { value: 'Auto', label: 'Auto' },
  { value: 'Color', label: 'Colour' },
  { value: 'Black&White', label: 'Mono' },
] as const;

interface Command {
  cmd: string;
  action?: number;
  param?: Record<string, unknown>;
}

/**
 * What a refusal actually means, for the codes seen on real hardware.
 *
 * The camera's own `detail` is two or three words — "ability error", "set
 * config failed" — which name the category and not the cause. These are the
 * causes, established by watching the same command answered differently:
 * `SetPowerLed` as an administrator returns -13 because the value was wrong for
 * the model, and the identical request as a non-administrator returns -26. One
 * is a bug in the request, the other is a permission, and telling them apart
 * from the detail string alone is impossible.
 */
const REFUSAL_HINTS: Record<number, string> = {
  // Two very different causes, and the camera uses the same two words for both.
  // A non-administrator gets it for any setting; an administrator gets it for
  // something the device will not do *now* — a zoom motor still travelling
  // refuses the next position.
  [-26]:
    'either the account this panel uses is not an administrator (viewing and PTZ are ' +
    'allowed to any user, changing a setting is not), or the camera would not do it at ' +
    'that moment — a lens still moving refuses the next command',
  [-13]: 'the camera would not take that value for this model',
  [-6]: 'the camera did not accept the user name or password',
};

interface Reply {
  cmd: string;
  code: number;
  value?: Record<string, unknown>;
  /**
   * Limits, when the command was sent with action 1.
   *
   * This is the whole reason absolute zoom is possible: the camera states its
   * own zoom travel, so a slider can span exactly what the lens can do rather
   * than a number picked here and hoped for.
   */
  range?: Record<string, unknown>;
  error?: { detail?: string; rspCode?: number };
}

/** Dig `a.b.c` out of a reply without trusting any level to exist. */
function dig(root: unknown, ...path: string[]): unknown {
  let at: unknown = root;
  for (const key of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Build a query string the way a URL bar would, not the way a form would.
 *
 * `URLSearchParams` serialises as application/x-www-form-urlencoded, which
 * escapes characters that are perfectly legal in a query — `!` becomes `%21`.
 * A server that percent-decodes its parameters cannot tell the difference; this
 * camera evidently does not, so a password of `F4cptbz5!` was being sent as
 * `F4cptbz5%21` and rejected. Which is worse than it sounds: the camera counts
 * failed logins and locks the account.
 *
 * `encodeURIComponent` leaves `!`, `'`, `(`, `)`, `*`, `-`, `.`, `_` and `~`
 * alone — exactly the set a shell would pass through to curl, which is the
 * request that was proved to work. Anything genuinely reserved is still
 * escaped, because it has to be.
 */
function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function apiUrl(config: CameraConfig, creds: CameraCredentials, params: Record<string, string> = {}): string {
  const base = normaliseCameraUrl(config.url);
  // Credentials go in the query string rather than a token, because obtaining a
  // token means reading a Login reply — which is exactly what we may not be
  // able to do. Every command accepts user/password directly.
  return `${base}/cgi-bin/api.cgi?${query({ user: creds.user, password: creds.password, ...params })}`;
}

/** A still image, as a URL an <img> can load from any origin. */
export function snapshotUrl(
  config: CameraConfig,
  creds: CameraCredentials,
  cacheBust: number,
): string {
  return apiUrl(config, creds, {
    cmd: 'Snap',
    channel: String(config.channel),
    snapType: config.quality,
    // Without this the browser serves the first frame forever.
    rs: String(cacheBust),
  });
}

/**
 * The RTSP URL, for pasting into VLC or a bridge.
 *
 * Present so it can be shown and copied, never used — nothing in a browser can
 * open it.
 */
export function rtspUrl(config: CameraConfig, creds: CameraCredentials): string {
  const host = normaliseCameraUrl(config.url).replace(/^https?:\/\//, '');
  const stream = config.quality === 'sub' ? 'sub' : 'main';
  return `rtsp://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@${host}/h264Preview_${String(config.channel + 1).padStart(2, '0')}_${stream}`;
}

export class ReolinkClient {
  /**
   * Whether this origin can read the camera's replies.
   *
   * Decided once, by probing, and then obeyed — never by trying a readable
   * request and retrying blind on failure. A rejected fetch was still
   * *delivered*, so retrying a PTZ command would move the camera twice.
   */
  readable = false;

  constructor(
    private config: CameraConfig,
    private creds: CameraCredentials,
  ) {}

  /** Send commands. Returns the replies, or null when they cannot be read. */
  async send(commands: Command[]): Promise<Reply[] | null> {
    const url = apiUrl(this.config, this.creds);
    const init: RequestInit = {
      method: 'POST',
      // Two constraints meet here.
      //
      // It has to be a CORS-simple content type, or the browser issues a
      // preflight — which this camera answers with nothing useful, so the
      // command never leaves the browser at all. That rules out
      // application/json, whatever the API documentation says.
      //
      // Of the three simple ones it has to be the one the camera actually
      // accepts, and text/plain is not it: the same command that works from
      // curl — which defaults to form-urlencoded — was ignored from the
      // browser. The body is JSON either way and the camera parses it happily;
      // it is the header it dispatches on. This is the shape proven against the
      // real device, so it is the shape to keep.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify(commands),
      cache: 'no-store',
      credentials: 'omit',
    };

    if (!this.readable) {
      // Opaque by request: the command is delivered and obeyed, and the browser
      // is told not to expect an answer, so it does not log a CORS failure for
      // every button press.
      await fetch(url, { ...init, mode: 'no-cors' });
      return null;
    }

    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`camera returned HTTP ${res.status}`);
    const body = (await res.json()) as Reply[];
    return Array.isArray(body) ? body : [body];
  }

  /**
   * Send commands and insist they were accepted.
   *
   * `send` hands back whatever the camera said and lets the caller judge it,
   * which is right for a probe. For a *write* there is nothing to judge: a
   * refused command comes back as a non-zero code with a reason attached, and
   * dropping that on the floor is precisely how a control that does nothing
   * ends up looking identical to a control that works. The camera's own words
   * are more use than anything that could be invented here, so they are what
   * gets raised.
   *
   * On a camera whose replies cannot be read there is nothing to check and the
   * command has still been delivered, so blind mode is unchanged.
   */
  private async sendChecked(commands: Command[]): Promise<void> {
    const replies = await this.send(commands);
    if (!replies) return;
    for (const command of commands) {
      const reply = replies.find((r) => r.cmd === command.cmd);
      if (!reply) throw new Error(`${command.cmd}: the camera did not answer`);
      if (reply.code !== 0) {
        const detail = reply.error?.detail ?? `code ${reply.code}`;
        const code = reply.error?.rspCode;
        const rsp = code != null ? ` (rspCode ${code})` : '';
        const hint = code != null && REFUSAL_HINTS[code] ? ` — ${REFUSAL_HINTS[code]}` : '';
        throw new Error(`the camera refused ${command.cmd}: ${detail}${rsp}${hint}`);
      }
    }
  }

  /**
   * Ask the camera what it is, and find out whether it answers at all.
   *
   * Only ever called with `readable` true — the caller flips it back to false
   * when this throws, which is the signal that we are in blind mode.
   */
  async identify(): Promise<{ model: string; firmware: string; name: string }> {
    const replies = await this.send([{ cmd: 'GetDevInfo', action: 0, param: {} }]);
    const info = replies?.[0];
    if (!info || info.code !== 0) throw new Error('camera did not accept GetDevInfo');
    const dev = (info.value?.DevInfo ?? {}) as Record<string, unknown>;
    return {
      model: String(dev.model ?? 'Reolink'),
      firmware: String(dev.firmVer ?? ''),
      name: String(dev.name ?? ''),
    };
  }

  /**
   * Which controls this camera actually has.
   *
   * Established by asking for each setting and seeing which ones come back with
   * code 0, rather than by parsing GetAbility — the ability tree is large,
   * differs between firmware generations, and this answers the only question
   * that matters ("will the setter work?") more directly.
   */
  async detectControls(): Promise<CameraControls> {
    const channel = this.config.channel;
    const probes: Array<[keyof CameraControls, string]> = [
      ['irLights', 'GetIrLights'],
      ['spotlight', 'GetWhiteLed'],
      ['dayNight', 'GetIsp'],
      ['statusLed', 'GetPowerLed'],
      ['image', 'GetImage'],
      ['presets', 'GetPtzPreset'],
    ];
    const replies = await this.send(
      probes.map(([, cmd]) => ({ cmd, action: 0, param: { channel } })),
    );

    const controls: CameraControls = {
      // Pan and zoom have no "get" to probe; PtzCtrl is simply refused by a
      // camera that cannot move, which is harmless.
      pan: true,
      zoom: true,
      presets: false,
      irLights: false,
      spotlight: false,
      dayNight: false,
      statusLed: false,
      image: false,
    };
    if (!replies) return controls;

    for (const [key, cmd] of probes) {
      controls[key] = replies.some((r) => r.cmd === cmd && r.code === 0);
    }
    return controls;
  }

  // --- Motion -------------------------------------------------------------

  async ptz(op: PtzOp, speed: number): Promise<void> {
    await this.sendChecked([
      { cmd: 'PtzCtrl', action: 0, param: { channel: this.config.channel, op, speed } },
    ]);
  }

  async stop(): Promise<void> {
    await this.sendChecked([
      { cmd: 'PtzCtrl', action: 0, param: { channel: this.config.channel, op: 'Stop' } },
    ]);
  }

  async goToPreset(id: number): Promise<void> {
    await this.sendChecked([
      { cmd: 'PtzCtrl', action: 0, param: { channel: this.config.channel, op: 'ToPos', id, speed: 32 } },
    ]);
  }

  // --- Absolute zoom ------------------------------------------------------
  //
  // Separate from ptz() on purpose. ZoomInc/ZoomDec are a motor being told to
  // run and then stop, which is all a camera needs to expose and all that works
  // when replies cannot be read. A position is a different thing: it can be
  // asked for, it can be shown, and it can be set — but only on a camera that
  // has GetZoomFocus, and only from an origin allowed to read the answer.

  /**
   * Where the lens is now and how far it travels, or null if that is not
   * knowable — no such command, no readable replies, or a camera that reports a
   * position without saying what the limits are. Null means "keep the buttons,
   * skip the slider" rather than "guess a range".
   */
  async zoomState(): Promise<ZoomState | null> {
    const replies = await this.send([
      { cmd: 'GetZoomFocus', action: 1, param: { channel: this.config.channel } },
    ]);
    const reply = replies?.find((r) => r.cmd === 'GetZoomFocus' && r.code === 0);
    if (!reply) return null;

    const pos = num(dig(reply.value, 'ZoomFocus', 'zoom', 'pos'));
    const min = num(dig(reply.range, 'ZoomFocus', 'zoom', 'pos', 'min'));
    const max = num(dig(reply.range, 'ZoomFocus', 'zoom', 'pos', 'max'));
    if (pos === null || min === null || max === null || max <= min) return null;
    return { pos: Math.min(max, Math.max(min, pos)), min, max };
  }

  async setZoom(pos: number): Promise<void> {
    await this.sendChecked([
      {
        cmd: 'StartZoomFocus',
        action: 0,
        param: { ZoomFocus: { channel: this.config.channel, op: 'ZoomPos', pos: Math.round(pos) } },
      },
    ]);
  }

  /** Named presets, when readable; empty otherwise. */
  async presets(): Promise<Array<{ id: number; name: string }>> {
    const replies = await this.send([
      { cmd: 'GetPtzPreset', action: 0, param: { channel: this.config.channel } },
    ]);
    const value = replies?.find((r) => r.cmd === 'GetPtzPreset' && r.code === 0)?.value;
    const list = (value?.PtzPreset ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) return [];
    return list
      // enable 0 means the slot exists but has never been set.
      .filter((p) => Number(p.enable) === 1)
      .map((p) => ({ id: Number(p.id), name: String(p.name ?? `Preset ${p.id}`) }));
  }

  // --- Light and image ----------------------------------------------------

  async setIrLights(on: boolean): Promise<void> {
    await this.sendChecked([
      {
        cmd: 'SetIrLights',
        action: 0,
        // "Auto" rather than "On": the IR array is driven by the light sensor,
        // and the choice the camera offers is auto-or-never.
        param: { IrLights: { channel: this.config.channel, state: on ? 'Auto' : 'Off' } },
      },
    ]);
  }

  async setSpotlight(mode: number, brightness: number): Promise<void> {
    await this.sendChecked([
      {
        cmd: 'SetWhiteLed',
        param: {
          WhiteLed: {
            channel: this.config.channel,
            state: mode === 0 ? 0 : 1,
            mode,
            bright: Math.max(0, Math.min(100, Math.round(brightness))),
          },
        },
      },
    ]);
  }

  /**
   * The lamp on the camera body.
   *
   * "Off" or "KeepOff" depending on the model, and getting it wrong is not a
   * no-op — an E1 Outdoor Pro answers "set config failed", rspCode -13, having
   * changed nothing. Its own `GetPowerLed` states the truth in a range block:
   * `state: ["On", "Off"]`. Other Reolinks say "KeepOff" there.
   *
   * So: use what the camera said it accepts, and where that is unknown — a
   * blind camera states nothing — try the likelier spelling and let a refusal
   * pick the other. Two requests once, rather than a switch that silently does
   * nothing on half the range of models.
   */
  async setStatusLed(on: boolean): Promise<void> {
    const offStates = this.powerLedOffStates ?? ['Off', 'KeepOff'];
    const candidates = on ? ['On'] : offStates;

    let last: unknown = null;
    for (const state of candidates) {
      try {
        await this.sendChecked([
          {
            cmd: 'SetPowerLed',
            action: 0,
            param: { PowerLed: { channel: this.config.channel, state } },
          },
        ]);
        return;
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error('the camera would not set the status LED');
  }

  /** Off-states this camera says it accepts, learned from GetPowerLed's range. */
  private powerLedOffStates: string[] | null = null;

  /**
   * Day/night mode.
   *
   * Read-modify-write, because SetIsp replaces the whole ISP block: send it one
   * field and the camera takes the rest as defaults, quietly undoing exposure
   * and anti-flicker settings. So this needs readable replies, and says so
   * rather than half-working.
   */
  async setDayNight(value: string): Promise<void> {
    if (!this.readable) {
      throw new Error(
        'Day/night needs to read the camera’s current image settings first, which this ' +
          'browser cannot do from a different origin — SetIsp replaces every setting at once.',
      );
    }
    const replies = await this.send([
      { cmd: 'GetIsp', action: 0, param: { channel: this.config.channel } },
    ]);
    const isp = replies?.find((r) => r.cmd === 'GetIsp' && r.code === 0)?.value?.Isp;
    if (!isp || typeof isp !== 'object') throw new Error('could not read the camera’s image settings');

    await this.sendChecked([
      { cmd: 'SetIsp', action: 0, param: { Isp: { ...(isp as object), dayNight: value } } },
    ]);
  }

  /**
   * Brightness, contrast, saturation and sharpness, with the limits the camera
   * states for each.
   *
   * `action: 1` because that is the request that comes back with a `range`
   * block — action 0 returns the values alone, which is not enough to build a
   * slider that means anything. Verified against an E1 Outdoor Pro, where
   * action 0 omits the ranges entirely.
   */
  async readImage(): Promise<ImageSettings | null> {
    const replies = await this.send([
      { cmd: 'GetImage', action: 1, param: { channel: this.config.channel } },
    ]);
    const reply = replies?.find((r) => r.cmd === 'GetImage' && r.code === 0);
    const block = dig(reply?.value, 'Image');
    if (!reply || typeof block !== 'object' || block === null) return null;

    const values = {} as Record<ImageField, number>;
    const ranges = {} as Record<ImageField, { min: number; max: number }>;
    for (const field of IMAGE_FIELDS) {
      const value = num((block as Record<string, unknown>)[field]);
      if (value === null) continue;
      values[field] = value;
      const min = num(dig(reply.range, 'Image', field, 'min'));
      const max = num(dig(reply.range, 'Image', field, 'max'));
      ranges[field] = min !== null && max !== null && max > min ? { min, max } : { min: 0, max: 255 };
    }
    if (!Object.keys(values).length) return null;
    return { block: block as Record<string, unknown>, values, ranges };
  }

  /**
   * Change one picture setting.
   *
   * Read-modify-write for the same reason as day/night: SetImage replaces the
   * whole block, so sending it one field lets the camera default the rest —
   * turning a nudge to the brightness into a quiet reset of everything else.
   * That means it needs readable replies, and says so rather than half-working.
   */
  async setImage(field: ImageField, value: number): Promise<void> {
    if (!this.readable) {
      throw new Error(
        'Picture settings need to read the camera’s current values first, which this browser ' +
          'cannot do from a different origin — SetImage replaces every setting at once.',
      );
    }
    const current = await this.readImage();
    if (!current) throw new Error('could not read the camera’s picture settings');
    await this.sendChecked([
      {
        cmd: 'SetImage',
        action: 0,
        param: {
          Image: { ...current.block, channel: this.config.channel, [field]: Math.round(value) },
        },
      },
    ]);
  }

  /** Current settings, for showing real state rather than guesses. */
  async readState(): Promise<{
    ir: boolean | null;
    spotlightMode: number | null;
    spotlightBright: number | null;
    dayNight: string | null;
    statusLed: boolean | null;
  }> {
    const channel = this.config.channel;
    const replies = await this.send([
      { cmd: 'GetIrLights', action: 0, param: { channel } },
      { cmd: 'GetWhiteLed', action: 0, param: { channel } },
      { cmd: 'GetIsp', action: 0, param: { channel } },
      // action 1 for this one: the allowed states come back in the range block,
      // and which word means "off" differs between models.
      { cmd: 'GetPowerLed', action: 1, param: { channel } },
    ]);
    const pick = (cmd: string, key: string) =>
      replies?.find((r) => r.cmd === cmd && r.code === 0)?.value?.[key] as
        | Record<string, unknown>
        | undefined;

    const ir = pick('GetIrLights', 'IrLights');
    const led = pick('GetWhiteLed', 'WhiteLed');
    const isp = pick('GetIsp', 'Isp');
    const power = pick('GetPowerLed', 'PowerLed');
    const states = dig(
      replies?.find((r) => r.cmd === 'GetPowerLed' && r.code === 0)?.range,
      'PowerLed',
      'state',
    );
    if (Array.isArray(states)) {
      const off = states.filter((v): v is string => typeof v === 'string' && v !== 'On');
      if (off.length) this.powerLedOffStates = off;
    }
    return {
      ir: ir ? ir.state === 'Auto' : null,
      spotlightMode: led && led.mode != null ? Number(led.mode) : null,
      spotlightBright: led && led.bright != null ? Number(led.bright) : null,
      dayNight: isp && isp.dayNight != null ? String(isp.dayNight) : null,
      // "KeepOff" is the camera's word for off; anything else is some flavour of on.
      statusLed: power && power.state != null ? String(power.state) === 'On' : null,
    };
  }
}
