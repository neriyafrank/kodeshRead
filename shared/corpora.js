/**
 * Preset corpora of Simple Search and Advanced Search ("תנ"ך", "משנה", "בבלי", "משנה תורה", ...):
 * the ONE place that decides which books a preset selects (pure JS, no database access).
 *
 * Otzaria's folder hierarchy is messy (wrapper folders like "אוצריא/", "תנ"ך/חומש/בראשית",
 * commentary books stored next to base books, "הערות על בראשית" inside תנך/תורה, ...), so a preset
 * never matches an exact folder path. A book belongs to a base-book preset only when ALL of:
 *   1. its corpus root is recognised: the first folder after any wrapper folders (תנך, משנה,
 *      תלמוד בבלי, תלמוד ירושלמי, הלכה / משנה תורה, הלכה / שולחן ערוך);
 *   2. its title is a canonical base book of THAT corpus (shared/libraryCatalog.js CANON lists: the 24
 *      books of תנ"ך, the 63 mishnaic tractates, the Bavli / Yerushalmi tractates, the 14 sefarim of
 *      Rambam's halachot, the 4 parts of Shulchan Aruch), so "משנה שבת" can never be a Bavli book;
 *   3. strict commentary / derivative exclusion: no folder below the root is a commentary folder
 *      (מפרשים, ראשונים, אחרונים, נושאי כלים, תרגומים, תרגום, מפרשי ..., מחברי זמננו ...), the title is not
 *      "X על Y" / פירוש / תרגום / הגהות / השגות ... or a known commentator (רש"י, תוספות, כסף משנה,
 *      משנה ברורה, ש"ך, ט"ז ...), and the library catalog does not flag it as a commentary.
 * The "מפרשים" preset is the opposite: commentary folders and every book the catalog flags.
 */
'use strict';

const { aliasKey } = require('./hebrew');
const { CANON, canon } = require('./libraryCatalog');

const USER_ID_BASE = 1000000000;

const key = (s) => aliasKey(s).toLowerCase();
const keySet = (list) => new Set(list.map(key));

/** Name lookup: exact normalized spelling, then the ktiv-chaser skeleton (ambiguous skeletons dropped). */
function nameIndex(list, extra) {
  const exact = new Set();
  const skel = new Map();
  const ambiguous = new Set();
  for (const n of list.concat(extra || [])) {
    exact.add(key(n));
    const k = canon(n);
    if (skel.has(k) && skel.get(k) !== key(n)) ambiguous.add(k);
    else skel.set(k, key(n));
  }
  for (const k of ambiguous) skel.delete(k);
  return { has: (name) => exact.has(key(name)) || skel.has(canon(name)) };
}

/** Removes the leading words (normalized) that may precede a canonical name, repeatedly. */
function stripLeads(title, leads) {
  let k = key(title);
  for (let again = true; again; ) {
    again = false;
    for (const w of leads) {
      if (k.startsWith(w + ' ')) {
        k = k.slice(w.length + 1);
        again = true;
      }
    }
  }
  return k;
}

// ---------------------------------------------------------------------------
// Canonical name lists (shared/libraryCatalog.js CANON)
// ---------------------------------------------------------------------------

const TANACH_BOOKS = nameIndex([...CANON.TORAH, ...CANON.NEVIIM, ...CANON.KETUVIM], ['קוהלת', 'תהלים', 'שיר השירים', 'דברי הימים א', 'דברי הימים ב']);
const MISHNA_BOOKS = nameIndex(CANON.MISHNA_TRACTATES.flat());
const BAVLI_BOOKS = nameIndex(CANON.BAVLI_TRACTATES);
const YERUSHALMI_BOOKS = nameIndex(CANON.MISHNA_TRACTATES.flat(), ['בכורים']);
const RAMBAM_HALACHOT = nameIndex(
  CANON.RAMBAM.flatMap(([, list]) => list),
  ['מסירת תורה שבעל פה', 'מצוות עשה', 'מצוות לא תעשה', 'תוכן החיבור'],
);
const SA_PARTS = nameIndex(CANON.SHULCHAN_ARUCH_PARTS);

const LEADS = {
  tanach: ['תנך', 'ספר'].map(key),
  mishna: ['משנה', 'מסכת'].map(key),
  // "משנה" is deliberately NOT a Bavli / Yerushalmi lead: "משנה שבת" is never a Talmud tractate.
  bavli: ['תלמוד בבלי', 'בבלי', 'גמרא', 'מסכת'].map(key),
  yerushalmi: ['תלמוד ירושלמי', 'ירושלמי', 'מסכת'].map(key),
  rambam: ['משנה תורה', 'רמבם', 'הלכות'].map(key),
  sa: ['שולחן ערוך', 'שוע'].map(key),
};

// ---------------------------------------------------------------------------
// Commentary / derivative detection
// ---------------------------------------------------------------------------

/** Folders that hold commentaries, translations or other works derived from the base text. */
const COMMENTARY_DIRS = keySet(['מפרשים', 'מפרשי', 'ראשונים', 'אחרונים', 'גאונים', 'נושאי כלים', 'תרגומים', 'תרגום', 'מחברי זמננו', 'מחברי זמנינו', 'פרשנים', 'פרשנות', 'ביאורים', 'חידושים', 'הערות', 'הגהות', 'השגות']);
const COMMENTARY_DIR_PREFIXES = ['מפרשי', 'מפרשים', 'פירוש', 'תרגומ', 'נושאי כלי', 'ביאור', 'חידושי', 'הגהות', 'השגות', 'הערות', 'שיטה מקובצת'].map(key);
/** Folders of editions / aids / sermons that are not the base text itself. */
const NON_BASE_DIRS = keySet(['גמרא נוחה', 'ספרות עזר', 'מסכתות קטנות', 'דרשות ודרושים', 'תוספתא', 'ילקוט שמעוני', 'שולחן ערוך הרב']);
/** Folders above the corpus root that only wrap the library ("אוצריא/", "ספרים/", ...). */
const WRAPPER_DIRS = keySet(['אוצריא', 'otzaria', 'otzaria-library', 'otzaria library', 'library', 'books', 'ספרים', 'ספריית אוצריא', 'raw_library', 'full', 'sample']);

const isCommentaryDir = (k) => COMMENTARY_DIRS.has(k) || COMMENTARY_DIR_PREFIXES.some((p) => k === p || k.startsWith(p + ' '));

const COMMENTARY_TITLE_LEADS = ['פירוש', 'תרגום', 'ביאור', 'באור', 'הערות', 'חידושי', 'השגות', 'הגהות', 'מפרשי', 'שיטה מקובצת', 'נושאי כלים', 'מראי מקומות', 'מראה מקומות'].map(key);
/** Well-known commentators / works matched as the WHOLE title ("ראש" must never hit "ראש השנה"). */
const COMMENTATOR_TITLES = keySet([
  'רש"י', 'תוספות', 'תוס\'', 'רמב"ן', 'רשב"א', 'ריטב"א', 'ר"ן', 'מאירי', 'רי"ף', 'רא"ש', 'רמב"ם על המשנה', 'מהרש"א', 'מהר"ם', 'מהרש"ל', 'מהרי"ט', 'רבנו גרשום', 'רבינו חננאל', 'שיטה מקובצת', 'פני משה', 'קרבן העדה', 'ר"ש', 'רע"ב', 'ברטנורא', 'תוספות יום טוב', 'תוספות רי"ד', 'תפארת ישראל', 'עיקר תוספות יום טוב', 'אונקלוס', 'תרגום אונקלוס', 'תרגום יונתן', 'תרגום ירושלמי', 'יונתן', 'אבן עזרא', 'אבן עזרא', 'רד"ק', 'רלב"ג', 'אברבנאל', 'ספורנו', 'מלבי"ם', 'מצודות', 'מצודות דוד', 'מצודת ציון', 'מצודות ציון', 'אור החיים הקדוש', 'כלי יקר', 'חזקוני', 'רבנו בחיי', 'בעל הטורים', 'כסף משנה', 'מגיד משנה', 'לחם משנה', 'משנה למלך', 'מעשה רקח', 'ראב"ד', 'השגות הראב"ד', 'השגות', 'הגהות מיימוניות', 'מגדל עוז', 'כסף משנה', 'משנה ברורה', 'ביאור הלכה', 'שער הציון', 'באר היטב', 'באר הגולה', 'מגן אברהם', 'ש"ך', 'ט"ז', 'סמ"ע', 'פרי מגדים', 'פתחי תשובה', 'ערוך השולחן', 'בית יוסף', 'דרכי משה', 'בית חדש', 'ב"ח', 'גר"א', 'ביאור הגר"א', 'הגהות הרמ"א', 'רמ"א', 'מפה', 'חיי אדם', 'קיצור שולחן ערוך', 'שולחן ערוך הרב', 'קצות החושן', 'נתיבות המשפט', 'אורים ותומים', 'לבוש', 'עטרת זקנים', 'דגול מרבבה', 'רעק"א',
]);

/** True for a title that is a commentary / translation / derivative work ("X על Y", פירוש ..., a known commentator). */
function isCommentaryTitle(title) {
  const k = key(title);
  if (!k) return false;
  if (k.includes(' על ') || k.startsWith('על ')) return true;
  if (COMMENTARY_TITLE_LEADS.some((w) => k === w || k.startsWith(w + ' '))) return true;
  return COMMENTATOR_TITLES.has(k);
}

// ---------------------------------------------------------------------------
// Corpus definitions
// ---------------------------------------------------------------------------

/**
 * Presets in display order. `base: true` = base books only; `mefarshim` is the commentary preset.
 * (`rambam` keeps its historical id; its label is "משנה תורה".)
 */
const CORPORA = [
  { id: 'tanach', label: 'תנ"ך', base: true },
  { id: 'mishna', label: 'משנה', base: true },
  { id: 'bavli', label: 'בבלי', base: true },
  { id: 'yerushalmi', label: 'ירושלמי', base: true },
  { id: 'rambam', label: 'משנה תורה', base: true },
  { id: 'shulchan-aruch', label: 'שולחן ערוך', base: true },
  { id: 'mefarshim', label: 'מפרשים', base: false },
];

/** Folder facts of one book: wrapper folders skipped, `root` = corpus root folder, `rest` = the folders below it. */
function folderFacts(categoryPath) {
  const dirs = String(categoryPath || '').split('/').filter(Boolean).map(key);
  let i = 0;
  while (i < dirs.length - 1 && WRAPPER_DIRS.has(dirs[i])) i++;
  return { dirs, root: dirs[i] || '', rest: dirs.slice(i + 1) };
}

const T = key;
const ROOTS = {
  tanach: new Set([T('תנך'), T('מקרא')]),
  mishna: new Set([T('משנה')]),
  bavli: new Set([T('תלמוד בבלי'), T('בבלי')]),
  yerushalmi: new Set([T('תלמוד ירושלמי'), T('ירושלמי')]),
  halacha: new Set([T('הלכה')]),
  rambam: new Set([T('משנה תורה'), T('רמבם')]),
  sa: new Set([T('שולחן ערוך')]),
};

/** Per-preset recognition of a canonical base book (the strict commentary exclusion runs first). */
const BASE_MATCHERS = {
  tanach: (b, f) => ROOTS.tanach.has(f.root) && TANACH_BOOKS.has(stripLeads(b.title, LEADS.tanach)),
  mishna: (b, f) => ROOTS.mishna.has(f.root) && MISHNA_BOOKS.has(stripLeads(b.title, LEADS.mishna)),
  bavli: (b, f) => ROOTS.bavli.has(f.root) && BAVLI_BOOKS.has(stripLeads(b.title, LEADS.bavli)),
  // Same canonical tractate names as the Mishnah, but only under the Yerushalmi root.
  yerushalmi: (b, f) => ROOTS.yerushalmi.has(f.root) && YERUSHALMI_BOOKS.has(stripLeads(b.title, LEADS.yerushalmi)),
  rambam: (b, f) => {
    const inRambam = ROOTS.rambam.has(f.root) || (ROOTS.halacha.has(f.root) && f.rest.some((d) => ROOTS.rambam.has(d)));
    return inRambam && RAMBAM_HALACHOT.has(stripLeads(b.title, LEADS.rambam));
  },
  'shulchan-aruch': (b, f) => {
    const inSa = ROOTS.sa.has(f.root) || (ROOTS.halacha.has(f.root) && f.rest.some((d) => ROOTS.sa.has(d)));
    return inSa && SA_PARTS.has(stripLeads(b.title, LEADS.sa));
  },
};

/** Is the book a commentary / translation / derivative work by its folders, its title or the catalog's flag? */
function isDerivative(b, f, isCommentary) {
  if (isCommentary && isCommentary(b.id)) return true;
  if (f.rest.some((d) => isCommentaryDir(d) || NON_BASE_DIRS.has(d))) return true;
  return isCommentaryTitle(b.title);
}

const factsCache = new WeakMap();
const factsOf = (book) => {
  let f = factsCache.get(book);
  if (!f) factsCache.set(book, (f = folderFacts(book.categoryPath)));
  return f;
};

/** Preset ids of one book (`book` = { id, title, categoryPath }): facts and the commentary check run once. */
function corporaOf(book, opts) {
  if (book.id >= USER_ID_BASE || book.personal) return [];
  const f = factsOf(book);
  const isCommentary = opts && opts.isCommentary;
  const out = [];
  if ((isCommentary && isCommentary(book.id)) || f.rest.some(isCommentaryDir)) out.push('mefarshim');
  // Strict commentary exclusion first: a canonical-looking title inside a commentary folder is still a commentary.
  else if (!isDerivative(book, f, isCommentary)) for (const id of Object.keys(BASE_MATCHERS)) if (BASE_MATCHERS[id](book, f)) out.push(id);
  return out.filter((id) => CORPORA.some((c) => c.id === id));
}

/** Does one book belong to preset `id`? */
const inCorpus = (book, id, opts) => corporaOf(book, opts).includes(id);

/** Book ids of one or several presets (OR-ed), in input order, without duplicates. */
function resolveCorpusBooks(books, ids, opts) {
  const wanted = new Set((ids || []).filter((id) => CORPORA.some((c) => c.id === id)));
  const out = [];
  for (const b of books || []) if (corporaOf(b, opts).some((id) => wanted.has(id))) out.push(b.id);
  return out;
}

/** Matched book count per preset id (what the preset chips show). */
function corpusCounts(books, opts) {
  const counts = {};
  for (const c of CORPORA) counts[c.id] = 0;
  for (const b of books || []) for (const id of corporaOf(b, opts)) counts[id]++;
  return counts;
}

const countText = (n) => (n === 1 ? 'ספר אחד' : `${n} ספרים`);

/** "בבלי (37 ספרים)" / "תנ"ך · משנה (86 ספרים)". */
function corpusName(ids, bookCount) {
  const labels = CORPORA.filter((c) => (ids || []).includes(c.id)).map((c) => c.label);
  return `${labels.join(' · ')} (${countText(bookCount)})`;
}

/**
 * The search scope of a preset selection: a `books` scope (ONE `book_id IN (...)` condition, FTS5 and the
 * no-FTS5 fallback alike) that remembers its presets in `corpora`. No preset = the whole library; presets
 * that resolve to no books give an (honestly) empty scope, never a silent "all".
 */
function corpusScope(books, ids, opts) {
  const chosen = CORPORA.filter((c) => (ids || []).includes(c.id)).map((c) => c.id);
  if (!chosen.length) return { kind: 'all' };
  const bookIds = resolveCorpusBooks(books, chosen, opts);
  return { kind: 'books', ids: bookIds, name: corpusName(chosen, bookIds.length), corpora: chosen };
}

module.exports = { CORPORA, inCorpus, isCommentaryTitle, isCommentaryDir, folderFacts, resolveCorpusBooks, corpusCounts, corpusName, corpusScope, countText };
