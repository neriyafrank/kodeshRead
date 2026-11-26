/**
 * Context-aware grouping of search results (pure JS, shared by the results jump / filter bar of Simple and
 * Advanced Search and scripts/selftest.js). The grouping granularity follows the search scope:
 *
 *   whole library                  -> broad top-level categories (תנ"ך, משנה, ש"ס בבלי, הלכה, מדרש, מחשבה, ...)
 *   משנה תורה preset               -> the individual Hilchot books (הלכות שבת, הלכות תפילה וברכת כהנים, ...)
 *   several presets (תנ"ך + בבלי)   -> the presets
 *   one preset / picked books      -> the books (short titles: "אורח חיים", not "שולחן ערוך, אורח חיים")
 *   a folder (category scope)      -> the next folder below it (or the book, for books directly in it)
 *   one book                       -> its top-level divisions (the first toc_path level: פרק / סימן / דף)
 *
 * createGroupTracker() is incremental: rows stream in (shared/searchStream.js) and are added batch by batch;
 * groups keep their first-seen order (results arrive in library order, so a new group is always appended:
 * the bar never reorders under the user's finger) and their counts grow in place.
 */
'use strict';

const { aliasKey } = require('./hebrew');
const corpora = require('./corpora');

const USER_ID_BASE = 1000000000;

const key = (s) => aliasKey(s || '').toLowerCase();

/** Corpus root folder (wrapper folders skipped) -> pill label. Unknown roots show their folder name. */
const BROAD_LABELS = new Map(
  [
    ['תנך', 'תנ"ך'],
    ['מקרא', 'תנ"ך'],
    ['משנה', 'משנה'],
    ['תוספתא', 'תוספתא'],
    ['תלמוד בבלי', 'ש"ס בבלי'],
    ['בבלי', 'ש"ס בבלי'],
    ['תלמוד ירושלמי', 'ירושלמי'],
    ['ירושלמי', 'ירושלמי'],
    ['מדרש', 'מדרש'],
    ['הלכה', 'הלכה'],
    ['שות', 'שו"ת'],
    ['קבלה', 'קבלה'],
    ['חסידות', 'חסידות'],
    ['מחשבת ישראל', 'מחשבה'],
    ['מחשבה', 'מחשבה'],
    ['ספרי מוסר', 'מוסר'],
    ['מוסר', 'מוסר'],
    ['סדר התפילה', 'תפילה'],
    ['ספרות עזר', 'ספרות עזר'],
    ['לימוד יומי', 'לימוד יומי'],
  ].map(([k, v]) => [key(k), v]),
);

/** Leading "<work>, " of a book title that every book of that work repeats (stripped from book pills). */
const TITLE_HEADS = ['משנה תורה', 'רמב"ם', 'שולחן ערוך', 'שו"ע', 'טור', 'ארבעה טורים', 'תלמוד ירושלמי', 'ירושלמי', 'תלמוד בבלי', 'משנה ברורה', 'ערוך השולחן'];

/** "משנה תורה, הלכות שבת" -> "הלכות שבת"; "שולחן ערוך, אורח חיים" -> "אורח חיים"; others unchanged. */
function shortTitle(title) {
  const t = String(title || '').trim();
  const comma = t.indexOf(',');
  if (comma > 0) {
    const head = key(t.slice(0, comma));
    if (TITLE_HEADS.some((h) => key(h) === head)) return t.slice(comma + 1).trim() || t;
  }
  // "רמב"ם הלכות שבת" / "משנה תורה הלכות שבת" (no comma)
  for (const h of ['משנה תורה', 'רמב"ם', 'רמבם']) if (t.startsWith(h + ' הלכות ')) return t.slice(h.length + 1);
  return t;
}

/** Broad category of a book (its corpus root folder). */
function broadCategory(categoryPath, bookId) {
  if (bookId >= USER_ID_BASE) return { key: 'c:user', label: 'ספרים אישיים' };
  const f = corpora.folderFacts(categoryPath);
  if (!f.root) return { key: 'c:', label: 'אחר' };
  const dirs = String(categoryPath || '').split('/').filter(Boolean);
  // The display name of the root: the original folder spelling at the root's position.
  const raw = dirs[f.dirs.length - f.rest.length - 1] || f.root;
  return { key: `c:${f.root}`, label: BROAD_LABELS.get(f.root) || raw };
}

/**
 * Grouping mode of a scope: 'category' | 'corpus' | 'hilchot' | 'book' | 'folder' | 'section'.
 * @param {{ kind: string, corpora?: string[] } | null | undefined} scope
 */
function groupModeFor(scope) {
  if (!scope || scope.kind === 'all') return 'category';
  if (scope.kind === 'book') return 'section';
  if (scope.kind === 'category') return 'folder';
  if (scope.kind === 'books') {
    const presets = scope.corpora || [];
    if (presets.length > 1) return 'corpus';
    if (presets.length === 1 && presets[0] === 'rambam') return 'hilchot';
    return 'book';
  }
  return 'category';
}

/** First toc_path level ("פרק א > פסוק ב" -> "פרק א"). */
function topSection(tocPath) {
  const first = String(tocPath || '').split(/\s*>\s*/).filter(Boolean)[0];
  return first || '';
}

/**
 * Group of one result row.
 * @param {{ book_id: number, book_title?: string, toc_path?: string | null }} row
 * @param {string} mode  groupModeFor()
 * @param {{ bookInfo?: (id: number) => ({ title?: string, categoryPath?: string } | undefined), scope?: object, isCommentary?: (id: number) => boolean }} [ctx]
 * @returns {{ key: string, label: string }}
 */
function groupOf(row, mode, ctx) {
  const info = (ctx && ctx.bookInfo && ctx.bookInfo(row.book_id)) || {};
  const title = info.title || row.book_title || '';
  const path = info.categoryPath || '';
  switch (mode) {
    case 'section': {
      const sec = topSection(row.toc_path);
      return sec ? { key: `s:${sec}`, label: sec } : { key: 's:', label: 'פתיחה' };
    }
    case 'hilchot':
    case 'book':
      return { key: `b:${row.book_id}`, label: shortTitle(title) };
    case 'folder': {
      const base = String((ctx && ctx.scope && ctx.scope.path) || '').replace(/\/+$/, '');
      const rest = base && (path === base || path.startsWith(base + '/')) ? path.slice(base.length).split('/').filter(Boolean) : [];
      return rest.length ? { key: `f:${rest[0]}`, label: rest[0] } : { key: `b:${row.book_id}`, label: shortTitle(title) };
    }
    case 'corpus': {
      const wanted = (ctx && ctx.scope && ctx.scope.corpora) || [];
      const ids = corpora.inCorpus ? wanted.filter((id) => corpora.inCorpus({ id: row.book_id, title, categoryPath: path }, id, { isCommentary: ctx && ctx.isCommentary })) : [];
      const id = ids[0];
      const def = id && corpora.CORPORA.find((c) => c.id === id);
      return def ? { key: `p:${def.id}`, label: def.label } : broadCategory(path, row.book_id);
    }
    default:
      return broadCategory(path, row.book_id);
  }
}

/**
 * Incremental group counts for streamed results.
 * @param {string} mode
 * @param {object} [ctx]  groupOf() context
 */
function createGroupTracker(mode, ctx) {
  const byKey = new Map(); // key -> { key, label, count, first }
  const order = [];
  const bookKey = new Map(); // book id -> group (book-level modes only)
  const perBook = mode !== 'section'; // every mode but 'section' groups a whole book together
  let seen = 0;
  const keyOf = (row) => {
    if (perBook && bookKey.has(row.book_id)) return bookKey.get(row.book_id);
    const g = groupOf(row, mode, ctx);
    if (perBook) bookKey.set(row.book_id, g);
    return g;
  };
  return {
    mode,
    /** Adds a batch of rows (in result order). */
    add(rows) {
      for (const r of rows || []) {
        const g = keyOf(r);
        let e = byKey.get(g.key);
        if (!e) {
          e = { key: g.key, label: g.label, count: 0, first: seen };
          byKey.set(g.key, e);
          order.push(e);
        }
        e.count += 1;
        seen += 1;
      }
      return this;
    },
    /** Snapshot: [{ key, label, count, first }] in first-seen order (`first` = index of its first row). */
    groups: () => order.map((e) => ({ ...e })),
    /** Rows added so far. */
    size: () => seen,
    keyOf: (row) => keyOf(row).key,
  };
}

/** Groups of a whole result list (one-shot createGroupTracker). */
function summarizeGroups(rows, mode, ctx) {
  return createGroupTracker(mode, ctx).add(rows).groups();
}

/** Rows of one group (`groupKey` null / 'all' = every row). */
function filterByGroup(rows, groupKey, tracker) {
  if (!groupKey || groupKey === 'all') return rows;
  return rows.filter((r) => tracker.keyOf(r) === groupKey);
}

module.exports = { BROAD_LABELS, shortTitle, broadCategory, groupModeFor, topSection, groupOf, createGroupTracker, summarizeGroups, filterByGroup };
