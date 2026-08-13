export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** RRF wants local wall-clock time as YYYY-MM-DDTHH:mm:ss (no timezone suffix). */
export function rrfTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  // Cards are sold in gigabytes and it stopped here, so an 8GB card read as
  // "7629.4 MiB" — a number nobody can compare against the one on the label.
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

/** Fixed-width number for DRO readouts; keeps the sign column stable. */
export function fixed(v: number | null | undefined, places = 3): string {
  if (v == null || !isFinite(v)) return '—';
  const s = v.toFixed(places);
  // Avoid rendering "-0.000"
  return s === `-${(0).toFixed(places)}` ? (0).toFixed(places) : s;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Join a directory and name into a controller-absolute path. */
export function joinPath(dir: string, name: string): string {
  const d = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return `${d}/${name}`;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * A controller address with a scheme on it, ready to build URLs against.
 *
 * Typing `192.168.1.9` or `sebscnc.local` into the address box is the normal
 * thing to do, and it worked — for connecting. The RepRapFirmware client
 * prepended `http://` privately before it built any request, so the connection,
 * the polling and every upload went to the right place, and the raw string the
 * operator typed was what got saved and published to the rest of the app.
 *
 * Everything that builds a URL from that string rather than making a request
 * with it then got a base with no scheme. `new URL('build.json', '192.168.1.9/
 * AxisControl/')` does not throw a useful error, it throws TypeError — and the
 * Install panel, which reads its own manifest back off the machine to confirm
 * the copy landed, reported that as the machine refusing to serve the files it
 * had just accepted. Uploads worked; only the reading back failed; and the
 * message blamed the SD card.
 *
 * So it is normalised once, where the address is stored, and every consumer
 * gets a string that `new URL` accepts. Idempotent, so applying it twice is
 * harmless — the client still calls it too, since a driver should not depend on
 * having been handed tidy input.
 */
export function normaliseControllerUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}
