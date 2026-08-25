// What a plugin is, as far as the rest of the app is concerned.
//
// See docs/plugins.md for the design and the reasoning. The short version:
// a plugin is JavaScript that runs in a sandboxed iframe with an opaque
// origin, so the browser — not this code — denies it the host DOM, storage,
// cookies and same-origin fetch. Everything it can do arrives over
// postMessage, which is where permission is checked.

/**
 * Permissions, each one a sentence an operator can act on.
 *
 * `storage.*` and `network.*` are parameterised: `storage.org.example.tools`,
 * `network.https://example.com`. Everything else is a bare name.
 */
export type PermissionName =
  | 'machine.read'
  | 'machine.motion'
  | 'machine.command'
  | 'files.read'
  | 'files.write'
  | 'ui.notify'
  | 'background'
  | 'unsafe.fullAccess'
  | `storage.${string}`
  | `network.${string}`;

/** Where a storage domain's bytes live. */
export type DomainScope = 'machine' | 'browser';

export interface DomainSpec {
  domain: string;
  scope: DomainScope;
}

export interface DomainUse {
  domain: string;
  access: 'read' | 'write';
}

export interface PanelSpec {
  title: string;
  /** Grid columns of 12, matching PanelDefinition.defaultWidth. */
  width?: number;
  /** Pixels, matching PanelDefinition.defaultHeight. */
  height?: number;
  description?: string;
}

export interface Manifest {
  /** Reverse-DNS. The plugin's identity everywhere: storage, grants, panel id. */
  id: string;
  name: string;
  version: string;
  /** Plugin API version this code was written against. */
  api: number;
  description?: string;
  author?: string;
  panel?: PanelSpec;
  /** Keep a hidden frame alive while enabled. Requires the `background` permission. */
  background?: boolean;
  permissions: PermissionName[];
  /** Domains this plugin owns. */
  provides: DomainSpec[];
  /** Domains owned by someone else that this plugin wants. */
  uses: DomainUse[];
}

/** The API version this build serves. Bump only for a breaking change. */
export const API_VERSION = 1;

/** Where a plugin's files live. */
export type PluginSource = 'machine' | 'browser';

export interface PluginRecord {
  manifest: Manifest;
  /** The plugin's entry source. */
  code: string;
  /** Optional stylesheet, injected into the frame document. */
  css?: string;
  source: PluginSource;
  /**
   * Hash of manifest + code. Grants are keyed by it, so new code that widens
   * what it asks for has to ask again.
   */
  hash: string;
  enabled: boolean;
  /**
   * Why this plugin is not running, when it is not. An empty string means it
   * is running or was never started.
   */
  fault?: string;
}

/** A permission decision the operator made, for one plugin at one hash. */
export interface Grant {
  pluginId: string;
  hash: string;
  granted: PermissionName[];
  /** Set when the operator refused; the plugin stays installed and disabled. */
  refused?: boolean;
  at: number;
}

export class PluginError extends Error {}

/** Thrown across the bridge when a plugin calls something it was not granted. */
export class PermissionDenied extends PluginError {
  constructor(
    readonly permission: PermissionName,
    readonly method: string,
  ) {
    super(`denied: ${method} needs the "${permission}" permission, which was not granted`);
  }
}
