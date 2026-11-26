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
 *
 * Torah parshiot (shared/torahParshiot.js): "וישלח", "פרשת וישלח שני", "וישלח ב" / "וישלח 2",
 * "תצוה עלייה חמישית", "בראשית מפטיר" open that parsha / aliyah's verse in the Chumash book
 * (spelling variants: תצוה / תצווה, פינחס / פנחס, שלח לך, אחרי, כי תבא ...). The five book names
 * stay book references ("בראשית א", "בראשית לב יד"); see parseParshaQuery for the rules.
 */
'use strict';

const { normalizeHebrew, stripHtml, decodeEntities } = require('./hebrew');
const { sourcesOf, adapterForBook } = require('./sources');
const dict = require('./hebrewTorahDict');
const torah = require('./torahParshiot');
const halacha = require('./halachaTopics');
const tosefta = require('./toseftaEditions');

const MAX_BOOK_CANDIDATES = 5;

/**
 * Load every book's title + aliases once and index them in memory.
 * `db` may be a router: the books of every library database are indexed together
 * (their ids never collide), core books first.
 *
 * `{ lazyAliases: true }` (the app's cold start): only the `books` map (id -> title / folder / lines, cheap columns, no
 * alias strings, no normalization) is loaded before the first render. The alias index (`byAlias`, `maxAliasTokens`)
 * is built later by `index.ensureAliases()` (cooperative, idempotent; `resolveReference` awaits it), so a library of
 * thousands of books never blocks the Library screen on ~1MB of alias text.
 */
async function loadBookIndex(db, opts) {
  const lazy = !!(opts && opts.lazyAliases);
  const books = new Map();
  for (const s of sourcesOf(db)) {
    const rows = await s.adapter.all(
      `SELECT b.id, b.title, b.total_lines, c.path AS category_path
       FROM books b LEFT JOIN categories c ON c.id = b.category_id ORDER BY b.id`,
      [],
    );
    for (const r of rows) {
      books.set(r.id, { id: r.id, title: r.title, categoryPath: r.category_path || '', totalLines: r.total_lines });
    }
  }
  const index = { byAlias: new Map(), books, maxAliasTokens: 1, aliasesReady: false, ensureAliases: null };
  let building = null;
  index.ensureAliases = (pause) => {
    if (index.aliasesReady) return Promise.resolve();
    if (!building) {
      building = buildAliasIndex(db, index, pause).then(
        () => {
          index.aliasesReady = true;
        },
        (e) => {
          building = null; // retry on the next call
          throw e;
        },
      );
    }
    return building;
  };
  if (!lazy) await index.ensureAliases();
  return index;
}

/** Fills index.byAlias / maxAliasTokens from the aliases column; yields (`pause`) every few hundred books when given. */
async function buildAliasIndex(db, index, pause) {
  const byAlias = new Map();
  let n = 0;
  for (const s of sourcesOf(db)) {
    const rows = await s.adapter.all('SELECT id, title, aliases FROM books ORDER BY id', []);
    for (const r of rows) {
      const book = index.books.get(r.id);
      if (!book) continue; // removed since the index was loaded
      const titleKey = normalizeHebrew(r.title, { keepPunctuation: false });
      const aliases = String(r.aliases).split('|').filter(Boolean);
      if (!aliases.includes(titleKey)) aliases.unshift(titleKey);
      for (const a of aliases) {
        const list = byAlias.get(a) || [];
        list.push({ book, exactTitle: a === titleKey });
        byAlias.set(a, list);
      }
      if (pause && ++n % 500 === 0) await pause();
    }
  }
  let maxAliasTokens = 1;
  for (const a of byAlias.keys()) maxAliasTokens = Math.max(maxAliasTokens, a.split(' ').length);
  index.byAlias = byAlias;
  index.maxAliasTokens = maxAliasTokens;
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

// --- Torah parshiot / aliyot --------------------------------------------------------------

const chumashCache = new WeakMap();
/** The library's Chumash books: Map(book name -> indexed book), core first. */
function chumashBooks(index) {
  let m = chumashCache.get(index);
  if (m) return m;
  m = new Map();
  for (const b of index.books.values()) {
    const name = torah.chumashBookOf(b.title, b.categoryPath);
    if (name && !m.has(name)) m.set(name, b);
  }
  chumashCache.set(index, m);
  return m;
}

/** A parsha / aliyah query resolved to its verse line in the library's Chumash book, or null. */
async function resolveParsha(db, index, hit) {
  const book = chumashBooks(index).get(hit.parsha.book);
  if (!book) return null;
  const start = hit.reading.start;
  const r = await resolveInBook(db, book, [{ key: dict.intToHebrewNumeral(start.chapter) }, { key: dict.intToHebrewNumeral(start.verse) }]);
  if (r.unmatched.length) return null;
  const ref = torah.printedRef(hit.parsha.book, start);
  const location = `${hit.parsha.title} · ${hit.reading.name}`;
  return {
    bookId: book.id,
    bookTitle: book.title,
    categoryPath: book.categoryPath,
    path: r.path,
    targetLine: r.targetLine,
    marker: r.marker,
    unmatched: [],
    preview: await previewText(db, book.id, r.targetLine),
    complete: true,
    suggestion: false,
    location,
    direct: hit.strong,
    parsha: { index: hit.parsha.index, name: hit.parsha.name, title: hit.parsha.title, aliyah: hit.reading.name, readingIndex: hit.readingIndex, book: hit.parsha.book, ref: { ...start }, refLabel: ref, label: `${location} (${ref})` },
  };
}

/**
 * Resolve a quick-jump query: book references, plus a parsha / aliyah card when the query names
 * one (first when it clearly does, after the book results for a bare "בראשית" / "שמות" ...).
 * @returns {Promise<Array<{ bookId, bookTitle, categoryPath, path: string[], targetLine, marker, unmatched: string[], preview, complete: boolean, parsha? }>>}
 */
async function resolveReference(db, index, input, opts) {
  // The alias index is built lazily after the first render (loadBookIndex { lazyAliases }): wait for it on first use.
  if (index.ensureAliases && !index.aliasesReady) await index.ensureAliases();
  const hit = torah.parseParshaQuery(rawTokens(input).map((w) => w.tok));
  const [parsha, books] = await Promise.all([hit ? resolveParsha(db, index, hit) : null, resolveBookReference(db, index, input, opts)]);
  if (!parsha) return books;
  const others = books.filter((b) => !(b.bookId === parsha.bookId && b.targetLine === parsha.targetLine));
  if (!hit.strong) return [...others, parsha];
  // Clearly a parsha: book-name completions of the same words stay below it, not as the direct card.
  return [parsha, ...others.map((b) => ({ ...b, direct: false }))];
}

// --- Rambam scoped prefix matcher ("רמבם תפילה ב ג") ---------------------------------------------------------

const RAMBAM_TOKEN = normalizeHebrew('רמב"ם', { keepPunctuation: false });
const MT = normalizeHebrew('משנה תורה', { keepPunctuation: false }).split(' ');
/** Words typed before the work's own name that carry no identity ("הלכות תפילה", "מסכת ברכות", "על ברכות"). */
const RAMBAM_NOISE = new Set(['הלכות', 'הלכה', 'הל', 'מסכת', 'מס', 'ספר', 'על', 'מסכתא'].map((w) => normalizeHebrew(w, { keepPunctuation: false })));
/** Leading words that select the Mishnah commentary ("רמבם פירוש המשנה ברכות", "רמבם משנה ברכות"). */
const PM_HINT = new Set(['פירוש', 'פירוש', 'המשנה', 'המשניות', 'משניות', 'משנה', 'לפירוש'].map((w) => normalizeHebrew(w, { keepPunctuation: false })));
const RAMBAM_NORM = RAMBAM_TOKEN; // final letters are folded by normalizeHebrew (רמבם -> רמבמ)
const PM_TITLE = new RegExp(`^(?:${RAMBAM_NORM} על (?:ה)?משנ(?:ה|יות)|פירוש (?:ה)?משנ(?:ה|יות) (?:ל)?ה?${RAMBAM_NORM})\\s*`);

const rambamCache = new WeakMap();

/**
 * Rambam's OWN works, identified by folder path / title (never by "X על רמבם"):
 *   mt  משנה תורה (a `משנה תורה` folder segment outside מפרשים, or a "משנה תורה, ..." title outside commentary folders)
 *   pm  פירוש המשנה לרמב"ם ("רמבם על משנה X" / "פירוש המשנה לרמב"ם X", outside מפרשים / אחרונים)
 * Each entry carries the name tokens used for matching (title minus the work's prefix and "הלכות").
 */
function rambamBooks(index) {
  let list = rambamCache.get(index);
  if (list) return list;
  list = [];
  const T = (x) => normalizeHebrew(x, { keepPunctuation: false });
  for (const b of index.books.values()) {
    const segs = String(b.categoryPath || '').split('/').map(T);
    const title = T(b.title).replace(/^[\u200E\u200F]+/, '');
    const commentaryFolder = segs.includes(T('מפרשים')) || segs.includes(T('אחרונים'));
    let kind = null;
    let rest = '';
    if (!commentaryFolder && PM_TITLE.test(title)) {
      kind = 'pm';
      rest = title.replace(PM_TITLE, '');
    } else if (!segs.includes(T('מפרשים')) && (segs.includes(T('משנה תורה')) || /^משנה תורה\b/.test(title))) {
      if (/\sעל\s/.test(title) && !/^משנה תורה/.test(title)) continue; // "X על משנה תורה"
      kind = 'mt';
      rest = title.replace(/^משנה תורה\s*/, '');
    }
    if (!kind) continue;
    const tokens = rest.split(' ').filter((t) => t && !RAMBAM_NOISE.has(t));
    if (tokens.length) list.push({ book: b, kind, tokens, order: list.length });
  }
  rambamCache.set(index, list);
  return list;
}

/** Score (0 = no match) of query tokens against a name's tokens: contiguous, word-equal (optional ו- prefix); `prefix` lets the last token be a word start. */
function rambamScore(q, name, prefix) {
  const strip = (t) => (t.length > 2 && t[0] === 'ו' ? t.slice(1) : t);
  const eq = (a, b) => a === b || strip(b) === a;
  for (let at = 0; at + q.length <= name.length; at++) {
    let ok = true;
    for (let i = 0; i < q.length && ok; i++) {
      const n = name[at + i];
      const last = i === q.length - 1;
      ok = eq(q[i], n) || (prefix && last && q[i].length >= 2 && (n.startsWith(q[i]) || strip(n).startsWith(q[i])));
    }
    if (ok) return q.length === name.length && at === 0 ? 3 : at === 0 ? 2 : 1;
  }
  return 0;
}

/**
 * "רמבם <name> [location]": match the remainder against Rambam's own works only (see rambamBooks), longest name first,
 * the rest of the query is the chapter / halakha / mishna reference. Null when the query is not scoped or nothing matches
 * (the generic resolver then runs as before).
 */
async function resolveRambamScoped(db, index, words, limit) {
  const tokens = words.map((w) => w.tok);
  if (tokens.length < 2 || tokens[0] !== RAMBAM_TOKEN) return null;
  let at = 1;
  let prefer = null;
  if (tokens.slice(at, at + 2).join(' ') === MT.join(' ')) {
    prefer = 'mt';
    at += 2;
  }
  while (at < tokens.length - 1 && (PM_HINT.has(tokens[at]) || RAMBAM_NOISE.has(tokens[at]))) {
    if (PM_HINT.has(tokens[at]) && !prefer) prefer = 'pm';
    at++;
  }
  const all = rambamBooks(index);
  if (!all.length || at >= tokens.length) return null;
  const rest = tokens.slice(at);
  let found = null;
  for (const prefix of [false, true]) {
    for (let n = rest.length; n >= 1 && !found; n--) {
      if (prefix && n !== rest.length) continue; // a word start is only accepted while typing the last word
      const q = rest.slice(0, n);
      const hits = [];
      for (const e of all) {
        if (prefer === 'mt' && e.kind !== 'mt') continue;
        const score = rambamScore(q, e.tokens, prefix);
        if (score) hits.push({ e, score });
      }
      if (hits.length) found = { hits, n };
    }
    if (found) break;
  }
  if (!found) return null;
  const rank = (e) => (prefer ? (e.kind === prefer ? 0 : 1) : e.kind === 'mt' ? 0 : 1);
  found.hits.sort((a, b) => b.score - a.score || rank(a.e) - rank(b.e) || a.e.order - b.e.order);
  const loc = parseLocation(words.slice(at + found.n));
  const results = [];
  for (const { e, score } of found.hits.slice(0, limit)) {
    const r = await resolveInBook(db, e.book, loc);
    results.push({
      bookId: e.book.id, bookTitle: e.book.title, categoryPath: e.book.categoryPath, path: r.path, targetLine: r.targetLine, marker: r.marker,
      unmatched: r.unmatched, preview: await previewText(db, e.book.id, r.targetLine), complete: r.unmatched.length === 0, suggestion: false,
      location: locationLabel(r.path, r.marker), direct: r.unmatched.length === 0 && loc.length > 0 && (r.path.length > 0 || !!r.marker), _score: score,
    });
  }
  // Fully resolved first, then name quality, then Mishneh Torah before Peirush HaMishnah (kept stable by the sort above).
  const keyed = results.map((r, i) => ({ r, i }));
  keyed.sort((a, b) => Number(b.r.complete) - Number(a.r.complete) || b.r._score - a.r._score || a.i - b.i);
  return keyed.map(({ r }) => {
    delete r._score;
    return r;
  });
}

// --- Shulchan Aruch / Tur topics ("שוע ציצית", "טור בשר בחלב") -------------------------------------------------

const SA_WORD = normalizeHebrew('שו"ע', { keepPunctuation: false });
const TUR_WORD = normalizeHebrew('טור', { keepPunctuation: false });
const topicBookCache = new WeakMap();

/** [{ book, info }] of the library's Shulchan Aruch / Tur section books (commentaries never), core first. */
function topicBooks(index) {
  let list = topicBookCache.get(index);
  if (list) return list;
  list = [];
  for (const b of index.books.values()) {
    const info = halacha.sectionOfBook(b.title, b.categoryPath);
    if (info) list.push({ book: b, info });
  }
  topicBookCache.set(index, list);
  return list;
}

/** "שוע" | "שו"ע" | "שולחן ערוך" | "טור" at the start: { kind, at } (tokens consumed) or null. */
function topicPrefix(tokens) {
  if (tokens[0] === TUR_WORD) return { kind: 'tur', at: 1 };
  if (tokens[0] === SA_WORD) return { kind: 'sa', at: 1 };
  if ((tokens[0] === normalizeHebrew('שולחן') || tokens[0] === normalizeHebrew('שלחן')) && tokens[1] === normalizeHebrew('ערוך')) return { kind: 'sa', at: 2 };
  return null;
}

/** First siman line of a topic inside a Tur book holding all four sections (its section heading found by title). */
async function turSimanInSection(db, book, sec, siman) {
  const rows = await db.all('SELECT id, title, level, start_line FROM toc_nodes WHERE book_id = ? AND level <= 2 ORDER BY start_line', [book.id]);
  const node = rows.find((r) => normalizeHebrew(r.title, { keepPunctuation: false }).includes(halacha.SECTION_NAME[sec]));
  if (!node) return null;
  const end = await rangeEnd(db, book.id, node, book.totalLines);
  const hit = await findNode(db, book.id, [dict.intToHebrewNumeral(siman)], node.start_line, end, node.level);
  return hit ? { node, hit } : null;
}

/**
 * "<שוע|שו"ע|שולחן ערוך|טור> [section] <topic>": matches the bundled הלכות topics (shared/halachaTopics.js) and opens the
 * section book at the topic's first siman. Numeric / abbreviated references ("שוע אוח ח", "טור יו"ד פז") are left to the
 * generic resolver. Null when not a topic query or no topic / book matches.
 */
async function resolveHalachaTopic(db, index, words, limit) {
  if (!halacha.hasData()) return null;
  const tokens = words.map((w) => w.tok);
  const pre = topicPrefix(tokens);
  if (!pre || tokens.length <= pre.at) return null;
  let rest = tokens.slice(pre.at);
  let sec = null;
  for (const k of halacha.SECTION_KEYS) {
    for (const alias of halacha.SECTION_ALIASES[k]) {
      const a = alias.split(' ');
      if (rest.length > a.length && a.every((x, i) => rest[i] === x)) {
        sec = k;
        rest = rest.slice(a.length);
        break;
      }
    }
    if (sec) break;
  }
  // A pure location ("ח", "כה ה", "סימן ח") is a reference, not a topic.
  if (rest.every((t) => /^\d+$/.test(t) || dict.isHebrewNumeral(t) || STRUCTURE_WORDS.has(t))) return null;
  const matches = halacha.matchTopics(pre.kind, rest, sec ? { sec } : undefined);
  if (!matches.length) return null;
  const books = topicBooks(index).filter((b) => b.info.kind === pre.kind);
  const results = [];
  for (const m of matches) {
    const cand = books.find((b) => b.info.sec === m.sec) || books.find((b) => b.info.sec === null);
    if (!cand) continue;
    const book = cand.book;
    const adapter = adapterForBook(db, book.id);
    let r;
    if (cand.info.sec) {
      r = await resolveInBook(db, book, [{ key: dict.intToHebrewNumeral(m.topic.from) }]);
      if (r.unmatched.length) continue;
    } else {
      const f = await turSimanInSection(adapter, book, m.sec, m.topic.from);
      if (!f) continue;
      r = { path: [f.node.title, f.hit.title], targetLine: f.hit.start_line, marker: null, unmatched: [] };
    }
    const location = `${m.topic.t} (סימן ${halacha.simanLabel(m.topic.from)})`;
    results.push({
      bookId: book.id, bookTitle: book.title, categoryPath: book.categoryPath, path: r.path, targetLine: r.targetLine, marker: null, unmatched: [],
      preview: await previewText(db, book.id, r.targetLine), complete: true, suggestion: false, location,
      direct: results.length === 0, topic: { section: m.sec, name: m.topic.t, from: m.topic.from, to: m.topic.to, label: `${cand.info.kind === 'tur' ? 'טור' : 'שולחן ערוך'} ${halacha.SECTION_LABEL[m.sec]} · ${location}` },
    });
    if (results.length >= limit) break;
  }
  return results.length ? results : null;
}

/** A literal title hit; Lieberman's Tosefta ("תוספתא ברכות (ליברמן)") counts as one: the edition label is not part of the name. */
const exactEdition = (c) => c.exactTitle || (tosefta.isToseftaBook(c.book) && tosefta.editionRank(c.book) === tosefta.LIEBERMAN_RANK);

/**
 * A Tosefta hit also brings the other edition(s) of the same tractate ("תוספתא ברכות" -> + "תוספתא ברכות (ליברמן)"): the
 * edition label is not part of the name typed, and both editions stay separate candidates (Lieberman first, see above).
 */
function withOtherEditions(index, candidates) {
  const stem = (t) => String(t || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const wanted = new Set(candidates.filter((c) => tosefta.isToseftaBook(c.book)).map((c) => stem(c.book.title)));
  if (!wanted.size) return candidates;
  const have = new Set(candidates.map((c) => c.book.id));
  const extra = [];
  for (const b of index.books.values()) {
    if (!have.has(b.id) && tosefta.isToseftaBook(b) && wanted.has(stem(b.title))) extra.push({ book: b, exactTitle: false });
  }
  return extra.length ? [...candidates, ...extra] : candidates;
}

async function resolveBookReference(db, index, input, opts) {
  const limit = (opts && opts.limit) || MAX_BOOK_CANDIDATES;
  const words = rawTokens(input);
  const tokens = words.map((w) => w.tok);
  if (!tokens.length) return [];

  const scoped = await resolveRambamScoped(db, index, words, limit);
  if (scoped && scoped.length) return scoped;
  const topical = await resolveHalachaTopic(db, index, words, limit);
  if (topical) return topical;

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
    out.sort((a, b) => Number(exactEdition(b.c)) - Number(exactEdition(a.c)) || tosefta.compareEditions(a.c.book, b.c.book) || a.alias.length - b.alias.length);
    const results = [];
    for (const { c } of out.slice(0, limit)) {
      results.push({
        bookId: c.book.id, bookTitle: c.book.title, categoryPath: c.book.categoryPath, path: [], targetLine: 1,
        marker: null, unmatched: [], preview: await previewText(db, c.book.id, 1), complete: false, suggestion: true, location: '', direct: false,
      });
    }
    return results;
  }

  candidates = withOtherEditions(index, candidates);
  const unique = [];
  const seen = new Set();
  for (const c of [...candidates].sort((a, b) => Number(exactEdition(b)) - Number(exactEdition(a)) || tosefta.compareEditions(a.book, b.book))) {
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
  results.sort((a, b) => Number(b.complete) - Number(a.complete) || a.unmatched.length - b.unmatched.length || tosefta.compareEditions(a, b));
  return results;
}

module.exports = { rambamBooks, loadBookIndex, resolveReference, resolveInBook, tokenize, parseLocation, lookupBook, rawTokens };
