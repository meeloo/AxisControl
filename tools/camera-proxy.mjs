// A CORS-adding proxy in front of a camera.
//
//   node tools/camera-proxy.mjs http://192.168.1.53 [listen-port]
//   npm run camera-proxy -- http://192.168.1.53
//
// Then point the camera panel at http://<this-host>:8100 instead of the camera.
//
// Why this exists
// ---------------
// A Reolink answers everything you ask it. What it does not send is
// `Access-Control-Allow-Origin`, and without that header a browser will not
// hand the reply to a page served from anywhere else — which is every page
// except the camera's own. That is a browser rule, not a camera fault, and it
// is not a setting on any Reolink: the firmware is built for their app and for
// NVRs, neither of which is a browser.
//
// The consequence is a panel in "blind" mode. Commands still work, because a
// command needs no reply: pan, tilt, presets, zoom by the buttons, click to
// aim. Everything that needs an *answer* does not: the model, the live state of
// IR and the spotlight, preset names, day/night (which has to read the whole
// image block before writing it back), the zoom slider — and live video, which
// unlike the snapshots is an ordinary fetch.
//
// Forwarding the same requests from a process that does add the header gets all
// of it back.
//
// Where to run it
// ---------------
// Anything on the same network that is always on: a Pi, a NAS, the machine
// that serves the app. Not a laptop that sleeps, or the camera stops working
// when the lid closes.
//
// It is a plain forwarder for a trusted LAN. It adds no authentication of its
// own — anyone who can reach this port can reach the camera through it, with
// whatever credentials the caller supplies — so bind it where you would be
// willing to expose the camera itself, and do not put it on the internet.

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const target = process.argv[2] ?? process.env.CAMERA_URL ?? '';
const port = Number(process.argv[3] ?? process.env.PROXY_PORT ?? 8100);

if (!target) {
  console.error('usage: node tools/camera-proxy.mjs http://<camera-address> [listen-port]');
  process.exit(1);
}

const upstream = new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
const call = upstream.protocol === 'https:' ? httpsRequest : httpRequest;

/**
 * Headers that belong to one hop and must not be copied to the next.
 *
 * `transfer-encoding` especially: node decides for itself whether to chunk the
 * response, and copying the upstream's value on top of that produces a reply
 * the browser gives up on halfway through — which on the video stream looks
 * like a camera that stops after a second.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function allow(req, res) {
  // Echo the origin rather than `*`, which is what a request would need if it
  // ever carried credentials — and costs nothing when it does not.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
  res.setHeader('Access-Control-Max-Age', '600');
}

const server = createServer((req, res) => {
  allow(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const headers = { ...req.headers, host: upstream.host };
  // The camera has no business knowing which page asked; leaving these in makes
  // some firmware answer differently, and neither is needed to serve a request.
  delete headers.origin;
  delete headers.referer;
  for (const name of HOP_BY_HOP) delete headers[name];

  const forward = call(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
      // A camera's own certificate is self-signed. Refusing it would mean the
      // proxy cannot talk to the thing it exists to talk to.
      rejectUnauthorized: false,
    },
    (upstreamRes) => {
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) res.setHeader(name, value);
      }
      res.writeHead(upstreamRes.statusCode ?? 502);
      // Piped, not buffered: the video stream never ends, and collecting it
      // would mean it never starts.
      upstreamRes.pipe(res);
    },
  );

  forward.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`camera-proxy: ${err.message}`);
  });

  // If the browser gives up — closing a video stream, or navigating away —
  // stop pulling from the camera as well.
  //
  // Watched on the response, not the request: a request stream also emits
  // `close` when its body has simply been read to the end, which is every
  // ordinary POST. Tearing the upstream down there means every command answers
  // "socket hang up" — the proxy killing its own request a moment before the
  // camera replies.
  res.on('close', () => {
    if (!res.writableEnded) forward.destroy();
  });
  req.pipe(forward);
});

server.listen(port, () => {
  console.log(`camera-proxy: http://localhost:${port}  →  ${upstream.origin}`);
  console.log('point the camera panel at this address instead of the camera');
});
