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
 *
 * Abbreviation-aware (shared/hebrewTorahDict.js): book names may be typed as
 * abbreviations or in another spelling ("שו\"ע או\"ח", "ב\"ק", "רמב\"ם הל' שבת",
 * "בר'", "שלחן ערוך"), and locations may carry structural words / abbreviations
 * ("סי' שכח", "סעיף ד", "פ\"א", "דף ב ע\"ב", "דף יג עמוד ב") or digits ("328").
 */
'use strict';

const { normalizeHebrew, stripHtml, decodeEntities } = require('./hebrew');
const { sourcesOf, adapterForBook } = require('./sources');
const dict = require('./hebrewTorahDict');

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

/** Raw-aware tokens: [{ tok, raw }] (raw keeps gershayim / geresh, e.g. "פ\"א", "סי'"). */
function rawTokens(input) {
  const out = [];
  for (const raw of String(input || '').split(/\s+/)) {
    const toks = tokenize(raw);
    if (toks.length === 1) out.push({ tok: toks[0], raw });
    else for (const t of toks) out.push({ tok: t, raw: t });
  }
  return out;
}

// --- Abbreviation / spelling-insensitive book keys ---------------------------

const canonCache = new WeakMap();

/** canonical key -> candidates, built lazily once per book index (see dict.canonicalForms). */
function canonicalIndex(index) {
  let m = canonCache.get(index);
  if (m) return m;
  m = new Map();
  for (const [alias, list] of index.byAlias) {
    for (const key of dict.canonicalForms(alias.split(' '))) {
      const cur = m.get(key) || [];
      for (const c of list) if (!cur.some((x) => x.book.id === c.book.id)) cur.push({ book: c.book, exactTitle: false });
      m.set(key, cur);
    }
  }
  canonCache.set(index, m);
  return m;
}

/**
 * Candidates for a token sequence: literal title / alias first, then abbreviation-expanded keys.
 * `raws` (as typed) decide whether a truncation may expand ("בר'" -> בראשית, "בר" not yet).
 */
function lookupBook(index, tokens, raws) {
  const literal = index.byAlias.get(tokens.join(' '));
  if (literal) return literal;
  const canon = canonicalIndex(index);
  const out = [];
  const keys = raws ? dict.canonicalForms(raws, 8, { typed: true }) : dict.canonicalForms(tokens);
  for (const key of keys) {
    for (const c of canon.get(key) || []) if (!out.some((x) => x.book.id === c.book.id)) out.push(c);
  }
  return out.length ? out : null;
}

// --- Location parsing ---------------------------------------------------------

/** Structural words dropped from a location (normalized): "סימן", "סי'", "סעיף", "פרק", "דף", "עמוד"... */
const STRUCTURE_WORDS = new Set(
  ['סימן', 'סימנים', 'סי', 'סימ', 'סעיף', 'סעיפים', 'סע', 'סעי', 'סק', 'פרק', 'פרקים', 'פר', 'הלכה', 'הלכות', 'הל', 'הלכ',
    'דף', 'דפים', 'עמוד', 'עמ', 'פסוק', 'פסוקים', 'פס', 'משנה', 'מש', 'אות', 'שער', 'מאמר', 'פרשת', 'פרשה', 'תשובה', 'תשו', 'שאלה']
    .map((w) => normalizeHebrew(w, { keepPunctuation: false })),
);
/** Single letters that are structural only when written with a geresh: "פ'" (פרק), "ס'" (סימן), "ד'" is 4. */
const STRUCTURE_LETTERS = new Set(['פ', 'ס']);
/** First letters of combined "structure + number" tokens: פ"א = פרק א, ה"ב = הלכה ב, ס"ק ד... */
const COMBINED_LEADS = new Set(['פ', 'ה', 'ס', 'מ']);

/**
 * Location tokens of a reference (everything after the book name):
 *   [{ key, alt? }]  key: normalized ref token ("שכח", "ב.", "עב"); alt: fallback key when a
 *   combined abbreviation is ambiguous ("פ\"א" -> key "פא" (81) with alt "א" (פרק א)).
 */
function parseLocation(words) {
  const out = [];
  for (const w of words) {
    const tok = w.tok;
    const marked = dict.hasAbbrevMark(w.raw);
    if (STRUCTURE_WORDS.has(tok.replace(/[.:]$/, '')) && !/[.:]$/.test(tok)) continue;
    if (tok.length === 1 && STRUCTURE_LETTERS.has(tok) && /['׳]$/.test(w.raw)) continue;
    const digits = /^(\d+)([.:]?)$/.exec(tok);
    if (digits) {
      const heb = dict.intToHebrewNumeral(parseInt(digits[1], 10));
      if (heb) {
        out.push({ key: heb + digits[2] });
        continue;
      }
    }
    let alt = null;
    const bare = tok.replace(/[.:]$/, '');
    if (marked && /["״]/.test(w.raw) && bare.length >= 2 && COMBINED_LEADS.has(bare[0]) && dict.isHebrewNumeral(bare.slice(1))) alt = bare.slice(1) + tok.slice(bare.length);
    out.push(alt ? { key: tok, alt } : { key: tok });
  }
  return out;
}

/** Human label of a parsed location ("סימן שכח › סעיף ד") from the matched TOC titles. */
function locationLabel(path, marker) {
  const parts = path.slice();
  if (marker) parts.push(`(${marker})`);
  return parts.join(' › ');
}

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

async function resolveInBook(router, book, locTokens) {
  const db = adapterForBook(router, book.id);
  const path = [];
  let node = null;
  let targetLine = 1;
  let i = 0;
  let marker = null;
  let toks = locTokens.slice();
  while (i < toks.length) {
    const start = node ? node.start_line : 0;
    const end = await rangeEnd(db, book.id, node, book.totalLines);
    const minLevel = node ? node.level : 0;
    const keys = toks.map((t) => t.key);
    const opts = refOptions(keys, i);
    if (toks[i].alt) {
      const altKeys = keys.slice();
      altKeys[i] = toks[i].alt;
      opts.push(...refOptions(altKeys, i));
    }
    let matched = null;
    for (const opt of opts) {
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
      if (matched.opt.thenAmud) toks = toks.slice(0, i).concat({ key: matched.opt.thenAmud }, toks.slice(i));
      continue;
    }
    // No heading matched: maybe an inline marker such as a verse number.
    let line = await findInlineMarker(db, book.id, toks[i].key, node ? node.start_line : 1, end);
    let used = toks[i].key;
    if (line == null && toks[i].alt) {
      line = await findInlineMarker(db, book.id, toks[i].alt, node ? node.start_line : 1, end);
      used = toks[i].alt;
    }
    if (line != null) {
      marker = used;
      targetLine = line;
      i += 1;
    }
    break;
  }
  return { path, targetLine, marker, unmatched: toks.slice(i).map((t) => t.key) };
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
  const words = rawTokens(input);
  const tokens = words.map((w) => w.tok);
  if (!tokens.length) return [];

  // Longest leading token sequence that is a book title/alias ("מסכת"/"ספר" optional),
  // literally or after abbreviation / spelling normalization ("שו\"ע או\"ח", "ב\"ק", "בר'").
  let candidates = null;
  let restStart = 0;
  const starts = tokens.length > 1 && OPTIONAL_LEADING.has(tokens[0]) ? [0, 1] : [0];
  for (const s of starts) {
    for (let n = Math.min(tokens.length - s, index.maxAliasTokens + 2); n >= 1 && !candidates; n--) {
      const hit = lookupBook(index, tokens.slice(s, s + n), words.slice(s, s + n).map((w) => w.raw));
      if (hit) {
        candidates = hit;
        restStart = s + n;
      }
    }
    if (candidates) break;
  }

  if (!candidates) {
    // Still typing a book name: prefix suggestions (literal, then abbreviation-expanded).
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
    if (!out.length) {
      const qs = dict.canonicalForms(words.map((w) => w.raw), 8, { typed: true });
      for (const [key, list] of canonicalIndex(index)) {
        if (!qs.some((k) => key.startsWith(k))) continue;
        for (const c of list) {
          if (seen.has(c.book.id)) continue;
          seen.add(c.book.id);
          out.push({ c, alias: key });
        }
      }
    }
    out.sort((a, b) => Number(b.c.exactTitle) - Number(a.c.exactTitle) || a.alias.length - b.alias.length);
    const results = [];
    for (const { c } of out.slice(0, limit)) {
      results.push({
        bookId: c.book.id, bookTitle: c.book.title, categoryPath: c.book.categoryPath, path: [], targetLine: 1,
        marker: null, unmatched: [], preview: await previewText(db, c.book.id, 1), complete: false, suggestion: true, location: '', direct: false,
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

  const loc = parseLocation(words.slice(restStart));
  const results = [];
  for (const book of unique.slice(0, limit)) {
    const r = await resolveInBook(db, book, loc);
    const complete = r.unmatched.length === 0;
    results.push({
      bookId: book.id,
      bookTitle: book.title,
      categoryPath: book.categoryPath,
      path: r.path,
      targetLine: r.targetLine,
      marker: r.marker,
      unmatched: r.unmatched,
      preview: await previewText(db, book.id, r.targetLine),
      complete,
      suggestion: false,
      location: locationLabel(r.path, r.marker),
      // A fully resolved reference to a place inside the book ("פתח: ... — ...").
      direct: complete && loc.length > 0 && (r.path.length > 0 || !!r.marker),
    });
  }
  // Fully resolved references first, then the most specific.
  results.sort((a, b) => Number(b.complete) - Number(a.complete) || a.unmatched.length - b.unmatched.length);
  return results;
}

module.exports = { loadBookIndex, resolveReference, tokenize, parseLocation, lookupBook, rawTokens };
