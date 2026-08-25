// Grants: what the operator agreed to, for which plugin, at which version.
//
// Every path through this file fails towards asking. A stored grant that
// cannot be read, a hash that no longer matches, a permission missing from the
// list: each one ends with the operator being asked again rather than with a
// plugin running on a decision nobody remembers making. The opposite mistake
// — treating an unreadable record as consent — is the one that cannot be seen
// from the outside, because a plugin using a permission looks exactly like a
// plugin that was granted it.

import { signal, type Signal } from '../core/signal.js';
import { loadSetting, saveSetting } from '../core/store.js';
import { permissionsOf } from './manifest.js';
import type { Grant, PermissionName, PluginRecord } from './types.js';

/** The grant dialog's state. `null` when nothing is being asked. */
export interface PendingGrant {
  record: PluginRecord;
  asking: PermissionName[];
  /** Called with true to grant everything asked, false to refuse. */
  answer: (granted: boolean) => void;
}

export const pendingGrant: Signal<PendingGrant | null> = signal<PendingGrant | null>(null);

/**
 * One setting holding every decision, as Record<pluginId, Grant>.
 *
 * One key rather than one per plugin because the Plugins panel wants to show
 * what has been granted to what, and a per-plugin key would mean enumerating
 * localStorage and guessing which of its names are ours.
 */
const SETTING_KEY = 'pluginGrants';

/**
 * Every decision on file, keyed by plugin id.
 *
 * Read through rather than cached: localStorage is shared with the same app
 * open in another tab, and a grant this tab has never seen is still a decision
 * the operator made. The cost is a JSON.parse per plugin start, which is not a
 * loop anyone waits on.
 */
export function loadGrants(): Record<string, Grant> {
  const raw = loadSetting<unknown>(SETTING_KEY, {});
  const grants: Record<string, Grant> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return grants;
  for (const [pluginId, value] of Object.entries(raw as Record<string, unknown>)) {
    const grant = readGrant(pluginId, value);
    if (grant) grants[pluginId] = grant;
  }
  return grants;
}

/**
 * One stored record, or null when it is not one.
 *
 * Anything a person could have typed into localStorage by hand ends up here,
 * so the shape is checked rather than trusted: a `granted` that is not an
 * array would otherwise throw inside `needsPrompt`, and a plugin that fails to
 * start with a TypeError is a plugin whose permission question never gets
 * asked. Dropping the record means asking again, which is the safe direction.
 */
function readGrant(pluginId: string, value: unknown): Grant | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['hash'] !== 'string') return null;
  if (!Array.isArray(raw['granted'])) return null;
  const granted = raw['granted'].filter((p): p is PermissionName => typeof p === 'string');
  return {
    // The key is the identity, not the `pluginId` inside the record: they can
    // only disagree if something rewrote the file, and the key is what every
    // lookup here goes through.
    pluginId,
    hash: raw['hash'],
    granted,
    ...(raw['refused'] === true && { refused: true }),
    at: typeof raw['at'] === 'number' ? raw['at'] : 0,
  };
}

export function grantFor(pluginId: string): Grant | null {
  return loadGrants()[pluginId] ?? null;
}

export function saveGrant(grant: Grant): void {
  const grants = loadGrants();
  grants[grant.pluginId] = grant;
  saveSetting(SETTING_KEY, grants);
}

export function clearGrant(pluginId: string): void {
  const grants = loadGrants();
  if (!(pluginId in grants)) return;
  delete grants[pluginId];
  saveSetting(SETTING_KEY, grants);
}

/**
 * True when the operator has to be asked: no grant yet, the code changed, or
 * this version asks for something the last one did not.
 *
 * A narrower request does NOT re-prompt — the plugin simply gets less. Nor
 * does a new hash on its own: what the operator agreed to is a list of
 * permissions, and a plugin that rewrote its code without asking for anything
 * new is covered by the answer already on file. Re-asking for it would teach
 * the operator that this dialog is noise, and the dialog that matters is the
 * one after that.
 */
export function needsPrompt(record: PluginRecord): boolean {
  const grant = grantFor(record.manifest.id);
  if (!grant) return true;
  // A refusal is a decision too. Asking again at every startup is how somebody
  // learns to click the dialog away, so it stands until the code changes —
  // which is the moment the question is genuinely about something they have
  // not already judged.
  if (grant.refused) return grant.hash !== record.hash;
  return permissionsOf(record.manifest).some((p) => !grant.granted.includes(p));
}

/** What this record actually holds right now. Empty when refused or unasked. */
export function grantedFor(record: PluginRecord): PermissionName[] {
  const grant = grantFor(record.manifest.id);
  if (!grant || grant.refused) return [];
  // The intersection, never either side on its own. A version that no longer
  // asks for machine.command must not keep it because an older one was granted
  // it, and a stored list cannot hand out a permission this manifest does not
  // ask for — which is what stops an edited localStorage from widening a
  // plugin behind the dialog's back.
  return permissionsOf(record.manifest).filter((p) => grant.granted.includes(p));
}

/**
 * Only one dialog at a time.
 *
 * Two plugins starting together — which is what happens at every startup —
 * would otherwise both write `pendingGrant`, and the second would replace the
 * question the operator is in the middle of reading with a different one,
 * under the same two buttons. So asks queue: each waits for the one before it
 * to settle, whichever way it settled.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Ask. Resolves true if every requested permission was granted.
 *
 * All-or-nothing on purpose: half a plugin is a plugin failing in ways its
 * author never saw. A refusal is recorded so the operator is not asked again
 * every time the app starts, and it disables the plugin.
 *
 * The decision is written before the promise settles, so whoever was waiting
 * on the answer can read it back through `grantedFor` rather than being handed
 * one truth by the promise and another by the store.
 */
export function requestGrant(record: PluginRecord): Promise<boolean> {
  // What was on file when the question was raised, so that an answer arriving
  // while this ask sat in the queue can be told from one made long ago.
  const before = grantKey(grantFor(record.manifest.id));
  const run = (): Promise<boolean> => ask(record, before);
  const result = queue.then(run, run);
  // The queue must survive a rejected ask, and must not carry its rejection to
  // an unrelated plugin: it exists to order dialogs, not to chain outcomes.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function ask(record: PluginRecord, before: string): Promise<boolean> {
  // The same plugin can be asked about twice at once — two panels of it
  // mounting on the same page, say. By the time this reaches the front of the
  // queue the answer may already be on file; showing the identical dialog a
  // second time would look like the first one had not registered.
  const stored = grantFor(record.manifest.id);
  if (stored && grantKey(stored) !== before && !needsPrompt(record)) {
    return Promise.resolve(stored.refused !== true);
  }

  const asking = permissionsOf(record.manifest);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const answer = (granted: boolean): void => {
      // A double click on Grant, or a dialog answered after it was superseded,
      // must not write the decision twice or resolve an already-settled ask.
      if (settled) return;
      settled = true;
      saveGrant({
        pluginId: record.manifest.id,
        hash: record.hash,
        granted: granted ? asking : [],
        ...(granted ? {} : { refused: true }),
        at: Date.now(),
      });
      pendingGrant.set(null);
      resolve(granted);
    };
    pendingGrant.set({ record, asking, answer });
  });
}

/**
 * A stored decision as one comparable string.
 *
 * `loadGrants` parses fresh objects every call, so two reads of the same
 * record are never the same object and `===` on them would say "changed" every
 * time.
 */
function grantKey(grant: Grant | null): string {
  if (!grant) return '';
  return JSON.stringify([grant.hash, grant.granted, grant.refused === true, grant.at]);
}
