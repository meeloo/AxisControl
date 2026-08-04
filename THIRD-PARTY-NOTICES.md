# Third-party notices

Axis Control is Apache-2.0. It ships the following components, all under
permissive licences. Attribution is required by BSD-3-Clause, Apache-2.0 and
the Boost licence, which is what this file is for.

| Component | Licence | Used for |
|---|---|---|
| [Lit](https://lit.dev) | BSD-3-Clause | templating and custom elements |
| [dockview-core](https://github.com/mathuo/dockview) | MIT | the dockable panel layout |
| [clipper-lib](https://sourceforge.net/projects/jsclipper/) | Boost Software License 1.0 | polygon offsetting for imported outlines |
| [mpegts.js](https://github.com/xqq/mpegts.js) | Apache-2.0 | HTTP-FLV demuxing for the camera panel |

Build-time only, not distributed in the bundle:

| Component | Licence |
|---|---|
| [esbuild](https://esbuild.github.io) | MIT |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 |

Axis Control talks to RepRapFirmware over its documented HTTP API. It contains
no RepRapFirmware or Duet Web Control code, and is not a derivative of either;
both are GPL-3.0 and are separate programs communicating over a network
interface.
