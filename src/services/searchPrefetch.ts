/**
 * Background prefetch of search-result targets (shared/prefetchCache.js): once a search settles and the UI is
 * idle, the reader windows around the top / visible results (up to PREFETCH_TARGETS) are read one at a time into
 * a small bounded LRU, so tapping one of them opens the reader with zero loading delay (BookReader hydrates from
 * takePrefetched()).
 *
 * The queue never competes with foreground work: a new search, fast scrolling (pause) and opening a book
 * (cancel) stop it before its next read; the cache belongs to one library generation (an install / import
 * clears it).
 */
import type { LibraryRouter } from '../../shared/sources';
import { covers, createLruCache, createPrefetchQueue, findWindow, loadReaderWindow, type PrefetchTarget, type ReaderWindow } from '../../shared/prefetchCache';

let owner: LibraryRouter | null = null;
let ownerGeneration = -1;
const cache = createLruCache<ReaderWindow>();
let current: LibraryRouter | null = null;
const queue = createPrefetchQueue({ cache, load: (t) => (current ? loadReaderWindow(current, t.bookId, t.line) : Promise.resolve(null)) });

/** Test hook (e2e): what the prefetcher holds / did. */
declare global {
  var __KODESHREAD_PREFETCH__: { keys: () => string[]; covered: (bookId: number, line: number) => boolean; stats: typeof queue.stats; hits: number } | undefined;
}
const debug = {
  keys: () => cache.keys(),
  /** A cached window opens this line at once (its own target or a neighbouring one's window). */
  covered: (bookId: number, line: number) => cache.values().some((e) => covers(e, bookId, line)),
  stats: queue.stats,
  hits: 0,
};
globalThis.__KODESHREAD_PREFETCH__ = debug;

/** A new library (generation) invalidates every cached window. */
function own(adapter: LibraryRouter, generation: number) {
  if (owner !== adapter || ownerGeneration !== generation) {
    queue.cancel();
    cache.clear();
    owner = adapter;
    ownerGeneration = generation;
  }
  current = adapter;
}

/** Starts (replaces) a prefetch run for these targets. Low priority: one read at a time. */
export function prefetchTargets(adapter: LibraryRouter, generation: number, targets: PrefetchTarget[]): void {
  own(adapter, generation);
  queue.resume();
  void queue.run(targets).catch(() => undefined);
}

/** A new search / opening a book: stop before the next read. */
export function cancelPrefetch(): void {
  queue.cancel();
}

/** Fast scrolling: hold the queue (resumePrefetch or a new run releases it). */
export function pausePrefetch(): void {
  queue.pause();
}

export function resumePrefetch(): void {
  queue.resume();
}

/** A cached window that opens `line` of `bookId` at once (null if none / another library). */
export function takePrefetched<Row = unknown>(adapter: LibraryRouter, generation: number, bookId: number, line: number): ReaderWindow<Row> | null {
  if (owner !== adapter || ownerGeneration !== generation) return null;
  const hit = findWindow(cache, bookId, line) as ReaderWindow<Row> | null;
  if (hit) debug.hits++;
  return hit;
}
