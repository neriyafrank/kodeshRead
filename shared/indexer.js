/**
 * Otzaria ingestion engine, shared by the PC build script (scripts/build-db.js, node:sqlite)
 * and the on-device indexer (src/services/localIndexer.ts, expo-sqlite + expo-file-system).
 *
 * Everything platform-specific goes through two tiny async adapters:
 *
 *   fs: { list(dir) -> Promise<{ name, isDir, handle }[]>, readText(handle) -> Promise<string> }
 *   db: { exec(sql), run(sql, params), all(sql, params) -> Promise<row[]> }
 *
 * so the parsing rules, Hebrew normalization, alias generation, ref keys, link matching
 * and the SQL that writes them are identical on both sides.
 *
 * ID namespaces: the core library uses ids from 1; the personal (user) library uses
 * ids above USER_ID_BASE for categories, books, toc_nodes and paragraphs, so rows of
 * both databases can be merged in the app without ever colliding.
 */
'use strict';

const { normalizeHebrew, extractRefKey, generateBookAliases, aliasKey, decodeEntities, stripHtml } = require('./hebrew');
const refAlign = require('./refAlign');
const { createLineSplitter } = require('./bookStream');

/**
 * Bump when the schema or the parsing rules change (stored in meta.script_version).
 * 3: books.is_complete + ingestion_state / ingestion_errors (resumable imports). Readers never
 *    depend on them, so version-2 libraries stay fully usable.
 * 6: book_units (heading units persisted in the books phase, read back one book at a time by
 *    the links phase) + import_queue (SQLite-backed BFS scan queue of a streaming import) +
 *    ingestion_state.skipped_count / scanned_dirs / links_done / links_total. Readers ignore
 *    all of them, so v5 libraries stay fully usable (migrateSchema adds them to writable DBs).
 */
const SCHEMA_VERSION = 6;
/** First id of the personal library's namespace (core ids stay below it). */
const USER_ID_BASE = 1000000000;
/** First id of the optional extended database (shared/coreLibrary.js); core ids stay below it. */
const EXTENDED_ID_BASE = 500000000;
/** Root folder of the personal library in the merged tree. */
const USER_ROOT_NAME = 'הספרים שלי';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,
  path TEXT UNIQUE NOT NULL
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id),
  title TEXT NOT NULL,
  aliases TEXT NOT NULL,
  file_path TEXT UNIQUE NOT NULL,
  total_lines INTEGER NOT NULL,
  -- 0 while the book's rows are being written; a resumed import redoes such books.
  is_complete INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE toc_nodes (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id),
  parent_id INTEGER REFERENCES toc_nodes(id),
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  start_line INTEGER NOT NULL
);
CREATE INDEX idx_toc_book_parent_ref ON toc_nodes(book_id, parent_id, ref_key);

CREATE TABLE paragraphs (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id),
  line_index INTEGER NOT NULL,
  toc_path TEXT,
  display_text TEXT NOT NULL,
  clean_text TEXT NOT NULL,
  is_heading INTEGER DEFAULT 0
);
CREATE INDEX idx_paragraphs_book_line ON paragraphs(book_id, line_index);

-- FTS5 external-content source. paragraphs has no category_path column (storing
-- it per row would bloat the full library by ~100MB), so FTS reads it through
-- this view. category_path always ends with "/" so a folder filter is simply
-- category_path LIKE 'folder/%' (matches the folder and all its sub-folders).
CREATE VIEW paragraphs_fts_source AS
  SELECT p.id AS id, p.clean_text AS clean_text, p.book_id AS book_id,
         COALESCE(c.path || '/', '') AS category_path, p.line_index AS line_index
  FROM paragraphs p
  JOIN books b ON b.id = p.book_id
  LEFT JOIN categories c ON c.id = b.category_id;

CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
  clean_text,
  book_id UNINDEXED,
  category_path UNINDEXED,
  line_index UNINDEXED,
  content='paragraphs_fts_source',
  content_rowid='id'
);

CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  book_a_id INTEGER NOT NULL,
  line_a INTEGER NOT NULL,
  book_b_id INTEGER NOT NULL,
  line_b INTEGER NOT NULL,
  link_type TEXT
);
CREATE INDEX idx_links_a ON links(book_a_id, line_a);
CREATE INDEX idx_links_b ON links(book_b_id, line_b);
` + '\n';

/**
 * Otzaria reference alignment (schema v4): a commentary unit (all lines under e.g.
 * "פרק א" > "פסוק א") linked to the base book's unit with the same canonical ref_key
 * ("פרק א|פסוק א"), as two line ranges. Built in the links phase (shared/refAlign.js);
 * looked up by a line on either side with an index seek (shared/commentary.js).
 */
const REF_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ref_links (
  id INTEGER PRIMARY KEY,
  base_book_id INTEGER NOT NULL,
  base_start INTEGER NOT NULL,
  base_end INTEGER NOT NULL,
  comm_book_id INTEGER NOT NULL,
  comm_start INTEGER NOT NULL,
  comm_end INTEGER NOT NULL,
  ref_key TEXT NOT NULL,
  link_type TEXT
);
-- (book, partner book, start, end): "the innermost unit of partner P covering line L" is an
-- index-only backward walk from L that stops at the first unit whose end >= L (a seif note, else
-- its siman's note), and a book's partners are enumerated with a skip-scan. (v5; v4 had no end.)
CREATE INDEX IF NOT EXISTS idx_ref_links_base_v5 ON ref_links(base_book_id, comm_book_id, base_start, base_end);
CREATE INDEX IF NOT EXISTS idx_ref_links_comm_v5 ON ref_links(comm_book_id, base_book_id, comm_start, comm_end);
`;

/**
 * Checkpoint tables of a resumable import (one import per database at a time, row id = 1).
 * Written in the same transaction as the books they describe, so after a crash the state
 * always matches what is on disk. Applied to older databases by migrateSchema().
 */
const INGESTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS ingestion_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_uri TEXT NOT NULL,
  source_name TEXT,
  source_kind TEXT NOT NULL DEFAULT 'folder',
  target_db TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'books',
  processed_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  base_book_id INTEGER NOT NULL DEFAULT 0,
  last_book_path TEXT,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  scanned_dirs INTEGER NOT NULL DEFAULT 0,
  links_done INTEGER NOT NULL DEFAULT 0,
  links_total INTEGER NOT NULL DEFAULT 0,
  inflight_key TEXT,
  inflight_attempts INTEGER NOT NULL DEFAULT 0,
  finalize_step TEXT,
  last_error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingestion_errors (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  message TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

/**
 * Heading units of every book (schema v6), written in the books phase in the same transaction as
 * the book: one row per TOC node that has a canonical reference (refAlign.bookUnits):
 *   ref_key        canonical path "פרק א|פסוק א" (labels are recovered with refAlign.labelsFromRefKey)
 *   depth          number of labels in ref_key
 *   start_line     line of the heading
 *   end_line       last line of the unit's subtree (before the next heading of the same / higher level)
 *   own_end        last line of the unit's own text (before the next heading of any level)
 *   heading_label  the plain heading ("סימן א", "מסכת ברכות")
 * The links phase aligns commentaries from these rows (one book at a time) instead of re-reading
 * TOCs or texts, so no book is ever held in memory beyond the pair being aligned.
 */
const BOOK_UNITS_SCHEMA = `
CREATE TABLE IF NOT EXISTS book_units (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL,
  ref_key TEXT NOT NULL,
  depth INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  own_end INTEGER NOT NULL,
  heading_label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_units_book ON book_units(book_id, start_line);
`;

/**
 * Streaming import queue (schema v6, shared/pipeline.js): the scan phase walks the source folder
 * breadth-first, one folder per transaction, persisting every sub-folder and book file it finds
 * instead of collecting thousands of URIs in a JS array. sort_key ("00003.00012") reproduces the
 * depth-first, canonically sorted order of scanBooks(), so books get the same ids / tree order.
 * A row is marked done / failed in the same transaction that writes its book, so a killed import
 * resumes at the exact next row.
 */
const IMPORT_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS import_queue (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  rel TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  book_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_queue_rel ON import_queue(kind, rel);
CREATE INDEX IF NOT EXISTS idx_import_queue_next ON import_queue(kind, status, sort_key);
`;

/**
 * ingestion_state columns added after v3 (name -> DDL), applied by migrateSchema().
 * inflight_key / inflight_attempts: the unit of work (a book, a links batch) that is running,
 * committed before it starts; a unit still in flight after repeated kills is skipped on resume
 * (crash-loop protection, shared/pipeline.js).
 */
const INGESTION_COLUMNS = {
  skipped_count: 'INTEGER NOT NULL DEFAULT 0',
  scanned_dirs: 'INTEGER NOT NULL DEFAULT 0',
  links_done: 'INTEGER NOT NULL DEFAULT 0',
  links_total: 'INTEGER NOT NULL DEFAULT 0',
  inflight_key: 'TEXT',
  inflight_attempts: 'INTEGER NOT NULL DEFAULT 0',
  // Finalize sub-progress of an on-device core build ('index' / 'meta', see shared/coreFinalize.js)
  // and the "step · message" diagnostic of its last failure.
  finalize_step: 'TEXT',
  last_error: 'TEXT',
};

const FTS_TABLE_RE = /CREATE VIRTUAL TABLE paragraphs_fts[\s\S]*?\);\n/;

async function sqliteHasFts5(db) {
  try {
    return (await db.all("SELECT 1 AS ok FROM pragma_module_list WHERE name = 'fts5'", [])).length > 0;
  } catch {
    return false;
  }
}

/**
 * Creates the schema (and meta rows) if the database is empty. Returns true when created.
 * On a SQLite build without FTS5 (only the web preview) the FTS table is left out; search
 * then uses the LIKE fallback.
 */
async function ensureSchema(db, opts) {
  const kind = (opts && opts.kind) || 'core';
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'", []);
  if (rows.length) {
    // Cold start: a database created by this schema version needs no migration (no DDL / write lock on every launch).
    const v = await db.all("SELECT value FROM meta WHERE key = 'script_version'", []).catch(() => []);
    if (!(v[0] && Number(v[0].value) === SCHEMA_VERSION)) await migrateSchema(db);
    return false;
  }
  const ddl = ((await sqliteHasFts5(db)) ? SCHEMA : SCHEMA.replace(FTS_TABLE_RE, '')) + REF_LINKS_SCHEMA + INGESTION_SCHEMA + BOOK_UNITS_SCHEMA + IMPORT_QUEUE_SCHEMA;
  // DDL is transactional in SQLite: a failure never leaves a half-created schema behind.
  await db.exec('BEGIN');
  try {
    await db.exec(ddl);
    await db.run('INSERT INTO meta (key, value) VALUES (?, ?), (?, ?)', ['kind', kind, 'script_version', String(SCHEMA_VERSION)]);
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return true;
}

/**
 * Brings a writable library created by an older version up to the current schema
 * (adds books.is_complete, the ingestion tables, ref_links, book_units and import_queue).
 * Idempotent and cheap. Books indexed before v6 have no book_units rows: the links phase then
 * derives their units from toc_nodes (see loadBookUnits).
 */
async function migrateSchema(db) {
  const cols = await db.all('PRAGMA table_info(books)', []);
  if (cols.length && !cols.some((c) => c.name === 'is_complete')) {
    await db.exec('ALTER TABLE books ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 1');
  }
  await db.exec(INGESTION_SCHEMA);
  // Newer checkpoint columns (CREATE TABLE IF NOT EXISTS keeps an old table's shape).
  const stateCols = new Set((await db.all('PRAGMA table_info(ingestion_state)', [])).map((c) => c.name));
  for (const [name, ddl] of Object.entries(INGESTION_COLUMNS)) {
    if (!stateCols.has(name)) await db.exec(`ALTER TABLE ingestion_state ADD COLUMN ${name} ${ddl}`);
  }
  await db.exec(REF_LINKS_SCHEMA);
  await db.exec(BOOK_UNITS_SCHEMA);
  await db.exec(IMPORT_QUEUE_SCHEMA);
  // v4 -> v5: the covering (start, end) indexes replace the start-only ones.
  await db.exec('DROP INDEX IF EXISTS idx_ref_links_base; DROP INDEX IF EXISTS idx_ref_links_comm;');
}

// ---------------------------------------------------------------------------
// Ingestion checkpoints
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

/** The import checkpoint of this database, or null (also null on pre-v3 read-only DBs). */
async function readIngestionState(db) {
  try {
    const rows = await db.all('SELECT * FROM ingestion_state WHERE id = 1', []);
    return rows[0] || null;
  } catch {
    return null;
  }
}

/** Upserts the checkpoint row (only the given columns change; updated_at is always refreshed). */
async function writeIngestionState(db, patch) {
  const cur = await readIngestionState(db);
  const t = nowIso();
  if (!cur) {
    const row = Object.assign(
      { source_uri: '', source_name: null, source_kind: 'folder', target_db: 'user', status: 'in_progress', phase: 'books', processed_count: 0, total_count: 0, error_count: 0, base_book_id: 0, last_book_path: null, started_at: t },
      patch,
      { updated_at: t },
    );
    const keys = Object.keys(row);
    await db.run(`INSERT INTO ingestion_state (id, ${keys.join(', ')}) VALUES (1, ${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
    return;
  }
  const entries = Object.entries(Object.assign({}, patch, { updated_at: t }));
  await db.run(`UPDATE ingestion_state SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = 1`, entries.map(([, v]) => v));
}

/** Removes the checkpoint and its error log (after a finished or discarded import). */
async function clearIngestionState(db) {
  await db.run('DELETE FROM ingestion_state', []);
  await db.run('DELETE FROM ingestion_errors', []);
}

async function readIngestionErrors(db, limit) {
  try {
    return await db.all('SELECT file_path, message, at FROM ingestion_errors ORDER BY id LIMIT ?', [limit || 50]);
  } catch {
    return [];
  }
}

/** An interrupted (resumable) checkpoint: in_progress after a crash, or paused. */
function isResumableState(st) {
  return !!st && (st.status === 'in_progress' || st.status === 'paused');
}

async function readMeta(db) {
  try {
    const rows = await db.all('SELECT key, value FROM meta', []);
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch {
    return null;
  }
}

async function writeMeta(db, entries) {
  for (const [k, v] of Object.entries(entries)) {
    await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(v)]);
  }
}

// ---------------------------------------------------------------------------
// Text sanitization & book parsing
// ---------------------------------------------------------------------------
const SAFE_INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'small', 'big', 'sup', 'sub']);

/** Keep safe inline tags (attributes removed), drop everything else, decode entities. */
function sanitizeDisplay(html) {
  let t = html.replace(/<\s*br\s*\/?>/gi, ' ');
  t = t.replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>/gi, (m, close, tag) => {
    const name = tag.toLowerCase();
    return SAFE_INLINE_TAGS.has(name) ? `<${close}${name}>` : '';
  });
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  // Entities -> characters, but keep < > & literal-safe for the inline-tag renderer.
  t = decodeEntities(t.replace(/&(lt|gt|amp);/gi, '\u0000$1;')).replace(/\u0000(lt|gt|amp);/gi, '&$1;');
  return t.replace(/[ \t]+/g, ' ').trim();
}

function plainHeading(html) {
  return decodeEntities(stripHtml(html)).replace(/\s+/g, ' ').trim();
}

const HEADING_RE = /^\s*<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>\s*(.*)$/i;

/**
 * Incremental Otzaria .txt parser: feed physical lines in order (`line(text)`), get the paragraph
 * each line produces (or null); `finish()` returns the title, the TOC and the last line number.
 * line_index = physical line number in the file (1-based, blank lines skipped), which keeps Otzaria
 * link indices valid. Headings are paragraphs too (is_heading = level). Only the TOC is retained,
 * so a book can be streamed line by line without ever holding its text.
 */
function createBookParser(fallbackTitle) {
  const toc = []; // { parentIdx, level, title, refKey, refPath, startLine }
  const stack = []; // open headings: { level, tocIdx, title, labels }
  let title = null;
  let lineNo = 0;
  let lastParagraphLine = 0;
  const emit = (p) => {
    lastParagraphLine = p.lineIndex;
    return p;
  };
  return {
    line(line) {
      const lineIndex = ++lineNo;
      if (!line.trim()) return null;
      const h = HEADING_RE.exec(line);
      if (h) {
        const level = Number(h[1]);
        const headingTitle = plainHeading(h[2]);
        if (level === 1) {
          if (!title) title = headingTitle;
          return emit({ lineIndex, tocPath: null, display: sanitizeDisplay(h[2]), clean: normalizeHebrew(h[2]), isHeading: 1 });
        }
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const parent = stack[stack.length - 1];
        // refPath: canonical reference of the unit ("פרק א|פסוק א", "דף ב|עמוד א"), used to align commentaries.
        const labels = (parent ? parent.labels : []).concat(refAlign.unitLabels(headingTitle));
        toc.push({ parentIdx: parent ? parent.tocIdx : null, level, title: headingTitle, refKey: extractRefKey(headingTitle), refPath: refAlign.refKeyOf(labels), startLine: lineIndex });
        stack.push({ level, tocIdx: toc.length - 1, title: headingTitle, labels });
        const p = { lineIndex, tocPath: stack.map((x) => x.title).join(' > '), display: sanitizeDisplay(h[2]), clean: normalizeHebrew(h[2]), isHeading: level };
        // Text after a closing heading tag on the same line ("<h2>סימן א</h2>(א) יתגבר ..." in the Shulchan
        // Aruch): shown, searchable, and read back as the unit's first content (seif 1) when aligning.
        if (h[3] && h[3].trim()) {
          const display = sanitizeDisplay(h[3]);
          if (display) {
            p.display += ' ' + display;
            p.clean += ' ' + normalizeHebrew(h[3]);
          }
        }
        return emit(p);
      }
      const content = line.replace(/^\s*<p\b[^>]*>/i, '').replace(/<\/p>\s*$/i, '');
      const display = sanitizeDisplay(content);
      if (!display) return null;
      return emit({
        lineIndex,
        tocPath: stack.length ? stack.map((x) => x.title).join(' > ') : null,
        display,
        clean: normalizeHebrew(content),
        isHeading: 0,
      });
    },
    finish() {
      return { title: title || fallbackTitle, toc, totalLines: lastParagraphLine };
    },
  };
}

/** Parse a whole Otzaria .txt book held in memory (the PC build, tests): createBookParser over its lines. */
function parseBook(raw, fallbackTitle) {
  const parser = createBookParser(fallbackTitle);
  const splitter = createLineSplitter({ maxLineChars: Infinity });
  const paragraphs = [];
  for (const line of splitter.push(raw).concat(splitter.end())) {
    const p = parser.line(line);
    if (p) paragraphs.push(p);
  }
  return Object.assign(parser.finish(), { paragraphs });
}

// ---------------------------------------------------------------------------
// Folder walk
// ---------------------------------------------------------------------------

/**
 * Traditional ordering for well-known folders/books (alphabetical order would put
 * במדבר before בראשית). Anything not listed sorts alphabetically after these.
 * A folder may also contain an `order.json` array of names to override this.
 */
const CANONICAL_ORDER = [
  // top-level sections
  'תנך', 'תנ"ך', 'משנה', 'תוספתא', 'תלמוד בבלי', 'תלמוד ירושלמי', 'מדרש', 'הלכה', 'שות', 'שו"ת', 'קבלה', 'חסידות', 'מחשבת ישראל', 'מוסר', 'ספרי מוסר',
  'תורה', 'נביאים', 'כתובים',
  'בראשית', 'שמות', 'ויקרא', 'במדבר', 'דברים',
  'יהושע', 'שופטים', 'שמואל א', 'שמואל ב', 'מלכים א', 'מלכים ב', 'ישעיהו', 'ירמיהו', 'יחזקאל', 'הושע', 'יואל', 'עמוס', 'עובדיה', 'יונה', 'מיכה', 'נחום', 'חבקוק', 'צפניה', 'חגי', 'זכריה', 'מלאכי',
  'תהילים', 'משלי', 'איוב', 'שיר השירים', 'רות', 'איכה', 'קהלת', 'אסתר', 'דניאל', 'עזרא', 'נחמיה', 'דברי הימים א', 'דברי הימים ב',
  'סדר זרעים', 'סדר מועד', 'סדר נשים', 'סדר נזיקין', 'סדר קדשים', 'סדר טהרות',
  'ברכות', 'פאה', 'דמאי', 'כלאים', 'שביעית', 'תרומות', 'מעשרות', 'מעשר שני', 'חלה', 'ערלה', 'ביכורים',
  'שבת', 'עירובין', 'פסחים', 'שקלים', 'יומא', 'סוכה', 'ביצה', 'ראש השנה', 'תענית', 'מגילה', 'מועד קטן', 'חגיגה',
  'יבמות', 'כתובות', 'נדרים', 'נזיר', 'סוטה', 'גיטין', 'קידושין',
  'בבא קמא', 'בבא מציעא', 'בבא בתרא', 'סנהדרין', 'מכות', 'שבועות', 'עדיות', 'עבודה זרה', 'אבות', 'הוריות',
  'זבחים', 'מנחות', 'חולין', 'בכורות', 'ערכין', 'תמורה', 'כריתות', 'מעילה', 'תמיד', 'מידות', 'קינים',
  'כלים', 'אהלות', 'נגעים', 'פרה', 'טהרות', 'מקואות', 'נדה', 'מכשירין', 'זבים', 'טבול יום', 'ידים', 'עוקצים',
  'אורח חיים', 'יורה דעה', 'אבן העזר', 'חושן משפט',
];
const ORDER_RANK = new Map(CANONICAL_ORDER.map((n, i) => [aliasKey(n), i]));

/** Sorts `{ name, isDir }` entries: order.json, canonical order, folders first, then alphabetical. */
function sortEntries(entries, localOrder) {
  const local = Array.isArray(localOrder) ? new Map(localOrder.map((n, i) => [aliasKey(n), i])) : null;
  const rank = (e) => {
    const k = aliasKey(e.name.replace(/\.txt$/i, ''));
    if (local && local.has(k)) return local.get(k) - 1e6;
    if (ORDER_RANK.has(k)) return ORDER_RANK.get(k);
    // "מסכת ברכות" / "שולחן ערוך אורח חיים": rank by a canonical suffix.
    for (const [n, r] of ORDER_RANK) if (k.endsWith(' ' + n)) return r;
    return Infinity;
  };
  return entries.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'he');
  });
}

const stripBom = (s) => String(s).replace(/^﻿/, '');

/** System / metadata folders that never hold books (checked before anything is read). */
const IGNORED_DIRS = new Set(['__macosx', '$recycle.bin', 'system volume information', 'lost.dir', '.trashes', '.thumbnails']);
/**
 * Hidden files, OS junk and Office lock files. Non-.txt files (pdf, jpg, epub, docx, ...) are
 * filtered by extension in scanBooks(), so their contents are never read into memory.
 */
function isIgnoredEntry(e) {
  const n = String(e.name || '');
  if (!n || n.startsWith('.') || n.startsWith('~$')) return true;
  if (e.isDir) return IGNORED_DIRS.has(n.toLowerCase());
  return /^(thumbs\.db|desktop\.ini)$/i.test(n);
}

/** True for the files scanBooks() indexes as books. */
function isBookFileName(name) {
  const n = decodeUriName(name);
  return /\.txt$/i.test(n) && !n.startsWith('.');
}

/** URL-decoded name (SAF content:// names can arrive as "%D7%91...txt"); the input when it is not valid. */
function decodeUriName(name) {
  const n = String(name == null ? '' : name);
  if (!/%[0-9A-F]{2}/i.test(n)) return n;
  try {
    return decodeURIComponent(n);
  } catch {
    return n;
  }
}

/**
 * True for a name that is clearly a FILE (an extension of a known file type), even when the platform
 * reported it as a folder: on Android SAF a document of an unknown MIME type can come back as a directory,
 * and scanning it as one never ends. Decodes URL-encoded names first.
 */
function looksLikeFileName(name) {
  return /\.(txt|docx?|pdf|rtf|odt|epub|mobi|html?|xml|json|csv|md|zip|7z|rar|gz|jpe?g|png|gif|webp|bmp|svg|mp3|mp4|m4a|wav|apk|db|sqlite|log|ini)$/i.test(decodeUriName(name));
}

/**
 * Walks a book folder: every sub-folder is a category, every `.txt` a book.
 * @returns {Promise<{ dirs: string[][], files: { handle, name, rel: string[], dir: string[] }[] }>}
 */
async function scanBooks(fsa, root, rel) {
  const base = rel || [];
  const out = { dirs: [], files: [] };
  const entries = (await fsa.list(root)).filter((e) => !isIgnoredEntry(e));
  const orderEntry = entries.find((e) => !e.isDir && e.name.toLowerCase() === 'order.json');
  let order = null;
  if (orderEntry) {
    try {
      order = JSON.parse(stripBom(await fsa.readText(orderEntry.handle)));
    } catch {
      order = null;
    }
  }
  for (const e of sortEntries(entries, order)) {
    if (e.isDir) {
      out.dirs.push(base.concat(e.name));
      const sub = await scanBooks(fsa, e.handle, base.concat(e.name));
      out.dirs.push(...sub.dirs);
      out.files.push(...sub.files);
    } else if (isBookFileName(e.name)) {
      out.files.push({ handle: e.handle, name: e.name, rel: base.concat(e.name), dir: base });
    }
  }
  return out;
}

const NON_LINK_JSON = new Set(['order.json', 'aliases.json', 'manifest.json', 'package.json']);

/** All link files (.csv / .json) under a folder, recursively, in a stable order. */
async function scanLinkFiles(fsa, root, rel) {
  const files = [];
  const base = rel || [];
  const entries = (await fsa.list(root)).filter((e) => !isIgnoredEntry(e)).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.isDir) files.push(...(await scanLinkFiles(fsa, e.handle, base.concat(e.name))));
    else if (/\.(csv|json)$/i.test(e.name) && !NON_LINK_JSON.has(e.name.toLowerCase())) files.push({ handle: e.handle, name: e.name, rel: base.concat(e.name) });
  }
  return files;
}

/** Merges aliases.json objects ({ "title": ["alias", ...] }) keyed by aliasKey(title). */
function mergeAliasOverrides(objects) {
  const merged = {};
  for (const data of objects) {
    if (!data) continue;
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('_')) continue; // comments
      merged[aliasKey(k)] = (merged[aliasKey(k)] || []).concat(Array.isArray(v) ? v : [v]);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Links (Otzaria JSON "<Book>_links.json" or generic CSV/JSON)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  for (const line of stripBom(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        cells.push(cur);
        cur = '';
      } else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

/** Words that may precede a book name in link files without changing which book it is. */
const NOISE_WORDS = new Set(['מסכת', 'ספר', 'תלמוד', 'בבלי', 'ירושלמי', 'תנכ', 'תנך'].map((w) => aliasKey(w)));

const baseName = (p) => String(p ?? '').replace(/\\/g, '/').split('/').pop();

/** "path/to/רש''י על שבת_links.json" -> "רשי על שבת" (normalized). */
function linkBookKey(name) {
  return aliasKey(baseName(name).replace(/\.(txt|json|csv)$/i, '').replace(/_links$/i, ''));
}

/**
 * Resolves the book names used in link files to book ids:
 *  1. exact normalized title / file name / alias (niqqud, gershayim, finals ignored)
 *  2. the same after dropping leading noise words ("מסכת שבת" -> "שבת")
 *  3. a unique book whose title contains the name as whole words ("אורח חיים" ->
 *     "שולחן ערוך אורח חיים"), or whose title is contained in the name with only
 *     noise words around it ("תלמוד בבלי שבת" -> "שבת").
 * "רש"י על ראש השנה" never resolves to "ראש השנה": extra non-noise words block step 3.
 *
 * @param {{ id: number, title: string, filePath: string, aliases: string[] }[]} books
 */
function makeBookMatcher(books) {
  const byKey = new Map();
  const put = (k, id) => {
    if (k && !byKey.has(k)) byKey.set(k, id);
  };
  for (const b of books) put(aliasKey(b.title), b.id);
  for (const b of books) put(aliasKey(baseName(b.filePath).replace(/\.txt$/i, '')), b.id);
  for (const b of books) put(aliasKey(b.filePath.replace(/\.txt$/i, '').replace(/\//g, ' ')), b.id);
  for (const b of books) for (const a of b.aliases) put(a, b.id);
  const titles = books.map((b) => ({ id: b.id, key: aliasKey(b.title) }));
  const stripNoise = (k) => {
    const w = k.split(' ');
    while (w.length > 1 && NOISE_WORDS.has(w[0])) w.shift();
    return w.join(' ');
  };
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const k = linkBookKey(name);
    let id = k ? byKey.get(k) ?? byKey.get(stripNoise(k)) : undefined;
    if (id === undefined && k) {
      const padded = ` ${k} `;
      let cands = titles.filter((t) => ` ${t.key} `.includes(padded));
      if (cands.length !== 1) {
        cands = titles.filter((t) => {
          if (!padded.includes(` ${t.key} `)) return false;
          const rest = padded.replace(` ${t.key} `, ' ').trim();
          return rest.split(' ').every((w) => !w || NOISE_WORDS.has(w));
        });
      }
      id = cands.length === 1 ? cands[0].id : undefined;
    }
    const res = id === undefined ? null : id;
    cache.set(name, res);
    return res;
  };
}

/**
 * Parses one link file into raw tuples [srcName, srcLine, tgtName, tgtLine, type].
 * CSV: source_book,source_line,target_book,target_line,link_type (header optional).
 * JSON: [{ source_book, ... }] or Otzaria's [{ line_index_1, path_2, line_index_2, "Conection Type" }]
 * where the source book is the file name ("<Book>_links.json").
 */
function parseLinkFile(fileName, raw) {
  const out = [];
  if (fileName.toLowerCase().endsWith('.csv')) {
    const rows = parseCsv(raw);
    const header = rows[0] && rows[0].map((h) => h.toLowerCase());
    const hasHeader = header && header.includes('source_book');
    const col = (n, d) => (hasHeader ? header.indexOf(n) : d);
    const [sb, sl, tb, tl, lt] = [col('source_book', 0), col('source_line', 1), col('target_book', 2), col('target_line', 3), col('link_type', 4)];
    for (const r of rows.slice(hasHeader ? 1 : 0)) out.push([r[sb], r[sl], r[tb], r[tl], r[lt]]);
    return out;
  }
  const data = JSON.parse(stripBom(raw));
  const arr = Array.isArray(data) ? data : data.links || [];
  const fileBook = baseName(fileName).replace(/\.json$/i, '').replace(/_links$/i, '');
  for (const l of arr) {
    if (l.source_book !== undefined) out.push([l.source_book, l.source_line, l.target_book, l.target_line, l.link_type]);
    else out.push([fileBook, l.line_index_1, l.path_2, l.line_index_2, l['Conection Type'] || l.connectionType || l.link_type]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
const PARA_BATCH = 150; // rows per multi-row INSERT (<= 8 params each)
/** Paragraphs per FTS insert statement (bounded native work per call). */
const FTS_BATCH = 2000;

/**
 * Multi-row INSERTs in chunks of PARA_BATCH. `map(item, index)` (optional) turns an item into its
 * row, so a big book's paragraphs are converted chunk by chunk instead of into a second full array.
 */
async function insertMany(db, head, cols, items, map) {
  const one = '(' + new Array(cols).fill('?').join(', ') + ')';
  for (let i = 0; i < items.length; i += PARA_BATCH) {
    const end = Math.min(items.length, i + PARA_BATCH);
    const params = [];
    for (let j = i; j < end; j++) {
      const r = map ? map(items[j], j) : items[j];
      for (let k = 0; k < cols; k++) params.push(r[k]);
    }
    await db.run(`${head} VALUES ${new Array(end - i).fill(one).join(', ')}`, params);
  }
}

async function maxId(db, table, base) {
  const r = await db.all(`SELECT MAX(id) AS m FROM ${table}`, []);
  const m = r[0] && r[0].m != null ? Number(r[0].m) : 0;
  return Math.max(m, base);
}

async function hasTable(db, name) {
  return (await db.all("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
}

/** Removes one book (its FTS entries, paragraphs, TOC, units and links) from a database. */
async function deleteBook(db, bookId) {
  await db.run(
    `INSERT INTO paragraphs_fts(paragraphs_fts, rowid, clean_text, book_id, category_path, line_index)
     SELECT 'delete', id, clean_text, book_id, category_path, line_index FROM paragraphs_fts_source WHERE book_id = ?`,
    [bookId],
  );
  await db.run('DELETE FROM paragraphs WHERE book_id = ?', [bookId]);
  await db.run('DELETE FROM toc_nodes WHERE book_id = ?', [bookId]);
  if (await hasTable(db, 'book_units')) await db.run('DELETE FROM book_units WHERE book_id = ?', [bookId]);
  await db.run('DELETE FROM links WHERE book_a_id = ? OR book_b_id = ?', [bookId, bookId]);
  if (await hasTable(db, 'ref_links')) await db.run('DELETE FROM ref_links WHERE base_book_id = ? OR comm_book_id = ?', [bookId, bookId]);
  await db.run('DELETE FROM books WHERE id = ?', [bookId]);
}

/** Deletes categories that hold no books and no sub-categories (keeps `keepIds`). */
async function pruneEmptyCategories(db, keepIds) {
  const keep = (keepIds || []).map(Number);
  for (;;) {
    const rows = await db.all(
      `SELECT c.id FROM categories c
       WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.category_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM categories s WHERE s.parent_id = c.id)`,
      [],
    );
    const ids = rows.map((r) => r.id).filter((id) => !keep.includes(Number(id)));
    if (!ids.length) return;
    await db.run(`DELETE FROM categories WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  }
}

/** Thrown out of an onFile / shouldStop hook to stop indexLinks (the link transaction rolls back). */
class IngestionStopped extends Error {
  constructor(reason) {
    super(reason === 'cancel' ? 'cancelled' : 'paused');
    this.reason = reason || 'pause';
  }
}

const errorMessage = (e) => String((e && e.message) || e).slice(0, 500);

/** A file that is not text (a binary renamed .txt, a PDF, ...): NUL bytes never occur in Otzaria books. */
function assertTextContent(raw) {
  if (raw.slice(0, 4096).indexOf('\u0000') !== -1) throw new Error('not a text file (binary content)');
}

/** Persisted heading units of a parsed book (refAlign.bookUnits over its TOC). */
function parsedUnits(parsed) {
  const nodes = parsed.toc.map((n, i) => ({ id: i, parent_id: n.parentIdx, level: n.level, title: n.title, start_line: n.startLine }));
  return refAlign.bookUnits(nodes, parsed.totalLines);
}

/**
 * Writes books into a database, one at a time (the engine behind indexBooks() and the streaming
 * queue of shared/pipeline.js). Allocates ids in the caller's namespace (idBase), creates
 * categories on demand, and writes each book's paragraphs, TOC, heading units (book_units) and
 * FTS rows. The caller owns the transaction; with `isolate`, each book is wrapped in a SAVEPOINT
 * and a failing book is rolled back alone ({ ok: false, error }).
 *
 * Memory: the file text and the parsed book live only inside write(); it returns counts.
 */
async function createBookWriter(db, opts) {
  const o = opts || {};
  const idBase = o.idBase || 0;
  const prefix = o.categoryPrefix || [];
  const overrides = o.aliasOverrides || {};
  const isolate = !!o.isolate;
  const unitsTable = await hasTable(db, 'book_units');

  let catId = await maxId(db, 'categories', idBase);
  let bookId = await maxId(db, 'books', idBase);
  let tocId = await maxId(db, 'toc_nodes', idBase);
  let paraId = await maxId(db, 'paragraphs', idBase);

  const catIds = new Map(); // 'a/b' -> id
  for (const r of await db.all('SELECT id, path FROM categories', [])) catIds.set(r.path, r.id);
  let bookCats = null; // categories created by the book being written (forgotten on rollback)
  const state = { newCats: 0 };

  const ensureCategory = async (parts) => {
    const p = parts.join('/');
    if (catIds.has(p)) return catIds.get(p);
    const parentId = parts.length > 1 ? await ensureCategory(parts.slice(0, -1)) : null;
    const id = ++catId;
    await db.run('INSERT INTO categories (id, parent_id, name, path) VALUES (?, ?, ?, ?)', [id, parentId, parts[parts.length - 1], p]);
    catIds.set(p, id);
    if (bookCats) bookCats.push(p);
    state.newCats++;
    return id;
  };

  /**
   * Streams one book into the database: lines are parsed as they arrive and paragraphs are
   * inserted PARA_BATCH at a time, so neither the text nor the parsed book is ever held whole.
   * The book row, TOC, units and FTS rows are written once the last line is in. Throws on any
   * failure (the caller's SAVEPOINT rolls the partial book back).
   * `next()` yields text chunks, then null.
   */
  const writeStream = async (file, relPath, oldIds, next) => {
    const fallback = file.name.replace(/\.[^.]+$/, '');
    for (const old of oldIds || []) await deleteBook(db, old);
    const dirParts = prefix.concat(file.dir);
    const categoryId = dirParts.length ? await ensureCategory(dirParts) : null;
    const id = ++bookId;
    const firstParaId = paraId + 1;
    // The row comes first (paragraphs reference it); title / aliases / size are set at the end.
    await db.run('INSERT INTO books (id, category_id, title, aliases, file_path, total_lines, is_complete) VALUES (?, ?, ?, ?, ?, 0, 0)', [id, categoryId, fallback, '||', relPath]);
    const parser = createBookParser(fallback);
    const splitter = createLineSplitter({ maxLineChars: o.maxLineChars });
    let head = '';
    let batch = [];
    let lines = 0;
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch;
      batch = [];
      lines += rows.length;
      await insertMany(db, 'INSERT INTO paragraphs (id, book_id, line_index, toc_path, display_text, clean_text, is_heading)', 7, rows, (q) => [
        ++paraId, id, q.lineIndex, q.tocPath, q.display, q.clean, q.isHeading ? 1 : 0,
      ]);
    };
    const feed = async (textLines) => {
      for (const l of textLines) {
        const q = parser.line(l);
        if (!q) continue;
        batch.push(q);
        if (batch.length >= PARA_BATCH) await flush();
      }
    };
    for (;;) {
      const chunk = await next();
      if (chunk == null) break;
      if (head.length < 4096) {
        head += chunk.slice(0, 4096 - head.length);
        assertTextContent(head);
      }
      await feed(splitter.push(chunk));
    }
    await feed(splitter.end());
    await flush();

    const parsed = parser.finish();
    const relKey = file.rel.join('/');
    const extra = [].concat(overrides[aliasKey(parsed.title)] || [], overrides[aliasKey(relKey)] || [], overrides[aliasKey(fallback)] || []);
    const aliases = generateBookAliases(prefix.concat(file.dir), parsed.title, extra);
    // Stored as "|a|b|c|" so a single alias can also be matched in SQL with LIKE '%|alias|%'.
    await db.run('UPDATE books SET title = ?, aliases = ?, total_lines = ? WHERE id = ?', [parsed.title, '|' + aliases.join('|') + '|', parsed.totalLines, id]);
    const tocIds = [];
    for (let i = 0; i < parsed.toc.length; i++) tocIds.push(++tocId);
    await insertMany(db, 'INSERT INTO toc_nodes (id, book_id, parent_id, level, title, ref_key, start_line)', 7, parsed.toc, (n, i) => [
      tocIds[i], id, n.parentIdx == null ? null : tocIds[n.parentIdx], n.level, n.title, n.refKey, n.startLine,
    ]);
    let units = 0;
    if (unitsTable) {
      const rows = parsedUnits(parsed);
      units = rows.length;
      await insertMany(db, 'INSERT INTO book_units (book_id, ref_key, depth, start_line, end_line, own_end, heading_label)', 7, rows, (u) => [
        id, u.refKey, u.labels.length, u.start, u.end, u.ownEnd, u.title,
      ]);
    }
    // FTS rows in bounded id ranges: no single statement runs long enough to stall the connection.
    for (let from = firstParaId; from <= paraId; from += FTS_BATCH) {
      await db.run(
        `INSERT INTO paragraphs_fts(rowid, clean_text, book_id, category_path, line_index)
         SELECT id, clean_text, book_id, category_path, line_index FROM paragraphs_fts_source WHERE id BETWEEN ? AND ? AND book_id = ?`,
        [from, Math.min(paraId, from + FTS_BATCH - 1), id],
      );
    }
    await db.run('UPDATE books SET is_complete = 1 WHERE id = ?', [id]);
    return { id, title: parsed.title, lines, tocNodes: parsed.toc.length, units };
  };

  /**
   * @param {{ file: { name, rel: string[], dir: string[] }, relPath: string, oldIds?: number[],
   *           open?: () => Promise<{ read(): Promise<string|null>, close(): any }>,
   *           read?: () => Promise<string>, onFileRead?: (relKey, raw) => void }} job
   *   open: streamed text chunks (the device); read: the whole text at once (the PC build, which
   *   also hashes it through onFileRead). Both go through the same line parser.
   * @returns {Promise<{ ok: true, id, title, lines, tocNodes, units } | { ok: false, error }>}
   */
  const write = async (job) => {
    if (isolate) await db.exec('SAVEPOINT book');
    bookCats = [];
    // Ids handed out by a book that is rolled back are reused: ids never depend on failures / kills.
    const ids = { catId, bookId, tocId, paraId };
    let reader = null;
    try {
      let next;
      if (job.open) {
        reader = await job.open();
        next = () => reader.read();
      } else {
        let raw = await job.read();
        if (job.onFileRead) job.onFileRead(job.file.rel.join('/'), raw);
        next = async () => {
          const t = raw;
          raw = null; // drop the text as soon as it is handed over
          return t;
        };
      }
      const r = await writeStream(job.file, job.relPath, job.oldIds, next);
      if (isolate) await db.exec('RELEASE book');
      return Object.assign({ ok: true }, r);
    } catch (e) {
      if (!isolate) throw e;
      await db.exec('ROLLBACK TO book');
      await db.exec('RELEASE book');
      ({ catId, bookId, tocId, paraId } = ids);
      for (const p of bookCats) catIds.delete(p);
      state.newCats -= bookCats.length;
      return { ok: false, error: e };
    } finally {
      bookCats = null;
      if (reader) await Promise.resolve(reader.close()).catch(() => undefined);
    }
  };

  return {
    ensureCategory,
    write,
    get newCategories() {
      return state.newCats;
    },
    get lastBookId() {
      return bookId;
    },
  };
}

/**
 * Indexes book files into a database that already has the schema.
 *
 * Resumable & crash-safe:
 *  - every book is written inside its own SAVEPOINT and flagged books.is_complete = 1 only
 *    after its paragraphs, TOC, units and FTS rows are in; a book that throws (malformed file,
 *    read error) is rolled back alone, reported through onError / stats.errors and skipped;
 *  - transactions are committed every `booksPerTransaction` books, or earlier once
 *    `maxLinesPerTransaction` paragraphs are pending (big books), so progress keeps
 *    reaching the disk;
 *  - with `ingestion`, the checkpoint row (ingestion_state) and the error log
 *    (ingestion_errors) are written in the same transaction as the books they describe;
 *  - with `ingestion.resume`, books already completed by the interrupted run (same
 *    file_path, is_complete = 1, id > the run's base_book_id) are skipped without reading;
 *  - `shouldStop()` is polled between books: on 'pause' / 'cancel' the pending books are
 *    committed (checkpoint status 'paused') and indexBooks returns with `stopped` set.
 *
 * The device uses the streaming queue of shared/pipeline.js instead (no file list in memory);
 * this array-based form serves the PC build (scripts/build-db.js) and small imports.
 *
 * @param {object} db     writer adapter { exec, run, all }
 * @param {object} fsa    file adapter { list, readText }
 * @param {object} opts
 *   files, dirs        output of scanBooks()
 *   idBase             0 for the core library, USER_ID_BASE for the personal library
 *   categoryPrefix     path segments every category/book is placed under (e.g. [USER_ROOT_NAME])
 *   aliasOverrides     mergeAliasOverrides() result
 *   replaceExisting    re-importing a file_path replaces that book (default true)
 *   booksPerTransaction    books per BEGIN/COMMIT (default 1; the PC build uses one big transaction)
 *   maxLinesPerTransaction commit early once this many paragraphs are pending (default 20000)
 *   ingestion          { sourceUri, sourceName?, sourceKind?, targetDb, resume? } checkpointing
 *   shouldStop()       -> null | 'pause' | 'cancel', polled between books
 *   onError({ relPath, error })  a book failed and was skipped (default: rethrow = abort)
 *   onFileRead(relPath, raw)   hook (the PC build hashes the sources for DB_VERSION)
 *   onBook({ index, total, relPath, title, lines, tocNodes, skipped? })
 *   onCommit()         awaited after every COMMIT (e.g. a WAL checkpoint)
 *   yieldEvery()       awaited between books so a UI stays responsive
 * @returns {Promise<{ books, paragraphs, tocNodes, categories, bookIds, skipped, failed, errors, processed, stopped }>}
 */
async function indexBooks(db, fsa, opts) {
  const prefix = opts.categoryPrefix || [];
  const perTx = Math.max(1, opts.booksPerTransaction || 1);
  const maxLines = Math.max(1, opts.maxLinesPerTransaction || 20000);
  const replace = opts.replaceExisting !== false;
  const ing = opts.ingestion || null;
  const isolate = typeof opts.onError === 'function';

  const writer = await createBookWriter(db, { idBase: opts.idBase, categoryPrefix: prefix, aliasOverrides: opts.aliasOverrides, isolate });
  const files = opts.files || [];
  const stats = { books: 0, paragraphs: 0, tocNodes: 0, categories: 0, bookIds: [], skipped: 0, failed: 0, errors: [], processed: 0, stopped: null };

  // --- checkpoint -------------------------------------------------------------
  let baseBookId = writer.lastBookId;
  let resume = false;
  let pendingErrors = [];
  let lastPath = null;
  if (ing) {
    const st = await readIngestionState(db);
    resume = !!ing.resume && isResumableState(st);
    if (resume) baseBookId = Number(st.base_book_id) || 0;
  }
  const checkpoint = async (status) => {
    if (!ing) return;
    for (const e of pendingErrors) await db.run('INSERT INTO ingestion_errors (file_path, message, at) VALUES (?, ?, ?)', [e.relPath, e.message, nowIso()]);
    pendingErrors = [];
    const patch = { status, phase: 'books', processed_count: stats.processed, total_count: files.length, last_book_path: lastPath };
    patch.error_count = Number((await db.all('SELECT COUNT(*) AS n FROM ingestion_errors', []))[0].n);
    await writeIngestionState(db, patch);
  };

  let inTx = false;
  let pendingBooks = 0;
  let pendingLines = 0;
  const begin = async () => {
    if (!inTx) {
      await db.exec('BEGIN');
      inTx = true;
    }
  };
  const commit = async (status) => {
    if (!inTx) return;
    await checkpoint(status || 'in_progress');
    await db.exec('COMMIT');
    inTx = false;
    pendingBooks = 0;
    pendingLines = 0;
    if (opts.onCommit) await opts.onCommit();
  };

  try {
    await begin();
    if (ing) {
      if (!resume) {
        await clearIngestionState(db);
        await writeIngestionState(db, {
          source_uri: String(ing.sourceUri || ''),
          source_name: ing.sourceName || null,
          source_kind: ing.sourceKind || 'folder',
          target_db: ing.targetDb || 'user',
          status: 'in_progress',
          base_book_id: baseBookId,
          total_count: files.length,
          started_at: nowIso(),
        });
      } else {
        await writeIngestionState(db, { status: 'in_progress', source_uri: String(ing.sourceUri || ''), total_count: files.length });
      }
    }
    if (prefix.length) await writer.ensureCategory(prefix);
    for (const parts of opts.dirs || []) await writer.ensureCategory(prefix.concat(parts));
    await commit();

    for (let fi = 0; fi < files.length; fi++) {
      const stop = opts.shouldStop ? opts.shouldStop() : null;
      if (stop) {
        stats.stopped = stop;
        break;
      }
      const file = files[fi];
      const relPath = prefix.concat(file.rel).join('/');
      await begin();

      const old = replace || resume ? await db.all('SELECT id, is_complete FROM books WHERE file_path = ?', [relPath]) : [];
      if (resume && old.length === 1 && Number(old[0].is_complete) === 1 && Number(old[0].id) > baseBookId) {
        // Finished by the interrupted run: skip without reading the file.
        stats.skipped++;
        stats.processed = fi + 1;
        lastPath = relPath;
        if (opts.onBook) opts.onBook({ index: fi + 1, total: files.length, relPath, title: file.name.replace(/\.[^.]+$/, ''), lines: 0, tocNodes: 0, skipped: true });
        // Skips are cheap: yield now and then so a long resume scan stays responsive.
        if (opts.yieldEvery && stats.skipped % 50 === 0) await opts.yieldEvery();
        continue;
      }

      const r = await writer.write({
        file,
        relPath,
        oldIds: replace || resume ? old.map((x) => x.id) : [],
        read: () => fsa.readText(file.handle),
        onFileRead: opts.onFileRead,
      });
      if (r.ok) {
        stats.books++;
        stats.paragraphs += r.lines;
        stats.tocNodes += r.tocNodes;
        stats.bookIds.push(r.id);
        pendingLines += r.lines;
      } else {
        stats.failed++;
        const err = { relPath, message: errorMessage(r.error) };
        stats.errors.push(err);
        pendingErrors.push(err);
        opts.onError({ relPath, error: r.error });
      }
      stats.processed = fi + 1;
      lastPath = relPath;
      pendingBooks++;
      if (r.ok && opts.onBook) opts.onBook({ index: fi + 1, total: files.length, relPath, title: r.title, lines: r.lines, tocNodes: r.tocNodes });
      if (pendingBooks >= perTx || pendingLines >= maxLines) await commit();
      if (opts.yieldEvery) await opts.yieldEvery();
    }
    await begin();
    await commit(stats.stopped ? 'paused' : 'in_progress');
  } catch (e) {
    if (inTx) await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
  stats.categories = writer.newCategories;
  return stats;
}

/** All books of a database in the shape makeBookMatcher() expects. */
async function loadBooksForMatching(db) {
  const rows = await db.all('SELECT id, title, aliases, file_path FROM books', []);
  return rows.map((r) => ({ id: r.id, title: r.title, filePath: r.file_path, aliases: String(r.aliases).split('|').filter(Boolean) }));
}

/**
 * Reads link files, matches their book names against every book in `db`, and stores
 * each unordered pair of (book, line) once. Links whose line is not a paragraph of its
 * book, and links already in the table, are dropped.
 *
 * @returns {Promise<{ files, parsed, kept, duplicates, outOfRange, invalid, unmatched: Map<string, number> }>}
 */
async function indexLinks(db, fsa, linkFiles, opts) {
  const stats = { files: linkFiles.length, parsed: 0, kept: 0, duplicates: 0, outOfRange: 0, invalid: 0, unmatched: new Map() };
  if (!linkFiles.length) return stats;
  const match = makeBookMatcher(await loadBooksForMatching(db));
  const miss = (n) => stats.unmatched.set(n, (stats.unmatched.get(n) || 0) + 1);
  const before = (await db.all('SELECT COUNT(*) AS n FROM links', []))[0].n;

  await db.exec('DROP TABLE IF EXISTS temp.links_stage');
  await db.exec('CREATE TEMP TABLE links_stage (a INTEGER, la INTEGER, b INTEGER, lb INTEGER, t TEXT)');
  try {
    await db.exec('BEGIN');
    for (let i = 0; i < linkFiles.length; i++) {
      const f = linkFiles[i];
      const raw = await fsa.readText(f.handle);
      if (opts && opts.onFileRead) opts.onFileRead(f, raw);
      let tuples;
      try {
        tuples = parseLinkFile(f.name, raw);
      } catch (e) {
        if (opts && opts.onError) opts.onError(f, e);
        continue;
      }
      const rows = [];
      for (const [srcName, srcLine, tgtName, tgtLine, type] of tuples) {
        const a = match(srcName);
        const b = match(tgtName);
        if (a == null) {
          miss(srcName);
          continue;
        }
        if (b == null) {
          miss(tgtName);
          continue;
        }
        const la = Number(srcLine);
        const lb = Number(tgtLine);
        if (!Number.isInteger(la) || !Number.isInteger(lb) || la < 1 || lb < 1) {
          stats.invalid++;
          continue;
        }
        rows.push([a, la, b, lb, type ? String(type).trim().toLowerCase() || null : null]);
      }
      stats.parsed += rows.length;
      await insertMany(db, 'INSERT INTO links_stage (a, la, b, lb, t)', 5, rows);
      if (opts && opts.onFile) opts.onFile({ index: i + 1, total: linkFiles.length, name: f.name });
    }
    // Canonical orientation for de-duplication: (a, la) <= (b, lb).
    await db.exec(`
      INSERT INTO links (book_a_id, line_a, book_b_id, line_b, link_type)
      SELECT a, la, b, lb, MIN(t) FROM (
        SELECT CASE WHEN a < b OR (a = b AND la <= lb) THEN a ELSE b END AS a,
               CASE WHEN a < b OR (a = b AND la <= lb) THEN la ELSE lb END AS la,
               CASE WHEN a < b OR (a = b AND la <= lb) THEN b ELSE a END AS b,
               CASE WHEN a < b OR (a = b AND la <= lb) THEN lb ELSE la END AS lb,
               t
        FROM links_stage
      ) s
      WHERE NOT (a = b AND la = lb)
        AND EXISTS (SELECT 1 FROM paragraphs p WHERE p.book_id = s.a AND p.line_index = s.la)
        AND EXISTS (SELECT 1 FROM paragraphs p WHERE p.book_id = s.b AND p.line_index = s.lb)
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.book_a_id = s.a AND l.line_a = s.la AND l.book_b_id = s.b AND l.line_b = s.lb)
      GROUP BY a, la, b, lb
      ORDER BY a, la, b, lb`);
    const distinct = (
      await db.all(
        `SELECT COUNT(*) AS n FROM (SELECT DISTINCT
           CASE WHEN a < b OR (a = b AND la <= lb) THEN a ELSE b END,
           CASE WHEN a < b OR (a = b AND la <= lb) THEN la ELSE lb END,
           CASE WHEN a < b OR (a = b AND la <= lb) THEN b ELSE a END,
           CASE WHEN a < b OR (a = b AND la <= lb) THEN lb ELSE la END
         FROM links_stage WHERE NOT (a = b AND la = lb))`,
        [],
      )
    )[0].n;
    await db.exec('COMMIT');
    stats.kept = (await db.all('SELECT COUNT(*) AS n FROM links', []))[0].n - before;
    stats.duplicates = stats.parsed - distinct;
    stats.outOfRange = distinct - stats.kept;
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.exec('DROP TABLE IF EXISTS temp.links_stage').catch(() => undefined);
  }
  return stats;
}

/**
 * Heading units of one book for alignment, read from book_units (schema v6). Books indexed before
 * v6 have no rows there: their units are derived from toc_nodes instead (same result).
 */
async function loadBookUnits(db, bookId, totalLines, unitsTable) {
  if (unitsTable) {
    const rows = await db.all('SELECT id, ref_key, depth, start_line, end_line, own_end, heading_label FROM book_units WHERE book_id = ? ORDER BY start_line, depth', [bookId]);
    if (rows.length) {
      return rows.map((r) => ({
        id: 'u' + r.id,
        title: r.heading_label,
        labels: refAlign.labelsFromRefKey(r.ref_key),
        refKey: r.ref_key,
        start: r.start_line,
        end: r.end_line,
        ownEnd: r.own_end,
      }));
    }
  }
  const nodes = await db.all('SELECT id, parent_id, level, title, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [bookId]);
  return refAlign.bookUnits(nodes, totalLines);
}

/**
 * The deterministic commentary -> base job list of a library: pure path / title pairing
 * (shared/pairing.js) over lightweight metadata only (id, title, aliases, folder path).
 * One job per commentary -> base pair (Otzaria "X על Y"), or per corpus-wide commentary
 * ("… על השס"), whose top-level headings each name a base (resolved when it is aligned).
 */
async function refLinkJobs(db, bookIds, pause) {
  const rows = await db.all(
    `SELECT b.id, b.title, b.aliases, b.total_lines, COALESCE(c.path, '') AS category_path
       FROM books b LEFT JOIN categories c ON c.id = b.category_id WHERE b.is_complete = 1 ORDER BY b.id`,
    [],
  );
  const books = rows.map((r) => ({ id: r.id, title: r.title, aliases: String(r.aliases).split('|').filter(Boolean), categoryPath: r.category_path, totalLines: r.total_lines }));
  // On the device the pairing yields every few hundred books (pause), so it never freezes the UI.
  const paired = pause ? await refAlign.pairCommentariesAsync(books, pause) : refAlign.pairCommentaries(books);
  let jobs = paired.map((p) => ({ commId: p.commId, baseId: p.baseId }));
  for (const m of paired.multi || []) jobs.push({ commId: m.commId, scope: m.scope });
  if (bookIds) {
    const only = new Set(bookIds);
    jobs = jobs.filter((j) => only.has(j.commId) || (j.baseId != null ? only.has(j.baseId) : true));
  }
  return { books, jobs };
}

/**
 * Heading-based reference alignment (Otzaria): pairs every commentary book with its base
 * book by folder path + file name only (no external link files), and stores, for each
 * commentary unit with its own text, the base unit with the same canonical ref_key as a
 * `ref_links` row of two line ranges. Runs in the links phase, after all books are indexed.
 *
 * Memory: only the metadata list (id, title, aliases, folder) is held for the whole library;
 * units come from book_units one book at a time (a few base books are cached, as many
 * commentaries share one base), base texts are read per unit only when a verse / seif has to
 * be resolved inline, and the commentary's own lines as (line, first 12 chars).
 *
 * Resumable: jobs are processed in small transactions (`booksPerTransaction`, default 20); each
 * job's rows are replaced (DELETE + INSERT), so a redo is harmless. `cursor` skips the first jobs
 * (committed by an interrupted run) and `beforeCommit(nextCursor, total)` is awaited inside each
 * transaction so the caller's checkpoint is committed atomically with the rows it describes.
 * `shouldStop()` (polled between jobs) ends the run early with `stopped` set.
 *
 * @param {object} db  writer adapter
 * @param {{ bookIds?: number[], booksPerTransaction?: number, cursor?: number,
 *           shouldStop?: () => any, beforeCommit?: (next: number, total: number) => Promise<void>,
 *           onBook?: (p: { index, total, title }) => void, onCommit?: () => Promise<void>,
 *           yieldEvery?: () => Promise<void> }} [opts]
 *   bookIds: only (re)align pairs that involve these books (a personal import).
 *   plan:    a refLinkJobs() result to reuse (the pipeline computes it once per run);
 *   limit:   process at most this many jobs from `cursor`, then return (cursor = next job).
 * @returns {Promise<{ pairs, aligned, units, stopped, cursor }>}
 */
async function indexRefLinks(db, opts) {
  const o = opts || {};
  const stats = { pairs: 0, aligned: 0, units: 0, stopped: null, cursor: 0 };
  if (!(await hasTable(db, 'ref_links'))) return stats;
  const unitsTable = await hasTable(db, 'book_units');
  const { books, jobs } = o.plan || (await refLinkJobs(db, o.bookIds));
  const byId = new Map(books.map((b) => [b.id, b]));
  stats.pairs = jobs.length;
  // Base books are reused by many commentaries (רש"י, רמב"ן, ... על בראשית): keep a few cached.
  const unitCache = new Map();
  const unitsOf = async (id) => {
    let u = unitCache.get(id);
    if (!u) {
      u = await loadBookUnits(db, id, byId.get(id).totalLines, unitsTable);
      if (unitCache.size > 16) unitCache.delete(unitCache.keys().next().value);
      unitCache.set(id, u);
    }
    return u;
  };
  const baseContentOf = (baseId) => async (unit) => {
    const rows = await db.all('SELECT line_index AS line, substr(clean_text, 1, 12) AS text FROM paragraphs WHERE book_id = ? AND line_index > ? AND line_index <= ? AND is_heading = 0 ORDER BY line_index', [baseId, unit.start, unit.end]);
    // The unit's own heading line may carry the text of its first seif ("<h2>סימן א</h2>(א) יתגבר ...").
    const head = await db.all('SELECT substr(clean_text, 1, 80) AS text FROM paragraphs WHERE book_id = ? AND line_index = ? AND is_heading <> 0', [baseId, unit.start]);
    const lead = head.length ? refAlign.headingLeadText(head[0].text, unit.title) : null;
    return lead ? [{ line: unit.start, text: lead, heading: true }, ...rows] : rows;
  };
  const perTx = Math.max(1, o.booksPerTransaction || 20);
  let inTx = false;
  let pending = 0;
  const start = Math.max(0, Math.min(jobs.length, Number(o.cursor) || 0));
  stats.cursor = start;
  const commit = async (next) => {
    if (!inTx) return;
    if (o.beforeCommit) await o.beforeCommit(next, jobs.length);
    await db.exec('COMMIT');
    inTx = false;
    pending = 0;
    stats.cursor = next;
    if (o.onCommit) await o.onCommit();
    if (o.yieldEvery) await o.yieldEvery();
  };
  let i = start;
  const stopAt = o.limit ? Math.min(jobs.length, start + o.limit) : jobs.length;
  try {
    for (; i < stopAt; i++) {
      const stop = o.shouldStop ? o.shouldStop() : null;
      if (stop) {
        stats.stopped = stop;
        break;
      }
      const job = jobs[i];
      const { commId } = job;
      const commUnits = await loadBookUnits(db, commId, byId.get(commId).totalLines, unitsTable);
      let rowsOut = [];
      if (commUnits.length) {
        // Line numbers + the first characters (inline "(ב)" markers split a unit per seif / verse).
        const content = await db.all('SELECT line_index AS line, substr(clean_text, 1, 12) AS text FROM paragraphs WHERE book_id = ? AND is_heading = 0 ORDER BY line_index', [commId]);
        const parts = job.baseId != null ? new Map([[job.baseId, commUnits]]) : refAlign.multiUnits(commUnits, refAlign.multiTargets(books, job.scope));
        for (const [baseId, units] of parts) {
          const aligned = await refAlign.alignUnits(await unitsOf(baseId), units, content, baseContentOf(baseId), {
            splitMarkers: refAlign.sharesInlineNumbering(byId.get(baseId).title),
          });
          for (const a of aligned) rowsOut.push([baseId, a.baseStart, a.baseEnd, commId, a.commStart, a.commEnd, a.refKey, refAlign.linkTypeFor(byId.get(commId).title)]);
        }
      }
      if (!inTx) {
        await db.exec('BEGIN');
        inTx = true;
      }
      // Idempotent per job (a resumed links phase may redo it).
      if (job.baseId != null) await db.run('DELETE FROM ref_links WHERE comm_book_id = ? AND base_book_id = ?', [commId, job.baseId]);
      else await db.run('DELETE FROM ref_links WHERE comm_book_id = ?', [commId]);
      await insertMany(db, 'INSERT INTO ref_links (base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key, link_type)', 8, rowsOut);
      stats.aligned++;
      stats.units += rowsOut.length;
      rowsOut = null;
      pending++;
      if (o.onBook) o.onBook({ index: i + 1, total: jobs.length, title: byId.get(commId).title });
      if (pending >= perTx) await commit(i + 1);
    }
    await commit(i);
  } catch (e) {
    if (inTx) await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return stats;
}

/**
 * Merges FTS segments and refreshes planner statistics after indexing.
 *
 * Default ('optimize'): one statement that rewrites the whole FTS index (fine on the PC).
 * `incremental: true` (on the device): repeated bounded FTS5 'merge' steps, each its own
 * short transaction followed by `onStep()` (e.g. a WAL checkpoint), so the WAL and memory
 * stay bounded on multi-GB libraries; `shouldStop()` may end it early (the index is valid
 * after every step, merely less compact). `optimize: false` skips the closing PRAGMA optimize
 * (the on-device finalize runs ANALYZE / optimize itself, as separate non-fatal steps).
 */
async function finalizeIndex(db, opts) {
  const o = opts || {};
  const hasFts = (await db.all("SELECT 1 AS ok FROM sqlite_master WHERE name = 'paragraphs_fts'", [])).length > 0;
  if (hasFts && o.incremental) {
    const pages = o.mergePages || 256;
    for (let i = 0; i < (o.maxSteps || 4000); i++) {
      if (o.shouldStop && o.shouldStop()) break;
      const before = Number((await db.all('SELECT total_changes() AS n', []))[0].n);
      await db.exec('BEGIN');
      try {
        await db.run('INSERT INTO paragraphs_fts(paragraphs_fts, rank) VALUES(?, ?)', ['merge', pages]);
        await db.exec('COMMIT');
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => undefined);
        throw e;
      }
      const after = Number((await db.all('SELECT total_changes() AS n', []))[0].n);
      if (o.onStep) await o.onStep(i + 1);
      // FTS5: fewer than 2 changed rows means there was nothing left to merge.
      if (after - before < 2) break;
    }
  } else if (hasFts) {
    await db.exec("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('optimize')");
  }
  // analysis_limit bounds ANALYZE to a sample per index (multi-GB libraries on a phone).
  if (o.analyze) await db.exec(o.analysisLimit ? `PRAGMA analysis_limit = ${Number(o.analysisLimit) | 0}; ANALYZE` : 'ANALYZE');
  if (o.optimize !== false) await db.exec('PRAGMA optimize');
}

/** Current totals of a library database (also written to meta). */
async function libraryCounts(db) {
  const one = async (sql) => Number((await db.all(sql, []))[0].n);
  return {
    books: await one('SELECT COUNT(*) AS n FROM books'),
    categories: await one('SELECT COUNT(*) AS n FROM categories'),
    paragraphs: await one('SELECT COUNT(*) AS n FROM paragraphs'),
    links: await one('SELECT COUNT(*) AS n FROM links'),
    refLinks: (await hasTable(db, 'ref_links')) ? await one('SELECT COUNT(*) AS n FROM ref_links') : 0,
    bookUnits: (await hasTable(db, 'book_units')) ? await one('SELECT COUNT(*) AS n FROM book_units') : 0,
    tocNodes: await one('SELECT COUNT(*) AS n FROM toc_nodes'),
  };
}

module.exports = {
  createBookParser,
  SCHEMA,
  INGESTION_SCHEMA,
  REF_LINKS_SCHEMA,
  BOOK_UNITS_SCHEMA,
  IMPORT_QUEUE_SCHEMA,
  createBookWriter,
  insertMany,
  maxId,
  hasTable,
  loadBookUnits,
  refLinkJobs,
  nowIso,
  errorMessage,
  IngestionStopped,
  migrateSchema,
  readIngestionState,
  writeIngestionState,
  clearIngestionState,
  readIngestionErrors,
  isResumableState,
  isIgnoredEntry,
  isBookFileName,
  looksLikeFileName,
  decodeUriName,
  SCHEMA_VERSION,
  USER_ID_BASE,
  EXTENDED_ID_BASE,
  USER_ROOT_NAME,
  ensureSchema,
  readMeta,
  writeMeta,
  sanitizeDisplay,
  plainHeading,
  parseBook,
  CANONICAL_ORDER,
  sortEntries,
  scanBooks,
  scanLinkFiles,
  mergeAliasOverrides,
  parseCsv,
  linkBookKey,
  makeBookMatcher,
  parseLinkFile,
  deleteBook,
  pruneEmptyCategories,
  indexBooks,
  indexLinks,
  indexRefLinks,
  finalizeIndex,
  libraryCounts,
};
