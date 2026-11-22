/**
 * Hebrew full-text search over paragraphs_fts (SQLite FTS5).
 *
 * Shared between the app (expo-sqlite) and the Node self-test (node:sqlite) via
 * the same { all(sql, params) } adapter as quickJump.js.
 *
 *  1. parseSearchQuery(): user input -> safe FTS5 MATCH expression.
 *     - quoted segments ("...", “...”, ״...״) become exact phrases;
 *       a quote *inside* a word is gershayim (שו"ע) and is not a delimiter;
 *     - every segment goes through the same normalizeHebrew() used to build
 *       clean_text, then FTS5 syntax characters (" ' - * ( ) : ^ and any other
 *       punctuation) are stripped, so no input can raise "fts5: syntax error";
 *     - every token is re-wrapped in double quotes, so FTS5 keywords typed by
 *       the user (AND / OR / NOT / NEAR) are plain words; terms are AND-ed.
 *  2. searchParagraphs(): scoped query (library / folder / book), keyset paging
 *     in canonical book order (rowid = paragraphs.id, inserted in library order).
 *  3. buildKwic(): Key-Word-In-Context snippet of display_text with hits marked.
 */
'use strict';

const { normalizeHebrew, stripHtml, decodeEntities } = require('./hebrew');
const { sourcesOf, sourceForId, sourcesForCategory } = require('./sources');

/** Characters FTS5 treats as query syntax (spec list). */
const FTS_RESERVED_RE = /["'\-*():^]/g;
/** Quote characters that may open/close an exact phrase in the UI. */
const PHRASE_QUOTES = new Set(['"', '“', '”', '„', '״']);
const MAX_TERMS = 16;

/** Normalize one segment of user input into plain FTS tokens. */
function toTokens(segment) {
  return normalizeHebrew(segment)
    .replace(FTS_RESERVED_RE, ' ')
    // Anything else that is not a letter/digit would be a bareword error or a
    // token separator anyway: drop it so tokens are pure.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Split raw input into [{ text, phrase }] segments on word-boundary quotes. */
function splitPhrases(input) {
  const s = String(input || '');
  const out = [];
  let buf = '';
  let inPhrase = false;
  const isSpace = (ch) => ch === undefined || /[\s,;.!?()[\]{}]/.test(ch);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (PHRASE_QUOTES.has(ch)) {
      const prev = s[i - 1];
      const next = s[i + 1];
      if (!inPhrase && isSpace(prev) && !isSpace(next)) {
        if (buf.trim()) out.push({ text: buf, phrase: false });
        buf = '';
        inPhrase = true;
        continue;
      }
      if (inPhrase && isSpace(next)) {
        if (buf.trim()) out.push({ text: buf, phrase: true });
        buf = '';
        inPhrase = false;
        continue;
      }
      // Otherwise: gershayim inside a word (שו"ע) - keep it; normalizeHebrew drops it.
    }
    buf += ch;
  }
  // An unclosed quote still means "exact phrase" (the user is typing one).
  if (buf.trim()) out.push({ text: buf, phrase: inPhrase });
  return out;
}

/**
 * @returns {{ match: string, terms: string[], phrases: string[][], empty: boolean }}
 *   match: FTS5 MATCH expression, e.g. `"שבת" "אור ליום"` (phrase) — AND semantics.
 *   terms: unique normalized tokens (for highlighting).
 */
function parseSearchQuery(input) {
  const parts = [];
  const phrases = [];
  const terms = [];
  let count = 0;
  for (const seg of splitPhrases(input)) {
    if (count >= MAX_TERMS) break;
    let tokens = toTokens(seg.text);
    tokens = tokens.slice(0, MAX_TERMS - count);
    if (!tokens.length) continue;
    count += tokens.length;
    for (const t of tokens) if (!terms.includes(t)) terms.push(t);
    if (seg.phrase && tokens.length > 1) {
      phrases.push(tokens);
      parts.push(`"${tokens.join(' ')}"`);
    } else {
      for (const t of tokens) parts.push(`"${t}"`);
    }
  }
  return { match: parts.join(' '), terms, phrases, empty: parts.length === 0 };
}

// ---------------------------------------------------------------------------
// Scopes & querying
// ---------------------------------------------------------------------------

/**
 * @typedef {{ kind: 'all' } | { kind: 'category', path: string, name: string } | { kind: 'book', bookId: number, title: string }} SearchScope
 */

/** Escape LIKE wildcards in a folder path (used with ESCAPE '\'). */
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

/** WHERE fragment + params for a scope (category_path always ends with "/"). */
function scopeClause(scope) {
  if (!scope || scope.kind === 'all') return { sql: '', params: [] };
  if (scope.kind === 'category') {
    const p = String(scope.path).replace(/\/+$/, '');
    return { sql: " AND f.category_path LIKE ? ESCAPE '\\'", params: [likeEscape(p) + '/%'] };
  }
  return { sql: ' AND f.book_id = ?', params: [scope.bookId] };
}

const PAGE_SIZE = 40;
const COUNT_CAP = 1000;

/**
 * True when the SQLite build has FTS5. Android builds always do (expo-sqlite
 * `enableFTS`); the web preview's wa-sqlite build does not.
 */
async function hasFts5(db) {
  for (const s of sourcesOf(db)) if (!(await hasFts5One(s.adapter))) return false;
  return true;
}

async function hasFts5One(db) {
  try {
    const mods = await db.all("SELECT name FROM pragma_module_list WHERE name = 'fts5'", []);
    if (!mods.length) return false;
    await db.all("SELECT rowid FROM paragraphs_fts WHERE paragraphs_fts MATCH '\"x\"' LIMIT 1", []);
    return true;
  } catch {
    return false;
  }
}

/**
 * FROM/WHERE for a query. With `fts: false` (web preview only) a slow substring
 * LIKE scan over clean_text stands in for MATCH (same scopes and ordering).
 */
function matchSource(q, opts) {
  const scope = opts && opts.scope;
  if (!opts || opts.fts !== false) {
    const sc = scopeClause(scope);
    let sql = `FROM paragraphs_fts f JOIN paragraphs p ON p.id = f.rowid WHERE paragraphs_fts MATCH ?${sc.sql}`;
    const params = [q.match, ...sc.params];
    if (scope && scope.kind === 'book') {
      // A book's paragraphs have contiguous ids: let FTS5 seek by rowid range too.
      sql += ' AND f.rowid BETWEEN (SELECT MIN(id) FROM paragraphs WHERE book_id = ?) AND (SELECT MAX(id) FROM paragraphs WHERE book_id = ?)';
      params.push(scope.bookId, scope.bookId);
    }
    return { sql, params, idCol: 'f.rowid' };
  }
  const groups = [...q.phrases.map((ph) => ph.join(' ')), ...q.terms.filter((t) => !q.phrases.some((ph) => ph.includes(t)))];
  let sql = 'FROM paragraphs p WHERE ' + groups.map(() => "p.clean_text LIKE ? ESCAPE '\\'").join(' AND ');
  const params = groups.map((g) => '%' + likeEscape(g) + '%');
  if (scope && scope.kind === 'book') {
    sql += ' AND p.book_id = ?';
    params.push(scope.bookId);
  } else if (scope && scope.kind === 'category') {
    sql += " AND p.book_id IN (SELECT b.id FROM books b JOIN categories c ON c.id = b.category_id WHERE c.path || '/' LIKE ? ESCAPE '\\')";
    params.push(likeEscape(String(scope.path).replace(/\/+$/, '')) + '/%');
  }
  return { sql, params, idCol: 'p.id' };
}

/**
 * Run a search. Results are in canonical library order; pass the last result's
 * `id` as `afterId` to fetch the next page (keyset paging, no OFFSET scans).
 *
 * @param {{ all: Function }} db
 * @param {string | ReturnType<typeof parseSearchQuery>} query
 * @param {{ scope?: SearchScope, afterId?: number, limit?: number, fts?: boolean }} [opts]
 */
async function searchParagraphs(db, query, opts) {
  const q = typeof query === 'string' ? parseSearchQuery(query) : query;
  const limit = (opts && opts.limit) || PAGE_SIZE;
  if (q.empty) return { rows: [], hasMore: false, query: q };
  // Sources are ordered by id namespace (core, then personal books), so keyset paging
  // by id continues seamlessly from one database into the next.
  const rows = [];
  for (const s of scopeSources(db, opts && opts.scope)) {
    if (rows.length > limit) break;
    rows.push(...(await searchOne(s.adapter, q, opts, limit + 1 - rows.length)));
  }
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore, query: q };
}

/** Databases a scope can match in (a book or folder lives in exactly one). */
function scopeSources(db, scope) {
  const srcs = sourcesOf(db);
  if (!scope || scope.kind === 'all') return srcs;
  if (scope.kind === 'book') {
    const s = srcs.length > 1 ? sourceForId(srcs, scope.bookId) : srcs[0];
    return s ? [s] : [];
  }
  return srcs.length > 1 ? sourcesForCategory(db, scope.path) : srcs;
}

async function searchOne(db, q, opts, take) {
  const src = matchSource(q, opts);
  const hasAfter = opts && opts.afterId != null;
  return db.all(
    `SELECT p.id AS id, p.book_id AS book_id, p.line_index AS line_index, p.toc_path AS toc_path,
            p.display_text AS display_text, p.is_heading AS is_heading,
            (SELECT title FROM books WHERE id = p.book_id) AS book_title
       ${src.sql}${hasAfter ? ` AND ${src.idCol} > ?` : ''}
      ORDER BY ${src.idCol}
      LIMIT ?`,
    [...src.params, ...(hasAfter ? [opts.afterId] : []), take],
  );
}

/** Number of matching paragraphs, capped at COUNT_CAP (returns { count, capped }). */
async function countMatches(db, query, opts) {
  const q = typeof query === 'string' ? parseSearchQuery(query) : query;
  if (q.empty) return { count: 0, capped: false };
  const cap = (opts && opts.cap) || COUNT_CAP;
  const src = matchSource(q, opts);
  let n = 0;
  for (const s of scopeSources(db, opts && opts.scope)) {
    if (n > cap) break;
    const r = await s.adapter.all(`SELECT COUNT(*) AS n FROM (SELECT 1 ${src.sql} LIMIT ?)`, [...src.params, cap + 1 - n]);
    n += r[0] ? Number(r[0].n) : 0;
  }
  return { count: Math.min(n, cap), capped: n > cap };
}

// ---------------------------------------------------------------------------
// KWIC snippets
// ---------------------------------------------------------------------------

const NIQQUD_DISPLAY_RE = /[֑-ֽֿ-ׂׄ-ׇ]/g;

/**
 * Build a Key-Word-In-Context snippet from a paragraph's display_text.
 * Words are matched by normalizing each displayed word exactly like the index,
 * so niqqud, finals and gershayim never prevent a highlight.
 *
 * @returns {{ segments: { text: string, hit: boolean }[], hitCount: number, clippedStart: boolean, clippedEnd: boolean }}
 */
function buildKwic(displayText, terms, opts) {
  const before = (opts && opts.before) || 7;
  const after = (opts && opts.after) || 16;
  const showNiqqud = !opts || opts.showNiqqud !== false;
  let text = decodeEntities(stripHtml(String(displayText || ''))).replace(/\s+/g, ' ').trim();
  if (!showNiqqud) text = text.replace(NIQQUD_DISPLAY_RE, '');
  const termSet = new Set(terms || []);
  // Words + separators (whitespace, maqaf, paseq) alternate in `parts`.
  const parts = text.split(/(\s+|[־׀])/);
  const words = [];
  for (let i = 0; i < parts.length; i += 2) {
    const w = parts[i];
    const sep = parts[i + 1] || '';
    const toks = toTokens(w);
    words.push({ text: w, sep, hit: toks.some((t) => termSet.has(t)) });
  }
  const first = words.findIndex((w) => w.hit);
  const hitCount = words.filter((w) => w.hit).length;
  let from = 0;
  let to = words.length;
  if (words.length > before + after + 1) {
    from = Math.max(0, (first < 0 ? 0 : first) - before);
    to = Math.min(words.length, from + before + after + 1);
    from = Math.max(0, Math.min(from, to - (before + after + 1)));
  }
  // Merge adjacent words with the same hit state into segments.
  const segments = [];
  for (let i = from; i < to; i++) {
    const w = words[i];
    const sep = i === to - 1 ? '' : w.sep;
    const last = segments[segments.length - 1];
    if (w.hit) {
      segments.push({ text: w.text, hit: true });
      if (sep) segments.push({ text: sep, hit: false });
    } else if (last && !last.hit) last.text += w.text + sep;
    else segments.push({ text: w.text + sep, hit: false });
  }
  // Coalesce consecutive non-hit segments created by separators.
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && !last.hit && !s.hit) last.text += s.text;
    else merged.push({ ...s });
  }
  return { segments: merged, hitCount, clippedStart: from > 0, clippedEnd: to < words.length };
}

/** "Part > Chapter > Section" from the stored toc_path (separator agnostic). */
function formatTocPath(tocPath) {
  if (!tocPath) return '';
  return String(tocPath)
    .split(/\s*>\s*/)
    .filter(Boolean)
    .join(' › ');
}

module.exports = {
  FTS_RESERVED_RE,
  PAGE_SIZE,
  COUNT_CAP,
  splitPhrases,
  parseSearchQuery,
  scopeClause,
  hasFts5,
  searchParagraphs,
  countMatches,
  buildKwic,
  formatTocPath,
};
