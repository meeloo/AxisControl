// The wire between the host and a plugin frame.
//
// One door. Every capability a plugin has is a method name in this table, and
// every method names the permission it needs — so a new capability cannot be
// added without deciding what it costs, and the check cannot be forgotten in
// one branch of a driver.

import type { PermissionName } from './types.js';

/** Bumped only when the message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export type HostToGuest =
  | { v: number; t: 'init'; manifest: unknown; granted: PermissionName[]; theme: Record<string, string> }
  | { v: number; t: 'res'; id: number; ok: true; value: unknown }
  | { v: number; t: 'res'; id: number; ok: false; error: string }
  | { v: number; t: 'event'; channel: string; payload: unknown }
  | { v: number; t: 'ping'; id: number };

export type GuestToHost =
  | { v: number; t: 'ready' }
  | { v: number; t: 'req'; id: number; method: string; args: unknown[] }
  | { v: number; t: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { v: number; t: 'pong'; id: number }
  | { v: number; t: 'subscribe'; channel: string }
  | { v: number; t: 'unsubscribe'; channel: string };

/**
 * Method → permission. `null` means the method is free: it either tells the
 * plugin about itself, or it does something the plugin could do anyway inside
 * its own frame.
 *
 * Everything the bridge will dispatch has to appear here. An unknown method is
 * refused rather than passed through, which is what keeps this table the whole
 * truth about what a plugin can reach.
 */
export const METHOD_PERMISSIONS: Record<string, PermissionName | null> = {
  'version': null,
  'ui.title': null,
  'ui.resize': null,
  'ui.notify': 'ui.notify',

  'machine.state': 'machine.read',
  'machine.capabilities': 'machine.read',
  'machine.subscribe': 'machine.read',

  'machine.jog': 'machine.motion',
  'machine.moveTo': 'machine.motion',
  'machine.home': 'machine.motion',
  'machine.goToWorkOrigin': 'machine.motion',

  'machine.send': 'machine.command',
  'machine.runMacro': 'machine.command',
  'machine.setSpindle': 'machine.command',
  'machine.stopSpindle': 'machine.command',
  'machine.setWorkZero': 'machine.command',
  'machine.selectWcs': 'machine.command',

  'files.list': 'files.read',
  'files.read': 'files.read',
  'files.write': 'files.write',
  'files.delete': 'files.write',

  // Storage is checked per domain rather than by a bare name — the domain is
  // the first argument, so the bridge resolves `storage.<domain>` itself.
  'storage.get': null,
  'storage.set': null,
  'storage.delete': null,
  'storage.keys': null,
  'storage.subscribe': null,

  'net.fetch': null, // resolved to `network.<origin>` from the argument
};

/** Methods whose permission depends on an argument rather than the name. */
export const DYNAMIC_PERMISSION = new Set([
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.keys',
  'storage.subscribe',
  'net.fetch',
]);

/** How long a plugin's call may take before the host gives up on it. */
export const CALL_TIMEOUT_MS = 10_000;

/** How often the host checks a frame is still answering. */
export const PING_INTERVAL_MS = 5_000;
