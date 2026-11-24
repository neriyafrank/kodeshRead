/**
 * Unified canonical library catalog (pure JS, no database access): ONE tree builder behind the
 * main Library screen (src/components/LibraryColumns.tsx) and the Search Scope Picker
 * (src/components/search/ScopeSheet.tsx), replacing the raw Otzaria folder / filesystem order.
 *
 * 1. Base books vs. commentaries. A book is a commentary (`isCommentary(id)`, i.e. "is_commentary
 *    = 1"; derived, the database schema is unchanged) when shared/pairing.js (the same pairing the
 *    importer uses to build `ref_links`) pairs it with a base book - by "X על Y" title and folder:
 *    "תלמוד בבלי/ראשונים/רש"י/סדר זרעים/רש"י על ברכות" -> Bavli ברכות - and it either sits in a
 *    commentary folder (מפרשים / ראשונים / אחרונים / תרגומים / מחברי זמננו) or in the base's own
 *    corpus ("הערות על בראשית" inside תנך/תורה). Corpus-wide commentaries ("… על השס") and
 *    unpaired "X על Y" commentary-folder books are "מפרשים כלליים". A midrash that happens to
 *    comment on Tanach ("מדרש לקח טוב על איכה", "ילקוט שמעוני על התורה") stays a base book.
 *    Commentaries on commentaries ("הערות על רש"י על בראשית") group under the root base book.
 * 2. Base books are placed in the traditional Jewish order, not file-system order: תנ"ך (תורה /
 *    נביאים / כתובים), משנה (six sedarim, + תוספתא), תלמוד בבלי (Shas order), תלמוד ירושלמי,
 *    מדרש, הלכה (משנה תורה in its 14 ספרים, ארבעה טורים, שולחן ערוך in 4 parts), מחשבה ומוסר,
 *    קבלה וחסידות, סדר התפילה, ספרות עזר וספרים נוספים, ספרים אישיים. Empty sections are
 *    dropped, so the sample library shows only what it holds.
 * 3. Every base book's commentaries (from ראשונים, אחרונים, תרגומים ... alike) are one group,
 *    sorted by shared/commentaryRank.js (רש"י, תוספות, רמב"ן, אבן עזרא, ... per corpus).
 *
 * Tree nodes: { id, kind: 'section' | 'book' | 'commentary', name, children?, bookId?, title?,
 * commentaryCount?, count } (count = base books below a section).
 */
'use strict';

const { aliasKey } = require('./hebrew');
const { skeletonPhrase, bookMatchScore } = require('./hebrewTorahDict');
const pairing = require('./pairing');
const commentaryRank = require('./commentaryRank');

const USER_ID_BASE = 1000000000;
const USER_ROOT_KEY = aliasKey('הספרים שלי');

const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator('he') : null;
const compareNames = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

/** Spelling-insensitive key (final letters, gershayim, niqqud, ktiv male/chaser). */
const canon = (s) => skeletonPhrase(aliasKey(s));

// ---------------------------------------------------------------------------
// Canonical lists
// ---------------------------------------------------------------------------

const TORAH = ['בראשית', 'שמות', 'ויקרא', 'במדבר', 'דברים'];
const NEVIIM = ['יהושע', 'שופטים', 'שמואל א', 'שמואל ב', 'מלכים א', 'מלכים ב', 'ישעיהו', 'ירמיהו', 'יחזקאל', 'הושע', 'יואל', 'עמוס', 'עובדיה', 'יונה', 'מיכה', 'נחום', 'חבקוק', 'צפניה', 'חגי', 'זכריה', 'מלאכי'];
const KETUVIM = ['תהילים', 'משלי', 'איוב', 'שיר השירים', 'רות', 'איכה', 'קהלת', 'אסתר', 'דניאל', 'עזרא', 'נחמיה', 'דברי הימים א', 'דברי הימים ב'];
const TANACH_GROUPS = [
  ['תורה', TORAH],
  ['נביאים', NEVIIM],
  ['כתובים', KETUVIM],
];

const SEDARIM = ['זרעים', 'מועד', 'נשים', 'נזיקין', 'קדשים', 'טהרות'];
const MISHNA_TRACTATES = [
  ['ברכות', 'פאה', 'דמאי', 'כלאים', 'שביעית', 'תרומות', 'מעשרות', 'מעשר שני', 'חלה', 'ערלה', 'ביכורים'],
  ['שבת', 'עירובין', 'פסחים', 'שקלים', 'יומא', 'סוכה', 'ביצה', 'ראש השנה', 'תענית', 'מגילה', 'מועד קטן', 'חגיגה'],
  ['יבמות', 'כתובות', 'נדרים', 'נזיר', 'סוטה', 'גיטין', 'קידושין'],
  ['בבא קמא', 'בבא מציעא', 'בבא בתרא', 'סנהדרין', 'מכות', 'שבועות', 'עדיות', 'עבודה זרה', 'אבות', 'הוריות'],
  ['זבחים', 'מנחות', 'חולין', 'בכורות', 'ערכין', 'תמורה', 'כריתות', 'מעילה', 'תמיד', 'מידות', 'קינים'],
  ['כלים', 'אהלות', 'נגעים', 'פרה', 'טהרות', 'מקוואות', 'נדה', 'מכשירין', 'זבים', 'טבול יום', 'ידים', 'עוקצים'],
];
const MISHNA_FLAT = MISHNA_TRACTATES.flat();
/** Shas order of the Babylonian Talmud (נידה closes it). */
const BAVLI_TRACTATES = [
  ['ברכות'],
  ['שבת', 'עירובין', 'פסחים', 'יומא', 'סוכה', 'ביצה', 'ראש השנה', 'תענית', 'מגילה', 'מועד קטן', 'חגיגה'],
  ['יבמות', 'כתובות', 'נדרים', 'נזיר', 'סוטה', 'גיטין', 'קידושין'],
  ['בבא קמא', 'בבא מציעא', 'בבא בתרא', 'סנהדרין', 'מכות', 'שבועות', 'עבודה זרה', 'הוריות'],
  ['זבחים', 'מנחות', 'חולין', 'בכורות', 'ערכין', 'תמורה', 'כריתות', 'מעילה', 'תמיד'],
  ['נדה'],
].flat();
const MINOR_TRACTATES = ['אבות דרבי נתן', 'אבות דרבי נתן נוסח ב', 'סופרים', 'שמחות', 'כלה', 'כלה רבתי', 'דרך ארץ רבה', 'דרך ארץ זוטא', 'גרים', 'כותים', 'עבדים', 'ציצית', 'תפילין', 'ספר תורה', 'מזוזה'];

const RAMBAM = [
  ['מדע', ['יסודי התורה', 'דעות', 'תלמוד תורה', 'עבודה זרה וחוקות הגויים', 'תשובה']],
  ['אהבה', ['קריאת שמע', 'תפילה וברכת כהנים', 'תפילין ומזוזה וספר תורה', 'ציצית', 'ברכות', 'מילה', 'סדר התפילה']],
  ['זמנים', ['שבת', 'עירובין', 'שביתת עשור', 'שביתת יום טוב', 'חמץ ומצה', 'שופר וסוכה ולולב', 'שקלים', 'קידוש החודש', 'תעניות', 'מגילה וחנוכה']],
  ['נשים', ['אישות', 'גירושין', 'יבום וחליצה', 'נערה בתולה', 'סוטה']],
  ['קדושה', ['איסורי ביאה', 'מאכלות אסורות', 'שחיטה']],
  ['הפלאה', ['שבועות', 'נדרים', 'נזירות', 'ערכים וחרמין']],
  ['זרעים', ['כלאים', 'מתנות עניים', 'תרומות', 'מעשרות', 'מעשר שני ונטע רבעי', 'ביכורים ושאר מתנות כהונה שבגבולין', 'שמיטה ויובל']],
  ['עבודה', ['בית הבחירה', 'כלי המקדש והעובדין בו', 'ביאת מקדש', 'איסורי מזבח', 'מעשה הקרבנות', 'תמידין ומוספין', 'פסולי המוקדשין', 'עבודת יום הכפורים', 'מעילה']],
  ['קרבנות', ['קרבן פסח', 'חגיגה', 'בכורות', 'שגגות', 'מחוסרי כפרה', 'תמורה']],
  ['טהרה', ['טומאת מת', 'פרה אדומה', 'טומאת צרעת', 'מטמאי משכב ומושב', 'שאר אבות הטומאות', 'טומאת אוכלים', 'כלים', 'מקואות']],
  ['נזיקין', ['נזקי ממון', 'גניבה', 'גזילה ואבידה', 'חובל ומזיק', 'רוצח ושמירת נפש']],
  ['קנין', ['מכירה', 'זכייה ומתנה', 'שכנים', 'שלוחין ושותפין', 'עבדים']],
  ['משפטים', ['שכירות', 'שאילה ופקדון', 'מלווה ולווה', 'טוען ונטען', 'נחלות']],
  ['שופטים', ['סנהדרין והעונשין המשתתפין להן', 'עדות', 'ממרים', 'אבל', 'מלכים ומלחמות']],
];
const SHULCHAN_ARUCH_PARTS = ['אורח חיים', 'יורה דעה', 'אבן העזר', 'חושן משפט'];
const MIDRASH_RABBAH = ['בראשית רבה', 'שמות רבה', 'ויקרא רבה', 'במדבר רבה', 'דברים רבה', 'שיר השירים רבה', 'רות רבה', 'איכה רבה', 'קהלת רבה', 'קוהלת רבה', 'אסתר רבה'];
const MIDRASH_HALACHA = ['מכילתא דרבי ישמעאל', 'מכילתא דרבי שמעון', 'ספרא', 'ספרי במדבר', 'ספרי דברים', 'ספרי זוטא', 'מדרש תנאים', 'מגילת תענית'];
/** Era folders, earliest first (generic sections). */
const ERA_ORDER = ['גאונים', 'ראשונים', 'אחרונים', 'מחברי זמננו'];

/**
 * Position lookup by name: exact normalized spelling first, then the ktiv-chaser skeleton (which
 * is ambiguous for some names - שביעית / שבועות - so ambiguous skeletons are dropped).
 */
class NameIndex {
  constructor(list) {
    this.exact = new Map();
    this.skel = new Map();
    const ambiguous = new Set();
    list.forEach((n, i) => {
      const e = aliasKey(n);
      if (!this.exact.has(e)) this.exact.set(e, i);
      const k = canon(n);
      if (this.skel.has(k) && this.skel.get(k) !== i) ambiguous.add(k);
      else this.skel.set(k, i);
    });
    for (const k of ambiguous) this.skel.delete(k);
  }

  get(raw) {
    const e = this.exact.get(aliasKey(raw));
    return e != null ? e : this.skel.get(canon(raw));
  }
}
const indexMap = (list) => new NameIndex(list);
const TANACH_INDEX = TANACH_GROUPS.map(([, list]) => indexMap(list));
const MISHNA_INDEX = indexMap(MISHNA_FLAT);
const BAVLI_INDEX = indexMap(BAVLI_TRACTATES);
const MINOR_INDEX = indexMap(MINOR_TRACTATES);
const SEDER_KEYS = SEDARIM.map((s) => canon('סדר ' + s));
const RAMBAM_SEFER = RAMBAM.map(([name]) => canon(name));
const RAMBAM_HALACHA = RAMBAM.map(([, list]) => indexMap(list));
const SA_INDEX = indexMap(SHULCHAN_ARUCH_PARTS);
const RABBAH_INDEX = indexMap(MIDRASH_RABBAH);
const MIDRASH_HALACHA_KEYS = MIDRASH_HALACHA.map(canon);

/** Top-level sections, in order. */
const TOP = {
  tanach: ['תנ"ך', 0],
  mishna: ['משנה', 1],
  bavli: ['תלמוד בבלי', 2],
  yerushalmi: ['תלמוד ירושלמי', 3],
  midrash: ['מדרש', 4],
  halacha: ['הלכה', 5],
  thought: ['מחשבה ומוסר', 6],
  kabbalah: ['קבלה וחסידות', 7],
  prayer: ['סדר התפילה', 8],
  more: ['ספרות עזר וספרים נוספים', 9],
  personal: ['ספרים אישיים', 10],
};
const MORE_SECTION = 'ספרים נוספים';
const GENERAL_COMMENTARIES = 'מפרשים כלליים';

const EARLY = -1;
const LATE = 1000;

const lv = (name, order) => ({ name, order });
const top = (key, ...rest) => [lv(TOP[key][0], TOP[key][1]), ...rest];

// ---------------------------------------------------------------------------
// Placement of one base book
// ---------------------------------------------------------------------------

const cleanDir = (d) => String(d).replace('מחברי זמנינו', 'מחברי זמננו');

/** Folder levels of a generic section, depth-capped (the rest of the path flattens into the book list). */
function genericLevels(dirs, from, maxDepth) {
  const out = [];
  for (const d of dirs.slice(from, from + (maxDepth == null ? 2 : maxDepth))) {
    const clean = cleanDir(d);
    const era = ERA_ORDER.indexOf(clean);
    out.push(lv(clean, era >= 0 ? 10 + era : 50));
  }
  return out;
}

const stripLead = (key, words) => {
  let k = key;
  for (let again = true; again; ) {
    again = false;
    for (const w of words) {
      if (k.startsWith(w + ' ')) {
        k = k.slice(w.length + 1);
        again = true;
      }
    }
  }
  return k;
};
const TRACTATE_LEADS = ['משנה', 'תלמוד ירושלמי', 'ירושלמי', 'תוספתא', 'תלמוד בבלי', 'מסכת'].map(aliasKey);
const tractateKey = (title) => stripLead(aliasKey(title), TRACTATE_LEADS);

/** Index of the longest tractate name that starts `key` ("כלים בתרא" -> כלים). */
function prefixIndex(index, key) {
  let best = -1;
  let len = 0;
  for (const [k, i] of index.exact) if ((key === k || key.startsWith(k + ' ')) && k.length > len) [best, len] = [i, k.length];
  return best;
}

/**
 * Where a base book sits: { levels: [{name, order}], order } - section path below the top
 * section and its sort position among its siblings (books and sub-sections share one scale).
 */
function placeBook(b) {
  const dirs = b.dirs;
  const T = canon;
  const topKey = dirs[0] ? T(dirs[0]) : '';
  const tk = canon(b.title);
  const ak = aliasKey(b.title);
  const more = (from, depth) => top('more', ...genericLevels(dirs, from, depth));
  if (b.personal) return { levels: [lv(TOP.personal[0], TOP.personal[1]), ...genericLevels(dirs, 1, 3)], order: 0 };

  if (topKey === T('תנך') || topKey === T('תנ"ך')) {
    const g = TANACH_GROUPS.findIndex(([name]) => canon(name) === (dirs[1] ? T(dirs[1]) : ''));
    if (g >= 0) {
      const i = TANACH_INDEX[g].get(b.title);
      if (i != null) return { levels: top('tanach', lv(TANACH_GROUPS[g][0], g)), order: i };
    }
    return { levels: top('tanach', lv(MORE_SECTION, LATE), ...genericLevels(dirs, 1, 1)), order: 0 };
  }

  if (topKey === T('משנה')) {
    const s = SEDER_KEYS.indexOf(dirs[1] ? T(dirs[1]) : '');
    const i = MISHNA_INDEX.get(tractateKey(b.title));
    if (s >= 0 && i != null) return { levels: top('mishna', lv('סדר ' + SEDARIM[s], s)), order: i };
    return { levels: top('mishna', lv(MORE_SECTION, LATE), ...genericLevels(dirs, 1, 1)), order: 0 };
  }
  if (topKey === T('תוספתא')) {
    const key = tractateKey(b.title);
    const i = prefixIndex(MISHNA_INDEX, key);
    return { levels: top('mishna', lv('תוספתא', 20), ...genericLevels(dirs, 1, 1)), order: i >= 0 ? i : 500 };
  }

  if (topKey === T('תלמוד בבלי')) {
    const i = BAVLI_INDEX.get(tractateKey(b.title));
    if (i != null && dirs[1] && SEDER_KEYS.includes(T(dirs[1]))) return { levels: top('bavli'), order: i };
    if (dirs[1] && T(dirs[1]) === T('מסכתות קטנות')) {
      const m = MINOR_INDEX.get(tractateKey(b.title));
      return { levels: top('bavli', lv('מסכתות קטנות', 60)), order: m != null ? m : 500 };
    }
    return { levels: top('bavli', lv(MORE_SECTION, LATE), ...genericLevels(dirs, 1, 1)), order: 0 };
  }
  if (topKey === T('תלמוד ירושלמי')) {
    const i = MISHNA_INDEX.get(tractateKey(b.title));
    if (i != null && dirs[1] && SEDER_KEYS.includes(T(dirs[1]))) return { levels: top('yerushalmi'), order: i };
    return { levels: top('yerushalmi', lv(MORE_SECTION, LATE), ...genericLevels(dirs, 1, 1)), order: 0 };
  }

  if (topKey === T('מדרש')) {
    if (dirs.some((d) => T(d) === T('מדרש רבה'))) {
      const i = RABBAH_INDEX.get(b.title);
      return { levels: top('midrash', lv('מדרש רבה', 0)), order: i != null ? i : 500 };
    }
    if (dirs[1] && T(dirs[1]) === T('הלכה')) {
      const i = MIDRASH_HALACHA_KEYS.findIndex((k) => tk === k || tk.startsWith(k + ' '));
      return { levels: top('midrash', lv('מדרשי הלכה', 1)), order: i >= 0 ? i : 500 };
    }
    if (tk.includes(T('תנחומא'))) return { levels: top('midrash', lv('תנחומא', 2)), order: 0 };
    if (tk.startsWith(T('ילקוט'))) return { levels: top('midrash', lv('ילקוט שמעוני', 3)), order: 0 };
    return { levels: top('midrash', lv('מדרשי אגדה', 4), ...genericLevels(dirs, 2, 1)), order: 0 };
  }

  if (topKey === T('הלכה')) {
    const sub = dirs[1] ? T(dirs[1]) : '';
    if (sub === T('משנה תורה')) {
      const halacha = ak.replace(/^משנה תורה (הלכות )?/, '').trim() || ak;
      const s = RAMBAM_SEFER.findIndex((k) => dirs[2] && T(stripLead(aliasKey(dirs[2]), ['ספר'].map(aliasKey))) === k);
      const rl = lv('משנה תורה לרמב"ם', 0);
      if (s >= 0) {
        const i = RAMBAM_HALACHA[s].get(halacha);
        return { levels: top('halacha', rl, lv(dirs[2], s)), order: i != null ? i : 500 };
      }
      if (dirs[2] && T(dirs[2]) === T('הקדמה')) return { levels: top('halacha', rl, lv('הקדמה', EARLY)), order: 0 };
      return { levels: top('halacha', rl, lv(MORE_SECTION, LATE)), order: 0 };
    }
    if (sub === T('טור')) return { levels: top('halacha', lv('ארבעה טורים', 1)), order: 0 };
    if (sub === T('שולחן ערוך')) {
      const part = ak.replace(/^שולחנ ערוכ /, '').trim();
      const i = SA_INDEX.get(part);
      return { levels: top('halacha', lv('שולחן ערוך', 2)), order: i != null ? i : part === canon('הקדמה') ? EARLY : 500 };
    }
    return { levels: top('halacha', lv('ספרי הלכה נוספים', 30), ...genericLevels(dirs, 1, 2)), order: 0 };
  }
  if (topKey === T('שות')) return { levels: top('halacha', lv('שו"ת', 40), ...genericLevels(dirs, 1, 2)), order: 0 };

  if (topKey === T('ספרי מוסר')) return { levels: top('thought', lv('ספרי מוסר', 0), ...genericLevels(dirs, 1, 2)), order: 0 };
  if (topKey === T('מחשבת ישראל')) return { levels: top('thought', lv('מחשבת ישראל', 1), ...genericLevels(dirs, 1, 2)), order: 0 };
  if (topKey === T('קבלה')) {
    const zohar = dirs[1] && T(dirs[1]) === T('זהר');
    return { levels: top('kabbalah', lv('קבלה', 0), ...genericLevels(dirs, 1, 2).map((l) => (zohar ? lv(l.name, EARLY) : l))), order: 0 };
  }
  if (topKey === T('חסידות')) return { levels: top('kabbalah', lv('חסידות', 1), ...genericLevels(dirs, 1, 2)), order: 0 };
  if (topKey === T('סדר התפילה')) return { levels: top('prayer', ...genericLevels(dirs, 1, 2)), order: 0 };
  if (topKey === T('ספרות עזר') || topKey === T('לימוד יומי') || topKey === T('מערכות ועניינים')) return { levels: more(0, 2), order: 0 };
  return { levels: more(0, 2), order: 0 };
}

// ---------------------------------------------------------------------------
// Commentary detection
// ---------------------------------------------------------------------------

const TARGUM_DIR = aliasKey('תרגומים');
const MEFARSHIM_DIR = aliasKey('מפרשים');
const SCRIPTURE_CORPORA = new Set(['tanach', 'mishna', 'bavli', 'yerushalmi']);
const toList = (a) => (Array.isArray(a) ? a : String(a || '').split('|').filter(Boolean));

/** Commentary -> base pairs of one database's books (what the importer's links phase uses). */
function pairBooks(infos) {
  if (!infos.length) return { pairs: [], multi: [] };
  const pairs = pairing.pairCommentaries(infos.map(pairInput));
  return { pairs, multi: pairs.multi || [] };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * @param {{ categories: { id, parent_id, name, path? }[], books: { id, category_id, title, aliases?, source? }[] }} data
 */
function buildLibraryCatalog(data) {
  const split = splitBooks(data);
  return assembleCatalog(split, [pairBooks(split.core), pairBooks(split.personal)]);
}

/** The same catalog, pairing cooperatively: `pause()` is awaited every few hundred books (UI stays live). */
async function buildLibraryCatalogAsync(data, pause) {
  const split = splitBooks(data);
  const pairAsync = async (infos) => {
    if (!infos.length) return { pairs: [], multi: [] };
    const pairs = await pairing.pairCommentariesAsync(infos.map(pairInput), pause);
    return { pairs, multi: pairs.multi || [] };
  };
  const coreResult = await pairAsync(split.core);
  return assembleCatalog(split, [coreResult, await pairAsync(split.personal)]);
}

const pairInput = (i) => ({ id: i.id, title: i.title, aliases: i.aliases, categoryPath: i.categoryPath });

/** Book infos of the input, split into the core library and personal books. */
function splitBooks(data) {
  const cats = new Map((data.categories || []).map((c) => [c.id, c]));
  const pathOf = (c) => {
    if (!c) return '';
    if (c.path) return c.path;
    const names = [];
    for (let x = c, n = 0; x && n < 20; x = x.parent_id != null ? cats.get(x.parent_id) : null, n++) names.unshift(x.name);
    return names.join('/');
  };
  const infos = (data.books || []).map((b) => {
    const categoryPath = pathOf(cats.get(b.category_id));
    const dirs = categoryPath.split('/').filter(Boolean);
    const personal = b.id >= USER_ID_BASE || b.source === 'user' || (dirs[0] && aliasKey(dirs[0]) === USER_ROOT_KEY);
    return { id: b.id, title: b.title, aliases: toList(b.aliases), categoryPath, dirs, personal };
  });
  return { cats, infos, core: infos.filter((i) => !i.personal), personal: infos.filter((i) => i.personal) };
}

function assembleCatalog(split, pairResults) {
  const { infos, core, personal } = split;
  const byId = new Map(infos.map((i) => [i.id, i]));

  // --- commentary detection (per database: the importer pairs within one) ---
  const commToBase = new Map(); // commentary id -> directly commented book id
  const generalIds = new Set();
  for (const [gi, group] of [core, personal].entries()) {
    const { pairs, multi } = pairResults[gi];
    for (const p of pairs) {
      const comm = byId.get(p.commId);
      const base = byId.get(p.baseId);
      if (!comm || !base || comm === base) continue;
      const place = pairing.placeOf(comm.categoryPath);
      const baseTop = pairing.placeOf(base.categoryPath).corpus;
      // A commentary folder, or a note inside the base's own corpus (not a midrash on Tanach).
      if (!place.primary || place.corpus === baseTop) commToBase.set(comm.id, base.id);
    }
    for (const m of multi) {
      const comm = byId.get(m.commId);
      if (!comm) continue;
      const place = pairing.placeOf(comm.categoryPath);
      if (!place.primary || place.corpus === (m.scope && m.scope.corpus)) generalIds.add(comm.id);
    }
    // Unpaired books of a commentary folder: "X על Y" anywhere in one, and any work in the
    // ראשונים / אחרונים / תרגומים / מחברי זמננו / מפרשים folders of תנ"ך, משנה, בבלי, ירושלמי
    // ("חזקוני", "רבנו בחיי", "תרגום איוב" name no base book but are still commentaries).
    for (const i of group) {
      if (commToBase.has(i.id) || generalIds.has(i.id)) continue;
      const place = pairing.placeOf(i.categoryPath);
      const inFolder = !place.primary || place.dirs.includes(TARGUM_DIR);
      if (!inFolder) continue;
      if (pairing.isCommentaryTitle(i.title) || SCRIPTURE_CORPORA.has(place.corpus) || place.dirs.includes(MEFARSHIM_DIR)) generalIds.add(i.id);
    }
  }
  const isCommentarySet = new Set([...commToBase.keys(), ...generalIds]);

  /** Root base book of a commentary (chains resolve upward), or null when it is general. */
  const rootCache = new Map();
  function rootBase(id) {
    if (rootCache.has(id)) return rootCache.get(id);
    let cur = id;
    for (let n = 0; n < 6 && commToBase.has(cur); n++) cur = commToBase.get(cur);
    const root = isCommentarySet.has(cur) ? null : cur;
    rootCache.set(id, root);
    return root;
  }

  const commsOfBase = new Map(); // base id -> commentary infos (unsorted)
  const general = [];
  for (const id of isCommentarySet) {
    const info = byId.get(id);
    const root = commToBase.has(id) ? rootBase(id) : null;
    if (root == null) general.push(info);
    else {
      if (!commsOfBase.has(root)) commsOfBase.set(root, []);
      commsOfBase.get(root).push(info);
    }
  }

  const rankedCache = new Map();
  const toItem = (i) => ({ bookId: i.id, bookTitle: i.title, categoryPath: i.categoryPath });
  function commentariesOf(baseId, opts) {
    const pinned = opts && opts.pinned;
    if (!pinned && rankedCache.has(baseId)) return rankedCache.get(baseId);
    const list = commsOfBase.get(baseId) || [];
    const base = byId.get(baseId);
    const ranked = commentaryRank
      .rankCommentaries(list.map(toItem), { pinned, context: base ? { title: base.title, categoryPath: base.categoryPath } : undefined })
      .map((r) => ({
        bookId: r.bookId,
        title: r.bookTitle,
        name: r.displayName,
        key: r.key,
        tier: r.tier,
        core: r.core,
        era: r.era,
        rank: r.rank,
        categoryPath: r.categoryPath,
      }));
    if (!pinned) rankedCache.set(baseId, ranked);
    return ranked;
  }

  // --- base tree ---
  const bases = infos.filter((i) => !isCommentarySet.has(i.id));
  function makeTree(include) {
    const root = { children: new Map() };
    const add = (placed, leaf) => {
      let node = root;
      let key = '';
      for (const l of placed.levels) {
        key += '/' + l.name;
        let next = node.children.get(l.name);
        if (!next) {
          next = { id: 'sec:' + key, kind: 'section', name: l.name, order: l.order, children: new Map() };
          node.children.set(l.name, next);
        }
        node = next;
      }
      node.children.set('#' + leaf.id, leaf);
    };
    for (const b of bases) {
      const cc = (commsOfBase.get(b.id) || []).length;
      if (!include(b, cc)) continue;
      const p = placeBook(b);
      add(p, { id: 'book:' + b.id, kind: 'book', name: b.title, title: b.title, bookId: b.id, order: p.order, commentaryCount: cc, count: 1, categoryPath: b.categoryPath });
    }
    return finalize([...root.children.values()]);
  }
  /** Maps -> sorted arrays, counts, empty sections dropped. */
  function finalize(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.kind === 'section') {
        n.children = finalize([...n.children.values()]);
        n.count = n.children.reduce((s, c) => s + c.count, 0);
        if (!n.count) continue;
      }
      out.push(n);
    }
    out.sort((a, b) => a.order - b.order || compareNames(a.name, b.name));
    return out;
  }

  const sections = makeTree(() => true);
  const commentarySections = makeTree((b, cc) => cc > 0);
  if (general.length) {
    const kids = general
      .slice()
      .sort((a, b) => compareNames(a.title, b.title))
      .map((g) => ({ id: 'comm:' + g.id, kind: 'commentary', name: g.title, title: g.title, bookId: g.id, order: 0, count: 1, categoryPath: g.categoryPath }));
    commentarySections.push({ id: 'sec:' + GENERAL_COMMENTARIES, kind: 'section', name: GENERAL_COMMENTARIES, order: 10000, children: kids, count: kids.length });
  }

  const nodeBooks = (node, out) => {
    if (node.kind === 'section') for (const c of node.children) nodeBooks(c, out);
    else out.push(node.bookId);
    return out;
  };

  return {
    sections,
    commentarySections,
    generalCommentaries: general.map((g) => ({ bookId: g.id, title: g.title })),
    bookCount: infos.length,
    /** Every book as { id, title, categoryPath, personal } (input of shared/corpora.js). */
    bookInfos: infos.map((i) => ({ id: i.id, title: i.title, categoryPath: i.categoryPath, personal: i.personal })),
    isCommentary: (id) => isCommentarySet.has(id),
    isBase: (id) => byId.has(id) && !isCommentarySet.has(id),
    /** Root base book a commentary belongs to (null: general or not a commentary). */
    baseOf: (id) => (commToBase.has(id) ? rootBase(id) : null),
    commentaryCount: (baseId) => (commsOfBase.get(baseId) || []).length,
    commentariesOf,
    commentaryIds: (baseId) => (commsOfBase.get(baseId) || []).map((i) => i.id),
    bookTitle: (id) => (byId.has(id) ? byId.get(id).title : ''),
    bookPath: (id) => (byId.has(id) ? byId.get(id).categoryPath : ''),
    /** Book ids of a section / book node (commentaries excluded from base sections). */
    bookIdsOf: (node) => nodeBooks(node, []),
  };
}

// ---------------------------------------------------------------------------
// Live filter
// ---------------------------------------------------------------------------

const norm = (s) => aliasKey(s);

/** Does a book title match the typed filter (substring, or abbreviation-aware: שו"ע או"ח, ב"ק)? */
function titleMatches(query, title, categoryPath) {
  const q = norm(query);
  if (!q) return true;
  if (norm(title).includes(q)) return true;
  return bookMatchScore(query, title, categoryPath) > 0;
}

/**
 * Prunes a tree to the nodes matching `query`: a section whose name matches keeps its whole
 * subtree; otherwise only matching books (and the sections leading to them) remain.
 * `extra(node)` may add a match (e.g. a commentator name).
 */
function filterTree(nodes, query, extra) {
  if (!norm(query)) return nodes;
  const walk = (list, ancestorMatch) => {
    const out = [];
    for (const n of list) {
      if (n.kind === 'section') {
        const selfMatch = ancestorMatch || norm(n.name).includes(norm(query));
        const kids = walk(n.children, selfMatch);
        if (kids.length) out.push({ ...n, children: kids, count: kids.reduce((s, c) => s + c.count, 0) });
      } else if (ancestorMatch || titleMatches(query, n.title, n.categoryPath) || (extra && extra(n))) out.push(n);
    }
    return out;
  };
  return walk(nodes, false);
}

/** All base-book ids below tree nodes. */
function treeBookIds(nodes) {
  const out = [];
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === 'section') walk(n.children);
      else out.push(n.bookId);
    }
  };
  walk(nodes);
  return out;
}

module.exports = {
  buildLibraryCatalog,
  buildLibraryCatalogAsync,
  filterTree,
  titleMatches,
  treeBookIds,
  canon,
  GENERAL_COMMENTARIES,
  TOP_SECTIONS: Object.values(TOP).sort((a, b) => a[1] - b[1]).map((x) => x[0]),
  CANON: { TORAH, NEVIIM, KETUVIM, SEDARIM, MISHNA_TRACTATES, BAVLI_TRACTATES, RAMBAM, SHULCHAN_ARUCH_PARTS },
};
