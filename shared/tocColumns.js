/**
 * Book table of contents as RTL cascading columns (Miller columns), shared by the reader's
 * TOC drawer and scripts/selftest.js.
 *
 *   column 0 (rightmost): top-level divisions (פרק / דף / סימן ...)
 *   column 1: children of the selected column-0 node (פסוק / עמוד / סעיף ...)
 *   column 2+: deeper headings, as long as the selected node has children
 *
 * A selected node without child headings may still have inline verses ("(א) ..." lines, as in
 * Otzaria Tanach): fetchInlineVerses() lists them for a final verse column.
 */
'use strict';

const { normalizeHebrew, extractRefKey, hebrewNumeralToInt } = require('./hebrew');
const { adapterForBook } = require('./sources');

/**
 * @param {{ id, parent_id, level, title, start_line, ref_key? }[]} nodes  flat toc_nodes rows
 * @returns {{ roots: object[], children: Map<number|null, object[]>, byId: Map<number, object>, depth: number }}
 *   depth: number of heading levels (1 for a single-level book).
 */
function buildTocTree(nodes) {
  const sorted = (nodes || []).slice().sort((a, b) => a.start_line - b.start_line || a.level - b.level);
  const byId = new Map(sorted.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of sorted) {
    // A parent missing from the list (should not happen) makes the node a root.
    const p = n.parent_id != null && byId.has(n.parent_id) ? n.parent_id : null;
    const list = children.get(p) || [];
    list.push(n);
    children.set(p, list);
  }
  let depth = 0;
  const walk = (p, d) => {
    for (const n of children.get(p) || []) {
      depth = Math.max(depth, d);
      walk(n.id, d + 1);
    }
  };
  walk(null, 1);
  return { roots: children.get(null) || [], children, byId, depth };
}

/** Whether a node has child headings. */
function hasChildren(tree, id) {
  return (tree.children.get(id) || []).length > 0;
}

/**
 * Columns for a selection path (node ids, outermost first): column 0 = roots, and one more
 * column for every selected node that has children.
 * @returns {{ depth: number, parentId: number|null, items: object[], selectedId: number|null }[]}
 */
function tocColumns(tree, path) {
  const cols = [{ depth: 0, parentId: null, items: tree.roots, selectedId: null }];
  for (let i = 0; i < (path || []).length; i++) {
    const id = path[i];
    const col = cols[i];
    if (!col || !col.items.some((n) => n.id === id)) break;
    col.selectedId = id;
    const kids = tree.children.get(id) || [];
    if (!kids.length) break;
    cols.push({ depth: i + 1, parentId: id, items: kids, selectedId: null });
  }
  return cols;
}

/**
 * Selection path for a reading position: at every level the last node starting at or before
 * `line` (so opening the TOC pre-selects the current chapter, then the current verse / seif).
 */
function pathForLine(tree, line) {
  const out = [];
  let items = tree.roots;
  while (items && items.length) {
    let pick = null;
    for (const n of items) {
      if (n.start_line <= line) pick = n;
      else break;
    }
    if (!pick) break;
    out.push(pick.id);
    items = tree.children.get(pick.id);
  }
  return out;
}

/** End line (inclusive) of a node's section: before the next node of the same or a higher level. */
function nodeEnd(tree, node, totalLines) {
  const all = [];
  for (const list of tree.children.values()) all.push(...list);
  let end = totalLines;
  for (const n of all) if (n.start_line > node.start_line && n.level <= node.level && n.start_line - 1 < end) end = n.start_line - 1;
  return end;
}

const VERSE_RE = /^\s*[([]\s*([א-ת]{1,4})\s*[)\]]/;

/**
 * Inline units of a section without sub-headings: "(א) ..." lines -> [{ key, title, line }].
 * `word` names them (פסוק in Tanach, סעיף in a סימן / כלל — see refAlign.inlineUnitWord).
 */
async function fetchInlineVerses(db, bookId, start, end, word) {
  const rows = await adapterForBook(db, bookId).all(
    `SELECT line_index, substr(clean_text, 1, 12) AS head FROM paragraphs
      WHERE book_id = ? AND line_index > ? AND line_index <= ? AND is_heading = 0 AND (clean_text LIKE '(%' OR clean_text LIKE '[%')
      ORDER BY line_index LIMIT 500`,
    [bookId, start, end],
  );
  const out = [];
  for (const r of rows) {
    const m = VERSE_RE.exec(r.head);
    if (m) out.push({ key: m[1], title: `${word || 'פסוק'} ${m[1]}`, line: r.line_index });
  }
  return out;
}

/** The inline verse containing `line` (last verse starting at or before it), or null. */
function verseForLine(verses, line) {
  let pick = null;
  for (const v of verses) {
    if (v.line <= line) pick = v;
    else break;
  }
  return pick;
}

/**
 * Quick filter: nodes whose title contains the query (niqqud / gershayim insensitive), or whose
 * reference key equals it as a Hebrew numeral or digits ("כה", "כ\"ה", "25", "סימן כה", "דף ב:").
 * Matches are ordered: exact reference first, then by position in the book.
 */
function filterToc(tree, query, limit) {
  const q = normalizeHebrew(query || '', { keepAmud: true, keepPunctuation: false });
  if (!q) return [];
  const digits = /^\d+$/.test(q) ? Number(q) : null;
  const key = extractRefKey(query);
  const qNum = digits != null ? digits : hebrewNumeralToInt(key);
  // "סימן כה": an exact reference must also be a סימן (not סעיף כה).
  const tokens = q.split(' ');
  const qType = tokens.length > 1 && key && key !== q ? tokens[0] : null;
  const out = [];
  for (const list of tree.children.values()) {
    for (const n of list) {
      const title = normalizeHebrew(n.title, { keepAmud: true, keepPunctuation: false });
      const ref = n.ref_key != null ? n.ref_key : extractRefKey(n.title);
      const refNum = hebrewNumeralToInt(ref);
      const sameNumber = ref === key || (qNum != null && refNum === qNum && /^[א-ת]+$/.test(ref));
      const exact = sameNumber && (!qType || title.startsWith(qType));
      if (exact) out.push({ node: n, rank: 0 });
      else if (title.includes(q)) out.push({ node: n, rank: 1 });
    }
  }
  out.sort((a, b) => a.rank - b.rank || a.node.start_line - b.node.start_line || a.node.level - b.node.level);
  return out.slice(0, limit || 200).map((x) => x.node);
}

/** Titles from the root to a node ("פרק א › פסוק ד"). */
function nodeTrail(tree, id) {
  const out = [];
  for (let n = tree.byId.get(id); n; n = n.parent_id != null ? tree.byId.get(n.parent_id) : null) out.unshift(n.title);
  return out;
}

// --- fit-to-content column widths ------------------------------------------------------------
// Text cannot be measured before layout in React Native, so widths are estimated from per-glyph
// advance factors of the UI font (Roboto / Noto Sans Hebrew, Chrome's system-ui), deliberately a
// little generous so a label never ellipsizes at its estimated width.

/** Per-column bounds (px). */
const TOC_COLUMN_WIDTH = { min: 108, max: 220 };

/** Approximate advance of one character, in em. */
function glyphEm(ch) {
  if (/[֑-ׇ‎‏]/.test(ch)) return 0; // niqqud, cantillation, direction marks
  if (/[א-ת]/.test(ch)) return 0.6;
  if (ch === ' ') return 0.27;
  if (/[0-9]/.test(ch)) return 0.57;
  if (/["'.:,;()\[\]׳״\-–—›‹]/.test(ch)) return 0.32;
  return 0.62;
}

/** Estimated rendered width (px) of a plain-text label at `fontSize`. */
function estimateTextWidth(text, fontSize) {
  const plain = String(text || '').replace(/<[^>]*>/g, '');
  let em = 0;
  for (const ch of plain) em += glyphEm(ch);
  return em * (fontSize || 15);
}

/**
 * Width (px) for one TOC column: its widest row label (plus the row chrome and, for branch rows,
 * the "‹" indicator) and its "לתחילת …" header, clamped to [min, max].
 * @param {string[]} labels
 * @param {{ fontSize?: number, chrome?: number, branch?: boolean, branchSpace?: number,
 *           header?: string|null, headerFontSize?: number, headerChrome?: number, min?: number, max?: number }} [opts]
 */
function tocColumnWidth(labels, opts) {
  const o = opts || {};
  const min = o.min != null ? o.min : TOC_COLUMN_WIDTH.min;
  const max = o.max != null ? o.max : TOC_COLUMN_WIDTH.max;
  const fontSize = o.fontSize || 15;
  let widest = 0;
  for (const l of labels || []) widest = Math.max(widest, estimateTextWidth(l, fontSize));
  let need = widest + (o.chrome != null ? o.chrome : 28) + (o.branch ? (o.branchSpace != null ? o.branchSpace : 18) : 0);
  if (o.header) need = Math.max(need, estimateTextWidth(o.header, o.headerFontSize || 13) * 1.06 + (o.headerChrome != null ? o.headerChrome : 28));
  return Math.round(Math.min(max, Math.max(min, need)));
}

/**
 * Drawer / panel width for the open columns: their sum, clamped to [min, cap] (a cap below `min`
 * wins: tiny screens). Columns beyond the cap scroll horizontally.
 */
function tocPanelWidth(columnWidths, opts) {
  const o = opts || {};
  const sum = (columnWidths || []).reduce((a, b) => a + b, 0);
  const cap = o.cap != null ? o.cap : Infinity;
  const min = Math.min(o.min != null ? o.min : 0, cap);
  return Math.round(Math.min(cap, Math.max(min, sum)));
}

/**
 * Shrinks column widths so their sum fits `cap` (no horizontal overflow): only the part of a column above `minCol` gives way,
 * in proportion to it (labels then truncate with an ellipsis). When even all-`minCol` columns exceed `cap`, they stay at
 * `minCol` and the columns scroll.
 */
function fitColumnWidths(widths, cap, minCol) {
  const min = minCol != null ? minCol : 96;
  const sum = widths.reduce((a, b) => a + b, 0);
  if (!(cap > 0) || sum <= cap) return widths.slice();
  const floor = widths.map((w) => Math.min(w, min));
  const floorSum = floor.reduce((a, b) => a + b, 0);
  if (floorSum >= cap) return floor;
  const room = widths.reduce((a, w, i) => a + (w - floor[i]), 0);
  const keep = (cap - floorSum) / room;
  const out = widths.map((w, i) => Math.floor(floor[i] + (w - floor[i]) * keep));
  return out;
}

module.exports = { fitColumnWidths, buildTocTree, hasChildren, tocColumns, pathForLine, nodeEnd, fetchInlineVerses, verseForLine, filterToc, nodeTrail, TOC_COLUMN_WIDTH, estimateTextWidth, tocColumnWidth, tocPanelWidth };
