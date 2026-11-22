/**
 * Quick Source Reference Jump ("קפיצה מהירה למקור") resolver.
 *
 * Shared between the app (expo-sqlite) and the Node self-test (node:sqlite) via
 * a minimal async adapter: { all(sql, params) => Promise<row[]> }.
 *
 *   "שוע אוח כה ה"   -> Shulchan Aruch OC, siman כה, seif ה
 *   "רמבם שבת א א"   -> Rambam Hilchot Shabbat, perek א, halacha א
 *   "ברכות ב."  / "ברכות ב א" / "ברכות ב"  -> daf ב amud א
 *   "בראשית א ג"    -> Genesis chapter א, verse marker "(ג)" inside the chapter
 */
'use strict';

const { normalizeHebrew, stripHtml, decodeEntities } = require('./hebrew');
const { sourcesOf, adapterForBook } = require('./sources');

const MAX_BOOK_CANDIDATES = 5;

/**
 * Load every book's title + aliases once and index them in memory.
 * `db` may be a router: the books of every library database are indexed together
 * (their ids never collide), core books first.
 */
async function loadBookIndex(db) {
  const rows = [];
  for (const s of sourcesOf(db)) {
    rows.push(
      ...(await s.adapter.all(
        `SELECT b.id, b.title, b.aliases, b.total_lines, c.path AS category_path
         FROM books b LEFT JOIN categories c ON c.id = b.category_id ORDER BY b.id`,
        [],
      )),
    );
  }
  const byAlias = new Map();
  const books = new Map();
  for (const r of rows) {
    const book = { id: r.id, title: r.title, categoryPath: r.category_path || '', totalLines: r.total_lines };
    books.set(r.id, book);
    const titleKey = normalizeHebrew(r.title, { keepPunctuation: false });
    const aliases = String(r.aliases).split('|').filter(Boolean);
    if (!aliases.includes(titleKey)) aliases.unshift(titleKey);
    for (const a of aliases) {
      const list = byAlias.get(a) || [];
      list.push({ book, exactTitle: a === titleKey });
      byAlias.set(a, list);
    }
  }
  let maxAliasTokens = 1;
  for (const a of byAlias.keys()) maxAliasTokens = Math.max(maxAliasTokens, a.split(' ').length);
  return { byAlias, books, maxAliasTokens };
}

function tokenize(input) {
  return normalizeHebrew(input, { keepAmud: true, keepPunctuation: false }).split(' ').filter(Boolean);
}

/** Leading words users often type that are not part of a book's stored name. */
const OPTIONAL_LEADING = new Set(['מסכת', 'מס', 'ספר', 'מסכתא']);

/** Candidate ref_keys for tokens[i], with how many tokens each consumes. */
function refOptions(tokens, i) {
  const t = tokens[i];
  const next = tokens[i + 1];
  const opts = [{ key: t, consume: 1 }];
  const hasMarker = /[.:]$/.test(t);
  const bare = hasMarker ? t.slice(0, -1) : t;
  if (!hasMarker) {
    if (next === 'א' || next === 'עא') opts.unshift({ key: t + '.', consume: 2 });
    else if (next === 'ב' || next === 'עב') opts.unshift({ key: t + ':', consume: 2 });
    opts.push({ key: t + '.', consume: 1 }); // "ברכות ב" -> daf ב amud א
  } else {
    // "ב." typed but the book uses "דף ב" > "עמוד א" headings.
    opts.push({ key: bare, consume: 1, thenAmud: t.endsWith('.') ? 'א' : 'ב' });
  }
  return opts;
}

async function rangeEnd(db, bookId, node, totalLines) {
  if (!node) return totalLines + 1;
  const r = await db.all(
    'SELECT MIN(start_line) AS e FROM toc_nodes WHERE book_id = ? AND start_line > ? AND level <= ?',
    [bookId, node.start_line, node.level],
  );
  return r[0] && r[0].e != null ? r[0].e : totalLines + 1;
}

/** Shallowest TOC node inside [start, end) whose ref_key is one of keys. */
async function findNode(db, bookId, keys, start, end, minLevel) {
  const ph = keys.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id, parent_id, level, title, ref_key, start_line FROM toc_nodes
     WHERE book_id = ? AND ref_key IN (${ph}) AND start_line >= ? AND start_line < ? AND level > ?
     ORDER BY level, start_line LIMIT 8`,
    [bookId, ...keys, start, end, minLevel],
  );
  if (!rows.length) return null;
  // Respect option priority (first key wins) among the shallowest level.
  const lvl = rows[0].level;
  for (const k of keys) {
    const hit = rows.find((r) => r.level === lvl && r.ref_key === k);
    if (hit) return hit;
  }
  return rows[0];
}

/** Inline markers inside a section, e.g. Tanach verses "(ג) ..." within "פרק א". */
async function findInlineMarker(db, bookId, token, start, end) {
  const t = token.replace(/[.:]$/, '');
  const rows = await db.all(
    `SELECT line_index FROM paragraphs
     WHERE book_id = ? AND line_index >= ? AND line_index < ? AND is_heading = 0
       AND (clean_text LIKE ? OR clean_text LIKE ?)
     ORDER BY line_index LIMIT 1`,
    [bookId, start, end, `(${t})%`, `[${t}]%`],
  );
  return rows[0] ? rows[0].line_index : null;
}

async function resolveInBook(router, book, tokens) {
  const db = adapterForBook(router, book.id);
  const path = [];
  let node = null;
  let targetLine = 1;
  let i = 0;
  let marker = null;
  while (i < tokens.length) {
    const start = node ? node.start_line : 0;
    const end = await rangeEnd(db, book.id, node, book.totalLines);
    const minLevel = node ? node.level : 0;
    let matched = null;
    for (const opt of refOptions(tokens, i)) {
      const hit = await findNode(db, book.id, [opt.key], start, end, minLevel);
      if (hit) {
        matched = { hit, opt };
        break;
      }
    }
    if (matched) {
      node = matched.hit;
      path.push(node.title);
      targetLine = node.start_line;
      i += matched.opt.consume;
      if (matched.opt.thenAmud) tokens = tokens.slice(0, i).concat(matched.opt.thenAmud, tokens.slice(i));
      continue;
    }
    // No heading matched: maybe an inline marker such as a verse number.
    const line = await findInlineMarker(db, book.id, tokens[i], node ? node.start_line : 1, end);
    if (line != null) {
      marker = tokens[i];
      targetLine = line;
      i += 1;
    }
    break;
  }
  return { path, targetLine, marker, unmatched: tokens.slice(i) };
}

async function previewText(router, bookId, line) {
  const rows = await adapterForBook(router, bookId).all(
    'SELECT line_index, display_text FROM paragraphs WHERE book_id = ? AND line_index >= ? AND is_heading = 0 ORDER BY line_index LIMIT 1',
    [bookId, line],
  );
  if (!rows[0]) return '';
  const t = decodeEntities(stripHtml(rows[0].display_text)).replace(/\s+/g, ' ').trim();
  return t.length > 160 ? t.slice(0, 160) + '…' : t;
}

/**
 * Resolve a quick-jump query.
 * @returns {Promise<Array<{ bookId, bookTitle, categoryPath, path: string[], targetLine, marker, unmatched: string[], preview, complete: boolean }>>}
 */
async function resolveReference(db, index, input, opts) {
  const limit = (opts && opts.limit) || MAX_BOOK_CANDIDATES;
  const tokens = tokenize(input);
  if (!tokens.length) return [];

  // Longest leading token sequence that is a book title/alias ("מסכת"/"ספר" optional).
  let candidates = null;
  let rest = [];
  const starts = tokens.length > 1 && OPTIONAL_LEADING.has(tokens[0]) ? [0, 1] : [0];
  for (const s of starts) {
    for (let n = Math.min(tokens.length - s, index.maxAliasTokens); n >= 1 && !candidates; n--) {
      const hit = index.byAlias.get(tokens.slice(s, s + n).join(' '));
      if (hit) {
        candidates = hit;
        rest = tokens.slice(s + n);
      }
    }
    if (candidates) break;
  }

  if (!candidates) {
    // Still typing a book name: prefix suggestions.
    const q = tokens.join(' ');
    const seen = new Set();
    const out = [];
    for (const [alias, list] of index.byAlias) {
      if (!alias.startsWith(q)) continue;
      for (const c of list) {
        if (seen.has(c.book.id)) continue;
        seen.add(c.book.id);
        out.push({ c, alias });
      }
    }
    out.sort((a, b) => Number(b.c.exactTitle) - Number(a.c.exactTitle) || a.alias.length - b.alias.length);
    const results = [];
    for (const { c } of out.slice(0, limit)) {
      results.push({
        bookId: c.book.id, bookTitle: c.book.title, categoryPath: c.book.categoryPath, path: [], targetLine: 1,
        marker: null, unmatched: [], preview: await previewText(db, c.book.id, 1), complete: false, suggestion: true,
      });
    }
    return results;
  }

  const unique = [];
  const seen = new Set();
  for (const c of [...candidates].sort((a, b) => Number(b.exactTitle) - Number(a.exactTitle))) {
    if (!seen.has(c.book.id)) {
      seen.add(c.book.id);
      unique.push(c.book);
    }
  }

  const results = [];
  for (const book of unique.slice(0, limit)) {
    const r = await resolveInBook(db, book, rest.slice());
    results.push({
      bookId: book.id,
      bookTitle: book.title,
      categoryPath: book.categoryPath,
      path: r.path,
      targetLine: r.targetLine,
      marker: r.marker,
      unmatched: r.unmatched,
      preview: await previewText(db, book.id, r.targetLine),
      complete: r.unmatched.length === 0,
      suggestion: false,
    });
  }
  // Fully resolved references first, then the most specific.
  results.sort((a, b) => Number(b.complete) - Number(a.complete) || a.unmatched.length - b.unmatched.length);
  return results;
}

module.exports = { loadBookIndex, resolveReference, tokenize };
