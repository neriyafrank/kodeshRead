#!/usr/bin/env node
/**
 * Splits a finished full library (build-db.js --scope=all) into two DISJOINT databases:
 *
 *   core_library.db       ספריית יסוד        shared/coreLibrary.js selectCoreBooks(): the foundational texts + primary commentators
 *   extended_library.db   הרחבה לספרייה מלאה  every other book (ids of every table shifted by EXTENDED_ID_BASE)
 *
 *   node scripts/split-library.js --db=full.db --core-out=core_library.db --extended-out=extended_library.db [--stats=split.json]
 *
 * Each output has the complete schema with its own FTS5 index and meta (`part` = core | extended, the same
 * `db_version` as the full build). Rows follow their book: a `ref_links` row (commentary <-> base units) lives in
 * the database of its COMMENTARY book and may point at a base book of the other database (the app consults every
 * installed database, shared/commentary.js); explicit `links` rows live with their book_a. Nothing is merged on the device.
 * Node built-ins only (node:sqlite).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const indexer = require('../shared/indexer');
const coreLibrary = require('../shared/coreLibrary');
const { openDb, writerAdapter } = require('./build-db');

const rm = (f) => {
  for (const x of [f, f + '-journal', f + '-wal', f + '-shm']) if (fs.existsSync(x)) fs.unlinkSync(x);
};

function readFull(file) {
  const db = openDb(file);
  try {
    const books = db
      .prepare('SELECT b.id AS id, b.title AS title, b.aliases AS aliases, b.file_path AS filePath, c.path AS categoryPath FROM books b LEFT JOIN categories c ON c.id = b.category_id ORDER BY b.id')
      .all()
      .map((b) => ({ id: b.id, title: b.title, aliases: String(b.aliases || '').split('|').filter(Boolean), filePath: b.filePath, categoryPath: b.categoryPath || '' }));
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    const hasRefLinks = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'ref_links'").all().length > 0;
    return { books, meta, hasRefLinks };
  } finally {
    db.close();
  }
}

async function buildPart({ part, fullFile, outFile, ids, extIds, full }) {
  const EXT = coreLibrary.EXTENDED_ID_BASE;
  const off = part === 'extended' ? EXT : 0;
  const tmp = outFile + '.tmp';
  rm(tmp);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const raw = openDb(tmp);
  raw.exec('PRAGMA page_size = 4096; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;');
  const db = writerAdapter(raw);
  await indexer.ensureSchema(db, { kind: part });
  raw.prepare('ATTACH DATABASE ? AS src').run(path.resolve(fullFile));
  raw.exec('CREATE TEMP TABLE mine (id INTEGER PRIMARY KEY); CREATE TEMP TABLE ext_ids (id INTEGER PRIMARY KEY);');
  const ins = (table, list) => {
    const st = raw.prepare(`INSERT INTO ${table} (id) VALUES (?)`);
    raw.exec('BEGIN');
    for (const id of list) st.run(id);
    raw.exec('COMMIT');
  };
  ins('mine', ids);
  ins('ext_ids', extIds);
  // An id as stored: books of the extended database are shifted, a partner book of the other database keeps its own
  // database's id (core ids as built, extended ids shifted).
  const m = (x) => `(CASE WHEN ${x} IN (SELECT id FROM ext_ids) THEN ${x} + ${EXT} ELSE ${x} END)`;
  raw.exec('BEGIN');
  raw.exec(`
    WITH RECURSIVE need(id) AS (
      SELECT DISTINCT category_id FROM src.books WHERE id IN mine AND category_id IS NOT NULL
      UNION
      SELECT c.parent_id FROM src.categories c JOIN need ON c.id = need.id WHERE c.parent_id IS NOT NULL)
    INSERT INTO categories (id, parent_id, name, path)
      SELECT id + ${off}, parent_id + ${off}, name, path FROM src.categories WHERE id IN need;
    INSERT INTO books (id, category_id, title, aliases, file_path, total_lines, is_complete)
      SELECT id + ${off}, category_id + ${off}, title, aliases, file_path, total_lines, 1 FROM src.books WHERE id IN mine;
    INSERT INTO toc_nodes (id, book_id, parent_id, level, title, ref_key, start_line)
      SELECT id + ${off}, book_id + ${off}, parent_id + ${off}, level, title, ref_key, start_line FROM src.toc_nodes WHERE book_id IN mine;
    INSERT INTO paragraphs (id, book_id, line_index, toc_path, display_text, clean_text, is_heading)
      SELECT id + ${off}, book_id + ${off}, line_index, toc_path, display_text, clean_text, is_heading FROM src.paragraphs WHERE book_id IN mine;
    INSERT INTO links (book_a_id, line_a, book_b_id, line_b, link_type)
      SELECT ${m('book_a_id')}, line_a, ${m('book_b_id')}, line_b, link_type FROM src.links WHERE book_a_id IN mine;`);
  if (full.hasRefLinks) {
    raw.exec(`
    INSERT INTO ref_links (base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key, link_type)
      SELECT ${m('base_book_id')}, base_start, base_end, ${m('comm_book_id')}, comm_start, comm_end, ref_key, link_type FROM src.ref_links WHERE comm_book_id IN mine;`);
  }
  raw.exec('COMMIT');
  raw.exec('DETACH DATABASE src');
  // Each database gets its OWN FTS5 index (external content over its own paragraphs).
  if (raw.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'paragraphs_fts'").all().length) raw.exec("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('rebuild')");
  await indexer.finalizeIndex(db, { analyze: true });
  const counts = await indexer.libraryCounts(db);
  await indexer.writeMeta(db, {
    kind: part,
    part,
    db_version: full.meta.db_version,
    built_at: full.meta.built_at,
    source: full.meta.source || '',
    script_version: indexer.SCHEMA_VERSION,
    scope: part,
    ...(part === 'extended' ? { extended_id_base: EXT } : {}),
    books: counts.books,
    categories: counts.categories,
    paragraphs: counts.paragraphs,
    links: counts.links,
    toc_nodes: counts.tocNodes,
  });
  raw.exec('DELETE FROM book_units; DELETE FROM import_queue;');
  raw.exec('PRAGMA optimize; VACUUM;');
  raw.close();
  rm(outFile);
  fs.renameSync(tmp, outFile);
  return { part, file: outFile, bytes: fs.statSync(outFile).size, ...counts };
}

/**
 * @param {{ fullDb: string, coreOut: string, extendedOut: string }} o
 * @returns {Promise<{ core: object, extended: object, overlap: number, version: string }>}
 */
async function splitLibrary(o) {
  const full = readFull(o.fullDb);
  if (!full.meta.db_version) throw new Error('the full library has no meta.db_version');
  const sel = coreLibrary.selectCoreBooks(full.books);
  const coreIds = [...sel.ids].sort((a, b) => a - b);
  const extIds = full.books.map((b) => b.id).filter((id) => !sel.ids.has(id));
  if (!coreIds.length) throw new Error('no core books were selected: is this the full Otzaria library?');
  if (full.books.some((b) => b.id >= coreLibrary.EXTENDED_ID_BASE)) throw new Error('the library already uses ids >= EXTENDED_ID_BASE');
  const core = await buildPart({ part: 'core', fullFile: o.fullDb, outFile: o.coreOut, ids: coreIds, extIds, full });
  const extended = await buildPart({ part: 'extended', fullFile: o.fullDb, outFile: o.extendedOut, ids: extIds, extIds, full });
  const paths = (file) => {
    const db = openDb(file);
    try {
      return new Set(db.prepare('SELECT file_path FROM books').all().map((r) => r.file_path));
    } finally {
      db.close();
    }
  };
  const a = paths(o.coreOut);
  const overlap = [...paths(o.extendedOut)].filter((p) => a.has(p)).length;
  if (overlap) throw new Error(`core and extended share ${overlap} book(s)`);
  if (core.books + extended.books !== full.books.length) throw new Error(`split lost books: ${core.books} + ${extended.books} != ${full.books.length}`);
  return { core, extended, overlap, version: full.meta.db_version, fullBooks: full.books.length };
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => /^--([^=]+)=(.*)$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (!args.db || !args['core-out'] || !args['extended-out']) {
    console.error('usage: split-library.js --db=<full.db> --core-out=<core_library.db> --extended-out=<extended_library.db> [--stats=<json>]');
    process.exit(2);
  }
  splitLibrary({ fullDb: path.resolve(args.db), coreOut: path.resolve(args['core-out']), extendedOut: path.resolve(args['extended-out']) }).then(
    (r) => {
      const mb = (n) => (n / 1048576).toFixed(0);
      console.log(`[split-library] core: ${r.core.books} books, ${r.core.paragraphs} paragraphs, ${mb(r.core.bytes)} MB`);
      console.log(`[split-library] extended: ${r.extended.books} books, ${r.extended.paragraphs} paragraphs, ${mb(r.extended.bytes)} MB (no overlap)`);
      if (args.stats) fs.writeFileSync(path.resolve(args.stats), JSON.stringify(r, null, 2) + '\n');
    },
    (e) => {
      console.error('[split-library] FAILED:', e.message);
      process.exit(1);
    },
  );
}

module.exports = { splitLibrary };
