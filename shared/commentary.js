/**
 * Parallel commentaries & links (Otzaria-style), shared by the app and scripts/selftest.js.
 *
 * The `links` table stores each link once, in either orientation, so every lookup
 * checks both sides: (book_a_id, line_a) and (book_b_id, line_b), each covered by
 * its own index. Only the lines in the reader's window (or one paragraph) are queried.
 */
'use strict';

const { adapterForBook } = require('./sources');

/**
 * Number of links per line for lines [from, to] of a book.
 * @returns {Promise<Map<number, number>>} line_index -> count (lines without links are absent)
 */
async function fetchLinkCounts(db, bookId, from, to) {
  const rows = await adapterForBook(db, bookId).all(
    `SELECT line, COUNT(*) AS n FROM (
       SELECT line_a AS line FROM links WHERE book_a_id = ? AND line_a BETWEEN ? AND ?
       UNION ALL
       SELECT line_b AS line FROM links WHERE book_b_id = ? AND line_b BETWEEN ? AND ?
     ) GROUP BY line`,
    [bookId, from, to, bookId, from, to],
  );
  const out = new Map();
  for (const r of rows) out.set(r.line, r.n);
  return out;
}

/** Rows with `line_index` get `link_count` (0 when the line has no links). */
function attachLinkCounts(rows, counts) {
  return rows.map((r) => ({ ...r, link_count: counts.get(r.line_index) || 0 }));
}

/** All entries linked to one paragraph, with the linked paragraph's text and book. */
function fetchLinkedEntries(db, bookId, line) {
  // Links never cross databases: a book's commentaries live in the same library DB.
  return adapterForBook(db, bookId).all(
    `SELECT x.book_id, b.title AS book_title, x.line, x.link_type, p.display_text, p.toc_path,
            c.path AS category_path
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
}

/** Display order of link types: commentaries first, then translations, then the rest. */
const TYPE_RANK = { commentary: 0, targum: 1, translation: 1, source: 2, reference: 3, other: 4 };
const typeRank = (t) => (t && TYPE_RANK[t] !== undefined ? TYPE_RANK[t] : 3);

/**
 * Short commentator name for a group header: "רש"י על שבת" -> "רש"י",
 * "תוספות על שבת" -> "תוספות"; titles without " על " are kept whole.
 */
function commentatorName(title) {
  const t = String(title || '').trim();
  const i = t.indexOf(' על ');
  return i > 0 ? t.slice(0, i) : t;
}

/**
 * Groups linked entries by commentator book (one group per book, entries by line),
 * commentaries before translations before cross-references, then in library order.
 */
function groupLinkedEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    let g = groups.get(e.book_id);
    if (!g) {
      g = { bookId: e.book_id, bookTitle: e.book_title, name: commentatorName(e.book_title), linkType: e.link_type || null, rank: typeRank(e.link_type), entries: [] };
      groups.set(e.book_id, g);
    }
    g.rank = Math.min(g.rank, typeRank(e.link_type));
    g.entries.push(e);
  }
  const out = [...groups.values()];
  for (const g of out) g.entries.sort((a, b) => a.line - b.line);
  out.sort((a, b) => a.rank - b.rank || a.bookId - b.bookId);
  return out;
}

module.exports = { fetchLinkCounts, attachLinkCounts, fetchLinkedEntries, commentatorName, groupLinkedEntries };
