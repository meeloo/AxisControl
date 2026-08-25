// The document a plugin runs in, and the `axis` global it finds there.
//
// This file is the wall. Everything else in src/plugins/ trusts it to build a
// document a plugin cannot get out of, so the two things it must get right are
// the Content-Security-Policy and the way somebody else's source is put into
// an HTML document without becoming HTML.
//
// One thing to be clear about before reading further: the `axis` object below
// is a convenience, not a security control. A plugin can ignore it entirely
// and postMessage the host directly, so nothing here is allowed to be the only
// check on anything. The checks live in plugins/bridge.ts, on the other side of
// the wire, and the browser's opaque origin does the rest.

import { PROTOCOL_VERSION } from './protocol.js';
import { API_VERSION, type Manifest, type PermissionName } from './types.js';
import { BUILD } from '../core/build.js';

/**
 * The in-frame runtime, as source. It is a string rather than a module because
 * it has to be evaluated inside a document this app does not otherwise reach:
 * the frame has an opaque origin, so it cannot import from us.
 *
 * It implements the guest half of protocol.ts — request ids, promise
 * plumbing, `axis.*`, and the lifecycle callbacks — and nothing else.
 *
 * It defines exactly one global of its own, `__axisBoot`, which frameHtml
 * calls with the plugin's source; the function deletes itself as its first
 * act. Everything else is inside the closure, where the plugin's own code
 * cannot reach it.
 *
 * Channels, for whoever writes the host end of `PluginFrame.emit`:
 *
 * | channel            | payload                                        | subscribed? |
 * |--------------------|------------------------------------------------|-------------|
 * | `machine.state`    | the MachineState snapshot                      | yes         |
 * | `storage:<domain>` | `{ key, value }`                               | yes         |
 * | `lifecycle`        | `{ phase: 'mount'\|'unmount'\|'visible', visible? }` | no     |
 * | `theme`            | `Record<string,string>` of CSS custom props    | no          |
 *
 * "subscribed" means the guest sends `subscribe`/`unsubscribe` for it and the
 * host should send nothing on that channel until it has; the other two are
 * host-driven and arrive whenever the host says so.
 *
 * Written in ES5-shaped JavaScript on purpose. It is never touched by esbuild
 * — it is a string, so nothing down-levels it — and the tablet this app has to
 * run on is an iPad on iOS 12.
 */
export const GUEST_RUNTIME: string = `(function () {
  'use strict';

  var V = ${PROTOCOL_VERSION};

  var W = window;
  var HOST = W.parent;
  var doc = W.document;

  // Natives, captured before the plugin's code has had a chance to replace
  // them. A plugin that overwrites JSON.stringify or Promise should break
  // itself and not the bridge; more to the point, a plugin that overwrites
  // Error must not be able to change the text of a permission refusal on its
  // way to the log.
  var freeze = Object.freeze;
  var keysOf = Object.keys;
  var defineProp = Object.defineProperty;
  var protoString = Object.prototype.toString;
  var slice = Array.prototype.slice;
  var isArray = Array.isArray;
  var Prom = W.Promise;
  var Err = W.Error;
  var parseJson = JSON.parse;
  var timeNow = Date.now;
  var realConsole = W.console;

  // ---------------------------------------------------------------- wire

  function send(msg) {
    try { HOST.postMessage(msg, '*'); } catch (e) { /* the host is gone */ }
  }

  var nextId = 1;
  var pending = {};

  function call(method, args) {
    return new Prom(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        // targetOrigin is '*' because this frame has no way to learn the
        // host's origin — no allow-same-origin, and the referrer is
        // suppressed. It is not a leak: the message goes to one window, the
        // one that created this document.
        HOST.postMessage({ v: V, t: 'req', id: id, method: method, args: args }, '*');
      } catch (e) {
        delete pending[id];
        reject(new Err(method + ': the arguments could not be sent to the host (' +
          (e && e.message ? e.message : String(e)) + '). Everything crossing this bridge is ' +
          'structured-cloned, so functions, DOM nodes and class instances have to be turned ' +
          'into plain data first.'));
      }
    });
  }

  function settle(m) {
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    // The host's message, verbatim: it is the sentence that names the missing
    // permission, and rewording it here would mean the plugin's log and the
    // app's log disagree about why a call failed.
    if (m.ok) p.resolve(m.value);
    else p.reject(new Err(typeof m.error === 'string' ? m.error : 'the host refused the call without saying why'));
  }

  // ---------------------------------------------------------------- logging

  var LOG_BURST = 200;
  var logWindow = 0;
  var logCount = 0;
  var logDropped = 0;

  // A plugin logging from a render loop must not be able to drown the host's
  // log — that log is the only way anyone sees what a plugin is doing, so
  // losing it to a flood costs more than the lines being dropped. The drop is
  // announced rather than silent, once per second.
  function log(level, text) {
    var t = timeNow();
    if (t - logWindow >= 1000) {
      if (logDropped > 0) {
        send({ v: V, t: 'log', level: 'warn', text: 'axis: dropped ' + logDropped +
          ' log lines - the plugin is logging faster than anyone can read' });
      }
      logWindow = t; logCount = 0; logDropped = 0;
    }
    logCount++;
    if (logCount > LOG_BURST) { logDropped++; return; }
    send({ v: V, t: 'log', level: level, text: text });
  }

  var TEXT_CAP = 4000;

  function describe(v, depth, seen) {
    var t = typeof v;
    if (t === 'string') return depth === 0 ? v : '"' + v + '"';
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') { try { return v.toString(); } catch (e) { return 'Symbol()'; } }
    if (t === 'function') return 'function ' + (v.name || '(anonymous)') + '()';
    if (isError(v)) return v.stack ? String(v.stack) : String(v.name) + ': ' + String(v.message);
    for (var s = 0; s < seen.length; s++) if (seen[s] === v) return '[circular]';
    if (depth >= 3) return isArray(v) ? '[...]' : '{...}';
    seen.push(v);
    try {
      if (isArray(v)) {
        var items = [];
        for (var i = 0; i < v.length && i < 20; i++) items.push(safeDescribe(v, i, depth, seen));
        if (v.length > 20) items.push('... ' + (v.length - 20) + ' more');
        return '[' + items.join(', ') + ']';
      }
      var tag = protoString.call(v);
      if (tag !== '[object Object]') return tag.slice(8, tag.length - 1);
      var keys = keysOf(v);
      var parts = [];
      for (var k = 0; k < keys.length && k < 20; k++) {
        parts.push(keys[k] + ': ' + safeDescribe(v, keys[k], depth, seen));
      }
      if (keys.length > 20) parts.push('... ' + (keys.length - 20) + ' more');
      return '{' + parts.join(', ') + '}';
    } catch (e) {
      return '[unreadable]';
    } finally {
      seen.pop();
    }
  }

  // Reading a property can run a getter, and a getter can throw. One bad
  // property must not lose the whole log line.
  function safeDescribe(owner, key, depth, seen) {
    try { return describe(owner[key], depth + 1, seen); } catch (e) { return '[threw on read]'; }
  }

  function isError(v) {
    if (v instanceof Err) return true;
    // Cross-realm errors (from a Worker, or from the host across the bridge)
    // fail instanceof, so go by shape as well.
    return !!v && typeof v === 'object' && typeof v.message === 'string' && typeof v.name === 'string';
  }

  function formatArgs(args) {
    var out = [];
    for (var i = 0; i < args.length; i++) out.push(describe(args[i], 0, []));
    var text = out.join(' ');
    if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP) + '... (' + (text.length - TEXT_CAP) + ' more characters)';
    return text;
  }

  // Console, window.onerror and unhandledrejection all end up in the host's
  // log pane. A plugin that fails silently is the worst outcome this system
  // can produce: nothing renders, nothing is logged, and the author has no
  // thread to pull.
  function captureConsole() {
    if (!realConsole) return;
    var names = ['log', 'info', 'debug', 'warn', 'error'];
    for (var i = 0; i < names.length; i++) capture(names[i]);
    function capture(name) {
      var original = realConsole[name];
      var level = name === 'warn' ? 'warn' : (name === 'error' ? 'error' : 'info');
      try {
        realConsole[name] = function () {
          var args = slice.call(arguments);
          try { log(level, formatArgs(args)); } catch (e) { /* never break the call */ }
          // Still print it: the frame is a real browsing context and devtools
          // showing the plugin's own console is half of how it gets debugged.
          if (typeof original === 'function') { try { original.apply(realConsole, args); } catch (e) {} }
        };
      } catch (e) { /* a frozen console is not worth dying for */ }
    }
  }

  function captureErrors() {
    // Capture phase, because a failed resource load fires at the element and
    // does not bubble — and that event is worth having: it is what a CSP
    // refusal looks like from in here.
    W.addEventListener('error', function (e) {
      try {
        if (e && (e.message || e.error)) {
          var where = e.filename ? ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')' : '';
          var stack = e.error && e.error.stack ? '\\n' + e.error.stack : '';
          log('error', 'uncaught ' + (e.message || describe(e.error, 0, [])) + where + stack);
        } else if (e && e.target && e.target !== W && e.target.tagName) {
          var src = e.target.src || e.target.href || '';
          log('warn', 'failed to load ' + String(e.target.tagName).toLowerCase() + (src ? ' ' + src : '') +
            ' - this frame allows data: and blob: images and nothing else off the network');
        }
      } catch (err) { /* the log must not itself throw */ }
    }, true);

    W.addEventListener('unhandledrejection', function (e) {
      try { log('error', 'unhandled rejection: ' + describe(e && e.reason, 0, [])); } catch (err) {}
    });
  }

  // ---------------------------------------------------------------- events

  var subs = {};

  function subscribeChannel(channel, cb) {
    var list = subs[channel];
    if (!list) { list = subs[channel] = []; send({ v: V, t: 'subscribe', channel: channel }); }
    list.push(cb);
    return function off() {
      var current = subs[channel];
      if (!current) return;
      var i = current.indexOf(cb);
      if (i < 0) return;
      current.splice(i, 1);
      if (current.length === 0) { delete subs[channel]; send({ v: V, t: 'unsubscribe', channel: channel }); }
    };
  }

  // The channel is opened before the permission is known, so that no event
  // sent between the request and its answer is lost; a refusal closes it again
  // and reaches the caller as a rejection.
  function subscribeCall(method, args, channel, adapt) {
    var off = subscribeChannel(channel, adapt);
    return call(method, args).then(function () { return off; }, function (err) { off(); throw err; });
  }

  function deliver(channel, payload) {
    var list = subs[channel];
    if (!list) return;
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](payload); } catch (e) { log('error', 'a ' + channel + ' subscriber threw: ' + describe(e, 0, [])); }
    }
  }

  // ---------------------------------------------------------------- lifecycle

  var hooks = { mount: [], unmount: [], visible: [] };
  var mounted = false;
  var unmountedAlready = false;

  function addHook(name, cb) {
    if (typeof cb !== 'function') return function () {};
    hooks[name].push(cb);
    // Late registration still fires, DOMContentLoaded-style: a plugin that
    // registers onMount from inside a promise has not missed anything.
    if (name === 'mount' && mounted) Prom.resolve().then(function () { runHook(cb, undefined, name); });
    return function () {
      var i = hooks[name].indexOf(cb);
      if (i >= 0) hooks[name].splice(i, 1);
    };
  }

  function runHook(cb, arg, name) {
    try { cb(arg); } catch (e) { log('error', 'a ' + name + ' hook threw: ' + describe(e, 0, [])); }
  }

  function fireHooks(name, arg) {
    var copy = hooks[name].slice();
    for (var i = 0; i < copy.length; i++) runHook(copy[i], arg, name);
  }

  function markMounted() {
    if (mounted) return;
    mounted = true;
    fireHooks('mount');
  }

  function markUnmounted() {
    if (unmountedAlready) return;
    unmountedAlready = true;
    fireHooks('unmount');
  }

  function lifecycle(payload) {
    var phase = payload && payload.phase;
    if (phase === 'mount') markMounted();
    else if (phase === 'unmount') markUnmounted();
    else if (phase === 'visible') fireHooks('visible', payload.visible !== false);
  }

  // ---------------------------------------------------------------- theme

  // A token value is not allowed to close the declaration block it is written
  // into. These come from the host rather than from the plugin, so this is
  // defence in depth rather than the main event — but the rule is the same one
  // frameHtml applies, and the two have to agree.
  function unsafeValue(v) {
    return v.indexOf('<') >= 0 || v.indexOf('>') >= 0 || v.indexOf('{') >= 0 ||
      v.indexOf('}') >= 0 || v.indexOf(';') >= 0 || v.indexOf('@') >= 0 || v.indexOf('/*') >= 0;
  }

  function themeCss(tokens) {
    var out = '';
    var names = keysOf(tokens);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var value = tokens[name];
      if (typeof value !== 'string' || !value) continue;
      if (!/^(--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) continue;
      if (unsafeValue(value)) continue;
      out += '  ' + name + ': ' + value + ';\\n';
    }
    return ':root {\\n' + out + '}\\n';
  }

  function applyTheme(tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    var el = doc.getElementById('axis-theme');
    if (!el) {
      el = doc.createElement('style');
      el.id = 'axis-theme';
      (doc.head || doc.documentElement).appendChild(el);
    }
    // textContent, not innerHTML: a style element's text is never parsed as
    // markup this way, so nothing in it can end the element early.
    el.textContent = themeCss(tokens);
  }

  // ---------------------------------------------------------------- axis

  function machineApi() {
    return freeze({
      state: function () { return call('machine.state', []); },
      capabilities: function () { return call('machine.capabilities', []); },
      subscribe: function (cb) {
        if (typeof cb !== 'function') return Prom.reject(new Err('axis.machine.subscribe needs a function'));
        return subscribeCall('machine.subscribe', [], 'machine.state', function (state) { cb(state); });
      },
      jog: function (deltas, feed) { return call('machine.jog', [deltas, feed]); },
      moveTo: function (targets, feed) { return call('machine.moveTo', [targets, feed]); },
      home: function (axes) { return call('machine.home', [axes]); },
      goToWorkOrigin: function (options) { return call('machine.goToWorkOrigin', [options]); },
      send: function (gcode) { return call('machine.send', [gcode]); },
      runMacro: function (path) { return call('machine.runMacro', [path]); },
      setSpindle: function (rpm, direction) { return call('machine.setSpindle', [rpm, direction]); },
      stopSpindle: function () { return call('machine.stopSpindle', []); },
      setWorkZero: function (axisName, value, wcs) { return call('machine.setWorkZero', [axisName, value, wcs]); },
      selectWcs: function (index) { return call('machine.selectWcs', [index]); }
    });
  }

  function filesApi() {
    return freeze({
      list: function (dir) { return call('files.list', [dir]); },
      read: function (path) { return call('files.read', [path]); },
      write: function (path, bytes) { return call('files.write', [path, bytes]); },
      'delete': function (path) { return call('files.delete', [path]); }
    });
  }

  function storageApi() {
    return freeze({
      // Async even though it answers locally: protocol.ts has no storage.open
      // method, and the only round trip available would be a read the plugin
      // may not have been granted. Access is decided per call, at the door.
      // Keeping the promise means a later version can start round-tripping
      // without breaking every plugin written against this one.
      open: function (domain) {
        if (typeof domain !== 'string' || !domain) {
          return Prom.reject(new Err('axis.storage.open needs a domain name, like "org.axiscontrol.tools"'));
        }
        return Prom.resolve(freeze({
          domain: domain,
          get: function (key) { return call('storage.get', [domain, key]); },
          set: function (key, value) { return call('storage.set', [domain, key, value]); },
          'delete': function (key) { return call('storage.delete', [domain, key]); },
          keys: function () { return call('storage.keys', [domain]); },
          subscribe: function (cb) {
            if (typeof cb !== 'function') return Prom.reject(new Err('subscribe needs a function'));
            return subscribeCall('storage.subscribe', [domain], 'storage:' + domain, function (change) {
              cb(change && change.key, change && change.value);
            });
          }
        }));
      }
    });
  }

  function uiApi() {
    return freeze({
      title: function (text) { return call('ui.title', [String(text)]); },
      notify: function (text, level) { return call('ui.notify', [String(text), level || 'info']); },
      // No argument means "as tall as what I have rendered", which is the
      // thing every caller was about to measure by hand.
      resize: function (height) {
        var px = typeof height === 'number' && isFinite(height)
          ? Math.ceil(height)
          : Math.ceil(doc.documentElement.scrollHeight);
        return call('ui.resize', [px]);
      },
      onMount: function (cb) { return addHook('mount', cb); },
      onUnmount: function (cb) { return addHook('unmount', cb); },
      onVisible: function (cb) { return addHook('visible', cb); }
    });
  }

  function logApi() {
    // Not a request: logs are one-way, so there is no answer to wait for and
    // nothing useful to await.
    return freeze({
      info: function () { log('info', formatArgs(slice.call(arguments))); },
      warn: function () { log('warn', formatArgs(slice.call(arguments))); },
      error: function () { log('error', formatArgs(slice.call(arguments))); }
    });
  }

  function plainHeaders(h) {
    var out = {};
    try {
      if (isArray(h)) {
        for (var i = 0; i < h.length; i++) out[String(h[i][0])] = String(h[i][1]);
      } else if (h && typeof h.forEach === 'function') {
        h.forEach(function (value, key) { out[String(key)] = String(value); });
      } else if (h && typeof h === 'object') {
        var names = keysOf(h);
        for (var k = 0; k < names.length; k++) out[names[k]] = String(h[names[k]]);
      }
    } catch (e) { /* an init nobody can read is an init with no headers */ }
    return out;
  }

  // Only the parts of RequestInit that survive a structured clone. A Headers
  // object, an AbortSignal or a stream would throw DataCloneError on the way
  // out and turn a fetch into an error about postMessage.
  function plainInit(init) {
    if (!init || typeof init !== 'object') return null;
    var out = {};
    if (typeof init.method === 'string') out.method = init.method;
    if (init.headers) out.headers = plainHeaders(init.headers);
    if (typeof init.body === 'string') out.body = init.body;
    else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) out.body = init.body;
    return out;
  }

  function decodeBody(body) {
    if (typeof body === 'string') return body;
    if (!body) return '';
    try { return new TextDecoder().decode(body.buffer ? body : new Uint8Array(body)); } catch (e) { return ''; }
  }

  // A Response is not structured-cloneable, so the host answers with plain
  // data and the shape a caller expects is put back together here.
  function makeResponse(r) {
    var body = r ? r.body : '';
    return freeze({
      ok: !!(r && r.ok),
      status: r && r.status ? r.status : 0,
      statusText: r && r.statusText ? String(r.statusText) : '',
      url: r && r.url ? String(r.url) : '',
      headers: freeze(r && r.headers ? r.headers : {}),
      text: function () { return Prom.resolve(decodeBody(body)); },
      json: function () { return Prom.resolve().then(function () { return parseJson(decodeBody(body)); }); },
      arrayBuffer: function () {
        return Prom.resolve().then(function () {
          if (typeof body !== 'string') return body;
          return new TextEncoder().encode(body).buffer;
        });
      }
    });
  }

  function netFetch(input, init) {
    var url;
    try { url = String(input && input.url ? input.url : input); } catch (e) { url = ''; }
    return call('net.fetch', [url, plainInit(init)]).then(makeResponse);
  }

  function buildAxis(version) {
    var axis = freeze({
      version: freeze({ api: version.api, app: version.app }),
      machine: machineApi(),
      files: filesApi(),
      storage: storageApi(),
      ui: uiApi(),
      log: logApi(),
      fetch: netFetch
    });
    try {
      // Frozen and non-writable, both: freeze stops a method being swapped
      // out, non-writable stops the whole object being replaced by something
      // that looks like it. A plugin that loads a second script of its own is
      // the case this is for.
      defineProp(W, 'axis', { value: axis, writable: false, configurable: false, enumerable: true });
    } catch (e) {
      W.axis = axis;
    }
    return axis;
  }

  // ---------------------------------------------------------------- plugin

  function safeId(id) {
    return String(id || 'plugin').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  }

  function applyCss(css) {
    if (!css) return;
    var el = doc.createElement('style');
    el.id = 'axis-plugin-css';
    el.textContent = css;
    (doc.head || doc.documentElement).appendChild(el);
  }

  // Window properties that silently corrupt a plugin's own top-level variable.
  //
  // The plugin's code runs at global scope, which is the right authoring model
  // for a frame that belongs to it — an inline onclick= handler resolves there,
  // and a breakpoint lands where the author wrote the line. The cost is the
  // legacy Window members: 'var status = document.createElement("p")' does not
  // create a variable, it calls window.status's setter, which coerces the node
  // to the string "[object HTMLParagraphElement]". Nothing throws. The failure
  // surfaces later and somewhere else, as appendChild being handed a string,
  // and it cost an afternoon the first time it happened here.
  //
  // 'origin' and 'length' fail the other way round: they are getter-only, so
  // the assignment is silently discarded and the variable keeps the frame's
  // value. All of them are worthless inside a plugin frame — the origin is
  // "null", the frame count is zero, the status bar has not existed for
  // fifteen years — so they are removed rather than worked around, and a
  // plugin naming a variable after one of them gets an ordinary variable.
  function clearLegacyGlobals() {
    var names = ['status', 'defaultStatus', 'defaultstatus', 'name', 'origin', 'length'];
    for (var i = 0; i < names.length; i++) {
      try {
        delete W[names[i]];
      } catch (e) {
        // Non-configurable in some engine: leave it. The plugin is no worse
        // off than it would have been, and nothing here depends on the delete.
      }
    }
  }

  function runPlugin(code, id) {
    clearLegacyGlobals();
    var el = doc.createElement('script');
    // textContent, so the browser never HTML-parses the plugin's source: an
    // end tag written anywhere in it cannot end an element, because it is not
    // inside one. The sourceURL gives the script a name in the devtools source
    // list, which is what makes a breakpoint in a plugin possible; the id is
    // scrubbed first because a newline in it would end the comment line and
    // start running.
    el.textContent = code + '\\n//# sourceURL=axis-plugin/' + id + '/main.js\\n';
    (doc.body || doc.documentElement).appendChild(el);
  }

  function whenReady(fn) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // ---------------------------------------------------------------- boot

  var initSeen = false;

  function onInit(m) {
    // The document was already built from the manifest, the grants and the
    // theme this message carries, so init's job here is the theme and the
    // confirmation that somebody is listening. It is deliberately not what
    // starts the plugin: a frame that sat waiting for a message that never
    // came would be a plugin that does nothing, with nothing in the log to say
    // why, which is the exact failure this whole system exists to avoid.
    if (initSeen) return;
    initSeen = true;
    if (m.theme) applyTheme(m.theme);
  }

  function listen() {
    W.addEventListener('message', function (e) {
      // Only the host. Sibling frames can address each other through
      // parent.frames, so without this check one plugin could answer another
      // plugin's requests or feed it invented machine state.
      if (e.source !== HOST) return;
      var m = e.data;
      if (!m || typeof m !== 'object' || m.v !== V) return;
      if (m.t === 'ping') { send({ v: V, t: 'pong', id: m.id }); return; }
      if (m.t === 'res') { settle(m); return; }
      if (m.t === 'init') { onInit(m); return; }
      if (m.t === 'event') {
        if (m.channel === 'theme') applyTheme(m.payload);
        else if (m.channel === 'lifecycle') lifecycle(m.payload);
        else deliver(m.channel, m.payload);
      }
    });

    // Tab-level visibility. Panel-level visibility is the host's to send,
    // because a panel hidden behind another tab of the dock is still a visible
    // document as far as this frame can tell.
    doc.addEventListener('visibilitychange', function () {
      fireHooks('visible', doc.visibilityState === 'visible');
    });
    // Best effort only: an iframe removed from the DOM does not reliably run
    // anything. The host should emit lifecycle/unmount before it destroys the
    // frame if it wants onUnmount to mean something.
    W.addEventListener('pagehide', markUnmounted);
  }

  function boot(options) {
    try { delete W.__axisBoot; } catch (e) { W.__axisBoot = undefined; }
    options = options || {};
    captureConsole();
    captureErrors();
    listen();
    buildAxis(options.version || { api: 0, app: 'unknown' });
    send({ v: V, t: 'ready' });
    whenReady(function () {
      applyCss(options.css);
      runPlugin(String(options.code || ''), safeId(options.id));
      markMounted();
    });
  }

  W.__axisBoot = boot;
})();
`;

/**
 * The whole frame document.
 *
 * Carries its own CSP: `default-src 'none'` closes the network, and
 * `connect-src` opens only the origins the plugin was granted. Inline script
 * is the only script, because there is no origin to load one from.
 *
 * `code` is the plugin's own source and is NOT trusted to be well-formed — it
 * is inlined into a <script>, so anything that could end the element early has
 * to be neutralised.
 *
 * The neutralising is not a search for `</script`. The source (and the
 * stylesheet, which has the same problem with `</style`) is carried as a JSON
 * string literal with every `<` and `>` written as `\u003c`/`\u003e`, and the
 * runtime hands it to the DOM as `textContent`. Two consequences, and both are
 * the point:
 *
 *   - The bytes the HTML tokenizer sees contain no `<` at all, so it cannot
 *     leave the script data state: not on `</script`, not on `<!--` (which
 *     would otherwise open the escaped state, where a later `<script` hides
 *     the real end tag and swallows the rest of the document), and not on
 *     `<script`. `]]>` and `-->` need no thought either — they mean something
 *     in XML, and an iframe srcdoc is always parsed as HTML.
 *   - The plugin's source arrives byte for byte. An escape that rewrites
 *     `</script` to `<\/script` is right inside a string and wrong inside
 *     `String.raw`, and a sandbox that silently changes the code it runs is a
 *     bug that only shows up in somebody else's plugin.
 *
 * U+2028 and U+2029 are escaped for the same round-trip reason: they are legal
 * JSON but were illegal in a JavaScript string literal before ES2019, and the
 * tablet this app has to run on is an iPad on iOS 12.
 */
export function frameHtml(
  manifest: Manifest,
  granted: PermissionName[],
  code: string,
  css: string | undefined,
  theme: Record<string, string>,
): string {
  const boot = {
    id: manifest.id,
    version: { api: API_VERSION, app: BUILD.version },
    code,
    css: css ?? '',
  };
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    // First, before anything the policy has to cover: a meta policy applies to
    // what follows it, so a stylesheet or a script above it would be outside
    // the only policy this document has.
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp(granted))}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Named after the plugin so the frame is findable in the devtools context
    // picker — there is one frame per open panel, and "about:srcdoc" three
    // times over is not a choice anyone can make.
    `<title>${escapeText(manifest.name || manifest.id)}</title>`,
    `<style id="axis-theme">${themeBlock(theme)}</style>`,
    `<style id="axis-base">${BASE_CSS}</style>`,
    '</head>',
    '<body>',
    `<script>${GUEST_RUNTIME}\n__axisBoot(${jsLiteral(boot)});\n</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The CSS custom properties forwarded into every frame, read from the host.
 *
 * The names are the ones public/styles.css actually defines — the list is
 * checked against that file by `npm run plugin-guest-check`, because a token
 * this app renamed and the frame kept sending is a plugin that goes on looking
 * right until somebody switches theme.
 *
 * `color-scheme` is not a custom property and is forwarded anyway: without it
 * the frame's own scrollbars, `<select>` menus and date pickers render light
 * on top of a dark panel, which is the one piece of a plugin's chrome no
 * stylesheet of ours can reach.
 */
export function themeTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  // Absent in node, where the check suites import this module for frameHtml.
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return out;
  const style = getComputedStyle(document.documentElement);
  for (const name of THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value) out[name] = value;
  }
  const scheme = style.getPropertyValue('color-scheme').trim();
  if (scheme) out['color-scheme'] = scheme;
  return out;
}

/** Every custom property `:root` in public/styles.css defines. */
export const THEME_TOKENS: readonly string[] = [
  '--pc', '--pgap', '--prow',
  '--bg', '--bg-panel', '--bg-raised', '--bg-input',
  '--border', '--border-strong',
  '--text', '--text-dim', '--text-faint',
  '--accent', '--good', '--warn', '--bad', '--active',
  '--on-accent', '--bad-text', '--shadow',
  '--tint-bad', '--tint-warn', '--tint-accent',
  '--code-number', '--code-string', '--code-boolean', '--code-comment',
  '--code-command', '--code-param', '--code-keyword', '--code-expr',
  '--radius', '--tap', '--mono', '--sans',
];

/**
 * What the frame is allowed to do, in the browser's words rather than ours.
 *
 * Delivered as a `<meta>` because a srcdoc document has no headers, which also
 * means the header-only directives are not available here: `frame-ancestors`,
 * `sandbox` and `report-uri` are ignored in a meta policy. The sandbox comes
 * from the iframe element instead (`allow-scripts`, and deliberately not
 * `allow-same-origin`), and that is where the opaque origin comes from.
 *
 * A meta policy can only add to whatever the parent document's policy already
 * imposed — a srcdoc inherits the embedder's CSP — so this can tighten and
 * never loosen.
 *
 *   default-src 'none'   Nothing loads. No scripts from a URL, no stylesheets,
 *                        no fonts, no frames, no XHR, no WebSocket, no
 *                        EventSource, no beacon. Every line below is an
 *                        exception carved out of this one, and anything not
 *                        named here is refused by the browser rather than by
 *                        us.
 *   script-src           'unsafe-inline' and nothing else: the runtime and the
 *                        plugin are text in this document, and there is no
 *                        origin to load a file from. It does NOT include
 *                        'unsafe-eval', so eval and new Function throw — a
 *                        plugin cannot turn a string that arrived over the
 *                        bridge into code.
 *   style-src            The theme block, the base sheet and the plugin's own
 *                        stylesheet are all inline.
 *   img-src data: blob:  Enough for a plugin to draw a canvas and show it, and
 *                        no route to the network: an <img src> pointed at a
 *                        server is the oldest exfiltration trick there is, and
 *                        it does not need fetch.
 *   worker-src blob:     docs/plugins.md's answer to a plugin that freezes the
 *                        window is "put the loop in a Worker", and without
 *                        this the worker would fall back through child-src to
 *                        script-src and be refused. A blob: worker inherits
 *                        this policy, so it gets no network either.
 *   base-uri 'none'      No <base> element: it has no default-src fallback, and
 *                        it rewrites where every relative URL in the document
 *                        points.
 *   form-action 'none'   No form submission. Also has no fallback, and a form
 *                        POST is a network request that survives everything
 *                        above. The sandbox already blocks it without
 *                        allow-forms; this is the belt to that pair of braces.
 *   connect-src          The granted origins, and only those. Omitted entirely
 *                        when nothing was granted, so it falls back to
 *                        default-src 'none'.
 *
 * What this does not close: a frame can still navigate *itself*, and
 * `location = 'https://elsewhere/?' + secret` is a network request no
 * directive here governs (`navigate-to` was never shipped). Closing it needs
 * `frame-src` on the *host* document's policy — public/index.html — not on
 * this one. Written down rather than papered over, per docs/plugins.md.
 */
function csp(granted: PermissionName[]): string {
  const parts = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'worker-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
  ];
  const origins = connectOrigins(granted);
  if (origins.length > 0) parts.push(`connect-src ${origins.join(' ')}`);
  return parts.join('; ');
}

/**
 * A scheme and a host, and nothing else — no path, no credentials, no
 * wildcard, no space and no semicolon.
 *
 * The permission string comes from a manifest somebody else wrote. A grant of
 * `network.https://example.com; script-src *` would otherwise be a way to
 * append a directive to this document's own policy, which is a plugin editing
 * the wall it is behind. Anything that does not match is dropped rather than
 * repaired, so the failure is a fetch that is refused rather than a policy
 * that is wider than it reads.
 */
const ORIGIN = /^(?:https?|wss?):\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

function connectOrigins(granted: PermissionName[]): string[] {
  const out: string[] = [];
  for (const permission of granted) {
    if (typeof permission !== 'string' || !permission.startsWith('network.')) continue;
    const origin = permission.slice('network.'.length);
    if (!ORIGIN.test(origin)) continue;
    if (out.indexOf(origin) < 0) out.push(origin);
  }
  return out;
}

/**
 * A JavaScript literal for arbitrary data, safe to put inside a script element.
 *
 * JSON first, then every `<` and `>` becomes an escape. All of them are inside
 * string literals — JSON's own punctuation is `{}[]",:` and digits — so the
 * substitution cannot corrupt the structure, and JSON.parse reads the result
 * back byte for byte.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The theme, as a `:root` block. Mirrors `themeCss` in the runtime. */
function themeBlock(theme: Record<string, string>): string {
  let out = '';
  for (const [name, value] of Object.entries(theme ?? {})) {
    if (typeof value !== 'string' || !value) continue;
    if (!/^(--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) continue;
    if (/[<>{};@]/.test(value) || value.includes('/*')) continue;
    out += `  ${name}: ${value};\n`;
  }
  return `\n:root {\n${out}}\n`;
}

function escapeText(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** For a double-quoted attribute, which is the only kind this file writes. */
function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

/**
 * What a plugin gets for styling nothing.
 *
 * The tokens above are only half of looking native — a plugin that renders a
 * button and no CSS should get the app's button, not the browser's 1995 one,
 * because the panel it is sitting in is two inches from a panel of ours. Every
 * colour here is a token with a fallback, so the sheet still reads if a token
 * is ever dropped.
 *
 * Selection is off for the same reason it is off in the app: this is a machine
 * control, a drag across it leaves a blue smear over labels and button faces,
 * and a long press on the tablet offers to look the word up. It is turned back
 * on for the things anyone would want to copy, and `.selectable` is the way
 * out for a plugin that wants more.
 */
const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { height: 100%; }
body {
  min-height: 100%;
  padding: 8px;
  background: var(--bg-panel, #fff);
  color: var(--text, #14181d);
  font-family: var(--sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: 14px;
  line-height: 1.4;
  color-scheme: var(--color-scheme, light);
  accent-color: var(--accent, #0a63c9);
  -webkit-text-size-adjust: 100%;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
input, textarea, select, pre, code, .selectable {
  -webkit-user-select: text;
  user-select: text;
  -webkit-touch-callout: default;
}
h1, h2, h3, h4 { margin: 0 0 8px; font-weight: 600; }
h1 { font-size: 18px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
p { margin: 0 0 8px; }
a { color: var(--accent, #0a63c9); }
label, .dim { color: var(--text-dim, #55606d); }
code, pre, .mono { font-family: var(--mono, ui-monospace, Menlo, Consolas, monospace); }
pre {
  margin: 0 0 8px;
  padding: 8px;
  overflow: auto;
  background: var(--bg-raised, #f4f6f9);
  border-radius: var(--radius, 6px);
}
hr { border: 0; border-top: 1px solid var(--border, #dbe1e9); margin: 8px 0; }
button, input, select, textarea {
  font: inherit;
  color: var(--text, #14181d);
  background: var(--bg-input, #fff);
  border: 1px solid var(--border-strong, #b9c3cf);
  border-radius: var(--radius, 6px);
  min-height: var(--tap, 40px);
  padding: 0 10px;
}
textarea { padding: 6px 10px; min-height: 0; }
input[type="checkbox"], input[type="radio"] { min-height: 0; width: 20px; height: 20px; }
button { background: var(--bg-raised, #f4f6f9); cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent, #0a63c9); }
button.primary {
  background: var(--accent, #0a63c9);
  border-color: var(--accent, #0a63c9);
  color: var(--on-accent, #fff);
}
button:disabled, input:disabled, select:disabled, textarea:disabled { opacity: 0.5; cursor: default; }
:focus-visible { outline: 2px solid var(--accent, #0a63c9); outline-offset: 1px; }
table { border-collapse: collapse; }
th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--border, #dbe1e9); }
th { color: var(--text-dim, #55606d); font-weight: 600; }
`;
