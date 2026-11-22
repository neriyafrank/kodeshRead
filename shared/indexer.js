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

/**
 * Bump when the schema or the parsing rules change (stored in meta.script_version).
 * 3: books.is_complete + ingestion_state / ingestion_errors (resumable imports). Readers never
 *    depend on them, so version-2 libraries stay fully usable.
 */
const SCHEMA_VERSION = 5;
/** First id of the personal library's namespace (core ids stay below it). */
const USER_ID_BASE = 1000000000;
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
    await migrateSchema(db);
    return false;
  }
  const ddl = ((await sqliteHasFts5(db)) ? SCHEMA : SCHEMA.replace(FTS_TABLE_RE, '')) + REF_LINKS_SCHEMA + INGESTION_SCHEMA;
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
 * (adds books.is_complete, the ingestion tables and ref_links). Idempotent and cheap.
 */
async function migrateSchema(db) {
  const cols = await db.all('PRAGMA table_info(books)', []);
  if (cols.length && !cols.some((c) => c.name === 'is_complete')) {
    await db.exec('ALTER TABLE books ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 1');
  }
  await db.exec(INGESTION_SCHEMA);
  await db.exec(REF_LINKS_SCHEMA);
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
 * Parse one Otzaria .txt book.
 * line_index = physical line number in the file (1-based, blank lines skipped),
 * which keeps Otzaria link indices valid. Headings are paragraphs too (is_heading=level).
 */
function parseBook(raw, fallbackTitle) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const paragraphs = [];
  const toc = []; // { parentIdx, level, title, refKey, startLine }
  const stack = []; // open headings: { level, tocIdx, title }
  let title = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lineIndex = i + 1;
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = Number(h[1]);
      const headingTitle = plainHeading(h[2]);
      if (level === 1) {
        if (!title) title = headingTitle;
        paragraphs.push({ lineIndex, tocPath: null, display: sanitizeDisplay(h[2]), clean: normalizeHebrew(h[2]), isHeading: 1 });
        continue;
      }
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      // refPath: canonical reference of the unit ("פרק א|פסוק א", "דף ב|עמוד א"), used to align commentaries.
      const labels = (parent ? parent.labels : []).concat(refAlign.unitLabels(headingTitle));
      toc.push({ parentIdx: parent ? parent.tocIdx : null, level, title: headingTitle, refKey: extractRefKey(headingTitle), refPath: refAlign.refKeyOf(labels), startLine: lineIndex });
      stack.push({ level, tocIdx: toc.length - 1, title: headingTitle, labels });
      paragraphs.push({ lineIndex, tocPath: stack.map((s) => s.title).join(' > '), display: sanitizeDisplay(h[2]), clean: normalizeHebrew(h[2]), isHeading: level });
      // Rare: text after a closing heading tag on the same line.
      if (h[3] && h[3].trim()) {
        const display = sanitizeDisplay(h[3]);
        if (display) paragraphs[paragraphs.length - 1].display += ' ' + display;
      }
      continue;
    }
    const content = line.replace(/^\s*<p\b[^>]*>/i, '').replace(/<\/p>\s*$/i, '');
    const display = sanitizeDisplay(content);
    if (!display) continue;
    paragraphs.push({
      lineIndex,
      tocPath: stack.length ? stack.map((s) => s.title).join(' > ') : null,
      display,
      clean: normalizeHebrew(content),
      isHeading: 0,
    });
  }
  return { title: title || fallbackTitle, paragraphs, toc, totalLines: paragraphs.length ? paragraphs[paragraphs.length - 1].lineIndex : 0 };
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
  return /\.txt$/i.test(name) && !String(name).startsWith('.');
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
const PARA_BATCH = 150; // rows per multi-row INSERT (6 params each)

async function insertMany(db, head, cols, rows) {
  const one = '(' + new Array(cols).fill('?').join(', ') + ')';
  for (let i = 0; i < rows.length; i += PARA_BATCH) {
    const chunk = rows.slice(i, i + PARA_BATCH);
    const params = [];
    for (const r of chunk) params.push(...r);
    await db.run(`${head} VALUES ${new Array(chunk.length).fill(one).join(', ')}`, params);
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

/** Removes one book (its FTS entries, paragraphs, TOC and links) from a database. */
async function deleteBook(db, bookId) {
  await db.run(
    `INSERT INTO paragraphs_fts(paragraphs_fts, rowid, clean_text, book_id, category_path, line_index)
     SELECT 'delete', id, clean_text, book_id, category_path, line_index FROM paragraphs_fts_source WHERE book_id = ?`,
    [bookId],
  );
  await db.run('DELETE FROM paragraphs WHERE book_id = ?', [bookId]);
  await db.run('DELETE FROM toc_nodes WHERE book_id = ?', [bookId]);
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

/**
 * Indexes book files into a database that already has the schema.
 *
 * Resumable & crash-safe:
 *  - every book is written inside its own SAVEPOINT and flagged books.is_complete = 1 only
 *    after its paragraphs, TOC and FTS rows are in; a book that throws (malformed file,
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
  const idBase = opts.idBase || 0;
  const prefix = opts.categoryPrefix || [];
  const overrides = opts.aliasOverrides || {};
  const perTx = Math.max(1, opts.booksPerTransaction || 1);
  const maxLines = Math.max(1, opts.maxLinesPerTransaction || 20000);
  const replace = opts.replaceExisting !== false;
  const ing = opts.ingestion || null;
  const isolate = typeof opts.onError === 'function';

  let catId = await maxId(db, 'categories', idBase);
  let bookId = await maxId(db, 'books', idBase);
  let tocId = await maxId(db, 'toc_nodes', idBase);
  let paraId = await maxId(db, 'paragraphs', idBase);

  const catIds = new Map(); // 'a/b' -> id
  for (const r of await db.all('SELECT id, path FROM categories', [])) catIds.set(r.path, r.id);
  let newCats = 0;
  let bookCats = null; // categories created by the book being written (forgotten on rollback)
  const ensureCategory = async (parts) => {
    const p = parts.join('/');
    if (catIds.has(p)) return catIds.get(p);
    const parentId = parts.length > 1 ? await ensureCategory(parts.slice(0, -1)) : null;
    const id = ++catId;
    await db.run('INSERT INTO categories (id, parent_id, name, path) VALUES (?, ?, ?, ?)', [id, parentId, parts[parts.length - 1], p]);
    catIds.set(p, id);
    if (bookCats) bookCats.push(p);
    newCats++;
    return id;
  };

  const files = opts.files || [];
  const stats = { books: 0, paragraphs: 0, tocNodes: 0, categories: 0, bookIds: [], skipped: 0, failed: 0, errors: [], processed: 0, stopped: null };

  // --- checkpoint -------------------------------------------------------------
  let baseBookId = bookId;
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
    if (prefix.length) await ensureCategory(prefix);
    for (const parts of opts.dirs || []) await ensureCategory(prefix.concat(parts));
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

      if (isolate) await db.exec('SAVEPOINT book');
      bookCats = [];
      let parsed;
      try {
        const raw = await fsa.readText(file.handle);
        if (opts.onFileRead) opts.onFileRead(file.rel.join('/'), raw);
        const fallback = file.name.replace(/\.[^.]+$/, '');
        parsed = parseBook(raw, fallback);
        const extra = [].concat(overrides[aliasKey(parsed.title)] || [], overrides[aliasKey(file.rel.join('/'))] || [], overrides[aliasKey(fallback)] || []);
        const aliases = generateBookAliases(prefix.concat(file.dir), parsed.title, extra);

        if (replace || resume) for (const o of old) await deleteBook(db, o.id);
        const dirParts = prefix.concat(file.dir);
        const categoryId = dirParts.length ? await ensureCategory(dirParts) : null;
        const id = ++bookId;
        // Stored as "|a|b|c|" so a single alias can also be matched in SQL with LIKE '%|alias|%'.
        await db.run('INSERT INTO books (id, category_id, title, aliases, file_path, total_lines, is_complete) VALUES (?, ?, ?, ?, ?, ?, 0)', [
          id, categoryId, parsed.title, '|' + aliases.join('|') + '|', relPath, parsed.totalLines,
        ]);
        const tocIds = [];
        const tocRows = [];
        for (const n of parsed.toc) {
          const nid = ++tocId;
          tocIds.push(nid);
          tocRows.push([nid, id, n.parentIdx == null ? null : tocIds[n.parentIdx], n.level, n.title, n.refKey, n.startLine]);
        }
        await insertMany(db, 'INSERT INTO toc_nodes (id, book_id, parent_id, level, title, ref_key, start_line)', 7, tocRows);
        const paraRows = parsed.paragraphs.map((p) => [++paraId, id, p.lineIndex, p.tocPath, p.display, p.clean, p.isHeading ? 1 : 0]);
        await insertMany(db, 'INSERT INTO paragraphs (id, book_id, line_index, toc_path, display_text, clean_text, is_heading)', 7, paraRows);
        await db.run(
          `INSERT INTO paragraphs_fts(rowid, clean_text, book_id, category_path, line_index)
           SELECT id, clean_text, book_id, category_path, line_index FROM paragraphs_fts_source WHERE book_id = ?`,
          [id],
        );
        await db.run('UPDATE books SET is_complete = 1 WHERE id = ?', [id]);
        if (isolate) await db.exec('RELEASE book');
        stats.books++;
        stats.paragraphs += parsed.paragraphs.length;
        stats.tocNodes += parsed.toc.length;
        stats.bookIds.push(id);
        pendingLines += parsed.paragraphs.length;
      } catch (e) {
        if (!isolate) throw e;
        await db.exec('ROLLBACK TO book');
        await db.exec('RELEASE book');
        for (const p of bookCats) catIds.delete(p);
        newCats -= bookCats.length;
        stats.failed++;
        const err = { relPath, message: errorMessage(e) };
        stats.errors.push(err);
        pendingErrors.push(err);
        opts.onError({ relPath, error: e });
        parsed = null;
      } finally {
        bookCats = null;
      }
      stats.processed = fi + 1;
      lastPath = relPath;
      pendingBooks++;
      if (parsed && opts.onBook) opts.onBook({ index: fi + 1, total: files.length, relPath, title: parsed.title, lines: parsed.paragraphs.length, tocNodes: parsed.toc.length });
      if (pendingBooks >= perTx || pendingLines >= maxLines) await commit();
      if (opts.yieldEvery) await opts.yieldEvery();
    }
    await begin();
    await commit(stats.stopped ? 'paused' : 'in_progress');
  } catch (e) {
    if (inTx) await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
  stats.categories = newCats;
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
 * Heading-based reference alignment (Otzaria): pairs every commentary book with its base
 * book (shared/refAlign.js pairCommentaries) and stores, for each commentary unit with its
 * own text, the base unit with the same canonical ref_key as a `ref_links` row of two line
 * ranges. Runs in the links phase, after all books are indexed.
 *
 * Idempotent and resumable: each commentary book's rows are replaced (DELETE + INSERT) in the
 * transaction that writes them, transactions are committed every `booksPerTransaction`
 * commentaries, and `shouldStop()` (polled between books) ends the run early with
 * `stopped` set; re-running the phase simply redoes the remaining books.
 *
 * @param {object} db  writer adapter
 * @param {{ bookIds?: number[], booksPerTransaction?: number, shouldStop?: () => any,
 *           onBook?: (p: { index, total, title }) => void, onCommit?: () => Promise<void> }} [opts]
 *   bookIds: only (re)align pairs that involve these books (a personal import).
 * @returns {Promise<{ pairs, aligned, units, stopped }>}
 */
async function indexRefLinks(db, opts) {
  const o = opts || {};
  const stats = { pairs: 0, aligned: 0, units: 0, stopped: null };
  if (!(await hasTable(db, 'ref_links'))) return stats;
  const rows = await db.all(
    `SELECT b.id, b.title, b.aliases, b.total_lines, COALESCE(c.path, '') AS category_path
       FROM books b LEFT JOIN categories c ON c.id = b.category_id WHERE b.is_complete = 1 ORDER BY b.id`,
    [],
  );
  const books = rows.map((r) => ({ id: r.id, title: r.title, aliases: String(r.aliases).split('|').filter(Boolean), categoryPath: r.category_path, totalLines: r.total_lines }));
  const byId = new Map(books.map((b) => [b.id, b]));
  let pairs = refAlign.pairCommentaries(books);
  if (o.bookIds) {
    const only = new Set(o.bookIds);
    pairs = pairs.filter((p) => only.has(p.commId) || only.has(p.baseId));
  }
  stats.pairs = pairs.length;
  // Base books are reused by many commentaries (רש"י, רמב"ן, ... על בראשית): keep a few cached.
  const unitCache = new Map();
  const unitsOf = async (id) => {
    let u = unitCache.get(id);
    if (!u) {
      const nodes = await db.all('SELECT id, parent_id, level, title, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [id]);
      u = refAlign.bookUnits(nodes, byId.get(id).totalLines);
      if (unitCache.size > 16) unitCache.delete(unitCache.keys().next().value);
      unitCache.set(id, u);
    }
    return u;
  };
  const perTx = Math.max(1, o.booksPerTransaction || 20);
  let inTx = false;
  let pending = 0;
  const commit = async () => {
    if (!inTx) return;
    await db.exec('COMMIT');
    inTx = false;
    pending = 0;
    if (o.onCommit) await o.onCommit();
  };
  try {
    for (let i = 0; i < pairs.length; i++) {
      const stop = o.shouldStop ? o.shouldStop() : null;
      if (stop) {
        stats.stopped = stop;
        break;
      }
      const { commId, baseId } = pairs[i];
      const baseUnits = await unitsOf(baseId);
      const commNodes = await db.all('SELECT id, parent_id, level, title, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [commId]);
      const commUnits = refAlign.bookUnits(commNodes, byId.get(commId).totalLines);
      // Line numbers + the first characters (inline "(ב)" markers split a unit per seif / verse).
      const content = (await db.all('SELECT line_index AS line, substr(clean_text, 1, 12) AS text FROM paragraphs WHERE book_id = ? AND is_heading = 0', [commId]));
      const aligned = await refAlign.alignUnits(baseUnits, commUnits, content, (unit) =>
        db
          .all('SELECT line_index AS line, clean_text AS text FROM paragraphs WHERE book_id = ? AND line_index > ? AND line_index <= ? AND is_heading = 0 ORDER BY line_index', [baseId, unit.start, unit.end])
          .then((r) => r.map((x) => ({ line: x.line, text: String(x.text).slice(0, 12) }))),
      );
      if (!inTx) {
        await db.exec('BEGIN');
        inTx = true;
      }
      await db.run('DELETE FROM ref_links WHERE comm_book_id = ? AND base_book_id = ?', [commId, baseId]);
      await insertMany(
        db,
        'INSERT INTO ref_links (base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key, link_type)',
        8,
        aligned.map((a) => [baseId, a.baseStart, a.baseEnd, commId, a.commStart, a.commEnd, a.refKey, refAlign.linkTypeFor(byId.get(commId).title)]),
      );
      stats.aligned++;
      stats.units += aligned.length;
      pending++;
      if (o.onBook) o.onBook({ index: i + 1, total: pairs.length, title: byId.get(commId).title });
      if (pending >= perTx) await commit();
    }
    await commit();
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
 * after every step, merely less compact).
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
  if (o.analyze) await db.exec('ANALYZE');
  await db.exec('PRAGMA optimize');
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
    tocNodes: await one('SELECT COUNT(*) AS n FROM toc_nodes'),
  };
}

module.exports = {
  SCHEMA,
  INGESTION_SCHEMA,
  REF_LINKS_SCHEMA,
  IngestionStopped,
  migrateSchema,
  readIngestionState,
  writeIngestionState,
  clearIngestionState,
  readIngestionErrors,
  isResumableState,
  isIgnoredEntry,
  isBookFileName,
  SCHEMA_VERSION,
  USER_ID_BASE,
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
