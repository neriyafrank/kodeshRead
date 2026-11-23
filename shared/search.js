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
 *     - smart mode ("חיפוש מורחב", { smart: true }) turns every word into an OR-group of
 *       variants from shared/hebrewTorahDict.js: abbreviation <-> full phrase (ב"ד <->
 *       "בית דין"), ktiv male/chaser (שולחן <-> שלחן), proclitic prefixes (ושבת, בשבת)
 *       and suffixes (FTS5 prefix queries, "שבת"*). Quoted phrases stay exact. Variant
 *       counts are capped per word and per query so FTS5 stays fast.
 *  2. searchParagraphs(): scoped query (library / folder / book), keyset paging
 *     in canonical book order (rowid = paragraphs.id, inserted in library order).
 *  2b. searchPlan() / countPlan(): run a shared/hebrewSearch.js plan (Simple + Advanced Search):
 *     FTS5 candidates, exact evaluation per row when the plan needs it, exact matches first
 *     ({ phase, afterId } cursor), corpus scopes (CORPORA) and an identical no-FTS5 fallback.
 *  3. buildKwic() / markTerms(): hit highlighting. `terms` entries are plain tokens
 *     ("שבת"), prefix patterns ("ושלחנ*") or multi-word phrases ("בית דינ"), so the
 *     result card and the reader mark the variant that actually matched.
 */
'use strict';

const { normalizeHebrew, stripHtml, decodeEntities, applyVocalization } = require('./hebrew');
const { sourcesOf, sourceForId, sourcesForCategory } = require('./sources');
const dict = require('./hebrewTorahDict');
const hs = require('./hebrewSearch');

/** Characters FTS5 treats as query syntax (spec list). */
const FTS_RESERVED_RE = /["'\-*():^]/g;
/** Quote characters that may open/close an exact phrase in the UI. */
const PHRASE_QUOTES = new Set(['"', '“', '”', '„', '״']);
const MAX_TERMS = 16;
/** Upper bound on FTS5 terms (OR variants) in one smart query. */
const MAX_QUERY_VARIANTS = 160;
/** Variants per word: between these, depending on how many words the query has. */
const MIN_WORD_VARIANTS = 6;

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

// Query tree: AND of groups; a group is an OR of alternatives:
//   { type: 'term', text, prefix }        one token ("שבת", or "שבת"* when prefix)
//   { type: 'phrase', tokens, prefix }    adjacent tokens ("בית דינ")
//   { type: 'and', groups }               all sub-groups anywhere in the paragraph

const termAlt = (v) => (v.endsWith('*') ? { type: 'term', text: v.slice(0, -1), prefix: true } : { type: 'term', text: v, prefix: false });

/** Exact (non-smart) parse: tokens AND-ed, quoted segments as phrases. */
function parseExact(input) {
  const parts = [];
  const phrases = [];
  const terms = [];
  const groups = [];
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
      groups.push({ alts: [{ type: 'phrase', tokens, prefix: false }] });
    } else {
      for (const t of tokens) {
        parts.push(`"${t}"`);
        groups.push({ alts: [{ type: 'term', text: t, prefix: false }] });
      }
    }
  }
  return { match: parts.join(' '), terms, phrases, groups, smart: false, empty: parts.length === 0 };
}

/** Raw words of an unquoted segment -> [{ tok, raw }] (raw keeps gershayim for abbreviation detection). */
function rawWords(text) {
  const out = [];
  for (const raw of String(text).split(/[\s,;!?()[\]{}]+/)) {
    const toks = toTokens(raw);
    if (toks.length === 1) out.push({ tok: toks[0], raw });
    else for (const t of toks) out.push({ tok: t, raw: t });
  }
  return out;
}

function pushAlt(alts, alt, limit) {
  if (alts.length >= limit) return;
  const key = altKey(alt);
  if (!alts.some((a) => altKey(a) === key)) alts.push(alt);
}
function altKey(a) {
  if (a.type === 'term') return 't:' + a.text + (a.prefix ? '*' : '');
  if (a.type === 'phrase') return 'p:' + a.tokens.join(' ') + (a.prefix ? '*' : '');
  return 'a:' + a.groups.map((g) => g.alts.map(altKey).join('|')).join('&');
}

/** Phrase alternatives for a multi-word expansion: "בית דינ", "ובית דינ", "בבית דינ", ... */
function phraseAlts(words, max) {
  const out = [{ type: 'phrase', tokens: words, prefix: false }];
  if (words[0].length >= dict.MIN_EXPAND_LEN) for (const p of ['ו', 'ב', 'ל', 'ה', 'מ', 'ש', 'וב', 'ול'].slice(0, Math.max(0, max - 1))) out.push({ type: 'phrase', tokens: [p + words[0], ...words.slice(1)], prefix: false });
  return out;
}

/** OR-group for one typed word in smart mode. */
function smartWordGroup(w, budget) {
  const alts = [];
  // Abbreviation -> full phrase(s) (+ the other abbreviations of the same phrase).
  const expansions = dict.expandAbbreviation(w.raw, { strict: true }).slice(0, 3);
  // An abbreviation keeps its exact spelling (+ prefixes): "שוע"* would also match "שועל".
  const variants = dict.expandWordVariants(w.tok, budget, { wildcard: !expansions.length }).map(termAlt);
  const abbrAlts = [];
  for (const exp of expansions) {
    const words = exp.split(' ');
    if (words.length > 1) abbrAlts.push(...phraseAlts(words, 3));
    else abbrAlts.push(...dict.expandWordVariants(exp, 6).map(termAlt));
    for (const a of dict.abbreviationsFor(exp, { strict: true })) if (a !== w.tok) abbrAlts.push({ type: 'term', text: a, prefix: false });
  }
  // A single full word with a dictionary abbreviation (תוספות -> תוס).
  for (const a of dict.abbreviationsFor(w.tok, { strict: true })) abbrAlts.push({ type: 'term', text: a, prefix: false });
  const head = abbrAlts.length ? Math.min(variants.length, Math.max(2, Math.floor(budget / 3))) : variants.length;
  for (const a of variants.slice(0, head)) pushAlt(alts, a, budget);
  for (const a of abbrAlts) pushAlt(alts, a, budget);
  for (const a of variants.slice(head)) pushAlt(alts, a, budget);
  return { alts };
}

/** OR-group for a typed dictionary full phrase ("בית דין"): all its words (expanded) OR its abbreviations. */
function smartPhraseGroup(words, budget) {
  const inner = Math.max(3, Math.floor(budget / (words.length + 1)));
  const alts = [{ type: 'and', groups: words.map((t) => ({ alts: dict.expandWordVariants(t, inner).map(termAlt) })) }];
  for (const a of dict.abbreviationsFor(words.join(' '), { strict: true })) pushAlt(alts, { type: 'term', text: a, prefix: false }, budget);
  return { alts };
}

/** Number of FTS5 terms in a group. */
function groupSize(g) {
  return g.alts.reduce((n, a) => n + (a.type === 'and' ? a.groups.reduce((m, x) => m + groupSize(x), 0) : 1), 0);
}

/** Highlight patterns of a group: "שבת", "ושבת*", "בית דינ". */
function groupTerms(g, out) {
  for (const a of g.alts) {
    if (a.type === 'term') out.add(a.text + (a.prefix ? '*' : ''));
    else if (a.type === 'phrase') out.add(a.tokens.join(' ') + (a.prefix ? '*' : ''));
    else for (const x of a.groups) groupTerms(x, out);
  }
  return out;
}

function altFts(a) {
  if (a.type === 'term') return `"${a.text}"${a.prefix ? '*' : ''}`;
  if (a.type === 'phrase') return `"${a.tokens.join(' ')}"${a.prefix ? '*' : ''}`;
  return '(' + a.groups.map(groupFts).join(' AND ') + ')';
}
function groupFts(g) {
  return g.alts.length === 1 ? altFts(g.alts[0]) : '(' + g.alts.map(altFts).join(' OR ') + ')';
}

/** Smart (morphological) parse. */
function parseSmart(input) {
  // 1. Items: exact quoted phrases, dictionary phrases, single words.
  const items = [];
  for (const seg of splitPhrases(input)) {
    if (seg.phrase) {
      const tokens = toTokens(seg.text);
      if (tokens.length) items.push({ kind: 'exact', tokens });
      continue;
    }
    const words = rawWords(seg.text);
    const maxN = dict.maxFullPhraseWords();
    for (let i = 0; i < words.length; ) {
      let n = Math.min(maxN, words.length - i);
      for (; n >= 2; n--) if (dict.isFullPhrase(words.slice(i, i + n).map((x) => x.tok))) break;
      if (n >= 2) {
        items.push({ kind: 'phrase', tokens: words.slice(i, i + n).map((x) => x.tok) });
        i += n;
      } else {
        items.push({ kind: 'word', word: words[i] });
        i += 1;
      }
    }
  }
  // 2. Groups within the term budgets.
  const groups = [];
  const phrases = [];
  let count = 0;
  const kept = [];
  for (const it of items) {
    const n = it.kind === 'word' ? 1 : it.tokens.length;
    if (count + n > MAX_TERMS) break;
    count += n;
    kept.push(it);
  }
  const budget = Math.max(MIN_WORD_VARIANTS, Math.min(dict.MAX_VARIANTS_PER_WORD, Math.floor(MAX_QUERY_VARIANTS / Math.max(1, kept.length))));
  let total = 0;
  for (const it of kept) {
    let g;
    if (it.kind === 'exact') {
      g = it.tokens.length > 1 ? { alts: [{ type: 'phrase', tokens: it.tokens, prefix: false }] } : { alts: [{ type: 'term', text: it.tokens[0], prefix: false }] };
      if (it.tokens.length > 1) phrases.push(it.tokens);
    } else if (it.kind === 'phrase') g = smartPhraseGroup(it.tokens, budget);
    else g = smartWordGroup(it.word, budget);
    total += groupSize(g);
    groups.push(g);
  }
  const terms = new Set();
  for (const g of groups) groupTerms(g, terms);
  return { match: groups.map(groupFts).join(' AND '), terms: [...terms], phrases, groups, smart: true, variantCount: total, empty: groups.length === 0 };
}

/**
 * @param {string} input
 * @param {{ smart?: boolean }} [opts]  smart: morphological / abbreviation expansion ("חיפוש מורחב")
 * @returns {{ match: string, terms: string[], phrases: string[][], groups: object[], smart: boolean, empty: boolean }}
 *   match: FTS5 MATCH expression, e.g. `"שבת" "אור ליום"` (phrase) — AND semantics.
 *   terms: highlight patterns (normalized tokens; smart mode adds "x*" prefixes and "a b" phrases).
 */
function parseSearchQuery(input, opts) {
  return opts && opts.smart ? parseSmart(input) : parseExact(input);
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

/**
 * Corpus sections of the Advanced Search ("סינון לפי מדור"), as Otzaria folder patterns on
 * category_path (which always ends with "/"). Base texts and their commentaries are separate:
 * "מפרשים" is every commentary / rishonim / acharonim folder.
 */
const CORPORA = [
  { id: 'tanach', label: 'תנ"ך', include: ['תנך/תורה/%', 'תנך/נביאים/%', 'תנך/כתובים/%'] },
  { id: 'mishna', label: 'משנה', include: ['משנה/סדר %'] },
  { id: 'bavli', label: 'בבלי', include: ['תלמוד בבלי/סדר %'] },
  { id: 'rambam', label: 'רמב"ם', include: ['הלכה/משנה תורה/%'], exclude: ['הלכה/משנה תורה/מפרשים/%'] },
  { id: 'shulchan-aruch', label: 'שולחן ערוך', include: ['הלכה/שולחן ערוך/'] },
  { id: 'mefarshim', label: 'מפרשים', include: ['%מפרשים%', '%/ראשונים/%', '%/אחרונים/%', '%/תרגומים/%', '%/מחברי זמננו/%', '%/מחברי זמנינו/%'] },
];

/** SQL condition on a category_path expression for a set of corpus ids. */
function corpusCondition(ids, col) {
  const params = [];
  const parts = [];
  for (const c of CORPORA.filter((x) => (ids || []).includes(x.id))) {
    let sql = '(' + c.include.map(() => `${col} LIKE ?`).join(' OR ') + ')';
    params.push(...c.include);
    if (c.exclude && c.exclude.length) {
      sql += ' AND NOT (' + c.exclude.map(() => `${col} LIKE ?`).join(' OR ') + ')';
      params.push(...c.exclude);
    }
    parts.push('(' + sql + ')');
  }
  return parts.length ? { sql: '(' + parts.join(' OR ') + ')', params } : { sql: '0', params: [] };
}

/** category_path of a paragraph's book (no-FTS fallback, where the FTS column is unavailable). */
const P_CATEGORY_PATH = "(SELECT COALESCE(c.path || '/', '') FROM books b LEFT JOIN categories c ON c.id = b.category_id WHERE b.id = p.book_id)";

/** WHERE fragment + params for a scope (category_path always ends with "/"). */
function scopeClause(scope) {
  if (!scope || scope.kind === 'all') return { sql: '', params: [] };
  if (scope.kind === 'corpus') {
    const c = corpusCondition(scope.ids, 'f.category_path');
    return { sql: ' AND ' + c.sql, params: c.params };
  }
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
  const params = [];
  let sql = 'FROM paragraphs p WHERE ' + likeGroups(q).map((g) => likeGroup(g, params, !!q.smart)).join(' AND ');
  if (scope && scope.kind === 'book') {
    sql += ' AND p.book_id = ?';
    params.push(scope.bookId);
  } else if (scope && scope.kind === 'category') {
    sql += " AND p.book_id IN (SELECT b.id FROM books b JOIN categories c ON c.id = b.category_id WHERE c.path || '/' LIKE ? ESCAPE '\\')";
    params.push(likeEscape(String(scope.path).replace(/\/+$/, '')) + '/%');
  } else if (scope && scope.kind === 'corpus') {
    const c = corpusCondition(scope.ids, P_CATEGORY_PATH);
    sql += ' AND ' + c.sql;
    params.push(...c.params);
  }
  return { sql, params, idCol: 'p.id' };
}

/** Groups of a parsed query (older callers may pass { terms, phrases } only). */
function likeGroups(q) {
  if (q.groups) return q.groups;
  const groups = q.phrases.map((ph) => ({ alts: [{ type: 'phrase', tokens: ph, prefix: false }] }));
  for (const t of q.terms) if (!q.phrases.some((ph) => ph.includes(t))) groups.push({ alts: [{ type: 'term', text: t, prefix: false }] });
  return groups;
}

/** GLOB character class of word characters (Hebrew letters, digits, Latin). */
const WORD_CHAR_CLASS = 'א-ת0-9a-zA-Z';

/** LIKE pattern text of a simple alternative (substring match covers prefixes and suffixes). */
const likeText = (a) => (a.type === 'term' ? a.text : a.tokens.join(' '));

/**
 * LIKE fragment of a group. Exact queries keep the historical substring match; smart queries
 * match terms at a word start (their prefixed / suffixed variants are enumerated anyway), so a
 * short abbreviation ("בד") does not match inside other words ("עבד").
 */
function likeGroup(g, params, smart) {
  const wordStart = (a) => smart && a.type === 'term';
  const simple = g.alts.filter((a) => a.type !== 'and');
  // An alternative already covered by a shorter one is redundant: substring ("ושבת" ⊃ "שבת")
  // or, at a word start, a longer word with the same beginning ("שבתות" after "שבת").
  const covered = (a) =>
    simple.some((o) => o !== a && likeText(o) !== likeText(a) && (wordStart(o) ? o.prefix && wordStart(a) && likeText(a).startsWith(likeText(o)) : likeText(a).includes(likeText(o))));
  const parts = [];
  const seen = new Set();
  for (const a of g.alts) {
    if (a.type === 'and') {
      parts.push('(' + a.groups.map((x) => likeGroup(x, params, smart)).join(' AND ') + ')');
      continue;
    }
    const t = likeText(a);
    const key = (wordStart(a) ? '^' : '') + t;
    if (seen.has(key) || covered(a)) continue;
    seen.add(key);
    if (wordStart(a) && !a.prefix) {
      // Whole word: next character is not a letter/digit (tokens are letters/digits only, so GLOB-safe).
      params.push('* ' + t + '[^' + WORD_CHAR_CLASS + ']*');
      parts.push("(' ' || p.clean_text || ' ') GLOB ?");
    } else if (wordStart(a)) {
      params.push('% ' + likeEscape(t) + '%');
      parts.push("(' ' || p.clean_text) LIKE ? ESCAPE '\\'");
    } else {
      params.push('%' + likeEscape(t) + '%');
      parts.push("p.clean_text LIKE ? ESCAPE '\\'");
    }
  }
  return parts.length === 1 ? parts[0] : '(' + parts.join(' OR ') + ')';
}

/**
 * Run a search. Results are in canonical library order; pass the last result's
 * `id` as `afterId` to fetch the next page (keyset paging, no OFFSET scans).
 *
 * @param {{ all: Function }} db
 * @param {string | ReturnType<typeof parseSearchQuery>} query
 * @param {{ scope?: SearchScope, afterId?: number, limit?: number, fts?: boolean, smart?: boolean }} [opts]
 */
async function searchParagraphs(db, query, opts) {
  const q = typeof query === 'string' ? parseSearchQuery(query, opts) : query;
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
  if (scope.kind !== 'category') return srcs;
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
  const q = typeof query === 'string' ? parseSearchQuery(query, opts) : query;
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
// Plans (shared/hebrewSearch.js): Simple + Advanced Search
// ---------------------------------------------------------------------------

/** Candidates read per verification batch, and the scan bounds per page / count. */
const VERIFY_BATCH = 250;
const MAX_SCAN_PER_PAGE = 20000;
const MAX_COUNT_SCAN = 40000;

/** LIKE condition of a plan (no-FTS5 web preview): a superset that evaluate() then decides. */
function planLike(plan, params) {
  const lg = hs.likeGroups(plan);
  const orLike = (subs) => {
    const parts = subs.map((t) => {
      params.push('%' + likeEscape(t) + '%');
      return "p.clean_text LIKE ? ESCAPE '\\'";
    });
    return parts.length === 1 ? parts[0] : '(' + parts.join(' OR ') + ')';
  };
  const parts = lg.must.map(orLike);
  if (lg.any) parts.push(orLike(lg.any));
  return parts.join(' AND ');
}

/** FROM / WHERE of one phase of a plan for one source. */
function planSource(phase, opts) {
  const scope = opts && opts.scope;
  if (!opts || opts.fts !== false) return matchSource({ match: phase.match }, opts);
  const params = [];
  let sql = 'FROM paragraphs p WHERE ' + planLike(phase.plan, params);
  if (scope && scope.kind === 'book') {
    sql += ' AND p.book_id = ?';
    params.push(scope.bookId);
  } else if (scope && scope.kind === 'category') {
    sql += " AND p.book_id IN (SELECT b.id FROM books b JOIN categories c ON c.id = b.category_id WHERE c.path || '/' LIKE ? ESCAPE '\\')";
    params.push(likeEscape(String(scope.path).replace(/\/+$/, '')) + '/%');
  } else if (scope && scope.kind === 'corpus') {
    const c = corpusCondition(scope.ids, P_CATEGORY_PATH);
    sql += ' AND ' + c.sql;
    params.push(...c.params);
  }
  return { sql, params, idCol: 'p.id' };
}

/**
 * Phases of a plan: exact matches first (the typed words only), then the rows that only the
 * expanded variants match. Each phase is { plan, match, verify(tokens) | null }.
 */
function planPhases(plan, fts) {
  const like = fts === false;
  const full = { plan, match: plan.match, verify: plan.needsVerify || like ? (t) => hs.evaluate(plan, t) : null };
  if (!plan.exact || plan.exact.empty) return [full];
  const ex = plan.exact;
  const exact = { plan: ex, match: ex.match, verify: ex.needsVerify || like ? (t) => hs.evaluate(ex, t) : null };
  const rest = {
    plan,
    // Exact rows are skipped by SQL when SQL decides them alone, and always by evaluate().
    match: ex.needsVerify ? plan.match : `(${plan.match}) NOT (${ex.positiveMatch})`,
    verify: (t) => hs.evaluate(plan, t) && !hs.evaluate(ex, t),
  };
  return [exact, rest];
}

async function planCandidates(db, phase, opts, afterId, take) {
  const out = [];
  for (const s of scopeSources(db, opts && opts.scope)) {
    if (out.length >= take) break;
    const src = planSource(phase, opts);
    const hasAfter = afterId != null;
    const rows = await s.adapter.all(
      `SELECT p.id AS id, p.book_id AS book_id, p.line_index AS line_index, p.toc_path AS toc_path,
              p.display_text AS display_text, p.is_heading AS is_heading,${phase.verify ? ' p.clean_text AS clean_text,' : ''}
              (SELECT title FROM books WHERE id = p.book_id) AS book_title
         ${src.sql}${hasAfter ? ` AND ${src.idCol} > ?` : ''}
        ORDER BY ${src.idCol}
        LIMIT ?`,
      [...src.params, ...(hasAfter ? [afterId] : []), take - out.length],
    );
    out.push(...rows);
  }
  return out;
}

/**
 * One page of a plan's results: exact matches (phase 0) in library order, then expanded-only
 * matches (phase 1). Pass the returned `cursor` back to continue.
 *
 * @param {{ all: Function }} db
 * @param {object} plan  hebrewSearch.buildQuery() result
 * @param {{ scope?: SearchScope, fts?: boolean, cursor?: { phase: number, afterId: number | null } | null, limit?: number }} [opts]
 * @returns {Promise<{ rows: (SearchRow & { phase: number })[], hasMore: boolean, cursor: { phase: number, afterId: number | null } | null }>}
 */
async function searchPlan(db, plan, opts) {
  const limit = (opts && opts.limit) || PAGE_SIZE;
  if (!plan || plan.empty) return { rows: [], hasMore: false, cursor: null };
  const phases = planPhases(plan, opts && opts.fts);
  const start = (opts && opts.cursor) || { phase: 0, afterId: null };
  const out = [];
  let scanned = 0;
  for (let phase = start.phase; phase < phases.length; phase++) {
    const ph = phases[phase];
    let afterId = phase === start.phase ? start.afterId : null;
    for (;;) {
      const take = ph.verify ? VERIFY_BATCH : limit + 1 - out.length;
      const rows = await planCandidates(db, ph, opts, afterId, take);
      for (const r of rows) {
        afterId = r.id;
        scanned++;
        if (ph.verify && !ph.verify(hs.toTokens(r.clean_text || ''))) continue;
        const { clean_text, ...row } = r;
        out.push({ ...row, phase });
        if (out.length > limit) {
          const last = out[limit - 1];
          return { rows: out.slice(0, limit), hasMore: true, cursor: { phase: last.phase, afterId: last.id } };
        }
      }
      if (rows.length < take) break; // this phase is exhausted
      if (scanned >= MAX_SCAN_PER_PAGE) return { rows: out, hasMore: true, cursor: { phase, afterId } };
    }
  }
  return { rows: out, hasMore: false, cursor: null };
}

/** Number of paragraphs a plan matches, capped at `cap` (default COUNT_CAP). */
async function countPlan(db, plan, opts) {
  if (!plan || plan.empty) return { count: 0, capped: false };
  const cap = (opts && opts.cap) || COUNT_CAP;
  const [full] = planPhases({ ...plan, exact: null }, opts && opts.fts);
  if (!full.verify) {
    let n = 0;
    for (const s of scopeSources(db, opts && opts.scope)) {
      if (n > cap) break;
      const src = planSource(full, opts);
      const r = await s.adapter.all(`SELECT COUNT(*) AS n FROM (SELECT 1 ${src.sql} LIMIT ?)`, [...src.params, cap + 1 - n]);
      n += r[0] ? Number(r[0].n) : 0;
    }
    return { count: Math.min(n, cap), capped: n > cap };
  }
  let n = 0;
  let scanned = 0;
  let afterId = null;
  for (;;) {
    const rows = await planCandidates(db, full, opts, afterId, VERIFY_BATCH);
    for (const r of rows) {
      afterId = r.id;
      scanned++;
      if (full.verify(hs.toTokens(r.clean_text || '')) && ++n > cap) return { count: cap, capped: true };
    }
    if (rows.length < VERIFY_BATCH) return { count: n, capped: false };
    if (scanned >= MAX_COUNT_SCAN) return { count: n, capped: true };
  }
}

// ---------------------------------------------------------------------------
// KWIC snippets
// ---------------------------------------------------------------------------

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
  // Same display toggles as the reader; hits are found on normalized words, so hidden
  // nikkud / cantillation never changes what is highlighted.
  const text = applyVocalization(decodeEntities(stripHtml(String(displayText || ''))).replace(/\s+/g, ' ').trim(), opts);
  const matcher = makeTermMatcher(terms);
  // Words + separators (whitespace, maqaf, paseq) alternate in `parts`.
  const parts = text.split(/(\s+|[־׀])/);
  const words = [];
  for (let i = 0; i < parts.length; i += 2) words.push({ text: parts[i], sep: parts[i + 1] || '', hit: false });
  const flags = matcher.hits(words.map((w) => toTokens(w.text)));
  words.forEach((w, i) => (w.hit = flags[i]));
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

/**
 * Compiles highlight `terms` into a word matcher. A term is a normalized token ("שבת"),
 * a prefix pattern ("ושלחנ*": any word starting with it) or a phrase of such words
 * ("בית דינ": consecutive words). hits(words) takes each displayed word's tokens
 * (toTokens) and returns which words are part of a match.
 */
function makeTermMatcher(terms) {
  const exact = new Set();
  const prefixes = [];
  const patterns = [];
  const phrases = [];
  // "~x" (inflected), "^x" / "%x" (prefixed) come from shared/hebrewSearch.js (Advanced Search).
  const parse = (w) => (/^[~^%]/.test(w) ? { fn: hs.compilePattern(w), text: w.slice(1) } : w.endsWith('*') ? { text: w.slice(0, -1), prefix: true } : { text: w, prefix: false });
  for (const t of terms || []) {
    const words = String(t || '').split(' ').filter(Boolean);
    if (words.length > 1) phrases.push(words.map(parse));
    else if (words.length === 1) {
      const w = parse(words[0]);
      if (!w.text) continue;
      if (w.fn) patterns.push(w.fn);
      else if (w.prefix) prefixes.push(w.text);
      else exact.add(w.text);
    }
  }
  const tokHit = (tok) => exact.has(tok) || prefixes.some((p) => tok.startsWith(p)) || patterns.some((fn) => fn(tok));
  const wordMatches = (toks, pw) => toks.some((t) => (pw.fn ? pw.fn(t) : pw.prefix ? t.startsWith(pw.text) : t === pw.text));
  return {
    empty: !exact.size && !prefixes.length && !patterns.length && !phrases.length,
    /** @param {string[][]} words  tokens of each word */
    hits(words) {
      const flags = words.map((toks) => toks.some(tokHit));
      if (phrases.length) {
        // Phrases only count when their words are consecutive (empty "words" such as
        // punctuation-only pieces are skipped).
        const idx = [];
        words.forEach((toks, i) => toks.length && idx.push(i));
        for (let k = 0; k < idx.length; k++) {
          for (const ph of phrases) {
            if (k + ph.length > idx.length) continue;
            let ok = true;
            for (let j = 0; j < ph.length && ok; j++) ok = wordMatches(words[idx[k + j]], ph[j]);
            if (ok) for (let j = 0; j < ph.length; j++) flags[idx[k + j]] = true;
          }
        }
      }
      return flags;
    },
  };
}

/**
 * Wraps the words of sanitized inline HTML (prepareDisplayText output) that match the
 * search terms in <mark>…</mark>, normalizing each word exactly like the index (niqqud,
 * finals, gershayim). Terms may be prefix patterns or phrases (see makeTermMatcher), so
 * smart-search hits such as "ושלחן" or "בית דין" are marked too. Tags are left untouched
 * (a phrase may span inline tags); used by the reader to flash the hit.
 */
function markTerms(html, terms) {
  const matcher = makeTermMatcher(terms);
  if (!html || matcher.empty) return html || '';
  const pieces = [];
  const wordIdx = [];
  for (const part of String(html).split(/(<[^>]*>)/)) {
    if (!part) continue;
    if (part[0] === '<') {
      pieces.push(part);
      continue;
    }
    part.split(/(\s+|[־׀])/).forEach((w, i) => {
      if (i % 2 === 0 && w) wordIdx.push(pieces.length);
      pieces.push(w);
    });
  }
  const flags = matcher.hits(wordIdx.map((i) => toTokens(pieces[i])));
  wordIdx.forEach((pi, k) => {
    if (flags[k]) pieces[pi] = `<mark>${pieces[pi]}</mark>`;
  });
  return pieces.join('');
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
  CORPORA,
  searchPlan,
  countPlan,
  FTS_RESERVED_RE,
  PAGE_SIZE,
  COUNT_CAP,
  MAX_QUERY_VARIANTS,
  splitPhrases,
  parseSearchQuery,
  scopeClause,
  hasFts5,
  searchParagraphs,
  countMatches,
  buildKwic,
  makeTermMatcher,
  markTerms,
  formatTocPath,
};
