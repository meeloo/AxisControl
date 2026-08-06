// Reading config.g and everything it runs, in the order it runs them.

import { OVERRIDE_FILE, parseConfig, type ConfigFile } from './parse.js';
import type { MachineDriver } from '../machine/driver.js';

/** Where a relative M98 path is resolved from. */
const SYS = '/sys';

/** An M98 P path as an absolute one. Exported so the checker resolves it identically. */
export function resolveInclude(path: string): string {
  const bare = path.replace(/^"|"$/g, '');
  if (bare.startsWith('/')) return bare;
  return `${SYS}/${bare}`;
}

export interface LoadedConfig {
  files: ConfigFile[];
  /** Files named by an M98 that could not be read, with the reason. */
  missing: Array<{ path: string; reason: string }>;
}

/**
 * Load the configuration as a flat list in execution order.
 *
 * Depth-first, because that is what M98 does: config.g stops at the M98, runs
 * the whole of the named file, and carries on. A checker that read the files in
 * any other order would report the wrong thing about which line overwrites
 * which.
 *
 * A file is read once however often it is called. Running it twice is legal and
 * rare; showing its contents twice would be noise, and the second run cannot
 * change what the parser says about the text.
 */
export async function loadConfig(
  driver: MachineDriver,
  entry = '/sys/config.g',
): Promise<LoadedConfig> {
  const files: ConfigFile[] = [];
  const missing: LoadedConfig['missing'] = [];
  const seen = new Set<string>();

  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 8 || seen.has(path)) return;
    seen.add(path);
    let text: string;
    try {
      const bytes = await driver.readFile(path);
      text = new TextDecoder().decode(bytes);
    } catch (err) {
      // config-override.g not existing is the normal state of a machine whose
      // values have never been saved with M500, so its absence is not news.
      if (!path.endsWith(OVERRIDE_FILE)) missing.push({ path, reason: (err as Error).message });
      return;
    }
    const file = parseConfig(path, text);
    files.push(file);
    for (const include of file.includes) {
      await visit(resolveInclude(include), depth + 1);
    }
  };

  await visit(entry, 0);
  return { files, missing };
}
