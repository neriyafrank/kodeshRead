/**
 * Platform-independent reader helpers (shared by the app and scripts/selftest.js):
 *  - display-text preparation (safe inline HTML, live Niqqud toggle, BiDi RLM)
 *  - sliding-window range math for the windowed book reader
 *  - TOC trail lookup and item-size estimation
 */
'use strict';

const { adapterForBook } = require('./sources');
const { applyVocalization, stripCantillationMarks } = require('./hebrew');

/** Inline tags the reader renders (everything else is stripped, keeping its text). */
const SAFE_TAGS = ['b', 'strong', 'i', 'em', 'u', 'small', 'big', 'sup', 'sub'];
const ANY_TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

/** Keep only bare <b>, <small>, ... tags; strip attributes and all other tags. */
function sanitizeInlineHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(ANY_TAG_RE, (m, tag) => {
      const t = tag.toLowerCase();
      if (!SAFE_TAGS.includes(t)) return '';
      return m[1] === '/' ? `</${t}>` : `<${t}>`;
    });
}

/** Hides vowel points and cantillation (punctuation such as maqaf and sof pasuq stays). */
function stripNiqqudForDisplay(text) {
  return applyVocalization(text, { showNikkud: false });
}

/** Cantillation only (te'amim U+0591–U+05AF): the vowel points stay. */
function stripCantillation(text) {
  return stripCantillationMarks(text);
}

const RLM = '‏';
/** Lines with parentheses or digits get a leading RLM so the BiDi algorithm keeps them RTL. */
function needsRtlMark(text) {
  return /[()[\]\d]/.test(text);
}

/** display_text from the DB -> string ready for <RichText>. */
function prepareDisplayText(html, opts) {
  // Tags carry no Hebrew marks, so stripping the whole sanitized HTML is safe.
  let out = applyVocalization(sanitizeInlineHtml(html), opts);
  if (needsRtlMark(out) && out[0] !== RLM) out = RLM + out;
  return out;
}

// --- Sliding window ---------------------------------------------------------

/** Lines loaded when a book is opened (~400 around the current line). */
const WINDOW_SIZE = 400;
/** Lines fetched each time the user scrolls near either edge. */
const CHUNK_SIZE = 200;
/** Upper bound on lines held in memory; the far edge is trimmed beyond this. */
const MAX_WINDOW = 800;

/** Line range [from, to] of ~WINDOW_SIZE lines around `target`, clamped to the book. */
function windowAround(target, totalLines, size) {
  const n = size || WINDOW_SIZE;
  const total = Math.max(1, totalLines | 0);
  const t = Math.min(Math.max(1, target | 0), total);
  let from = Math.max(1, t - Math.floor(n * 0.35));
  let to = Math.min(total, from + n - 1);
  from = Math.max(1, Math.min(from, to - n + 1));
  return { from, to };
}

/** Next range to fetch when scrolling `direction` ('forward' | 'backward'), or null at the book edge. */
function nextChunk(range, direction, totalLines, chunk) {
  const c = chunk || CHUNK_SIZE;
  if (direction === 'forward') {
    if (range.to >= totalLines) return null;
    return { from: range.to + 1, to: Math.min(totalLines, range.to + c) };
  }
  if (range.from <= 1) return null;
  return { from: Math.max(1, range.from - c), to: range.from - 1 };
}

/**
 * Merge a fetched chunk into the window and trim the opposite edge to `max` rows.
 * `rows` are sorted by line_index. Returns the new rows plus the covered range
 * (which stays contiguous in line numbers even when some lines are empty).
 */
function mergeChunk(rows, range, chunkRows, chunkRange, direction, max) {
  const limit = max || MAX_WINDOW;
  let next;
  let from;
  let to;
  if (direction === 'forward') {
    next = rows.concat(chunkRows);
    from = range.from;
    to = chunkRange.to;
    if (next.length > limit) {
      next = next.slice(next.length - limit);
      from = next[0].line_index;
    }
  } else {
    next = chunkRows.concat(rows);
    from = chunkRange.from;
    to = range.to;
    if (next.length > limit) {
      next = next.slice(0, limit);
      to = next[next.length - 1].line_index;
    }
  }
  return { rows: next, range: { from, to } };
}

/** Index of the first row at or after `line` (rows sorted by line_index); -1 if none. */
function indexOfLine(rows, line) {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].line_index >= line) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

const WINDOW_COLUMNS = 'line_index, display_text, is_heading, toc_path';

/** Fetch paragraphs [from, to] of a book (never the whole book). */
function fetchRange(db, bookId, from, to) {
  return adapterForBook(db, bookId).all(
    `SELECT ${WINDOW_COLUMNS} FROM paragraphs WHERE book_id = ? AND line_index BETWEEN ? AND ? ORDER BY line_index`,
    [bookId, from, to],
  );
}

// --- TOC & layout -------------------------------------------------------------

/**
 * Given TOC nodes (any order) returns the trail of node ids, outermost first,
 * that contains `line`: for each level, the last node starting at or before it.
 */
function tocTrail(nodes, line) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let best = null;
  for (const n of nodes) {
    if (n.start_line <= line && (!best || n.start_line > best.start_line || (n.start_line === best.start_line && n.level > best.level))) best = n;
  }
  const trail = [];
  for (let n = best; n; n = n.parent_id == null ? null : byId.get(n.parent_id)) trail.unshift(n.id);
  return trail;
}

/** Paragraph vertical padding used by the reader rows (keep in sync with BookReader). */
const ROW_PADDING = 12;
/** Average characters in a paragraph line at the given font size on a ~380dp wide phone. */
function estimateItemSize(fontSize, lineHeight, avgChars) {
  const chars = avgChars || 200;
  const charsPerLine = Math.max(10, Math.floor(340 / (fontSize * 0.5)));
  const lines = Math.max(1, Math.ceil(chars / charsPerLine));
  return Math.round(lines * fontSize * lineHeight + ROW_PADDING);
}

module.exports = {
  SAFE_TAGS,
  RLM,
  WINDOW_SIZE,
  CHUNK_SIZE,
  MAX_WINDOW,
  sanitizeInlineHtml,
  stripNiqqudForDisplay,
  stripCantillation,
  needsRtlMark,
  prepareDisplayText,
  windowAround,
  nextChunk,
  mergeChunk,
  indexOfLine,
  fetchRange,
  tocTrail,
  estimateItemSize,
};
