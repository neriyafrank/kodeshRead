#!/usr/bin/env node
/**
 * Build-time ingestion: Otzaria folders -> assets/db/library.db (SQLite + FTS5).
 *
 *   node scripts/build-db.js --source=sample        # raw_library/sample (tracked in git)
 *   node scripts/build-db.js --source=full          # raw_library/full   (git-ignored)
 *   node scripts/build-db.js --source=sample --if-missing   # no-op when the DB already exists
 *
 * Options:
 *   --out=<path>        output DB (default assets/db/library.db)
 *   --links=<dir>       links folder (default raw_links/)
 *
 * Requires Node >= 22.13 (built-in `node:sqlite`, which ships with FTS5). If
 * `better-sqlite3` is installed it is used as a fallback on older Node versions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  normalizeHebrew,
  extractRefKey,
  generateBookAliases,
  aliasKey,
  decodeEntities,
  stripHtml,
} = require('../shared/hebrew');

const SCRIPT_VERSION = 1; // bump when the schema or parsing rules change
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { source: 'sample', out: path.join(ROOT, 'assets/db/library.db'), links: path.join(ROOT, 'raw_links'), ifMissing: false };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'source') args.source = v;
    else if (k === 'out') args.out = path.resolve(v);
    else if (k === 'links') args.links = path.resolve(v);
    else if (k === 'if-missing') args.ifMissing = true;
    else if (k === 'help') args.help = true;
    else throw new Error(`Unknown option --${k}`);
  }
  if (!['sample', 'full'].includes(args.source) && !fs.existsSync(path.resolve(args.source))) {
    throw new Error(`--source must be "sample", "full" or a folder path (got "${args.source}")`);
  }
  args.sourceDir = ['sample', 'full'].includes(args.source) ? path.join(ROOT, 'raw_library', args.source) : path.resolve(args.source);
  return args;
}

// ---------------------------------------------------------------------------
// SQLite driver (node:sqlite, or better-sqlite3 as fallback)
// ---------------------------------------------------------------------------
function openDb(file) {
  try {
    // Silence the one-line ExperimentalWarning printed by some Node 22 builds.
    const origEmit = process.emitWarning;
    process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...rest));
    const { DatabaseSync } = require('node:sqlite');
    process.emitWarning = origEmit;
    return new DatabaseSync(file);
  } catch (e) {
    try {
      const Better = require('better-sqlite3');
      return new Better(file);
    } catch {
      throw new Error('No SQLite driver: use Node >= 22.13 (node:sqlite) or `npm i -D better-sqlite3`.\n' + e.message);
    }
  }
}

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
  total_lines INTEGER NOT NULL
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
`;

// ---------------------------------------------------------------------------
// Text sanitization
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
 * which keeps Otzaria link indices valid. Headings are paragraphs too (is_heading=1).
 */
function parseBook(raw, fallbackTitle) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const paragraphs = [];
  const toc = []; // { idx, parentIdx, level, title, refKey, startLine }
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
      toc.push({ parentIdx: parent ? parent.tocIdx : null, level, title: headingTitle, refKey: extractRefKey(headingTitle), startLine: lineIndex });
      stack.push({ level, tocIdx: toc.length - 1, title: headingTitle });
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
// Library walk
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

function sortEntries(dir, entries) {
  let local = null;
  const orderFile = path.join(dir, 'order.json');
  if (fs.existsSync(orderFile)) local = new Map(JSON.parse(fs.readFileSync(orderFile, 'utf8')).map((n, i) => [aliasKey(n), i]));
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
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'he');
  });
}

function walk(dir, rel = []) {
  const out = { dirs: [], files: [] };
  const entries = sortEntries(dir, fs.readdirSync(dir, { withFileTypes: true }));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.dirs.push(rel.concat(e.name));
      const sub = walk(full, rel.concat(e.name));
      out.dirs.push(...sub.dirs);
      out.files.push(...sub.files);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.txt')) {
      out.files.push({ full, rel: rel.concat(e.name), dir: rel });
    }
  }
  return out;
}

function loadAliasOverrides(sourceDir) {
  const merged = {};
  for (const f of [path.join(ROOT, 'raw_library', 'aliases.json'), path.join(sourceDir, 'aliases.json')]) {
    if (!fs.existsSync(f)) continue;
    const data = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
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
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

function makeBookMatcher(books) {
  const byKey = new Map();
  const put = (k, id) => { if (k && !byKey.has(k)) byKey.set(k, id); };
  for (const b of books) put(aliasKey(b.title), b.id);
  for (const b of books) put(aliasKey(path.basename(b.filePath, '.txt')), b.id);
  for (const b of books) for (const a of b.aliases) put(a, b.id);
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    let base = String(name).replace(/\\/g, '/').split('/').pop().replace(/\.(txt|json|csv)$/i, '').replace(/_links$/i, '');
    const k = aliasKey(base);
    let id = byKey.get(k);
    if (id === undefined) {
      // Fuzzy: unique title containing / contained in the key.
      const cands = books.filter((b) => { const t = aliasKey(b.title); return t.includes(k) || k.includes(t); });
      id = cands.length === 1 ? cands[0].id : null;
    }
    cache.set(name, id);
    return id;
  };
}

function loadLinks(linksDir, books) {
  const result = { links: [], unmatched: new Map() };
  if (!fs.existsSync(linksDir)) return result;
  const match = makeBookMatcher(books);
  const miss = (n) => result.unmatched.set(n, (result.unmatched.get(n) || 0) + 1);
  const add = (srcName, srcLine, tgtName, tgtLine, type) => {
    const a = match(srcName);
    const b = match(tgtName);
    if (a == null) return miss(srcName);
    if (b == null) return miss(tgtName);
    const la = Number(srcLine);
    const lb = Number(tgtLine);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) return;
    result.links.push([a, la, b, lb, type || null]);
  };
  const files = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) rec(f);
      else if (/\.(csv|json)$/i.test(e.name)) files.push(f);
    }
  })(linksDir);
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    if (f.toLowerCase().endsWith('.csv')) {
      const rows = parseCsv(raw);
      const header = rows[0] && rows[0].map((h) => h.toLowerCase());
      const hasHeader = header && header.includes('source_book');
      const col = (n, d) => (hasHeader ? header.indexOf(n) : d);
      const [sb, sl, tb, tl, lt] = [col('source_book', 0), col('source_line', 1), col('target_book', 2), col('target_line', 3), col('link_type', 4)];
      for (const r of rows.slice(hasHeader ? 1 : 0)) add(r[sb], r[sl], r[tb], r[tl], r[lt]);
    } else {
      const data = JSON.parse(raw.replace(/^﻿/, ''));
      const arr = Array.isArray(data) ? data : data.links || [];
      const fileBook = path.basename(f, '.json').replace(/_links$/i, '');
      for (const l of arr) {
        if (l.source_book !== undefined) add(l.source_book, l.source_line, l.target_book, l.target_line, l.link_type);
        // Otzaria native: { line_index_1, line_index_2, path_2, "Conection Type" }
        else add(fileBook, l.line_index_1, l.path_2, l.line_index_2, l['Conection Type'] || l.connectionType || l.link_type);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  const versionFile = path.join(path.dirname(args.out), 'db-version.json');
  if (args.ifMissing && fs.existsSync(args.out) && fs.existsSync(versionFile)) {
    console.log(`[build-db] ${path.relative(ROOT, args.out)} exists, skipping (--if-missing).`);
    return;
  }
  if (!fs.existsSync(args.sourceDir)) throw new Error(`Source folder not found: ${args.sourceDir}`);

  const t0 = Date.now();
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const tmp = args.out + '.tmp';
  for (const f of [tmp, tmp + '-journal', tmp + '-wal', tmp + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

  const db = openDb(tmp);
  db.exec('PRAGMA page_size = 4096; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);

  const overrides = loadAliasOverrides(args.sourceDir);
  const hash = crypto.createHash('sha1').update(`v${SCRIPT_VERSION}|${args.source}|`);
  hash.update(fs.readFileSync(path.join(ROOT, 'shared/hebrew.js')));
  hash.update(fs.readFileSync(__filename));
  hash.update(JSON.stringify(overrides));

  const tree = walk(args.sourceDir);
  const insCat = db.prepare('INSERT INTO categories (id, parent_id, name, path) VALUES (?, ?, ?, ?)');
  const insBook = db.prepare('INSERT INTO books (id, category_id, title, aliases, file_path, total_lines) VALUES (?, ?, ?, ?, ?, ?)');
  const insToc = db.prepare('INSERT INTO toc_nodes (id, book_id, parent_id, level, title, ref_key, start_line) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insPara = db.prepare('INSERT INTO paragraphs (book_id, line_index, toc_path, display_text, clean_text, is_heading) VALUES (?, ?, ?, ?, ?, ?)');

  db.exec('BEGIN');
  const catIds = new Map(); // 'a/b' -> id
  let catId = 0;
  for (const parts of tree.dirs) {
    const p = parts.join('/');
    if (catIds.has(p)) continue;
    const parentId = parts.length > 1 ? catIds.get(parts.slice(0, -1).join('/')) : null;
    catIds.set(p, ++catId);
    insCat.run(catId, parentId ?? null, parts[parts.length - 1], p);
  }

  const books = [];
  let bookId = 0;
  let tocId = 0;
  let paraCount = 0;
  for (const file of tree.files) {
    const raw = fs.readFileSync(file.full, 'utf8');
    hash.update(file.rel.join('/')).update(raw);
    const fallback = path.basename(file.full, path.extname(file.full));
    const parsed = parseBook(raw, fallback);
    const relPath = file.rel.join('/');
    const extra = [].concat(overrides[aliasKey(parsed.title)] || [], overrides[aliasKey(relPath)] || [], overrides[aliasKey(fallback)] || []);
    const aliases = generateBookAliases(file.dir, parsed.title, extra);
    const id = ++bookId;
    // Stored as "|a|b|c|" so a single alias can also be matched in SQL with LIKE '%|alias|%'.
    insBook.run(id, file.dir.length ? catIds.get(file.dir.join('/')) : null, parsed.title, '|' + aliases.join('|') + '|', relPath, parsed.totalLines);
    const tocIds = [];
    for (const n of parsed.toc) {
      const nid = ++tocId;
      tocIds.push(nid);
      insToc.run(nid, id, n.parentIdx == null ? null : tocIds[n.parentIdx], n.level, n.title, n.refKey, n.startLine);
    }
    for (const p of parsed.paragraphs) insPara.run(id, p.lineIndex, p.tocPath, p.display, p.clean, p.isHeading ? 1 : 0);
    paraCount += parsed.paragraphs.length;
    books.push({ id, title: parsed.title, filePath: relPath, aliases });
    console.log(`[build-db] ${relPath}: ${parsed.paragraphs.length} lines, ${parsed.toc.length} TOC nodes`);
  }

  // Links
  const { links, unmatched } = loadLinks(args.links, books);
  const insLink = db.prepare('INSERT INTO links (book_a_id, line_a, book_b_id, line_b, link_type) VALUES (?, ?, ?, ?, ?)');
  for (const l of links) insLink.run(...l);
  if (unmatched.size) {
    console.warn(`[build-db] WARNING: ${unmatched.size} unmatched book name(s) in links:`);
    for (const [n, c] of unmatched) console.warn(`   - "${n}" (${c} link${c > 1 ? 's' : ''})`);
  }
  db.exec('COMMIT');

  // Aliases that point to more than one book are ambiguous for Quick Jump; report them.
  const aliasOwners = new Map();
  for (const b of books) for (const a of b.aliases) aliasOwners.set(a, (aliasOwners.get(a) || []).concat(b.title));
  const ambiguous = [...aliasOwners].filter(([, v]) => v.length > 1);
  if (ambiguous.length) {
    console.log(`[build-db] note: ${ambiguous.length} alias(es) shared by several books (Quick Jump shows all matches), e.g.:`);
    for (const [a, v] of ambiguous.slice(0, 8)) console.log(`   - "${a}": ${v.join(', ')}`);
  }

  db.exec("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('rebuild')");
  db.exec("INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('optimize')");

  const version = hash.digest('hex').slice(0, 12);
  const builtAt = new Date().toISOString();
  const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({ db_version: version, built_at: builtAt, source: args.source, script_version: String(SCRIPT_VERSION), books: String(books.length), paragraphs: String(paraCount), links: String(links.length) })) insMeta.run(k, v);
  db.exec('ANALYZE; PRAGMA optimize; VACUUM;');
  db.close();

  for (const f of [args.out, args.out + '-journal', args.out + '-wal', args.out + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
  fs.renameSync(tmp, args.out);
  fs.writeFileSync(versionFile, JSON.stringify({ version, builtAt, source: args.source, books: books.length, paragraphs: paraCount }, null, 2) + '\n');

  const size = (fs.statSync(args.out).size / 1024 / 1024).toFixed(2);
  console.log(`[build-db] done: ${books.length} books, ${catIds.size} categories, ${paraCount} paragraphs, ${links.length} links, ${tocId} TOC nodes`);
  console.log(`[build-db] ${path.relative(ROOT, args.out)} (${size} MB), DB_VERSION=${version}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[build-db] FAILED:', e.message);
    process.exit(1);
  }
}

module.exports = { parseBook, sanitizeDisplay, loadLinks, makeBookMatcher };
