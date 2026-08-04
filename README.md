# Axis Control

A CNC-first web front end for RepRapFirmware controllers.

![The Control page: work and machine coordinates, the jog rose, and the tool changer](docs/screenshots/control.webp)

![The Job page: toolpath viewer with the preflight checks that run before a job starts](docs/screenshots/job.webp)

DWC is an excellent 3D-printer interface, and that is the problem: on a router
its information architecture is shaped around a machine that does a different
job. Axis Control is arranged around the things a CNC operator actually reaches
for — work coordinates, jogging, tool length, probing, and watching a program
run — and it is honest about what the controller can and cannot do rather than
showing buttons that quietly fail.

It is written against RepRapFirmware's documented HTTP API, contains no DWC or
RRF code, and is not a replacement for either: firmware updates, the config
tool and network setup are all still DWC's job, and DWC stays installed at `/`.

> **This drives machinery that can injure you.** It moves a spindle and a
> gantry, and it will do exactly what it is told. Nothing here replaces your own
> judgement: verify every generated program before you run it, keep a hand on
> the stop, and treat the simulation as a drawing rather than a promise. See the
> warranty and liability sections of [LICENSE](LICENSE).

## What is in it

Twenty-one panels, arranged onto pages you lay out yourself:

- **Position** — work and machine coordinates, WCS selection (G54–G59.3), zeroing
- **Motion** — a jog rose of concentric rings, eight directions each, with
  distances that are always numbers a person would choose
- **Spindle & Tools** — the active tool stated large, ATC slots, and tool
  libraries importable straight from a Fusion 360 `.tools` export
- **Toolpath** — WebGL viewer with live cutter tracking, a time slider,
  run-from-line picking, and the actual cutter drawn to size
- **Probing** — separate flows for tool length, workpiece and feature probing,
  which are three different jobs and never conflated
- **Machining, Surfacing, Import** — conversational operations, spoilboard
  flattening, and SVG/DXF import with tool-radius offsetting
- **Tool changer** — set up a RapidChange ATC and install its macros: pocket
  geometry checked against the machine's own travel, every file shown before it
  is written, and nothing run for you
- **Camera** — live H.264 over HTTP-FLV where the camera allows it, pipelined
  stills where it does not, with pan/tilt and lighting for Reolink
- **Job, Console, Files, Macros, Object model, Diagnostics, Preflight**

Dependencies, all permissive: Lit for templating, dockview for the layout,
clipper-lib for polygon offsetting, and mpegts.js for camera video — the last
loaded only when video is actually attempted. About 225 KB gzipped for the app,
plus 62 KB for the video demuxer if it is ever needed.

```
npm install
npm run dev        # esbuild watch + dev server on :8080
npm run build      # dist/, with .gz siblings for the controller
npm run typecheck
```

## Developing without the machine

```
node tools/mock-rrf.mjs        # mock controller on :8081, also serves dist/
node tools/mock-camera.mjs 8090        # camera, no CORS headers
node tools/mock-camera.mjs 8091 --cors # camera, CORS headers
```

The mocks are deliberately unkind. Over the course of building this they grew
every trap the real hardware sprang: sparse arrays with genuine holes, replies
in mm/s where the docs imply mm/min, a directory long enough to need scrolling,
an endpoint that accepts a connection and then says nothing at all. Each one is
there because something shipped broken without it.

The mock implements the `rr_*` endpoints against a synthetic object model
shaped like the real Ultimate Bee: X/Y/Z plus the U dust-shoe axis, a
0–24000 rpm VFD spindle, the 8-slot RapidChange ATC, and the `atc*`/`dustShoe*`
globals a real ATC configuration declares. It simulates motion and job progress, so the DRO
moves and the viewer's live cutter tracking has something to follow. Two sample
programs are included, one with arcs and a full circle to exercise the
tessellator.

Open <http://localhost:8081> and it connects to itself.

## Deploying to the controller

Either host it anywhere on the LAN and point it at the controller, or copy
`dist/` onto the SD card:

```
cp -r dist/* /path/to/sd/www/axis/
```

then browse to `http://<controller>/axis/`. Ship the `.gz` files alongside the
originals; the Duet serves them when the browser sends `Accept-Encoding: gzip`,
which matters because it reads off the SD card single-threaded.

Served from anywhere other than the controller, cross-origin rules apply, so
the controller needs `M586 C"*"` in its network config. Note what that does
*not* fix: RRF answers a CORS preflight with nothing useful, so cross-origin
requests must stay inside the CORS-simple envelope — which is why the driver
drops the session-key header and falls back to RRF's implicit per-IP session
when it is not same-origin.

On iOS, Share → Add to Home Screen runs it full screen with no address bar.

## Architecture

```
src/
  core/          signals (reactivity), app store, CRC32, helpers
  machine/
    types.ts     vendor-neutral machine model — the only vocabulary panels see
    driver.ts    the MachineDriver contract
    registry.ts  driver list
    drivers/
      rrf/       RepRapFirmware: HTTP transport, object model, state mapping
      carvera/   Makera Carvera / Z1 — stub, see its README first
  ui/            panel base class, dashboard layout, top bar, prompt dialog
  panels/        one file per panel, self-registering
  viewer/        G-code parser, WebGL2 renderer, mat4
```

### The driver layer

Panels read **only** `machine/types.ts`. Nothing above the driver layer may
import RRF object-model types or `rr_*` endpoint names. A second controller is a
new `MachineDriver` implementation, not a fork of the UI.

Each driver publishes a `Capabilities` record, and panels hide themselves when
the active controller can't back them — so a partially-implemented driver still
yields a coherent UI instead of dead buttons. The object-model browser is the
one panel that deliberately reaches through `driver.native`, gated on
`capabilities.objectModel`.

### RRF specifics

Standalone RRF has no WebSocket (reserved in the API, unimplemented — the board
has ~8 sockets and half may go to non-HTTP services). So the driver polls:

1. one cheap `rr_model?flags=d99fn` per tick for live values across the whole
   tree, plus `seqs`;
2. a full `rr_model?key=<k>&flags=d99vn` **only** for subtrees whose sequence
   number moved;
3. `rr_reply` when `seqs.reply` advances.

250 ms while active, 500 ms when idle. Replies are buffered per HTTP client on
3.5+, so running this alongside DWC and `tools/grr.py` doesn't steal output.
Sessions use `sessionKey`/`X-Session-Key` where available, falling back to
implicit per-IP sessions on older firmware.

### Why the byte offset matters

The parser records the **source byte offset** on every vertex. RRF reports
`job.filePosition` as a byte offset, so comparing the two in the fragment shader
is what draws the cut/uncut boundary and places the live cutter. A parser that
discards offsets can draw a toolpath but can never track a running job.

## Adding a controller

1. Implement `MachineDriver` under `src/machine/drivers/<name>/`.
2. Set `Capabilities` honestly as you go.
3. Register a factory in `src/machine/registry.ts`.

No panel changes. See `drivers/carvera/README.md` — note especially that the
Carvera/Z1 speaks raw TCP or USB serial rather than HTTP, so it needs WebSerial
or a small WebSocket⇄TCP bridge. `connect(config)` takes a URL string precisely
so that choice stays inside the driver.

## Status

Used daily on one machine — a 750x1500 router with an 8-slot RapidChange ATC, a
2.2kW spindle on a Huangyang VFD, and a U-axis dust shoe — which is to say it is
proven on a sample of exactly one. The RRF driver is complete enough for real
work; the Carvera/Z1 driver is a stub.

Known gaps: job history, an ATC carousel view, and no automated test suite —
verification so far has been a real headless browser driven against the mocks,
which has caught a great deal but is not the same thing.

Browser support goes back further than you would expect: the bundle targets
ES2019, and there is a compatibility layer for Safari 12 (an iPad mini 2 makes a
fine control screen). WebGL2 is used where present and WebGL1 where it is not.

## Contributing

Issues and pull requests welcome. Two things to know:

- **The driver boundary is the point.** Panels see only `machine/types.ts`. If a
  change needs an `rr_*` endpoint name above the driver layer, it belongs in the
  driver instead.
- **Say what you verified.** This drives machinery; "should work" and "tested
  against the mock" and "ran it on my machine" are three very different claims
  and the review will ask which one it is.

## Licence

Apache-2.0 — see [LICENSE](LICENSE), [NOTICE](NOTICE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

RepRapFirmware and Duet Web Control are GPL-3.0 and are separate programs; this
talks to them over HTTP and contains none of their code.

## Notes

- `M292` is sent with `S<seq>` and, for input prompts, `R<value>`. Both are 3.5+
  additions — on older firmware, drop them for a bare `M292 P0`.
- Hold-to-jog fires repeated discrete relative moves; there is no continuous-jog
  command over HTTP polling. A pendant will always feel better than a browser.
- `/sys` files are editable but deliberately **not** runnable — handing
  `config.g` to `M32` would try to execute it as a job.
