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
 *
 * Two-stage library (shared/coreLibrary.js): a commentary of the extended database can comment on a base book of the
 * core database (and vice versa). The links of a book are therefore looked up in EVERY installed database ("holders":
 * the rows live with their commentary book), and the text of each linked block is read from the database that owns the
 * linked book. With one database (or a plain adapter) this is exactly the single-database lookup.
 */
'use strict';

const { adapterForBook, sourcesOf } = require('./sources');
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

/** Every database that can hold link rows of a book (a plain adapter is its own single holder). */
const holdersOf = (db) => sourcesOf(db).map((s) => s.adapter);

/** Forget cached partners (after an import changed the links). */
function clearRefCache(db) {
  if (!db) return;
  partnerCache.delete(db);
  for (const h of holdersOf(db)) partnerCache.delete(h);
}

/**
 * Aligned units containing `line` of `bookId`, on both sides (for each partner book the innermost
 * unit covering the line: a seif's note, or where the seif has none, its siman's note):
 *   [{ role: 'base' | 'comm', otherBookId, refKey, start, end, otherStart, otherEnd, link_type }]
 * role 'base': bookId is the base book, the other side is a commentary block (and vice versa).
 */
async function fetchUnitLinks(db, bookId, line) {
  const out = [];
  for (const a of holdersOf(db)) {
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
  }
  return out;
}

/**
 * Number of links per line for lines [from, to] of a book (line links + the first line of
 * every aligned unit, where the reader shows the badge).
 * @returns {Promise<Map<number, number>>} line_index -> count (lines without links are absent)
 */
async function fetchLinkCounts(db, bookId, from, to) {
  const out = new Map();
  for (const a of holdersOf(db)) {
    const rows = await a.all(
      `SELECT line, COUNT(*) AS n FROM (
         SELECT line_a AS line FROM links WHERE book_a_id = ? AND line_a BETWEEN ? AND ?
         UNION ALL
         SELECT line_b AS line FROM links WHERE book_b_id = ? AND line_b BETWEEN ? AND ?
       ) GROUP BY line`,
      [bookId, from, to, bookId, from, to],
    );
    for (const r of rows) out.set(r.line, (out.get(r.line) || 0) + r.n);
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
  // Explicit link rows live in the database of one of their books (any installed database may hold them); the
  // linked paragraph is read from the database that owns the OTHER book.
  const raw = [];
  for (const h of holdersOf(db)) {
    raw.push(
      ...(await h.all(
        `SELECT book_b_id AS book_id, line_b AS line, link_type FROM links WHERE book_a_id = ? AND line_a = ?
         UNION ALL
         SELECT book_a_id AS book_id, line_a AS line, link_type FROM links WHERE book_b_id = ? AND line_b = ?`,
        [bookId, line, bookId, line],
      )),
    );
  }
  const lineLinks = [];
  for (const r of raw) {
    const found = await adapterForBook(db, r.book_id).all(
      `SELECT b.title AS book_title, c.path AS category_path, p.display_text, p.toc_path
         FROM books b
         LEFT JOIN categories c ON c.id = b.category_id
         LEFT JOIN paragraphs p ON p.book_id = b.id AND p.line_index = ?
        WHERE b.id = ?`,
      [r.line, r.book_id],
    );
    if (found.length) lineLinks.push({ book_id: r.book_id, ...found[0], line: r.line, link_type: r.link_type });
  }
  lineLinks.sort((x, y) => x.book_id - y.book_id || x.line - y.line);
  const explicit = new Set(lineLinks.map((r) => r.book_id + ':' + r.line));
  const out = [];
  const seen = new Set();
  const blocks = [];
  for (const u of await fetchUnitLinks(db, bookId, line)) {
    const end = Math.min(u.otherEnd, u.otherStart + MAX_BLOCK_LINES);
    const rows = await adapterForBook(db, u.otherBookId).all(
      `SELECT p.book_id, ${ENTRY_COLUMNS}, p.line_index AS line, p.display_text, p.toc_path, p.is_heading, t.title AS heading_title
         FROM paragraphs p JOIN books b ON b.id = p.book_id LEFT JOIN categories c ON c.id = b.category_id
         LEFT JOIN toc_nodes t ON p.is_heading <> 0 AND t.book_id = p.book_id AND t.start_line = p.line_index
        WHERE p.book_id = ? AND p.line_index BETWEEN ? AND ? AND (p.is_heading = 0 OR p.line_index = ?)
        ORDER BY p.line_index`,
      [u.otherBookId, u.otherStart, end, u.otherStart],
    ).then((found) =>
      found.flatMap(({ is_heading, heading_title, ...r }) => {
        if (!is_heading) return [r];
        // The unit's own heading line, "<h2>סימן א</h2>(א) יתגבר ...": its text after the title is the
        // first paragraph (seif 1) of the unit; a bare heading is never an entry.
        const title = String(heading_title || '').trim();
        const text = String(r.display_text || '');
        const rest = title && text.startsWith(title) ? text.slice(title.length).trim() : '';
        return rest ? [{ ...r, display_text: rest }] : [];
      }),
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

/** Display order of link types: commentaries first, then translations, then the rest; parallel works last. */
const TYPE_RANK = { commentary: 0, targum: 1, translation: 1, source: 2, reference: 3, other: 4, parallel: 5 };
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

/**
 * Drawer groups for parallel works (shared/parallelWorks.js findParallels result): one card per
 * parallel book, `linkType: 'parallel'`, whose block is the parallel סימן / פרק / פרשה (open
 * target) and whose entries are its opening paragraphs (the overview shown in the card).
 */
function parallelGroups(result) {
  const list = (result && result.parallels) || [];
  return list.map((p) => {
    const block = { refKey: p.label, start: p.start, end: p.end, role: 'parallel' };
    return {
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      name: p.name,
      categoryPath: p.categoryPath || null,
      linkType: 'parallel',
      rank: TYPE_RANK.parallel,
      block,
      parallel: { family: p.family, work: p.work, label: p.label, order: p.order },
      entries: (p.preview || []).map((r) => ({
        book_id: p.bookId,
        book_title: p.bookTitle,
        line: r.line,
        link_type: 'parallel',
        display_text: r.display_text,
        toc_path: r.toc_path,
        category_path: p.categoryPath || null,
        block,
      })),
    };
  });
}

/**
 * Commentary groups + parallel groups. A parallel book that is ALSO aligned through `ref_links`
 * (a halachic sibling such as the רא"ש, paired with the Bavli by title at import) is shown once,
 * as a parallel work.
 */
function mergeParallelGroups(groups, parallels) {
  const ids = new Set((parallels || []).map((g) => g.bookId));
  return [...(groups || []).filter((g) => !ids.has(g.bookId)), ...(parallels || [])];
}

module.exports = { MAX_BLOCK_LINES, parallelGroups, mergeParallelGroups, fetchUnitLinks, fetchLinkCounts, attachLinkCounts, fetchLinkedEntries, commentatorName, groupLinkedEntries, clearRefCache };
