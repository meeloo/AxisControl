# Plugins — a plan

A plugin adds a panel, reads the machine, and keeps data that other plugins can
read. It is JavaScript, it installs and uninstalls in one action, and by
default it runs where it cannot touch the app, the DOM, the network, or the
browser's storage — only the plugin API. A plugin that needs more asks for it
by name, and the operator grants or refuses; refusing disables the plugin.

Nothing here is built yet. This is the design and the order to build it in.

## Why an isolation boundary at all

This app drives a spindle. A plugin is somebody else's code running in the
window that has the STOP button in it, and the failure that matters is not a
plugin crashing — it is a plugin quietly doing something nobody asked for:
sending a G-code, reading the config, reaching the controller's HTTP API
directly, or scribbling on another plugin's saved data. A plugin API alone does
not prevent any of that, because in one realm a plugin can ignore the API and
use `fetch`, `document`, or `localStorage` directly.

So the boundary has to be the browser's own, not a convention.

## The shape

Each plugin runs in a **sandboxed iframe** (`sandbox="allow-scripts"`, content
via `srcdoc`, no `allow-same-origin`). That gives an opaque origin, which means
the browser itself — not our code — denies it:

- the host DOM and everything reachable from it (`parent.document` throws)
- `localStorage`, `sessionStorage`, IndexedDB, cookies
- same-origin `fetch`, so no direct route to the controller's HTTP API
- the service worker and the app's caches

and a `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">` inside the frame document closes the rest of the network.

Everything a plugin *can* do therefore arrives over `postMessage`, which is
where the permission checks live — one door, not a scattering of them.

Two frames per plugin, at most:

- a **panel frame** per visible panel instance, created when the panel mounts
  and destroyed when it unmounts;
- one optional **service frame**, hidden, alive while the plugin is enabled,
  for a plugin that has to keep working with no panel open (watching state,
  keeping a log). Declared in the manifest; costs a permission of its own,
  because a background context is exactly what a badly-behaved plugin wants.

### Why not a Worker

A Worker isolates better — no DOM at all — but then the plugin cannot render,
and the app would have to invent a description-of-a-UI language and a widget
vocabulary for plugins to speak. That is a large API to design, a larger one to
keep stable, and it would rule out a plugin drawing its own canvas. The frame
lets a plugin author write ordinary DOM code, which is the thing they already
know how to do. A plugin that needs real compute can start a Worker *inside*
its own frame.

### What the frame does not fix

A frame with an opaque origin usually shares a process with its parent, so a
plugin that never yields **can still freeze the window**. The host pings each
frame and marks it unresponsive, but a ping cannot preempt a spinning loop —
the mark only lands once the frame yields. Mitigations, in order: the docs tell
authors to put loops in a Worker; the host shows an unresponsive plugin in the
Plugins panel and offers to disable it; and the STOP control lives in host
chrome that a frame cannot cover or intercept. The residual risk is real and
should be written down rather than papered over.

## The manifest

`plugin.json`, beside `main.js`:

```json
{
  "id": "net.meeloo.surface-notes",
  "name": "Surface notes",
  "version": "1.2.0",
  "api": 1,
  "panel": { "title": "Surface notes", "width": 4, "height": 320 },
  "background": false,
  "permissions": ["machine.read", "ui.notify"],
  "provides": [{ "domain": "net.meeloo.surface-notes", "scope": "machine" }],
  "uses": [{ "domain": "org.axiscontrol.tools", "access": "read" }]
}
```

`id` is a reverse-DNS string and is the plugin's identity everywhere: its
storage prefix, its grant record, its panel type in the layout. `api` is the
plugin API version the code was written against; the host refuses to load a
plugin whose `api` it cannot serve, rather than letting it fail in pieces.

## Permissions

A fixed vocabulary, each one a sentence the operator can act on. The grant
dialog shows the plugin's name, the list, and — this matters — what the app
will *do* if refused.

| Permission | What it opens |
|---|---|
| `machine.read` | live state: position, status, tool, spindle, capabilities |
| `machine.motion` | jog, move, home, go to origin |
| `machine.command` | arbitrary G-code, spindle, tool change, job control |
| `files.read` / `files.write` | the controller's SD card, path-prefixed |
| `storage.<domain>` | read or write a domain another plugin owns |
| `network.<origin>` | outbound fetch to one named origin |
| `ui.notify` | toasts and the log |
| `background` | a service frame that runs with no panel open |
| `unsafe.fullAccess` | everything below — see the next section |

`machine.motion` and `machine.command` move the machine and are presented
that way, in those words. There is no implicit grant and no "remember for all
plugins": grants are per plugin id, recorded with the manifest hash, and asked
again when a new version widens them.

Refusing any requested permission disables the plugin. That is the rule the
brief asks for and it is the right one: half a plugin is a plugin that fails in
ways its author never saw.

## Full access

`unsafe.fullAccess` loads the plugin as a module in the host realm — no frame,
no bridge, the real imports. It exists because some plugin will want to do
something this API has not thought of, and the alternative is people patching
the app. It is not a bigger permission list; it is the absence of the boundary,
and the dialog says so in one sentence: *this plugin will be able to do
anything you can do, including moving the machine and changing its
configuration.* Full-access plugins are listed apart in the Plugins panel and
carry a marker in the UI.

## Storage, and the domains that make it shareable

The unit is a **domain**: a reverse-DNS id that names a body of data rather
than the plugin that made it. A tool-table plugin owns `org.axiscontrol.tools`;
a feeds-and-speeds plugin declares `uses: org.axiscontrol.tools` with `read`
and is granted it once, by the operator, at install.

```js
const notes = await macadam.storage.open('net.meeloo.surface-notes');
await notes.set('last-scan', { at: Date.now(), deviation: 0.04 });
const tools = await macadam.storage.open('org.axiscontrol.tools'); // read-only
for (const key of await tools.keys()) { /* … */ }
notes.subscribe((key, value) => { /* another panel changed it */ });
```

Rules that keep this honest:

- A domain has exactly one owner — the plugin that declares it in `provides`.
  A second plugin claiming the same domain fails to install, with the conflict
  named. Ownership is what makes a schema possible at all.
- Everyone else needs a grant, and `read` is a separate grant from `write`.
- Values are JSON, structured-cloned across the bridge. There is a per-domain
  size cap (start at 1MB) enforced on write, because a plugin filling the
  browser's quota breaks the app, not just itself.
- `subscribe` fires in every frame with read access, which is how two panels
  share a value without knowing about each other.

**Scope** decides where the bytes live, and it is per domain:

- `machine` — a JSON file at `/plugins/data/<domain>.json` on the controller's
  card, through the existing file API. Written debounced, and it follows the
  machine: open the app from a different browser and the data is there. Tool
  tables and fixture offsets want this.
- `browser` — IndexedDB in the host. Fast, private to this browser, and gone
  when someone clears site data. Right for a UI preference and wrong for
  anything the operator would be upset to lose.

`machine` is the default, on `text/fontstore.ts`'s reasoning: the app already
decided that operator-owned data belongs on the card rather than in the
browser, because the card is what survives a new laptop, a cleared profile and
a reinstall. Note that IndexedDB is not used anywhere in the app today — the
`browser` scope is a new primitive and should be built second, not first.

## The API surface

One global, `macadam`, inside the frame. Everything is async, because
everything is a message.

```
macadam.version                      -> { api: 1, app: "0.1.3" }
macadam.machine.state()              -> MachineState snapshot
macadam.machine.subscribe(cb)        -> unsubscribe
macadam.machine.capabilities()
macadam.machine.jog(deltas, feed)            [machine.motion]
macadam.machine.moveTo(targets, feed)        [machine.motion]
macadam.machine.home(axes?)                  [machine.motion]
macadam.machine.send(gcode)                  [machine.command]
macadam.machine.runMacro(path)               [machine.command]
macadam.files.list(dir) / read(path)         [files.read]
macadam.files.write(path, bytes)             [files.write]
macadam.storage.open(domain)
macadam.ui.title(text) / notify(text, level) [ui.notify]
macadam.ui.onMount(cb) / onUnmount(cb) / onVisible(cb)
macadam.log.info|warn|error(...)
```

The machine methods mirror `core/store.ts`'s `actions`, **not** the driver
interface. The driver is where controller dialects differ and where the
capability flags are decided; `actions` is already the neutral, guarded layer,
and routing plugins through it means one place enforces a permission rather
than one place per driver.

State arrives as the same `MachineState` the panels see, minus nothing —
`machine.read` is a real permission precisely so that this can be generous
once granted.

## Writing one, inside the app

The Plugins panel is also the editor, because the thing that makes a plugin
system used is that trying an idea takes a minute:

- **New plugin** scaffolds a manifest and a `main.js` that renders "hello" and
  reads the position, and opens it in the editor.
- **Save reloads it.** The frame is torn down and rebuilt; state in the plugin
  is lost, storage is not. That is the whole edit loop.
- A **log pane** shows the plugin's `console`, its uncaught errors and
  rejections, and every denied call with the reason in plain words — *denied:
  machine.command was not granted*. A plugin that silently does nothing is the
  worst thing this system could produce, so refusals are loud by default.
- An **RPC trace** toggle logs every call and its arguments, which is what you
  want when the plugin is fine and the assumption about the machine is not.

Browser devtools work normally: the frame is a real browsing context, appears
in the context picker, takes breakpoints and `debugger`, and shows its own
network tab (empty, which is itself a useful check).

## Installing and removing

A plugin is a **zip** containing `plugin.json`, `main.js`, and optionally
`panel.css` and assets. `core/zip.ts` already reads zips. Install accepts:

- a file from the disk (drag or picker),
- a paste of a single `main.js` with a `/* @plugin { … } */` header comment,
  which is what a plugin looks like while it is being written,
- a URL, behind a confirmation showing the origin.

Installed plugins go to `/plugins/<id>/` on the card by default, so they follow
the machine and survive a browser reset, with a local-only option for one you
are still writing.

The path is the card root, beside `/sys`, `/macros`, `/gcodes` and `/fonts`,
and `text/fontstore.ts` already argues the case at length: **not** under
`/www/AxisControl`, because the Install panel rewrites that directory on every
update and the day someone adds a clean-out step is the day everyone's plugins
disappear; **not** under `/www` at all, which is DWC's home and a collision
waiting for the next DWC release; and **not** under `/sys`, which is RRF's own
configuration directory and already crowded with files the firmware reads at
boot. Removal deletes the directory and the grants,
and asks separately about the plugin's data, since the data may be the point
(a tool table outlives the plugin that made it).

There is no registry, no signing, no auto-update. Those are worth having only
once plugins exist and are being shared; the plan is deliberately short of
them, and the manifest carries a `version` so they can be added without a
format change.

## Order of work

1. **Loader and bridge.** Manifest parsing and validation, the frame, the
   `postMessage` RPC with request ids and timeouts, `macadam.version`,
   `ui.onMount`, `log.*`. A plugin that renders "hello" and nothing else.
2. **Panels.** Register a `PanelDefinition` per installed plugin at runtime —
   `registerPanel` is already a live map — so a plugin panel is picked from the
   normal panel picker, saved in the layout, and restored. Handle the layout
   referencing a panel whose plugin is gone: the layout already filters unknown
   panel ids, which is the behaviour we want.
3. **Machine, read-only.** `machine.read`, state snapshots and subscription.
   Most useful plugins need nothing more.
4. **Storage and domains.** Ownership, grants, `browser` scope, subscription.
   Then `machine` scope on the card, debounced.
5. **The Plugins panel.** List, enable/disable, permissions, storage use,
   errors, install and remove.
6. **Permissions with teeth.** The grant dialog, persisted grants keyed by
   manifest hash, re-prompt on widening, denial logging.
7. **Motion and commands.** `machine.motion`, then `machine.command`, each with
   its own dialog wording. Rate limiting and an audit line in the console log
   for every command a plugin sends — a plugin's G-code should be as visible as
   a typed one.
8. **The editor.** Scaffold, save-to-reload, log pane, RPC trace.
9. **Full access.** Last, deliberately: it is the escape hatch, and it should
   be built when there is enough of an API to know what it is an escape from.
10. **Packaging.** Zip install, service frames, `network.<origin>`.

Stop after any step and the thing still works — each one is a usable system
with a smaller API.

## What has to be tested, and how

The check suites in `tools/` are the model: the failures here are silent ones.

- **`plugin-isolation-check`**, in a browser (the harness in
  `tools/prompt-browser.mjs` is the pattern). Load a hostile plugin and assert
  every escape fails: `parent.document` throws, `localStorage` throws, `fetch`
  to the app's own origin fails, `top.location` is not writable, and a message
  claiming a permission it was not granted is refused. This is the test that
  makes the boundary a fact rather than an intention.
- **`plugin-api-check`**: the manifest validator against good and bad
  manifests, domain ownership conflicts, the size cap, grant persistence and
  re-prompting when a version widens its permissions.
- The mock stands in for the controller throughout, and — the lesson from issue
  #1 — it must not be kinder than the real thing: a denied permission in the
  test must be denied by the same code path that denies it in the app.

## Open questions

- **Theming.** The frame has its own document, so the app's CSS does not reach
  it. Options: ship a small stylesheet into every frame and forward the theme
  tokens on change; or let plugins style themselves entirely and accept that
  they will look foreign. Leaning towards forwarding tokens plus an optional
  default stylesheet, so a plugin that does nothing looks native and a plugin
  that wants to be different can be.
- **Keyboard.** Key events in a frame do not reach the host, so an app-wide
  shortcut pressed with the focus inside a plugin panel will not fire. The
  frame can forward a small allow-list of keys.
- **Cost on a phone.** One frame per panel instance is not free. Measure before
  worrying, but the stacked layout only mounts the visible panel, which helps.
- **A plugin that outlives its data format.** Domains are shared, so a schema
  change breaks readers. A `schema` integer per domain and a documented
  convention that owners never repurpose a key is probably enough; a migration
  hook is not worth it yet.
