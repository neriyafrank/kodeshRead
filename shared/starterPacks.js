/**
 * Cloud starter packs: a small curated set of well-known base books (with their primary
 * commentaries) that a new user loads on demand from GitHub Releases, before deciding to download
 * the multi-GB offline library.
 *
 *   build side (scripts/export-starter-packs.js, runs in the cloud build on the fresh core_library.db)
 *     selectStarterBooks()   curated list -> books actually present in the DB (canonical order)
 *     buildStarterPack()     one pack = base book + bundled commentaries + their ref_links
 *     packToBytes()          deterministic gzipped JSON  (starter-<slug>.json.gz)
 *     buildStarterCatalog()  starter-catalog.json
 *
 *   app side (src/services/starterLibrary.ts)
 *     validateStarterCatalog() / verifyPackBytes() / decodePack()  untrusted download -> verified pack
 *     importStarterPack()    one SQLite transaction into starter_library.db: books, TOC, paragraphs,
 *                            FTS rows and ref_links; idempotent and collision-free
 *
 * Everything is pure JS over the writer adapter of shared/indexer.js ({ exec, run, all }), so the
 * self-tests run the exact import code of the phone on an in-memory node:sqlite database.
 *
 * Ids: a pack keeps the ids of the core library it was exported from. Inside the starter DB they are
 * preserved when free (the full library of the same release then has the very same ids, so open tabs
 * survive the upgrade) and remapped cleanly when they collide with rows of another release.
 */
'use strict';


/**
 * Compression codec. No top-level dependency: Node-only callers (CI export script, which runs without
 * node_modules) pass `{ gzipSync, gunzipSync }` from Node's built-in zlib; the app passes nothing and
 * `fflate` is loaded lazily on first use. This file never requires 'zlib' (Metro must not bundle it).
 */
let fflateModule = null;
function fflate() {
  if (!fflateModule) fflateModule = require('fflate');
  return fflateModule;
}
function utf8Encode(str) {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(str) : fflate().strToU8(str);
}
function utf8Decode(bytes) {
  return typeof TextDecoder === 'function' ? new TextDecoder('utf-8').decode(bytes) : fflate().strFromU8(bytes);
}
const { aliasKey } = require('./hebrew');
const pairing = require('./pairing');
const libraryCatalog = require('./libraryCatalog');

const STARTER_RELEASE_TAG = 'starter-latest';
const STARTER_CATALOG_NAME = 'starter-catalog.json';
const PACK_FORMAT = 'kodeshread-starter-pack';
const PACK_FORMAT_VERSION = 1;
const CATALOG_FORMAT_VERSION = 1;
/** Rows per multi-row INSERT (8 columns x 150 = 1200 bound variables, far below SQLite's limit). */
const INSERT_BATCH = 150;
/** FTS rows per statement (same bound as the indexer). */
const FTS_BATCH = 2000;

const packFileName = (slug) => `starter-${slug}.json.gz`;

/**
 * The curated list. `titles` are matched on the normalized title (aliasKey: no quotes / commas /
 * niqqud) inside `corpus` (shared/pairing.js placeOf: tanach, mishna, bavli, halacha, ...), in a
 * non-commentary folder. `commentators` are commentator keys of shared/commentaryRank.js (the `key`
 * of catalog.commentariesOf), bundled when present. Books missing from a library are skipped.
 */
const STARTER_BOOKS = [
  { slug: 'genesis', title: 'בראשית', titles: ['בראשית'], corpus: 'tanach', author: 'תורה', commentators: ['רשי', 'אונקלוס'] },
  { slug: 'exodus', title: 'שמות', titles: ['שמות'], corpus: 'tanach', author: 'תורה', commentators: ['רשי', 'אונקלוס'] },
  { slug: 'leviticus', title: 'ויקרא', titles: ['ויקרא'], corpus: 'tanach', author: 'תורה', commentators: ['רשי', 'אונקלוס'] },
  { slug: 'numbers', title: 'במדבר', titles: ['במדבר'], corpus: 'tanach', author: 'תורה', commentators: ['רשי', 'אונקלוס'] },
  { slug: 'deuteronomy', title: 'דברים', titles: ['דברים'], corpus: 'tanach', author: 'תורה', commentators: ['רשי', 'אונקלוס'] },
  { slug: 'psalms', title: 'תהילים', titles: ['תהילים', 'תהלים'], corpus: 'tanach', author: 'דוד המלך', commentators: ['רשי'] },
  { slug: 'mishna-avot', title: 'משנה אבות', titles: ['משנה אבות', 'אבות'], corpus: 'mishna', author: 'תנאים', commentators: [] },
  { slug: 'mishna-berachot', title: 'משנה ברכות', titles: ['משנה ברכות', 'ברכות'], corpus: 'mishna', author: 'תנאים', commentators: [] },
  { slug: 'bavli-berachot', title: 'ברכות', titles: ['ברכות'], corpus: 'bavli', author: 'תלמוד בבלי', commentators: ['רשי', 'תוספות'] },
  { slug: 'bavli-shabbat', title: 'שבת', titles: ['שבת'], corpus: 'bavli', author: 'תלמוד בבלי', commentators: ['רשי', 'תוספות'] },
  { slug: 'shulchan-aruch-orach-chaim', title: 'שולחן ערוך אורח חיים', titles: ['שולחן ערוך אורח חיים'], corpus: 'halacha', author: 'רבי יוסף קארו', commentators: [] },
  { slug: 'mesilat-yesharim', title: 'מסילת ישרים', titles: ['מסילת ישרים'], corpus: null, author: 'רמח"ל', commentators: [] },
  { slug: 'kuzari', title: 'ספר הכוזרי', titles: ['ספר הכוזרי', 'הכוזרי', 'כוזרי'], corpus: null, author: 'רבי יהודה הלוי', commentators: [] },
  { slug: 'rambam-deot', title: 'משנה תורה, הלכות דעות', titles: ['משנה תורה הלכות דעות', 'הלכות דעות'], corpus: 'halacha', author: 'הרמב"ם', commentators: [] },
  { slug: 'rambam-teshuva', title: 'משנה תורה, הלכות תשובה', titles: ['משנה תורה הלכות תשובה', 'הלכות תשובה'], corpus: 'halacha', author: 'הרמב"ם', commentators: [] },
];

// ---------------------------------------------------------------------------
// Selection (build side)
// ---------------------------------------------------------------------------

/**
 * Starter books present in a library, in canonical catalog order (shared/libraryCatalog.js).
 * @param {{ categories: any[], books: any[] }} data  as shared/sources.js loadCatalog() returns
 * @returns {{ spec, baseId: number, title: string, categoryPath: string, section: string[], commentaries: { id, title, key, name }[] }[]}
 */
function selectStarterBooks(data, specs = STARTER_BOOKS) {
  const catalog = libraryCatalog.buildLibraryCatalog(data);
  const cats = new Map(data.categories.map((c) => [c.id, c]));
  const order = new Map(libraryCatalog.treeBookIds(catalog.sections).map((id, i) => [id, i]));
  // Section names above every base book of the catalog tree (תנ"ך › תורה).
  const sectionOf = new Map();
  const walk = (nodes, names) => {
    for (const n of nodes) {
      if (n.kind === 'section') walk(n.children, [...names, n.name]);
      else sectionOf.set(n.bookId, names);
    }
  };
  walk(catalog.sections, []);

  const out = [];
  for (const spec of specs) {
    const wanted = new Set(spec.titles.map(aliasKey));
    const exact = aliasKey(spec.titles[0]);
    const found = data.books
      .map((b) => ({ b, path: (cats.get(b.category_id) || {}).path || '' }))
      .filter(({ b, path }) => {
        if (!wanted.has(aliasKey(b.title))) return false;
        const place = pairing.placeOf(path);
        // Scripture / halacha books live in primary folders; free-standing works (מחשבת ישראל / מוסר
        // keep their authors in ראשונים / אחרונים folders) only need not to be a commentary.
        if (spec.corpus && (!place.primary || place.corpus !== spec.corpus)) return false;
        return !catalog.isCommentary(b.id);
      })
      // The spec's first title wins over its variants, then the lowest id.
      .sort((x, y) => Number(aliasKey(y.b.title) === exact) - Number(aliasKey(x.b.title) === exact) || x.b.id - y.b.id);
    if (!found.length) continue;
    const { b, path } = found[0];
    const comms = [];
    const seen = new Set();
    for (const c of catalog.commentariesOf(b.id)) {
      if (!spec.commentators.includes(c.key) || seen.has(c.key)) continue;
      seen.add(c.key);
      comms.push({ id: c.bookId, title: c.title, key: c.key, name: c.name });
    }
    comms.sort((x, y) => spec.commentators.indexOf(x.key) - spec.commentators.indexOf(y.key));
    out.push({ spec, baseId: b.id, title: b.title, categoryPath: path, section: sectionOf.get(b.id) || [], commentaries: comms, rank: order.has(b.id) ? order.get(b.id) : 1e9 });
  }
  return out.sort((a, b) => a.rank - b.rank || STARTER_BOOKS.indexOf(a.spec) - STARTER_BOOKS.indexOf(b.spec));
}

// ---------------------------------------------------------------------------
// Pack building (build side)
// ---------------------------------------------------------------------------

const inList = (n) => new Array(n).fill('?').join(', ');

/** Rows are positional arrays (the file stays small); this documents the column order. */
const PACK_COLUMNS = {
  categories: ['id', 'parent_id', 'name', 'path'],
  books: ['id', 'category_id', 'title', 'aliases', 'file_path', 'total_lines', 'role'],
  toc: ['id', 'book_id', 'parent_id', 'level', 'title', 'ref_key', 'start_line'],
  paragraphs: ['id', 'book_id', 'line_index', 'toc_path', 'display_text', 'clean_text', 'is_heading'],
  refLinks: ['base_book_id', 'base_start', 'base_end', 'comm_book_id', 'comm_start', 'comm_end', 'ref_key', 'link_type'],
};

/** One pack: base book + bundled commentaries (metadata, TOC, paragraphs) + the ref_links between them. */
async function buildStarterPack(db, sel, meta) {
  const ids = [sel.baseId, ...sel.commentaries.map((c) => c.id)];
  const marks = inList(ids.length);
  const books = await db.all(`SELECT id, category_id, title, aliases, file_path, total_lines FROM books WHERE id IN (${marks}) ORDER BY id`, ids);
  if (books.length !== ids.length) throw new Error(`starter pack ${sel.spec.slug}: ${ids.length - books.length} book(s) missing from the database`);
  const allCats = await db.all('SELECT id, parent_id, name, path FROM categories ORDER BY id', []);
  const catById = new Map(allCats.map((c) => [c.id, c]));
  const needed = new Map();
  for (const b of books) {
    for (let c = catById.get(b.category_id), n = 0; c && n < 20; c = c.parent_id != null ? catById.get(c.parent_id) : null, n++) needed.set(c.id, c);
  }
  const categories = [...needed.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.id - b.id);
  const role = (id) => (id === sel.baseId ? 'base' : 'commentary');
  const toc = await db.all(`SELECT id, book_id, parent_id, level, title, ref_key, start_line FROM toc_nodes WHERE book_id IN (${marks}) ORDER BY id`, ids);
  const paragraphs = [];
  for (const id of ids) {
    const rows = await db.all('SELECT id, book_id, line_index, toc_path, display_text, clean_text, is_heading FROM paragraphs WHERE book_id = ? ORDER BY id', [id]);
    for (const r of rows) paragraphs.push([r.id, r.book_id, r.line_index, r.toc_path, r.display_text, r.clean_text, r.is_heading ? 1 : 0]);
  }
  const commIds = ids.slice(1);
  const refLinks = commIds.length
    ? await db.all(
        `SELECT base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key, link_type FROM ref_links
         WHERE base_book_id = ? AND comm_book_id IN (${inList(commIds.length)}) ORDER BY id`,
        [sel.baseId, ...commIds],
      )
    : [];
  const pack = {
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    slug: sel.spec.slug,
    title: sel.title,
    dbVersion: (meta && meta.dbVersion) || null,
    builtAt: (meta && meta.builtAt) || null,
    baseBookId: sel.baseId,
    columns: PACK_COLUMNS,
    categories: categories.map((c) => [c.id, c.parent_id, c.name, c.path]),
    books: books.map((b) => [b.id, b.category_id, b.title, b.aliases, b.file_path, b.total_lines, role(b.id)]),
    toc: toc.map((t) => [t.id, t.book_id, t.parent_id, t.level, t.title, t.ref_key, t.start_line]),
    paragraphs,
    refLinks: refLinks.map((r) => [r.base_book_id, r.base_start, r.base_end, r.comm_book_id, r.comm_start, r.comm_end, r.ref_key, r.link_type]),
  };
  pack.counts = { books: pack.books.length, toc: pack.toc.length, paragraphs: pack.paragraphs.length, refLinks: pack.refLinks.length };
  return validatePack(pack);
}

/** Deterministic gzip (mtime 0): the same pack always hashes the same. */
function packToBytes(pack, codec) {
  const raw = utf8Encode(JSON.stringify(pack));
  if (codec && codec.gzipSync) return new Uint8Array(codec.gzipSync(raw));
  return fflate().gzipSync(raw, { level: 9, mtime: 0 });
}

/** @param {{ sel, pack, bytes: Uint8Array, sha256: string }[]} items  in canonical order */
function buildStarterCatalog(items, meta) {
  return validateStarterCatalog({
    formatVersion: CATALOG_FORMAT_VERSION,
    version: (meta && meta.dbVersion) || 'unknown',
    builtAt: (meta && meta.builtAt) || new Date().toISOString(),
    books: items.map(({ sel, pack, bytes, sha256 }) => ({
      slug: sel.spec.slug,
      title: sel.title,
      category: sel.section[0] || '',
      subcategory: sel.section.slice(1).join(' › '),
      author: sel.spec.author || '',
      packFile: packFileName(sel.spec.slug),
      sizeBytes: bytes.length,
      sha256,
      filePath: pack.books.find((b) => b[0] === pack.baseBookId)[4],
      paragraphs: pack.counts.paragraphs,
      bundledCommentaries: sel.commentaries.map((c) => ({ title: c.title, name: c.name })),
    })),
  });
}

// ---------------------------------------------------------------------------
// Validation / decoding (app side: the download is untrusted)
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_PACK_FILE = /^starter-[a-z0-9-]+\.json\.gz$/;

function validateStarterCatalog(json) {
  const bad = (m) => {
    throw new Error(`starter-catalog.json: ${m}`);
  };
  if (!json || typeof json !== 'object') bad('not an object');
  if (json.formatVersion != null && json.formatVersion > CATALOG_FORMAT_VERSION) bad('needs a newer app');
  if (!Array.isArray(json.books)) bad('books is missing');
  const slugs = new Set();
  const books = json.books.map((b, i) => {
    if (!b || typeof b.slug !== 'string' || !/^[a-z0-9-]+$/.test(b.slug)) bad(`book ${i} has no valid slug`);
    if (slugs.has(b.slug)) bad(`duplicate slug ${b.slug}`);
    slugs.add(b.slug);
    if (typeof b.title !== 'string' || !b.title) bad(`${b.slug}: no title`);
    if (typeof b.packFile !== 'string' || !SAFE_PACK_FILE.test(b.packFile)) bad(`${b.slug}: unsafe packFile`);
    const sizeBytes = Number(b.sizeBytes);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) bad(`${b.slug}: no sizeBytes`);
    const sha256 = String(b.sha256 || '').toLowerCase();
    if (!HEX64.test(sha256)) bad(`${b.slug}: no valid sha256`);
    return {
      slug: b.slug,
      title: b.title,
      category: String(b.category || ''),
      subcategory: String(b.subcategory || ''),
      author: String(b.author || ''),
      packFile: b.packFile,
      sizeBytes,
      sha256,
      filePath: String(b.filePath || ''),
      paragraphs: Number(b.paragraphs) || 0,
      bundledCommentaries: Array.isArray(b.bundledCommentaries) ? b.bundledCommentaries.map((c) => ({ title: String((c && c.title) || ''), name: String((c && c.name) || '') })) : [],
    };
  });
  return { formatVersion: CATALOG_FORMAT_VERSION, version: String(json.version || ''), builtAt: String(json.builtAt || ''), books };
}

/** Absolute URL of a pack: next to the catalog it was listed in. */
function packUrl(catalogUrl, entry) {
  return String(catalogUrl).replace(/[?#].*$/, '').replace(/[^/]*$/, '') + entry.packFile;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** sha256 (hex) of bytes: WebCrypto when there is one, else the pure-JS implementation (Hermes has none). */
async function sha256Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) return hex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  return sha256Js(bytes);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Js(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  view.setUint32(padded.length - 4, (len << 3) >>> 0, false);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const s = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + s[i]) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Checks size + SHA-256 of a downloaded pack against its catalog entry (throws a Hebrew message). */
async function verifyPackBytes(bytes, entry) {
  if (bytes.length !== entry.sizeBytes) throw new Error(`גודל החבילה (${bytes.length}) שונה מהצפוי (${entry.sizeBytes})`);
  if ((await sha256Hex(bytes)) !== entry.sha256) throw new Error('בדיקת SHA-256 של החבילה נכשלה: הקובץ פגום או שונה מהגרסה שפורסמה');
}

/** gunzip + parse + validate. */
function decodePack(bytes, codec) {
  let pack;
  try {
    const raw = codec && codec.gunzipSync ? codec.gunzipSync(bytes) : fflate().gunzipSync(bytes);
    pack = JSON.parse(utf8Decode(raw));
  } catch (e) {
    throw new Error(`חבילת הספר פגומה (${e && e.message ? e.message : e})`);
  }
  return validatePack(pack);
}

function validatePack(pack) {
  const bad = (m) => {
    throw new Error(`starter pack: ${m}`);
  };
  if (!pack || pack.format !== PACK_FORMAT) bad('not a kodeshRead starter pack');
  if (pack.formatVersion > PACK_FORMAT_VERSION) bad('needs a newer app');
  for (const k of ['categories', 'books', 'toc', 'paragraphs', 'refLinks']) if (!Array.isArray(pack[k])) bad(`${k} is missing`);
  if (!pack.books.some((b) => b[0] === pack.baseBookId && b[6] === 'base')) bad('base book is missing');
  const ids = new Set(pack.books.map((b) => b[0]));
  if (ids.size !== pack.books.length) bad('duplicate book ids');
  for (const p of pack.paragraphs) if (!ids.has(p[1])) bad('paragraph of an unknown book');
  for (const t of pack.toc) if (!ids.has(t[1])) bad('TOC node of an unknown book');
  for (const r of pack.refLinks) if (!ids.has(r[0]) || !ids.has(r[3])) bad('ref link of an unknown book');
  return pack;
}

// ---------------------------------------------------------------------------
// Import (app side, and the self-tests)
// ---------------------------------------------------------------------------

async function scalar(db, sql, params) {
  const r = await db.all(sql, params || []);
  if (!r.length) return null;
  const v = Object.values(r[0])[0];
  return v == null ? null : Number(v);
}

async function insertRows(db, head, cols, rows, map) {
  const one = '(' + new Array(cols).fill('?').join(', ') + ')';
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const end = Math.min(rows.length, i + INSERT_BATCH);
    const params = [];
    for (let j = i; j < end; j++) {
      const r = map(rows[j]);
      for (let k = 0; k < cols; k++) params.push(r[k]);
    }
    await db.run(`${head} VALUES ${new Array(end - i).fill(one).join(', ')}`, params);
  }
}

/**
 * Writes a pack into a starter database (created with indexer.ensureSchema) in ONE transaction:
 * a failure rolls everything back, a second import of the same book is a no-op.
 *
 * Books are identified by file_path. A book that is already there is reused, so re-opening never
 * duplicates a row; ids are kept when free and shifted past the current maximum when they collide
 * with another release's rows.
 *
 * @returns {Promise<{ slug, bookId: number, title: string, added: number, skipped: number, paragraphs: number, refLinks: number, idMap: Record<number, number> }>}
 */
async function importStarterPack(db, pack) {
  validatePack(pack);
  const hasFts = (await db.all("SELECT 1 AS ok FROM sqlite_master WHERE name = 'paragraphs_fts'", [])).length > 0;
  await db.exec('BEGIN');
  try {
    const result = await importInTransaction(db, pack, hasFts);
    await db.exec('COMMIT');
    return result;
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

async function importInTransaction(db, pack, hasFts) {
  const maxOf = async (table) => (await scalar(db, `SELECT MAX(id) FROM ${table}`)) || 0;

  // --- categories: matched by path, parents first ---------------------------------------------
  const catMap = new Map();
  for (const [id, parentId, name, path] of pack.categories) {
    const existing = await scalar(db, 'SELECT id FROM categories WHERE path = ?', [path]);
    if (existing != null) {
      catMap.set(id, existing);
      continue;
    }
    const newId = (await scalar(db, 'SELECT 1 FROM categories WHERE id = ?', [id])) == null ? id : (await maxOf('categories')) + 1;
    await db.run('INSERT INTO categories (id, parent_id, name, path) VALUES (?, ?, ?, ?)', [newId, parentId == null ? null : (catMap.get(parentId) ?? null), name, path]);
    catMap.set(id, newId);
  }

  // --- books ---------------------------------------------------------------------------------
  const bookMap = new Map();
  const fresh = new Set(); // old ids of the books written by this import
  let skipped = 0;
  for (const [id, categoryId, title, aliases, filePath, totalLines] of pack.books) {
    const existing = await db.all('SELECT id, is_complete FROM books WHERE file_path = ?', [filePath]);
    if (existing.length && Number(existing[0].is_complete) === 1) {
      bookMap.set(id, Number(existing[0].id));
      skipped++;
      continue;
    }
    if (existing.length) await removeBook(db, Number(existing[0].id), hasFts); // an incomplete leftover
    const newId = (await scalar(db, 'SELECT 1 FROM books WHERE id = ?', [id])) == null ? id : (await maxOf('books')) + 1;
    await db.run('INSERT INTO books (id, category_id, title, aliases, file_path, total_lines, is_complete) VALUES (?, ?, ?, ?, ?, ?, 0)', [
      newId,
      categoryId == null ? null : (catMap.get(categoryId) ?? null),
      title,
      aliases,
      filePath,
      totalLines,
    ]);
    bookMap.set(id, newId);
    fresh.add(id);
  }

  // --- TOC + paragraphs + FTS of the new books --------------------------------------------------
  const tocByBook = groupBy(pack.toc, 1);
  const paraByBook = groupBy(pack.paragraphs, 1);
  let paragraphs = 0;
  for (const oldId of fresh) {
    const bookId = bookMap.get(oldId);
    const tocRows = tocByBook.get(oldId) || [];
    if (tocRows.length) {
      const delta = await idDelta(db, 'toc_nodes', tocRows.map((r) => r[0]));
      await insertRows(db, 'INSERT INTO toc_nodes (id, book_id, parent_id, level, title, ref_key, start_line)', 7, tocRows, (r) => [r[0] + delta, bookId, r[2] == null ? null : r[2] + delta, r[3], r[4], r[5], r[6]]);
    }
    const rows = paraByBook.get(oldId) || [];
    if (rows.length) {
      const delta = await idDelta(db, 'paragraphs', rows.map((r) => r[0]));
      await insertRows(db, 'INSERT INTO paragraphs (id, book_id, line_index, toc_path, display_text, clean_text, is_heading)', 7, rows, (r) => [r[0] + delta, bookId, r[2], r[3], r[4], r[5], r[6]]);
      if (hasFts) {
        let first = Infinity;
        let last = -Infinity;
        for (const r of rows) {
          if (r[0] < first) first = r[0];
          if (r[0] > last) last = r[0];
        }
        for (let from = first + delta; from <= last + delta; from += FTS_BATCH) {
          await db.run(
            `INSERT INTO paragraphs_fts(rowid, clean_text, book_id, category_path, line_index)
             SELECT id, clean_text, book_id, category_path, line_index FROM paragraphs_fts_source WHERE id BETWEEN ? AND ? AND book_id = ?`,
            [from, Math.min(last + delta, from + FTS_BATCH - 1), bookId],
          );
        }
      }
      paragraphs += rows.length;
    }
    await db.run('UPDATE books SET is_complete = 1 WHERE id = ?', [bookId]);
  }

  // --- ref_links between the books (only those that involve a new book) ---------------------------
  const links = pack.refLinks.filter((r) => fresh.has(r[0]) || fresh.has(r[3]));
  const pairs = new Set(links.map((r) => `${bookMap.get(r[0])}:${bookMap.get(r[3])}`));
  for (const pair of pairs) {
    const [baseId, commId] = pair.split(':').map(Number);
    await db.run('DELETE FROM ref_links WHERE base_book_id = ? AND comm_book_id = ?', [baseId, commId]);
  }
  await insertRows(db, 'INSERT INTO ref_links (base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key, link_type)', 8, links, (r) => [
    bookMap.get(r[0]), r[1], r[2], bookMap.get(r[3]), r[4], r[5], r[6], r[7],
  ]);

  // --- bookkeeping: which packs are loaded ------------------------------------------------------
  const metaRows = await db.all("SELECT value FROM meta WHERE key = 'starter_loaded'", []);
  let loaded = {};
  try {
    loaded = metaRows.length ? JSON.parse(metaRows[0].value) : {};
  } catch {
    loaded = {};
  }
  loaded[pack.slug] = { dbVersion: pack.dbVersion, builtAt: pack.builtAt };
  await db.run("INSERT INTO meta (key, value) VALUES ('starter_loaded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(loaded)]);

  return {
    slug: pack.slug,
    bookId: bookMap.get(pack.baseBookId),
    title: pack.books.find((b) => b[0] === pack.baseBookId)[2],
    added: fresh.size,
    skipped,
    paragraphs,
    refLinks: links.length,
    idMap: Object.fromEntries(bookMap),
  };
}

function groupBy(rows, col) {
  const m = new Map();
  for (const r of rows) {
    const list = m.get(r[col]);
    if (list) list.push(r);
    else m.set(r[col], [r]);
  }
  return m;
}

/** 0 when the pack's id range is free in `table`, else the shift that moves it past every existing id. */
async function idDelta(db, table, ids) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of ids) {
    if (id < lo) lo = id;
    if (id > hi) hi = id;
  }
  if (!(await scalar(db, `SELECT COUNT(*) FROM ${table} WHERE id BETWEEN ? AND ?`, [lo, hi]))) return 0;
  const max = (await scalar(db, `SELECT MAX(id) FROM ${table}`)) || 0;
  return max + 1 - lo;
}

async function removeBook(db, bookId, hasFts) {
  if (hasFts) {
    await db.run(
      `INSERT INTO paragraphs_fts(paragraphs_fts, rowid, clean_text, book_id, category_path, line_index)
       SELECT 'delete', id, clean_text, book_id, category_path, line_index FROM paragraphs_fts_source WHERE book_id = ?`,
      [bookId],
    );
  }
  await db.run('DELETE FROM paragraphs WHERE book_id = ?', [bookId]);
  await db.run('DELETE FROM toc_nodes WHERE book_id = ?', [bookId]);
  await db.run('DELETE FROM ref_links WHERE base_book_id = ? OR comm_book_id = ?', [bookId, bookId]);
  await db.run('DELETE FROM books WHERE id = ?', [bookId]);
}

/** file_path of every complete book in a starter database (what is "available offline"). */
async function loadedFilePaths(db) {
  const rows = await db.all('SELECT file_path FROM books WHERE is_complete = 1', []);
  return new Set(rows.map((r) => r.file_path));
}

module.exports = {
  STARTER_RELEASE_TAG,
  STARTER_CATALOG_NAME,
  STARTER_BOOKS,
  PACK_FORMAT,
  PACK_FORMAT_VERSION,
  PACK_COLUMNS,
  packFileName,
  selectStarterBooks,
  buildStarterPack,
  packToBytes,
  buildStarterCatalog,
  validateStarterCatalog,
  validatePack,
  decodePack,
  verifyPackBytes,
  packUrl,
  sha256Hex,
  sha256Js,
  importStarterPack,
  loadedFilePaths,
};
