// A camera pointed at the machine.
//
// Independent of the controller entirely — it has its own address and its own
// credentials, and it works whether or not the Duet is connected, because the
// times you most want to see the spindle are the times something has gone
// wrong with the connection to it.
//
// The picture is double-buffered: two <img> elements, one showing and one
// loading, swapped when the new frame has decoded. Pointing a single <img> at a
// new src blanks it while the next one downloads, which at 2fps is a strobe
// rather than a video.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { appendLog, loadSetting, saveSetting } from '../core/store.js';
import { detectCamera } from '../camera/detect.js';
import { DAY_NIGHT, ReolinkClient, SPOTLIGHT_MODES, rtspUrl, snapshotUrl } from '../camera/reolink.js';
import type { PtzOp } from '../camera/reolink.js';
import { flvUrl, playVideo, videoSupported, type VideoSession } from '../camera/flv.js';
import {
  NO_CONTROLS,
  defaultCameraConfig,
  defaultCredentials,
  type CameraConfig,
  type CameraCredentials,
  IMAGE_FIELDS,
  type CameraProbe,
  type ImageSettings,
  type ZoomState,
} from '../camera/types.js';

/** Pad layout, matching the jog rose's compass sense: north is up-screen. */
const PAD: Array<{ op: PtzOp; label: string; title: string } | null> = [
  { op: 'LeftUp', label: '↖', title: 'Up and left' },
  { op: 'Up', label: '↑', title: 'Up' },
  { op: 'RightUp', label: '↗', title: 'Up and right' },
  { op: 'Left', label: '←', title: 'Left' },
  null, // centre: stop
  { op: 'Right', label: '→', title: 'Right' },
  { op: 'LeftDown', label: '↙', title: 'Down and left' },
  { op: 'Down', label: '↓', title: 'Down' },
  { op: 'RightDown', label: '↘', title: 'Down and right' },
];

/**
 * Rates offered. 0 means "as fast as they arrive" — with the pipeline that is
 * the camera's own ceiling rather than a number anyone has to guess.
 */
const FPS_CHOICES: Array<{ value: number; label: string }> = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 5, label: '5' },
  { value: 10, label: '10' },
  { value: 15, label: '15' },
  { value: 0, label: 'Max' },
];

/** Consecutive dropped frames before the picture is called stale. */
const FRAME_ERROR_LIMIT = 3;

export class CameraPanel extends PanelElement {
  private config: CameraConfig = {
    ...defaultCameraConfig(),
    ...loadSetting<Partial<CameraConfig>>('camera', {}),
  };
  private creds: CameraCredentials = {
    ...defaultCredentials(),
    ...loadSetting<Partial<CameraCredentials>>('cameraAuth', {}),
  };

  private probe: CameraProbe | null = null;
  private client: ReolinkClient | null = null;
  private error: string | null = null;
  /** Which operation the message belongs to, so only that one may clear it. */
  private errorFor: string | null = null;
  private busy = false;
  private showSetup = false;
  /** Reveal the stored camera password, for when it has to be checked. */
  private showPassword = false;
  private live = false;

  /** Buffers cycle; whichever decodes a newer frame becomes the visible one. */
  private streaming = false;
  private timers: number[] = [];
  /** Request counter, so an out-of-order arrival can be recognised and dropped. */
  private seq = 0;
  private shownSeq = -1;
  /** Consecutive frame failures; reset by any frame that arrives. */
  private frameErrors = 0;

  // --- Live video ---------------------------------------------------------
  private video: VideoSession | null = null;
  private usingVideo = false;
  /** Why video is not on, when it was tried and did not work. */
  private videoNote: string | null = null;
  /** Guards the async start against updated() calling in again mid-attempt. */
  private startingStream = false;
  private presets: Array<{ id: number; name: string }> = [];

  // Control state. Null means "not read" — blind mode never learns it.
  private ir: boolean | null = null;
  private spotMode: number | null = null;
  private spotBright = 100;
  private dayNight: string | null = null;
  private statusLed: boolean | null = null;
  private image: ImageSettings | null = null;
  private showImage = false;

  private speed = 16;

  /**
   * Absolute zoom, when the camera has it. Null keeps the ＋/－ buttons alone,
   * which is the right answer for a camera that can only be told to zoom and
   * not asked where it is.
   */
  private zoom: ZoomState | null = null;
  /** Slider position while dragging, before the camera has confirmed it. */
  private zoomWanted: number | null = null;
  private zoomSending = false;
  /**
   * Why there is no zoom slider, so the panel can say rather than just omit it.
   * A control that is silently absent reads as a broken app.
   */
  private zoomWhy: 'unknown' | 'ok' | 'blind' | 'unsupported' = 'unknown';

  /** Where the last aim-click landed, for the marker. Element coordinates. */
  private aim: { x: number; y: number } | null = null;
  private aimTimer: number | null = null;
  private lastClickAt = 0;
  /** True while anything queued below is still running, for the marker. */
  private aiming = false;
  private pending = 0;
  /**
   * Aim actions run one after another.
   *
   * A double-click is a pan and then a zoom, and they are different subsystems
   * reached through the same PtzCtrl: sending the zoom while the pan is still
   * running means the pan's Stop can land on the zoom instead, which reads as
   * "double-click sometimes doesn't zoom".
   */
  private queue: Promise<unknown> = Promise.resolve();

  override connectedCallback(): void {
    super.connectedCallback();
    // Nothing is contacted until the operator asks, or until a camera that has
    // already been set up is on screen.
    if (this.configured) void this.start();
    else this.showSetup = true;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopStream();
  }

  /** A hidden tab must not keep pulling 4K stills off the camera. */
  private onVisibility = (): void => {
    if (document.hidden) this.stopStream();
    else if (this.live) this.startStream();
  };

  private get configured(): boolean {
    return this.config.kind === 'generic' ? !!this.config.imageUrl.trim() : !!this.config.url.trim();
  }

  private get controls() {
    return this.probe?.controls ?? NO_CONTROLS;
  }

  // --- Connecting ---------------------------------------------------------

  private async start(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.requestUpdate();
    try {
      const probe = await detectCamera(this.config, this.creds);
      this.probe = probe;
      if (probe.kind === 'reolink') {
        const client = new ReolinkClient(this.config, this.creds);
        client.readable = probe.readable;
        this.client = client;
        this.zoom = null;
        this.zoomWhy = probe.readable ? 'unknown' : 'blind';
        if (probe.readable) await this.refreshState();
      } else {
        this.client = null;
      }
      this.live = true;
      this.showSetup = false;
      this.showPassword = false;
      void this.startStream();
    } catch (err) {
      this.error = (err as Error).message;
      this.live = false;
      this.probe = null;
      this.showSetup = true;
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private async refreshState(): Promise<void> {
    if (!this.client?.readable) return;
    try {
      const state = await this.client.readState();
      this.ir = state.ir;
      this.spotMode = state.spotlightMode;
      if (state.spotlightBright != null) this.spotBright = state.spotlightBright;
      this.dayNight = state.dayNight;
      this.statusLed = state.statusLed;
      if (this.controls.image) this.image = await this.client.readImage();
      if (this.controls.presets) this.presets = await this.client.presets();
      if (this.controls.zoom) {
        this.zoom = await this.client.zoomState();
        this.zoomWhy = this.zoom ? 'ok' : 'unsupported';
      }
    } catch {
      // Readable a moment ago, not now. The picture is the important part.
    }
  }

  private saveConfig(): void {
    saveSetting('camera', this.config);
    saveSetting('cameraAuth', this.creds);
  }

  // --- The picture --------------------------------------------------------

  private imgs(): HTMLImageElement[] {
    return Array.from(this.querySelectorAll<HTMLImageElement>('.cam-frame'));
  }

  private frameUrl(): string {
    if (this.config.kind === 'generic') {
      const url = this.config.imageUrl;
      if (this.config.stream) return url; // one long-lived request, never reissued
      // A still fetched over and over needs a cache-buster of its own, or the
      // browser answers every request with the first frame it ever saw.
      return `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
    }
    return snapshotUrl(this.config, this.creds, Date.now());
  }

  /**
   * Frames per second the pipeline is actually achieving.
   *
   * Shown, because the ceiling depends entirely on the camera and the network
   * and there is otherwise no way to tell a setting that is too high from a
   * camera that is struggling.
   */
  private measured = 0;
  private frameTimes: number[] = [];

  /** Milliseconds between frames the operator asked for; 0 means unpaced. */
  private framePeriod(): number {
    const fps = this.config.fps;
    return fps > 0 ? 1000 / fps : 0;
  }

  /**
   * Poll for stills, several requests deep.
   *
   * The obvious loop — request, wait, request — is what made this a slideshow:
   * the wait is added *after* the frame arrives, so every frame costs a full
   * round trip plus the interval, and a 2fps setting over a 150ms link runs at
   * about 1.5. Requests are pipelined instead, so the round trip overlaps
   * itself and the rate is set by what the camera can produce rather than by
   * how far away it is.
   *
   * Three in flight, not more: Reolink's HTTP server has few workers, and
   * queueing requests it cannot serve buys latency rather than frames.
   */
  private async startStream(): Promise<void> {
    if (this.startingStream) return;
    this.startingStream = true;
    try {
      this.stopStream();
      if (!this.live || document.hidden) return;

      // Video first where it is wanted and possible. Whether it works is not
      // predictable from anything the camera says about itself, so it is
      // simply attempted; the fallback costs a few seconds once.
      if (this.wantsVideo() && (await this.tryVideo())) return;

      this.startSnapshots();
    } finally {
      this.startingStream = false;
    }
  }

  /** Is live video worth attempting at all? */
  private wantsVideo(): boolean {
    if (this.config.kind === 'generic' || this.config.mode === 'snapshot') return false;
    // No Media Source Extensions means no video, and checking first is what
    // keeps an iOS 12 iPad from downloading a 270KB demuxer it cannot use.
    return videoSupported();
  }

  /**
   * Try HTTP-FLV, and say whether it actually produced a picture.
   *
   * The <video> element has to exist before the player can attach to it, hence
   * the render round trip. A failure here is ordinary — a camera set to H.265,
   * a firmware without the endpoint, or a stream this origin is not allowed to
   * read — so it resolves false rather than throwing.
   */
  private async tryVideo(): Promise<boolean> {
    this.usingVideo = true;
    this.videoNote = null;
    this.requestUpdate();
    await this.updateComplete;

    const el = this.querySelector<HTMLVideoElement>('.cam-video');
    if (!el) {
      this.usingVideo = false;
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let decided = false;
      const settle = (ok: boolean, note: string | null): void => {
        if (decided) return;
        decided = true;
        if (!ok) {
          this.usingVideo = false;
          this.videoNote = note;
          this.video?.stop();
          this.video = null;
        }
        this.requestUpdate();
        resolve(ok);
      };

      playVideo(el, flvUrl(this.config, this.creds), {
        onPlaying: () => settle(true, null),
        onError: (message) => {
          if (!decided) {
            settle(false, message);
            return;
          }
          // It played and then stopped. Go back to stills rather than leaving
          // a frozen frame that looks like a working camera.
          this.videoNote = `Video stopped: ${message}`;
          this.usingVideo = false;
          this.video?.stop();
          this.video = null;
          this.requestUpdate();
          this.startSnapshots();
        },
      })
        .then((session) => {
          if (decided && !this.usingVideo) session.stop();
          else this.video = session;
        })
        .catch((err: Error) => settle(false, err.message));
    });
  }

  private startSnapshots(): void {
    this.frameErrors = 0;
    this.frameTimes = [];
    this.measured = 0;
    if (!this.live || document.hidden) return;

    // A multipart MJPEG endpoint streams into one <img> on its own; polling it
    // would throw away the connection every frame. Only ever a generic camera:
    // Reolink's snapshot endpoint returns one image and would freeze on it.
    if (this.config.kind === 'generic' && this.config.stream) {
      const [a] = this.imgs();
      if (a && a.src !== this.config.imageUrl) a.src = this.frameUrl();
      return;
    }

    const imgs = this.imgs();
    // start() flips `live` and calls straight in, before the render that
    // creates the buffers. Staying stopped is what lets updated() try again;
    // claiming to be streaming with nothing to stream from would wedge it.
    if (!imgs.length) return;

    this.streaming = true;
    const period = this.framePeriod();
    imgs.forEach((img, index) => {
      // Stagger the start so the buffers stay evenly spaced rather than all
      // asking at once and then all idling together.
      this.timers[index] = window.setTimeout(
        () => this.pump(img, index),
        (period * index) / Math.max(1, imgs.length),
      );
    });
  }

  /** One buffer's loop: request a frame, show it if it is the newest, repeat. */
  private pump(img: HTMLImageElement, index: number): void {
    if (!this.streaming) return;

    // Dockview keeps a panel mounted when its tab is not the one showing, so
    // without this the camera is still asked for frames while nobody is
    // looking. offsetParent is null exactly when an ancestor is display:none.
    if (document.hidden || this.offsetParent === null) {
      this.timers[index] = window.setTimeout(() => this.pump(img, index), 1000);
      return;
    }

    const seq = ++this.seq;
    const started = Date.now();

    img.onload = () => {
      const wasStale = this.frameErrors >= FRAME_ERROR_LIMIT;
      this.frameErrors = 0;
      this.showFrame(img, seq);
      if (wasStale) this.requestUpdate();
      this.reschedule(img, index, started, false);
    };
    img.onerror = () => {
      // A dropped frame is not a failure — cameras hiccup, and retrying is
      // right. But retrying silently forever is how a black rectangle comes
      // to mean both "night" and "the camera died half an hour ago", so once
      // it is clearly not a hiccup, say so.
      this.frameErrors++;
      if (this.frameErrors === FRAME_ERROR_LIMIT) this.requestUpdate();
      this.reschedule(img, index, started, true);
    };
    img.src = this.frameUrl();
  }

  private reschedule(
    img: HTMLImageElement,
    index: number,
    started: number,
    failed: boolean,
  ): void {
    if (!this.streaming) return;
    const buffers = Math.max(1, this.imgs().length);
    // Each buffer only has to fire every buffers×period for the buffers
    // together to hit the asked-for rate.
    const target = failed
      ? Math.max(1000, this.framePeriod())
      : this.framePeriod() * buffers;
    const wait = Math.max(0, target - (Date.now() - started));
    this.timers[index] = window.setTimeout(() => this.pump(img, index), wait);
  }

  /**
   * Put a decoded frame on screen, unless a newer one already is.
   *
   * With several requests in flight they can finish out of order, and showing
   * a late arrival would jump the picture backwards in time.
   */
  private showFrame(img: HTMLImageElement, seq: number): void {
    if (seq < this.shownSeq) return;
    this.shownSeq = seq;
    for (const other of this.imgs()) other.classList.toggle('showing', other === img);

    const now = Date.now();
    this.frameTimes.push(now);
    if (this.frameTimes.length > 12) this.frameTimes.shift();
    const span = now - this.frameTimes[0];
    if (this.frameTimes.length > 2 && span > 0) {
      const rate = ((this.frameTimes.length - 1) * 1000) / span;
      // Only re-render when the readout would actually change.
      if (Math.abs(rate - this.measured) > 0.4) {
        this.measured = rate;
        this.requestUpdate();
      }
    }
  }

  private stopStream(): void {
    this.video?.stop();
    this.video = null;
    this.usingVideo = false;
    this.streaming = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const img of this.imgs()) img.onload = img.onerror = null;
  }

  protected override updated(): void {
    // The <img> pair only exists once a camera is live, so the stream cannot be
    // started before the first render that includes them.
    if (this.live && !this.streaming && !this.usingVideo && !this.startingStream && !this.config.stream) {
      void this.startStream();
    }
  }

  // --- Commands -----------------------------------------------------------

  /**
   * Every control goes through here, so a blind-mode failure is still seen.
   *
   * Only the *same* operation succeeding clears a message. Clearing on any
   * success sounds tidier and is unreadable: a refused pan is followed a moment
   * later by the Stop that ends the press, and if that Stop wipes the message
   * the report of the refusal is on screen for about a second — long enough to
   * notice, not long enough to read.
   *
   * It also goes to the console, so it can be read after the fact, and quoted.
   * A camera's own words about why it said no are the most useful thing in the
   * whole exchange.
   */
  private async command(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      if (this.errorFor === what) {
        this.error = null;
        this.errorFor = null;
      }
    } catch (err) {
      const message = `${what}: ${(err as Error).message}`;
      this.error = message;
      this.errorFor = what;
      appendLog({ level: 'error', text: `camera: ${message}`, time: new Date() });
      // The switch or slider has already moved to where it was put. If the
      // camera refused, that reading is now a lie — so where the camera can be
      // asked, ask it, and let the control snap back to the truth.
      if (this.client?.readable) void this.refreshState();
    }
    this.requestUpdate();
  }

  private hold(op: PtzOp): void {
    void this.command('move', async () => {
      await this.client!.ptz(op, this.speed);
    });
  }

  private release(): void {
    void this.command('stop', async () => {
      await this.client!.stop();
    });
    // The buttons and the slider drive the same lens, so the slider has to
    // follow them. Read it back after the motor has had a moment to stop,
    // otherwise the answer is where it was rather than where it ended up.
    if (this.zoom) window.setTimeout(() => void this.refreshZoom(), 400);
  }

  // --- Aiming by clicking the picture -------------------------------------
  //
  // A camera of this kind cannot be told to look at an angle. It can be told to
  // start moving and to stop, so aiming at a point means running the motor for
  // a while — and how long depends on the gearing and the field of view, which
  // no command reports. `sweepMs` is that constant, and clicking is the only
  // way to calibrate it.
  //
  // Which is why the aim deliberately falls short: at 80% of the computed
  // travel, repeated clicks converge on the target even when the constant is
  // some way out. Aiming for exactly 100% turns any overestimate into an
  // oscillation that never settles, and the operator into someone tapping back
  // and forth across the thing they wanted to look at.

  /** Fixed, so `sweepMs` means something. The Speed slider is for the pad. */
  private static readonly AIM_SPEED = 32;
  private static readonly AIM_FRACTION = 0.8;
  /** Below this the camera has barely started before it is told to stop. */
  private static readonly MIN_NUDGE_MS = 50;

  /**
   * Where a click landed, as a fraction of the picture from its centre:
   * (0, 0) is the middle, (±1, ±1) the corners.
   *
   * Measured against the picture rather than the element, because both the
   * stills and the video are `object-fit: contain` — on a panel that is not the
   * camera's aspect ratio there are bars, and a click measured against the box
   * aims at the wrong place by however wide they are.
   */
  private aimPoint(e: MouseEvent): { nx: number; ny: number; x: number; y: number } | null {
    const view = this.querySelector<HTMLElement>('.cam-view');
    if (!view) return null;
    const rect = view.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const media: HTMLVideoElement | HTMLImageElement | null = this.usingVideo
      ? this.querySelector<HTMLVideoElement>('.cam-video')
      : (this.imgs().find((i) => i.classList.contains('showing')) ?? null);
    const nw = media instanceof HTMLVideoElement ? media.videoWidth : (media?.naturalWidth ?? 0);
    const nh = media instanceof HTMLVideoElement ? media.videoHeight : (media?.naturalHeight ?? 0);

    let w = rect.width;
    let h = rect.height;
    if (nw > 0 && nh > 0) {
      const scale = Math.min(rect.width / nw, rect.height / nh);
      w = nw * scale;
      h = nh * scale;
    }
    const left = rect.left + (rect.width - w) / 2;
    const top = rect.top + (rect.height - h) / 2;

    const nx = ((e.clientX - left) / w) * 2 - 1;
    const ny = ((e.clientY - top) / h) * 2 - 1;
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null; // the letterbox
    return { nx, ny, x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Can this camera be aimed at all? */
  private get aimable(): boolean {
    return this.live && !!this.client && this.controls.pan;
  }

  private onViewClick(e: MouseEvent): void {
    if (!this.aimable) return;
    const now = e.timeStamp;
    // The second click of a double-click is the same click, so it must not aim
    // again — two moves for one target is double the travel and a guaranteed
    // overshoot. dblclick handles the pair.
    const double = now - this.lastClickAt < 500;
    this.lastClickAt = now;
    if (double) return;

    const at = this.aimPoint(e);
    if (at) this.aimAt(at, false);
  }

  private onViewDoubleClick(e: MouseEvent): void {
    if (!this.aimable) return;
    const at = this.aimPoint(e);
    // The first click of the pair has already aimed; this only zooms.
    if (at) this.aimAt(at, true, false);
  }

  private enqueue(task: () => Promise<void>): void {
    this.pending++;
    this.aiming = true;
    this.requestUpdate();
    this.queue = this.queue
      .catch(() => {})
      .then(task)
      .catch(() => {})
      .then(() => {
        this.pending--;
        if (this.pending === 0) {
          this.aiming = false;
          this.requestUpdate();
        }
      });
  }

  private markAim(x: number, y: number): void {
    this.aim = { x, y };
    if (this.aimTimer !== null) clearTimeout(this.aimTimer);
    this.aimTimer = window.setTimeout(() => {
      this.aim = null;
      this.aimTimer = null;
      this.requestUpdate();
    }, 700);
    this.requestUpdate();
  }

  private aimAt(
    at: { nx: number; ny: number; x: number; y: number },
    zoom: boolean,
    move = true,
  ): void {
    this.markAim(at.x, at.y);
    // A move already running swallows a new one rather than queueing it: the
    // picture is a second or two behind the camera, so an impatient second
    // click is aimed at where things were, and obeying both is how you end up
    // pointing at the ceiling.
    if (move && this.pending === 0) this.enqueue(() => this.moveTo(at));
    if (zoom) this.enqueue(() => this.zoomIn());
  }

  private async moveTo(at: { nx: number; ny: number }): Promise<void> {
    const sweep = this.config.sweepMs > 0 ? this.config.sweepMs : 900;
    // Half a frame of offset is `n` = 1, so the travel is n/2 frames.
    const ms = (n: number) => Math.round((Math.abs(n) / 2) * sweep * CameraPanel.AIM_FRACTION);
    // One axis at a time: the diagonal ops exist, but the two axes need
    // different durations and a diagonal can only have one.
    await this.command('aim', async () => {
      const px = ms(at.nx);
      if (px >= CameraPanel.MIN_NUDGE_MS) await this.nudge(at.nx > 0 ? 'Right' : 'Left', px);
      const py = ms(at.ny);
      if (py >= CameraPanel.MIN_NUDGE_MS) await this.nudge(at.ny > 0 ? 'Down' : 'Up', py);
    });
  }

  /** Run one axis for a while, then stop it. */
  private async nudge(op: PtzOp, ms: number): Promise<void> {
    await this.client!.ptz(op, CameraPanel.AIM_SPEED);
    await new Promise((resolve) => window.setTimeout(resolve, ms));
    await this.client!.stop();
  }

  /** A step in, by a quarter of the travel where that is knowable. */
  private async zoomIn(): Promise<void> {
    // Read the lens first. The cached position is from the last time anything
    // asked, and the Reolink app may have moved it since — stepping from a
    // stale number either overshoots or, if the stale number was the maximum,
    // does nothing at all while the lens sits wide open.
    if (this.zoom) await this.refreshZoom();
    if (this.zoom) {
      const step = Math.max(1, Math.round((this.zoom.max - this.zoom.min) * 0.25));
      const target = Math.min(this.zoom.max, this.zoom.pos + step);
      if (target === this.zoom.pos) return;
      this.zoomWanted = target;
      await this.pushZoom();
      return;
    }
    await this.command('zoom', async () => {
      await this.nudge('ZoomInc', 500);
    });
  }

  private async refreshZoom(): Promise<void> {
    if (!this.client?.readable || !this.controls.zoom) return;
    try {
      const state = await this.client.zoomState();
      if (state) {
        this.zoom = state;
        this.zoomWanted = null;
        this.requestUpdate();
      }
    } catch {
      // The picture matters more than the readout.
    }
  }

  /**
   * Zoom while the slider is being dragged.
   *
   * Coalesced rather than throttled on a timer: one request is in flight at a
   * time and the newest wanted position is sent when it lands. A slider can
   * produce sixty events a second, and a camera answering each of them a beat
   * late turns a drag into a queue that keeps moving after you let go.
   */
  private async pushZoom(): Promise<void> {
    if (this.zoomSending || !this.client || this.zoomWanted === null) return;
    this.zoomSending = true;
    try {
      while (this.zoomWanted !== null && this.zoomWanted !== this.zoom?.pos) {
        const target: number = this.zoomWanted;
        await this.command('zoom', async () => {
          await this.client!.setZoom(target);
        });
        if (this.zoom) this.zoom = { ...this.zoom, pos: target };
        if (this.zoomWanted === target) this.zoomWanted = null;
      }
    } finally {
      this.zoomSending = false;
      this.requestUpdate();
      // Confirm rather than assume. The knob has been showing where it was
      // asked to go; a camera that clamped the request, or refused it, is only
      // visible by reading the lens back once the drag has settled.
      window.setTimeout(() => void this.refreshZoom(), 600);
    }
  }

  // --- Render -------------------------------------------------------------

  private renderSetup(): TemplateResult {
    const c = this.config;
    const generic = c.kind === 'generic';

    return html`
      <div class="cam-setup">
        <label class="param">
          <span class="param-label">Camera</span>
          <span class="param-input">
            <select
              @change=${(e: Event) => {
                this.config = { ...c, kind: (e.target as HTMLSelectElement).value as CameraConfig['kind'] };
                this.requestUpdate();
              }}
            >
              <option value="auto" ?selected=${c.kind === 'auto'}>Detect (Reolink)</option>
              <option value="reolink" ?selected=${c.kind === 'reolink'}>Reolink</option>
              <option value="generic" ?selected=${generic}>Other — image URL</option>
            </select>
          </span>
        </label>

        ${generic
          ? html`
              <label class="param wide">
                <span class="param-label">Image or MJPEG URL</span>
                <span class="param-input">
                  <input
                    type="text"
                    .value=${c.imageUrl}
                    placeholder="http://camera/snapshot.jpg"
                    @change=${(e: Event) => (this.config = { ...c, imageUrl: (e.target as HTMLInputElement).value })}
                  />
                </span>
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  .checked=${c.stream}
                  @change=${(e: Event) => {
                    this.config = { ...c, stream: (e.target as HTMLInputElement).checked };
                    this.requestUpdate();
                  }}
                />
                It is a continuous MJPEG stream, not a still
              </label>
            `
          : html`
              <label class="param" title="How long to run the motors to sweep a whole frame width, at the speed used for click-to-centre. Raise it if a click barely moves, lower it if it overshoots — a click that falls short converges when you click again, one that overshoots never settles.">
                <span class="param-label">Aim travel</span>
                <span class="param-input">
                  <input
                    type="number"
                    min="100"
                    max="10000"
                    step="50"
                    .value=${String(c.sweepMs)}
                    @change=${(e: Event) =>
                      (this.config = { ...c, sweepMs: Number((e.target as HTMLInputElement).value) || 900 })}
                  />
                  <em>ms</em>
                </span>
              </label>

              <label class="param wide">
                <span class="param-label">Address</span>
                <span class="param-input">
                  <input
                    type="text"
                    .value=${c.url}
                    placeholder="192.168.1.40"
                    @change=${(e: Event) => (this.config = { ...c, url: (e.target as HTMLInputElement).value })}
                  />
                </span>
              </label>
              <label class="param">
                <span class="param-label">User</span>
                <span class="param-input">
                  <input
                    type="text"
                    .value=${this.creds.user}
                    @change=${(e: Event) => (this.creds = { ...this.creds, user: (e.target as HTMLInputElement).value })}
                  />
                </span>
              </label>
              <label class="param">
                <span class="param-label">Password</span>
                <span class="param-input">
                  <input
                    type=${this.showPassword ? 'text' : 'password'}
                    autocomplete="off"
                    spellcheck="false"
                    .value=${this.creds.password}
                    @change=${(e: Event) => (this.creds = { ...this.creds, password: (e.target as HTMLInputElement).value })}
                  />
                  <!-- A camera password is typed once and then needed again the
                       day something stops working. Being able to see what is
                       actually stored beats retyping it blind. -->
                  <button
                    type="button"
                    class="tiny"
                    title=${this.showPassword ? 'Hide the password' : 'Show the password'}
                    @click=${(e: Event) => {
                      e.preventDefault();
                      this.showPassword = !this.showPassword;
                      this.requestUpdate();
                    }}
                  >
                    ${this.showPassword ? 'Hide' : 'Show'}
                  </button>
                </span>
              </label>
              <label class="param">
                <span class="param-label">Quality</span>
                <span class="param-input">
                  <select
                    @change=${(e: Event) => (this.config = { ...c, quality: (e.target as HTMLSelectElement).value as 'sub' | 'main' })}
                  >
                    <option value="sub" ?selected=${c.quality === 'sub'}>Substream (light)</option>
                    <option value="main" ?selected=${c.quality === 'main'}>Full resolution</option>
                  </select>
                </span>
              </label>
            `}

        ${c.kind !== 'generic'
          ? html`
              <label class="param">
                <span class="param-label">Picture</span>
                <span class="param-input">
                  <select
                    @change=${(e: Event) => {
                      this.config = { ...c, mode: (e.target as HTMLSelectElement).value as CameraConfig['mode'] };
                      this.requestUpdate();
                    }}
                  >
                    <option value="auto" ?selected=${c.mode === 'auto'}>Video if possible</option>
                    <option value="video" ?selected=${c.mode === 'video'}>Video only</option>
                    <option value="snapshot" ?selected=${c.mode === 'snapshot'}>Stills only</option>
                  </select>
                </span>
              </label>
            `
          : nothing}

        <label class="param">
          <span class="param-label">Frames / second</span>
          <span class="param-input">
            <select
              ?disabled=${c.stream}
              @change=${(e: Event) => {
                this.config = { ...c, fps: Number((e.target as HTMLSelectElement).value) };
                this.startStream();
              }}
            >
              ${FPS_CHOICES.map(
                (f) => html`<option value=${f.value} ?selected=${f.value === c.fps}>${f.label}</option>`,
              )}
            </select>
          </span>
        </label>

        <div class="cam-setup-actions">
          <button
            class="primary"
            ?disabled=${this.busy}
            @click=${() => {
              this.saveConfig();
              void this.start();
            }}
          >
            ${this.busy ? 'Looking…' : 'Connect'}
          </button>
          ${this.live
            ? html`<button
                class="ghost"
                @click=${() => ((this.showSetup = false), (this.showPassword = false), this.requestUpdate())}
              >
                Cancel
              </button>`
            : nothing}
        </div>

        <p class="hint cam-note">
          The password is kept on this device only — it is left out of the settings shared
          through the controller. A browser cannot play RTSP: if this camera only speaks
          RTSP, run go2rtc or MediaMTX in front of it and paste the MJPEG URL above.
        </p>
      </div>
    `;
  }

  private renderPad(): TemplateResult {
    return html`
      <div class="cam-pad">
        ${PAD.map((cell) =>
          cell
            ? html`
                <button
                  title=${cell.title}
                  @pointerdown=${() => this.hold(cell.op)}
                  @pointerup=${() => this.release()}
                  @pointerleave=${() => this.release()}
                  @pointercancel=${() => this.release()}
                  @contextmenu=${(e: Event) => e.preventDefault()}
                >
                  ${cell.label}
                </button>
              `
            : html`<button class="cam-stop" title="Stop moving" @click=${() => this.release()}>■</button>`,
        )}
      </div>
    `;
  }

  /**
   * Absolute zoom, shown only when the camera reports one.
   *
   * A slider whose knob does not correspond to anything is worse than no
   * slider: it invites you to set a position and then sits wherever you left
   * it while the lens is somewhere else. So this appears only when the camera
   * answered GetZoomFocus with both a position and its limits — otherwise the
   * ＋/－ buttons stand alone, which is honest about a camera that can only be
   * nudged.
   */
  private renderZoomSlider(): TemplateResult | typeof nothing {
    const zoom = this.zoom;
    if (!zoom) {
      // Say why. An absent control is indistinguishable from a broken one, and
      // the two reasons here have completely different answers: one is the
      // camera, the other is where this page is served from.
      if (this.zoomWhy === 'unsupported') {
        return html`<div class="cam-zoom-note">
          This camera does not report a lens position, so there is nothing for a slider to
          follow. The buttons step it.
        </div>`;
      }
      if (this.zoomWhy === 'blind') {
        return html`<div class="cam-zoom-note">
          No slider: this page cannot read the camera's replies, so where the lens is standing is
          unknowable. Serve the app from the same origin as the camera, or put a proxy that adds
          CORS headers in front of it.
        </div>`;
      }
      return nothing;
    }
    const at = this.zoomWanted ?? zoom.pos;
    const span = zoom.max - zoom.min;
    const percent = Math.round(((at - zoom.min) / span) * 100);

    return html`
      <label class="cam-zoom-slider" title="Zoom to a position. The camera reports ${zoom.min}…${zoom.max}.">
        <span>Zoom</span>
        <input
          type="range"
          min=${zoom.min}
          max=${zoom.max}
          step="1"
          .value=${String(at)}
          @input=${(e: Event) => {
            this.zoomWanted = Number((e.target as HTMLInputElement).value);
            this.requestUpdate();
            void this.pushZoom();
          }}
        />
        <em>${percent}%</em>
      </label>
    `;
  }

  /**
   * Brightness and friends.
   *
   * Behind a toggle rather than always on screen: they are set once for a
   * workshop and then left alone, and four more sliders above the pad would
   * push the picture off a narrow panel. Each one writes on release rather
   * than while dragging — every write is a read-modify-write of the whole
   * block, so a drag would be dozens of round trips.
   */
  private renderImage(): TemplateResult | typeof nothing {
    const image = this.image;
    if (!image) return nothing;
    return html`
      <div class="cam-image">
        ${IMAGE_FIELDS.filter((field) => image.values[field] !== undefined).map((field) => {
          const range = image.ranges[field];
          return html`
            <label class="cam-image-row" title="${field} — the camera allows ${range.min} to ${range.max}">
              <span>${field}</span>
              <input
                type="range"
                min=${range.min}
                max=${range.max}
                .value=${String(image.values[field])}
                @input=${(e: Event) => {
                  const value = Number((e.target as HTMLInputElement).value);
                  this.image = { ...image, values: { ...image.values, [field]: value } };
                  this.requestUpdate();
                }}
                @change=${(e: Event) => {
                  const value = Number((e.target as HTMLInputElement).value);
                  void this.command(field, async () => {
                    await this.client!.setImage(field, value);
                    // Read back: the camera clamps, and a slider showing a
                    // value the camera did not take is a slider that lies.
                    const fresh = await this.client!.readImage();
                    if (fresh) this.image = fresh;
                  });
                }}
              />
              <em class="cam-sub">${image.values[field]}</em>
            </label>
          `;
        })}
      </div>
    `;
  }

  private renderControls(): TemplateResult | typeof nothing {
    const c = this.controls;
    if (!this.client) return nothing;
    const anyMode = c.irLights || c.spotlight || c.dayNight || c.statusLed;

    return html`
      <div class="cam-controls">
        ${c.pan
          ? html`
              <div class="cam-motion">
                ${this.renderPad()}
                <div class="cam-motion-side">
                  <label class="cam-speed">
                    <span>Speed</span>
                    <input
                      type="range"
                      min="1"
                      max="64"
                      .value=${String(this.speed)}
                      @input=${(e: Event) => (this.speed = Number((e.target as HTMLInputElement).value))}
                    />
                  </label>
                  ${c.zoom
                    ? html`
                        <div class="cam-zoom">
                          <button
                            title="Zoom in"
                            @pointerdown=${() => this.hold('ZoomInc')}
                            @pointerup=${() => this.release()}
                            @pointerleave=${() => this.release()}
                          >
                            ＋
                          </button>
                          <button
                            title="Zoom out"
                            @pointerdown=${() => this.hold('ZoomDec')}
                            @pointerup=${() => this.release()}
                            @pointerleave=${() => this.release()}
                          >
                            －
                          </button>
                        </div>
                        ${this.renderZoomSlider()}
                      `
                    : nothing}
                </div>
              </div>
            `
          : nothing}

        ${this.presets.length
          ? html`
              <div class="cam-presets">
                ${this.presets.map(
                  (p) => html`<button class="tiny" @click=${() => void this.command('preset', () => this.client!.goToPreset(p.id))}>
                    ${p.name}
                  </button>`,
                )}
              </div>
            `
          : c.presets && !this.probe?.readable
            ? html`
                <div class="cam-presets">
                  <span class="hint">Presets</span>
                  ${[1, 2, 3, 4].map(
                    (id) => html`<button class="tiny" title="Go to preset ${id}"
                      @click=${() => void this.command('preset', () => this.client!.goToPreset(id))}>
                      ${id}
                    </button>`,
                  )}
                </div>
              `
            : nothing}

        ${anyMode
          ? html`
              <div class="cam-modes">
                ${c.irLights
                  ? html`
                      <label class="check" title="Infrared illuminators, driven by the light sensor">
                        <input
                          type="checkbox"
                          .checked=${this.ir ?? true}
                          @change=${(e: Event) => {
                            const on = (e.target as HTMLInputElement).checked;
                            this.ir = on;
                            void this.command('IR lights', () => this.client!.setIrLights(on));
                          }}
                        />
                        IR
                      </label>
                    `
                  : nothing}
                ${c.statusLed
                  ? html`
                      <label
                        class="check"
                        title="The lamp on the camera body. Worth turning off on a camera watching a machine at night — it reflects off everything nearby."
                      >
                        <input
                          type="checkbox"
                          .checked=${this.statusLed ?? true}
                          @change=${(e: Event) => {
                            const on = (e.target as HTMLInputElement).checked;
                            this.statusLed = on;
                            void this.command('status LED', () => this.client!.setStatusLed(on));
                          }}
                        />
                        LED
                      </label>
                    `
                  : nothing}
                ${c.spotlight
                  ? html`
                      <label class="cam-mode">
                        <span>Spotlight</span>
                        <select
                          @change=${(e: Event) => {
                            const mode = Number((e.target as HTMLSelectElement).value);
                            this.spotMode = mode;
                            void this.command('spotlight', () => this.client!.setSpotlight(mode, this.spotBright));
                          }}
                        >
                          ${SPOTLIGHT_MODES.map(
                            (m) => html`<option value=${m.value} ?selected=${m.value === this.spotMode}>
                              ${m.label}
                            </option>`,
                          )}
                        </select>
                        <em class="cam-sub">${this.spotBright}%</em>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          title="Spotlight brightness"
                          aria-label="Spotlight brightness"
                          .value=${String(this.spotBright)}
                          @input=${(e: Event) => {
                            this.spotBright = Number((e.target as HTMLInputElement).value);
                            this.requestUpdate();
                          }}
                          @change=${(e: Event) => {
                            this.spotBright = Number((e.target as HTMLInputElement).value);
                            void this.command('spotlight', () =>
                              this.client!.setSpotlight(this.spotMode ?? 1, this.spotBright),
                            );
                          }}
                        />
                      </label>
                    `
                  : nothing}
                ${c.dayNight
                  ? html`
                      <label class="cam-mode">
                        <span>Image</span>
                        <select
                          @change=${(e: Event) => {
                            const value = (e.target as HTMLSelectElement).value;
                            this.dayNight = value;
                            void this.command('day/night', () => this.client!.setDayNight(value));
                          }}
                        >
                          ${DAY_NIGHT.map(
                            (d) => html`<option value=${d.value} ?selected=${d.value === this.dayNight}>
                              ${d.label}
                            </option>`,
                          )}
                        </select>
                      </label>
                    `
                  : nothing}
                ${this.image
                  ? html`
                      <button
                        class="tiny"
                        title="Brightness, contrast, saturation and sharpness"
                        @click=${() => ((this.showImage = !this.showImage), this.requestUpdate())}
                      >
                        ${this.showImage ? 'Picture ▾' : 'Picture…'}
                      </button>
                    `
                  : nothing}
              </div>
              ${this.showImage ? this.renderImage() : nothing}
            `
          : nothing}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const probe = this.probe;

    return html`
      <div class="cam-panel">
        <div class="cam-bar">
          <span class="cam-id">
            ${probe
              ? html`${probe.model ?? (probe.kind === 'reolink' ? 'Reolink' : 'Camera')}
                  ${probe.name ? html`· ${probe.name}` : nothing}`
              : 'No camera'}
          </span>
          ${probe && !probe.readable
            ? html`<span class="pill dim" title=${probe.note ?? ''}>blind</span>`
            : nothing}
          ${this.live && this.usingVideo
            ? html`<span class="pill good" title="Live H.264 over HTTP-FLV">video</span>`
            : nothing}
          ${this.live && !this.usingVideo && this.measured > 0 && !this.config.stream
            ? html`<span class="cam-fps" title="Frames per second actually arriving">
                ${this.measured.toFixed(1)} fps
              </span>`
            : nothing}
          <span class="topbar-spacer"></span>
          ${this.live
            ? html`<button class="tiny" title="Full-resolution still in a new tab"
                @click=${() =>
                  window.open(
                    this.config.kind === 'generic'
                      ? this.config.imageUrl
                      : snapshotUrl({ ...this.config, quality: 'main' }, this.creds, Date.now()),
                    '_blank',
                    'noopener',
                  )}>
                Still
              </button>`
            : nothing}
          <button
            class=${this.showSetup ? 'icon active' : 'icon'}
            title="Camera settings"
            @click=${() => ((this.showSetup = !this.showSetup), this.requestUpdate())}
          >
            ⚙
          </button>
        </div>

        ${this.error
          ? html`<div class="warn-banner cam-error">
              <span>${this.error}</span>
              <button
                class="tiny"
                title="Dismiss"
                @click=${() => ((this.error = null), (this.errorFor = null), this.requestUpdate())}
              >
                ✕
              </button>
            </div>`
          : nothing}
        ${probe?.note && !this.showSetup ? html`<div class="cam-hint">${probe.note}</div>` : nothing}
        ${this.videoNote && !this.showSetup
          ? html`<div class="cam-hint">
              ${this.config.mode === 'video' ? 'Video failed' : 'Showing stills'} — ${this.videoNote}
            </div>`
          : nothing}
        ${this.showSetup ? this.renderSetup() : nothing}

        <div
          class="cam-view ${this.live ? '' : 'idle'} ${this.aimable ? 'aimable' : ''}"
          title=${this.aimable
            ? 'Click to bring that point to the middle. Double-click to bring it in and zoom.'
            : ''}
          @click=${(e: MouseEvent) => this.onViewClick(e)}
          @dblclick=${(e: MouseEvent) => this.onViewDoubleClick(e)}
        >
          ${this.live && this.usingVideo
            ? html`<video class="cam-video" muted playsinline autoplay draggable="false"></video>`
            : nothing}
          ${this.live && !this.usingVideo
            ? html`
                <img class="cam-frame showing" alt="Camera" draggable="false" />
                <img class="cam-frame" alt="" draggable="false" />
                <img class="cam-frame" alt="" draggable="false" />
                ${this.frameErrors >= FRAME_ERROR_LIMIT
                  ? html`<span class="cam-stale">No frames from the camera</span>`
                  : nothing}
              `
            : html`<span class="hint">${this.busy ? 'Looking for the camera…' : 'Not connected'}</span>`}
          ${this.aim
            ? html`<span
                class="cam-aim ${this.aiming ? 'moving' : ''}"
                style="left:${this.aim.x}px; top:${this.aim.y}px"
              ></span>`
            : nothing}
        </div>

        ${this.live && !this.showSetup ? this.renderControls() : nothing}
        ${this.showSetup && this.config.kind !== 'generic' && this.config.url
          ? html`<p class="hint cam-rtsp">
              RTSP (for VLC or a bridge): <code>${rtspUrl(this.config, { ...this.creds, password: '•••' })}</code>
            </p>`
          : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-camera', CameraPanel);

registerPanel({
  id: 'camera',
  title: 'Camera',
  tag: 'cnc-camera',
  defaultWidth: 4,
  defaultHeight: 420,
  // Nothing here depends on the controller — a camera is worth watching most
  // when the machine is the thing that has stopped answering.
  available: () => true,
  description: 'Live view from an IP camera, with pan/tilt and lighting',
});
