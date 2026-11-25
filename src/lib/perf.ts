/**
 * Lightweight cold-start timing. Every entry is kept in `globalThis.__KODESHREAD_PERF__` (read by the e2e runs) and, in
 * development builds, printed as `[perf] <tag>: a=1ms b=2ms ...` so the Library cold start can be verified on a device.
 */
type Fields = Record<string, number | string>;

const log: { tag: string; fields: Fields }[] = [];
(globalThis as { __KODESHREAD_PERF__?: unknown }).__KODESHREAD_PERF__ = log;

/** Milliseconds since the JS bundle started (Hermes `performance.now()`), 0 where unavailable. */
export const sinceStart = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? Math.round(performance.now()) : 0);

/** Time of the Library provider's database opening, read by the catalog log of the same launch. */
export const openTimings: { dbOpen: number; bookIndex: number; fts: number; total: number } = { dbOpen: 0, bookIndex: 0, fts: 0, total: 0 };

export function perfLog(tag: string, fields: Fields): void {
  log.push({ tag, fields });
  if (log.length > 50) log.shift();
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(`[perf] ${tag}: ${Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'number' ? `${v}ms` : v}`).join(' ')}`);
  }
}

/**
 * Runs `fn` after the screen that is mounting has painted (next frame, then a macrotask), so deferred cold-start work
 * (writing the catalog cache, building the Quick Jump alias index) never competes with the first render.
 * (React Native 0.88 no longer exports InteractionManager.)
 */
export function runAfterRender(fn: () => void): void {
  const go = () => setTimeout(fn, 0);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
  else go();
}
