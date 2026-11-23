/**
 * Parallel commentaries & links (Otzaria-style), shared by the app and scripts/selftest.js.
 *
 * Two sources are merged:
 *  1. `links` (explicit Otzaria link files): one row per (book, line) pair, stored once in
 *     either orientation, so every lookup checks both sides — each has its own index.
 *  2. `ref_links` (schema v4, heading-based reference alignment, shared/refAlign.js): a
 *     commentary unit (every דיבור המתחיל under "פרק א" > "פסוק א") linked to the base
 *     unit with the same ref_key, as two line ranges. Selecting any line of a verse shows
 *     the whole commentary block of that verse, for every commentator; selecting a line of a
 *     commentary shows the base text of its unit.
 * Explicit links that point into a block already shown are dropped (no duplicates).
 * Databases built before schema v4 have no ref_links table: lookups then use `links` only.
 */
'use strict';

const { adapterForBook } = require('./sources');
const { paragraphNumber } = require('./refAlign');

/** Longest commentary / base block rendered in the drawer (a whole chapter at most). */
const MAX_BLOCK_LINES = 400;

const noTable = (e) => /no such table/i.test(String((e && e.message) || e));

// --- ref_links helpers ------------------------------------------------------------

const SIDES = {
  base: { self: 'base_book_id', other: 'comm_book_id', start: 'base_start', end: 'base_end', oStart: 'comm_start', oEnd: 'comm_end' },
  comm: { self: 'comm_book_id', other: 'base_book_id', start: 'comm_start', end: 'comm_end', oStart: 'base_start', oEnd: 'base_end' },
};

const partnerCache = new WeakMap();

/**
 * Books aligned with `bookId` on one side (its commentaries for 'base', its base books for
 * 'comm'), via an index skip-scan (one seek per partner). Cached per adapter.
 */
async function refPartners(a, side, bookId) {
  let cache = partnerCache.get(a);
  if (!cache) {
    cache = new Map();
    partnerCache.set(a, cache);
  }
  const key = side + ':' + bookId;
  if (cache.has(key)) return cache.get(key);
  const S = SIDES[side];
  let ids = [];
  try {
    const rows = await a.all(
      `WITH RECURSIVE s(p) AS (
         SELECT MIN(${S.other}) FROM ref_links WHERE ${S.self} = ?
         UNION ALL
         SELECT (SELECT MIN(${S.other}) FROM ref_links WHERE ${S.self} = ? AND ${S.other} > s.p) FROM s WHERE s.p IS NOT NULL
       ) SELECT p FROM s WHERE p IS NOT NULL`,
      [bookId, bookId],
    );
    ids = rows.map((r) => r.p);
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, ids);
  return ids;
}

/** Forget cached partners (after an import changed the links). */
function clearRefCache(db) {
  if (db) partnerCache.delete(db);
}

/**
 * Aligned units containing `line` of `bookId`, on both sides (for each partner book the innermost
 * unit covering the line: a seif's note, or where the seif has none, its siman's note):
 *   [{ role: 'base' | 'comm', otherBookId, refKey, start, end, otherStart, otherEnd, link_type }]
 * role 'base': bookId is the base book, the other side is a commentary block (and vice versa).
 */
async function fetchUnitLinks(db, bookId, line) {
  const a = adapterForBook(db, bookId);
  const out = [];
  for (const side of ['base', 'comm']) {
    const partners = await refPartners(a, side, bookId);
    if (!partners.length) continue;
    const S = SIDES[side];
    const values = partners.map(() => '(?)').join(', ');
    const rows = await a.all(
      `WITH p(id) AS (VALUES ${values})
       SELECT r.${S.other} AS other_id, r.ref_key, r.${S.start} AS s, r.${S.end} AS e, r.${S.oStart} AS os, r.${S.oEnd} AS oe, r.link_type
         FROM p JOIN ref_links r
           ON r.${S.self} = ? AND r.${S.other} = p.id
          AND r.${S.start} = (
                SELECT ${S.start} FROM ref_links
                 WHERE ${S.self} = ? AND ${S.other} = p.id AND ${S.start} <= ? AND ${S.end} >= ?
                 ORDER BY ${S.start} DESC LIMIT 1)
        WHERE r.${S.end} >= ?
        ORDER BY r.${S.other}, r.${S.oStart}`,
      [...partners, bookId, bookId, line, line, line],
    );
    for (const r of rows) {
      out.push({ role: side, otherBookId: r.other_id, refKey: r.ref_key, start: r.s, end: r.e, otherStart: r.os, otherEnd: r.oe, link_type: r.link_type });
    }
  }
  return out;
}

/**
 * Number of links per line for lines [from, to] of a book (line links + the first line of
 * every aligned unit, where the reader shows the badge).
 * @returns {Promise<Map<number, number>>} line_index -> count (lines without links are absent)
 */
async function fetchLinkCounts(db, bookId, from, to) {
  const a = adapterForBook(db, bookId);
  const rows = await a.all(
    `SELECT line, COUNT(*) AS n FROM (
       SELECT line_a AS line FROM links WHERE book_a_id = ? AND line_a BETWEEN ? AND ?
       UNION ALL
       SELECT line_b AS line FROM links WHERE book_b_id = ? AND line_b BETWEEN ? AND ?
     ) GROUP BY line`,
    [bookId, from, to, bookId, from, to],
  );
  const out = new Map();
  for (const r of rows) out.set(r.line, r.n);
  for (const side of ['base', 'comm']) {
    const partners = await refPartners(a, side, bookId);
    if (!partners.length) continue;
    const S = SIDES[side];
    const units = await a.all(
      `SELECT ${S.start} AS line, COUNT(*) AS n FROM ref_links
        WHERE ${S.self} = ? AND ${S.other} IN (${partners.map(() => '?').join(', ')}) AND ${S.start} BETWEEN ? AND ?
        GROUP BY ${S.start}`,
      [bookId, ...partners, from, to],
    );
    for (const r of units) out.set(r.line, (out.get(r.line) || 0) + r.n);
  }
  return out;
}

/** Rows with `line_index` get `link_count` (0 when the line has no links). */
function attachLinkCounts(rows, counts) {
  return rows.map((r) => ({ ...r, link_count: counts.get(r.line_index) || 0 }));
}

const ENTRY_COLUMNS = `b.title AS book_title, c.path AS category_path`;

/**
 * Every entry linked to one paragraph, with the linked paragraph's text and book:
 * the full aligned blocks first (all paragraphs of the unit, `block` set), then explicit
 * line links that are not already inside a block of the same book.
 */
async function fetchLinkedEntries(db, bookId, line) {
  // Links never cross databases: a book's commentaries live in the same library DB.
  const a = adapterForBook(db, bookId);
  const lineLinks = await a.all(
    `SELECT x.book_id, ${ENTRY_COLUMNS}, x.line, x.link_type, p.display_text, p.toc_path
     FROM (
       SELECT book_b_id AS book_id, line_b AS line, link_type FROM links WHERE book_a_id = ? AND line_a = ?
       UNION ALL
       SELECT book_a_id AS book_id, line_a AS line, link_type FROM links WHERE book_b_id = ? AND line_b = ?
     ) x
     JOIN books b ON b.id = x.book_id
     LEFT JOIN categories c ON c.id = b.category_id
     LEFT JOIN paragraphs p ON p.book_id = x.book_id AND p.line_index = x.line
     ORDER BY x.book_id, x.line`,
    [bookId, line, bookId, line],
  );
  const explicit = new Set(lineLinks.map((r) => r.book_id + ':' + r.line));
  const out = [];
  const seen = new Set();
  const blocks = [];
  for (const u of await fetchUnitLinks(db, bookId, line)) {
    const end = Math.min(u.otherEnd, u.otherStart + MAX_BLOCK_LINES);
    const rows = await a.all(
      `SELECT p.book_id, ${ENTRY_COLUMNS}, p.line_index AS line, p.display_text, p.toc_path
         FROM paragraphs p JOIN books b ON b.id = p.book_id LEFT JOIN categories c ON c.id = b.category_id
        WHERE p.book_id = ? AND p.line_index BETWEEN ? AND ? AND p.is_heading = 0
        ORDER BY p.line_index`,
      [u.otherBookId, u.otherStart, end],
    );
    const block = { refKey: u.refKey, start: u.otherStart, end: u.otherEnd, role: u.role };
    blocks.push({ bookId: u.otherBookId, ...block });
    for (const r of rows) {
      const k = r.book_id + ':' + r.line;
      if (seen.has(k)) continue;
      seen.add(k);
      // A Bavli "שורה ה" marker stored as a plain paragraph (not a heading) is only a label.
      if (u.role === 'base' && paragraphNumber(r.display_text) != null) continue;
      // `direct`: an Otzaria link file also points at exactly this paragraph.
      out.push({ ...r, link_type: u.role === 'base' ? u.link_type || 'commentary' : 'source', block, direct: explicit.has(k) });
    }
  }
  for (const r of lineLinks) {
    const k = r.book_id + ':' + r.line;
    if (seen.has(k) || blocks.some((b) => b.bookId === r.book_id && r.line >= b.start && r.line <= b.end)) continue;
    seen.add(k);
    out.push({ ...r, direct: true });
  }
  return out;
}

/** Display order of link types: commentaries first, then translations, then the rest. */
const TYPE_RANK = { commentary: 0, targum: 1, translation: 1, source: 2, reference: 3, other: 4 };
const typeRank = (t) => (t && TYPE_RANK[t] !== undefined ? TYPE_RANK[t] : 3);

/**
 * Short commentator name for a group header: "רש"י על שבת" -> "רש"י",
 * "תוספות על שבת" -> "תוספות"; notes on a commentary keep their parent ("הערות על רשי על
 * בראשית" -> "הערות על רשי"); titles without " על " are kept whole.
 */
function commentatorName(title) {
  const t = String(title || '').trim();
  const i = t.lastIndexOf(' על ');
  return i > 0 ? t.slice(0, i) : t;
}

/**
 * Groups linked entries by commentator book (one group per book, entries by line),
 * commentaries before translations before cross-references, then in library order.
 * A group built from an aligned unit carries `block` ({ refKey, start, end }): the
 * whole range to open / highlight in the commentary book. The drawer re-orders groups by
 * commentator priority (shared/commentaryRank.js).
 */
function groupLinkedEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    let g = groups.get(e.book_id);
    if (!g) {
      g = {
        bookId: e.book_id,
        bookTitle: e.book_title,
        name: commentatorName(e.book_title),
        categoryPath: e.category_path || null,
        linkType: e.link_type || null,
        rank: typeRank(e.link_type),
        entries: [],
        block: null,
      };
      groups.set(e.book_id, g);
    }
    g.rank = Math.min(g.rank, typeRank(e.link_type));
    if (e.block && !g.block) g.block = { refKey: e.block.refKey, start: e.block.start, end: e.block.end };
    g.entries.push(e);
  }
  const out = [...groups.values()];
  for (const g of out) g.entries.sort((a, b) => a.line - b.line);
  out.sort((a, b) => a.rank - b.rank || a.bookId - b.bookId);
  return out;
}

module.exports = { MAX_BLOCK_LINES, fetchUnitLinks, fetchLinkCounts, attachLinkCounts, fetchLinkedEntries, commentatorName, groupLinkedEntries, clearRefCache };
