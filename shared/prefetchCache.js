/**
 * Background prefetch of search-result targets (pure JS, io injected; shared by src/services/searchPrefetch.ts
 * and scripts/selftest.js).
 *
 *   createLruCache({ maxEntries, maxChars })  small bounded LRU of reader windows: least recently used entries
 *       are evicted beyond `maxEntries` or when the windows' text exceeds `maxChars` (RAM bound).
 *   createPrefetchQueue({ load, cache })       a low-priority, strictly sequential queue (one SQLite read at a
 *       time, a gap between reads so foreground queries are never queued behind it): run(targets) replaces the
 *       previous run, cancel() stops it before its next read, pause() / resume() hold it (fast scrolling).
 *   loadReaderWindow(db, bookId, line)        the rows a reader needs to open `line` without a query: a small
 *       window (PREFETCH_BEFORE lines above, PREFETCH_AFTER below) + link counts + the book's line count.
 *   findWindow(cache, bookId, line)            a cached window that can open `line` at once (enough context on
 *       both sides, or the book edge).
 */
'use strict';

/** Results prefetched per settled search. */
const PREFETCH_TARGETS = 8;
/** Window lines kept per target (the reader extends it as usual while scrolling). */
const PREFETCH_BEFORE = 40;
const PREFETCH_AFTER = 80;
/** A cached window opens `line` only with this much context on each side (unless at the book edge). */
const MIN_CONTEXT = 8;
/** Bounds of the shared cache. */
const MAX_ENTRIES = 8;
const MAX_CHARS = 1500000;

const sizeOf = (entry) => (entry && entry.rows ? entry.rows.reduce((n, r) => n + String(r.display_text || '').length + 32, 0) : 0);

/** Bounded LRU (Map insertion order = recency). */
function createLruCache(opts) {
  const maxEntries = Math.max(1, (opts && opts.maxEntries) || MAX_ENTRIES);
  const maxChars = Math.max(1, (opts && opts.maxChars) || MAX_CHARS);
  const map = new Map();
  let chars = 0;
  const drop = (k) => {
    const e = map.get(k);
    if (!e) return;
    chars -= e.size;
    map.delete(k);
  };
  return {
    get(k) {
      const e = map.get(k);
      if (!e) return undefined;
      map.delete(k);
      map.set(k, e); // most recent
      return e.value;
    },
    peek: (k) => (map.has(k) ? map.get(k).value : undefined),
    has: (k) => map.has(k),
    set(k, value) {
      drop(k);
      const size = sizeOf(value);
      if (size > maxChars) return false; // never cache a window larger than the whole budget
      map.set(k, { value, size });
      chars += size;
      while (map.size > maxEntries || chars > maxChars) drop(map.keys().next().value);
      return true;
    },
    delete: (k) => drop(k),
    clear() {
      map.clear();
      chars = 0;
    },
    keys: () => [...map.keys()],
    values: () => [...map.values()].map((e) => e.value),
    get size() {
      return map.size;
    },
    get chars() {
      return chars;
    },
  };
}

const keyOf = (bookId, line) => `${bookId}:${line}`;

/** Line range of a prefetched window around `line` (clamped to the book). */
function prefetchRange(line, totalLines) {
  const total = Math.max(1, totalLines | 0);
  const t = Math.min(Math.max(1, line | 0), total);
  return { from: Math.max(1, t - PREFETCH_BEFORE), to: Math.min(total, t + PREFETCH_AFTER) };
}

/** Can a cached window open `line` at once? */
function covers(entry, bookId, line) {
  if (!entry || entry.bookId !== bookId || !entry.rows || !entry.rows.length) return false;
  const { from, to } = entry.range;
  if (line < from || line > to) return false;
  const above = from <= 1 || line - from >= MIN_CONTEXT;
  const below = to >= entry.total || to - line >= MIN_CONTEXT;
  return above && below;
}

/** A cached window for (bookId, line): the exact target first, then any window of the book covering it. */
function findWindow(cache, bookId, line) {
  const exact = cache.peek(keyOf(bookId, line));
  if (covers(exact, bookId, line)) return cache.get(keyOf(bookId, line));
  for (const k of cache.keys()) {
    const e = cache.peek(k);
    if (covers(e, bookId, line)) return cache.get(k);
  }
  return null;
}

/**
 * Loads the reader window of one target. `db` is a router / adapter; uses the same queries as the reader
 * (shared/reader.js fetchRange + shared/commentary.js link counts).
 */
async function loadReaderWindow(db, bookId, line) {
  const { fetchRange } = require('./reader');
  const { fetchLinkCounts, attachLinkCounts } = require('./commentary');
  const { adapterForBook } = require('./sources');
  const [book] = await adapterForBook(db, bookId).all('SELECT total_lines FROM books WHERE id = ?', [bookId]);
  if (!book) return null;
  const total = Number(book.total_lines) || 1;
  const range = prefetchRange(line, total);
  const [rows, counts] = await Promise.all([fetchRange(db, bookId, range.from, range.to), fetchLinkCounts(db, bookId, range.from, range.to)]);
  return { bookId, line, total, range, rows: attachLinkCounts(rows, counts), at: Date.now() };
}

/**
 * Sequential low-priority prefetch queue.
 * @param {{ load: (t: { bookId: number, line: number }) => Promise<object | null>, cache: ReturnType<typeof createLruCache>,
 *           gapMs?: number, maxTargets?: number, sleep?: (ms: number) => Promise<void> }} opts
 */
function createPrefetchQueue(opts) {
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const gapMs = opts.gapMs == null ? 40 : opts.gapMs;
  const maxTargets = opts.maxTargets || PREFETCH_TARGETS;
  let run = 0;
  let paused = false;
  let wake = null;
  let active = false;
  const stats = { loaded: 0, skipped: 0, cancelled: 0, failed: 0 };
  const waitWhilePaused = async (id) => {
    while (paused && id === run) await new Promise((r) => (wake = r));
  };
  const release = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  return {
    /**
     * Prefetches `targets` (first `maxTargets`, duplicates and cached ones skipped). A new run replaces the previous one.
     * Resolves to { loaded, skipped, cancelled } of this run.
     */
    async run(targets) {
      const id = ++run;
      release();
      const seen = new Set();
      const list = [];
      for (const t of targets || []) {
        const k = keyOf(t.bookId, t.line);
        if (seen.has(k)) continue;
        seen.add(k);
        list.push(t);
        if (list.length >= maxTargets) break;
      }
      const out = { loaded: 0, skipped: 0, cancelled: false };
      active = true;
      try {
        for (const t of list) {
          await waitWhilePaused(id);
          if (id !== run) return (stats.cancelled++, { ...out, cancelled: true });
          if (findWindow(opts.cache, t.bookId, t.line)) {
            out.skipped++;
            stats.skipped++;
            continue;
          }
          let entry = null;
          try {
            entry = await opts.load(t);
          } catch {
            stats.failed++;
          }
          if (id !== run) return (stats.cancelled++, { ...out, cancelled: true });
          if (entry) {
            opts.cache.set(keyOf(t.bookId, t.line), entry);
            out.loaded++;
            stats.loaded++;
          }
          if (gapMs) await sleep(gapMs);
        }
        return out;
      } finally {
        if (id === run) active = false;
      }
    },
    /** Stops the current run before its next read (an in-flight read still lands in the cache). */
    cancel() {
      run++;
      active = false;
      release();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      release();
    },
    isPaused: () => paused,
    isActive: () => active,
    stats,
  };
}

module.exports = {
  PREFETCH_TARGETS,
  PREFETCH_BEFORE,
  PREFETCH_AFTER,
  MIN_CONTEXT,
  MAX_ENTRIES,
  MAX_CHARS,
  createLruCache,
  prefetchRange,
  covers,
  findWindow,
  loadReaderWindow,
  createPrefetchQueue,
  keyOf,
};
