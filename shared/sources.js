/**
 * Unified query layer over the two library databases:
 *
 *   core  (core_library.db)  downloaded release or built from an Otzaria folder; ids from 1
 *   user  (user_library.db)  personal books imported on the device; ids >= USER_ID_BASE
 *
 * A "router" is { sources: [{ name, adapter, idBase, categoryRoot? }], forBook(bookId) }.
 * Every per-book query (reader window, TOC, Quick Jump traversal, commentaries) goes to
 * the one database that owns the book id; library-wide queries (book index, tree, search)
 * run on each database and are merged here. Because the id ranges never overlap, merged
 * results stay unique and keep a stable order (core first, then personal books).
 *
 * Why not ATTACH + UNION ALL views: SQLite cannot push join constraints into a compound
 * view, so a join against such a view materializes the whole `paragraphs` table (EXPLAIN
 * QUERY PLAN: "MATERIALIZE paragraphs"), which is unusable on the full library.
 *
 * Plain adapters ({ all(sql, params) }) are accepted everywhere as a single source, so the
 * Node self-tests and older call sites keep working unchanged.
 */
'use strict';

const { USER_ID_BASE, USER_ROOT_NAME } = require('./indexer');

function isRouter(db) {
  return !!db && Array.isArray(db.sources) && typeof db.forBook === 'function';
}

/** Sources of a router, or a plain adapter as the single source. */
function sourcesOf(db) {
  return isRouter(db) ? db.sources : [{ name: 'main', adapter: db, idBase: 0 }];
}

/** The source owning `bookId`: the one with the largest idBase <= bookId. */
function sourceForId(sources, id) {
  let best = null;
  for (const s of sources) if ((s.idBase || 0) <= id && (!best || (s.idBase || 0) > (best.idBase || 0))) best = s;
  return best;
}

/** Adapter to query one book with (routes on routers, identity on plain adapters). */
function adapterForBook(db, bookId) {
  return isRouter(db) ? db.forBook(bookId) : db;
}

/** Builds a router from sources (sorted by idBase so merged id order is stable). */
function createRouter(sources) {
  const list = sources.filter(Boolean).slice().sort((a, b) => (a.idBase || 0) - (b.idBase || 0));
  const empty = { all: async () => [] };
  return {
    sources: list,
    forBook(bookId) {
      const s = sourceForId(list, Number(bookId));
      return s ? s.adapter : empty;
    },
  };
}

/** Sources that can contain rows of a category path (a folder never spans databases). */
function sourcesForCategory(db, path) {
  const srcs = sourcesOf(db);
  const p = String(path || '').replace(/\/+$/, '');
  const owner = srcs.find((s) => s.categoryRoot && (p === s.categoryRoot || p.startsWith(s.categoryRoot + '/')));
  if (owner) return [owner];
  return srcs.filter((s) => !s.categoryRoot);
}

/**
 * Categories + books of every source (tree / scope picker). Ids are unique across
 * sources. A source with no books contributes no categories (an empty personal library
 * adds no empty folder to the tree).
 */
async function loadCatalog(db) {
  const categories = [];
  const books = [];
  for (const s of sourcesOf(db)) {
    const [cats, bks] = await Promise.all([
      s.adapter.all('SELECT id, parent_id, name, path FROM categories ORDER BY id', []),
      s.adapter.all('SELECT id, category_id, title, aliases, total_lines FROM books ORDER BY id', []),
    ]);
    if (!bks.length) continue;
    for (const c of cats) categories.push({ ...c, source: s.name });
    for (const b of bks) books.push({ ...b, source: s.name });
  }
  return { categories, books };
}

module.exports = { USER_ID_BASE, USER_ROOT_NAME, isRouter, sourcesOf, sourceForId, adapterForBook, createRouter, sourcesForCategory, loadCatalog };
