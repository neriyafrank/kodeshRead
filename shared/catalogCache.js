/**
 * Persistent cache of the canonical library catalog (pure JS, storage injected): pairing the whole library and
 * building + collating the trees (shared/libraryCatalog.js) costs ~1s on a desktop and several seconds on a phone, but
 * its result only depends on WHICH books are installed. The first launch builds it and stores the snapshot; every
 * later launch with the same library restores it in a few milliseconds.
 *
 * The key is `catalogCacheKey(...)`: the catalog logic version, the installed stages (core / extended versions) and,
 * per library source, cheap statistics of its books / categories (row count + max id for the immutable downloaded
 * stages; plus id / title checksums for the mutable personal + starter databases). Any difference (a core -> core +
 * extended install, an import, a deleted book, a new core build) is a different key, so a stale snapshot is never
 * served. A missing, unreadable, truncated or foreign cache is simply a miss.
 */
'use strict';

const { sourcesOf } = require('./sources');
const { CATALOG_VERSION, buildLibraryCatalogAsync, catalogFromSnapshot } = require('./libraryCatalog');
const { loadCatalog } = require('./sources');

const CACHE_FORMAT = 1;
/** Sources whose rows change without a new build version (imports, starter downloads): checksummed. */
const MUTABLE_SOURCES = new Set(['user', 'starter']);

/**
 * Statistics of every source's books and categories: a few indexed aggregates, never a full-column read.
 * @param {{ all: Function }} db  router or plain adapter
 */
async function sourceStats(db) {
  const out = [];
  for (const s of sourcesOf(db)) {
    const deep = MUTABLE_SOURCES.has(s.name) || !!s.categoryRoot;
    const [b] = await s.adapter.all(
      deep
        ? 'SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m, COALESCE(SUM(id), 0) AS a, COALESCE(SUM(category_id), 0) AS c, COALESCE(SUM(LENGTH(title)), 0) AS t FROM books'
        : 'SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM books',
      [],
    );
    const [c] = await s.adapter.all(deep ? 'SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS a, COALESCE(SUM(LENGTH(path)), 0) AS p FROM categories' : 'SELECT COUNT(*) AS n FROM categories', []);
    out.push([s.name, s.idBase || 0, b.n, b.m, b.a ?? 0, b.c ?? 0, b.t ?? 0, c.n, c.a ?? 0, c.p ?? 0].join(':'));
  }
  return out;
}

/** `stages`: e.g. "core=2025.1|extended=2025.1" (the installed library versions). */
async function catalogCacheKey(db, stages) {
  return ['kr-catalog', CACHE_FORMAT, CATALOG_VERSION, stages || '', ...(await sourceStats(db))].join('|');
}

/**
 * Restores the catalog stored under `key`, or null (miss: nothing stored, another key, bad JSON, wrong shape).
 * @param {{ read: () => Promise<string | null>, write: (text: string) => Promise<void> }} store
 */
async function readCatalogCache(store, key) {
  let text;
  try {
    text = await store.read();
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.format !== CACHE_FORMAT || parsed.key !== key) return null;
    return catalogFromSnapshot(parsed.snapshot);
  } catch {
    return null;
  }
}

async function writeCatalogCache(store, key, catalog) {
  await store.write(JSON.stringify({ format: CACHE_FORMAT, key, snapshot: catalog.toSnapshot() }));
}

/**
 * The catalog of the installed library: from the cache when its key matches, else built (cooperatively, `pause`) and stored.
 * `onTiming` receives { cache: 'hit' | 'miss' | 'off', keyMs, readMs, queryMs, buildMs, totalMs }.
 * Storing happens through `schedule(fn)` (default: immediately) so the caller can defer the write past the first render.
 */
async function loadCatalogCached(db, { stages = '', store = null, pause, now = Date.now, onTiming, schedule = (fn) => fn() } = {}) {
  const t0 = now();
  const timing = { cache: store ? 'miss' : 'off', keyMs: 0, readMs: 0, queryMs: 0, buildMs: 0, totalMs: 0 };
  let key = null;
  if (store) {
    key = await catalogCacheKey(db, stages);
    timing.keyMs = now() - t0;
    const t1 = now();
    const hit = await readCatalogCache(store, key);
    timing.readMs = now() - t1;
    if (hit) {
      timing.cache = 'hit';
      timing.totalMs = now() - t0;
      if (onTiming) onTiming(timing);
      return hit;
    }
  }
  const t2 = now();
  const data = await loadCatalog(db);
  timing.queryMs = now() - t2;
  const t3 = now();
  const catalog = await buildLibraryCatalogAsync(data, pause);
  timing.buildMs = now() - t3;
  timing.totalMs = now() - t0;
  if (onTiming) onTiming(timing);
  if (store) schedule(() => writeCatalogCache(store, key, catalog).catch(() => undefined));
  return catalog;
}

module.exports = { CACHE_FORMAT, catalogCacheKey, sourceStats, readCatalogCache, writeCatalogCache, loadCatalogCached };
