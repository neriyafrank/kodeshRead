/**
 * Corpus-aware commentary priority ranking for the commentary drawer (shared by the app and
 * scripts/selftest.js; pure, no database access).
 *
 * A passage can have 40-100+ linked commentaries. They are ordered so the well-known ones are
 * always on top, never buried alphabetically among obscure works:
 *   1. user-pinned favorites (⭐), in pin order — they override everything;
 *   2. the base text itself (when reading a commentary, its source is the main link: "מקור");
 *   3. the canonical core list of the corpus being read (תנ"ך, משנה, בבלי, ירושלמי, משנה תורה,
 *      שולחן ערוך, טור), in the list's order;
 *   4. era tier from Otzaria's real folder layout: תרגומים -> ראשונים -> אחרונים -> מחברי זמננו
 *      -> the rest ("תנך/ראשונים/רמבן/תורה/רמבן על בראשית", "תלמוד בבלי/אחרונים/...");
 *   5. alphabetical (Hebrew), then book id.
 *
 * Names are matched spelling- and punctuation-insensitively: Otzaria file titles carry no
 * gershayim ("רשי על בראשית", "מלבים", "ריטבא", "בח"), commentaries on commentaries ("הערות על
 * רשי על …") are not their parent, and series titles without "על" ("יכין ברכות", "באר היטב
 * אורח חיים") match by their leading name.
 *
 * Every ranked item also gets a display group (`tier`): עיקריים / תרגומים / ראשונים / אחרונים /
 * נוספים (+ מקור for a base text), and the drawer's name filter understands Torah abbreviations
 * through shared/hebrewTorahDict.js ("מ"ב", "אב"ע", "תוס", "רש").
 */
'use strict';

const { acronyms } = require('./hebrew');
const { normKey, skeletonPhrase, expandAbbreviation } = require('./hebrewTorahDict');

// ---------------------------------------------------------------------------
// Canonical core lists (first form = display name; "|" separates aliases)
// ---------------------------------------------------------------------------

const CORE_LISTS = {
  tanach: [
    'אונקלוס|תרגום אונקלוס|אונקלוס הגר',
    'תרגום יונתן|יונתן בן עוזיאל|תרגום יונתן בן עוזיאל|תרגום יהונתן|תי"ב',
    'רש"י',
    'רמב"ן',
    'אבן עזרא|אב"ע|ראב"ע',
    'ספורנו',
    'אור החיים|אור החיים הקדוש|אוה"ח',
    'כלי יקר',
    'בעל הטורים',
    'רשב"ם',
    'רד"ק',
    'מצודת דוד',
    'מצודת ציון',
    'מלבי"ם',
    'שפתי חכמים',
    'רלב"ג',
    'אברבנאל|אברבנל|אבארבנאל',
    'חזקוני',
    'אלשיך|תורת משה',
    'העמק דבר|נצי"ב',
  ],
  mishna: [
    'ברטנורא|ברטנורה|רע"ב|ר"ע מברטנורא|רבי עובדיה מברטנורא',
    'תוספות יום טוב|תוי"ט|תויו"ט',
    'עיקר תוספות יום טוב|עיקר תוי"ט',
    'פירוש המשניות לרמב"ם|רמב"ם|פירוש המשניות|פיהמ"ש|רמב"ם על המשנה',
    'יכין',
    'בועז',
    'תפארת ישראל',
    'מלאכת שלמה',
    'קהתי|פירוש קהתי|משניות קהתי',
  ],
  bavli: [
    'רש"י',
    'תוספות|תוס\'',
    'רשב"ם',
    'ר"ן|הר"ן|חידושי הר"ן',
    'רי"ף|הרי"ף|הלכות הרי"ף',
    'רא"ש|הרא"ש|פסקי הרא"ש|רבנו אשר',
    'רשב"א|הרשב"א|חידושי הרשב"א',
    'ריטב"א|הריטב"א|חידושי הריטב"א',
    'רמב"ן|הרמב"ן|חידושי הרמב"ן',
    'מאירי|בית הבחירה',
    'מהרש"א|חידושי אגדות|חידושי הלכות|מהרש"א חידושי הלכות|מהרש"א חידושי אגדות',
    'מהר"ם|מהר"ם שיף|מהר"ם לובלין',
    'מהרש"ל|חכמת שלמה',
    'פני יהושע|פנ"י',
    'שיטה מקובצת|שטמ"ק',
    'רבינו חננאל|רבנו חננאל|ר"ח|ר\' חננאל',
    'שטיינזלץ|ביאור שטיינזלץ',
    'חברותא|ביאור חברותא',
  ],
  yerushalmi: [
    'פני משה',
    'קרבן העדה',
    'מראה הפנים',
    'שירי קרבן',
    'ר"ש סיריליאו|רבי שלמה סיריליאו|סיריליאו',
  ],
  rambam: [
    'השגות הראב"ד|ראב"ד|הראב"ד',
    'מגיד משנה',
    'כסף משנה',
    'לחם משנה',
    'משנה למלך',
    'רדב"ז',
    'הגהות מימוניות',
    'אור שמח',
    'קרית ספר',
  ],
  shulchan_aruch: [
    'משנה ברורה|מ"ב|משנ"ב',
    'מגן אברהם|מג"א',
    'ט"ז|טורי זהב',
    'ש"ך|שפתי כהן',
    'באר היטב|באה"ט',
    'ביאור הגר"א|הגר"א',
    'באר הגולה',
    'כף החיים',
    'ערוך השולחן',
    'פרי מגדים|פמ"ג',
    'בית שמואל',
    'חלקת מחוקק',
    'סמ"ע|ספר מאירת עינים|מאירת עינים',
    'פתחי תשובה|פת"ש',
    'הגהות רעק"א|הגהות רבי עקיבא איגר|רעק"א',
    'שערי תשובה',
    'שולחן ערוך הרב|שו"ע הרב',
    'אליה רבה',
  ],
  tur: [
    'בית יוסף|ב"י',
    'דרכי משה|ד"מ',
    'ב"ח|בית חדש',
    'פרישה',
    'דרישה',
  ],
};

/** Hebrew corpus names (for display / debugging). */
const CORPUS_LABEL = {
  tanach: 'תנ"ך',
  mishna: 'משנה',
  bavli: 'תלמוד בבלי',
  yerushalmi: 'תלמוד ירושלמי',
  rambam: 'משנה תורה',
  shulchan_aruch: 'שולחן ערוך',
  tur: 'טור',
};

/** Display groups. `מקור` is the base text shown from inside a commentary. */
const TIERS = { source: 'מקור', core: 'עיקריים', targum: 'תרגומים', rishonim: 'ראשונים', acharonim: 'אחרונים', other: 'נוספים' };

/** Era fallback order (lower first). */
const ERA_RANK = { targum: 0, rishonim: 1, acharonim: 2, modern: 3 };
const UNKNOWN_ERA_RANK = 4;

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/** Leading words that do not change which commentator is meant ("ביאור הגר"א" ~ "הגר"א"). */
const GENERIC_LEAD = new Set(['ביאור', 'באור', 'פירוש', 'פרוש', 'חידושי', 'חדושי', 'תרגום', 'רבינו', 'רבנו', 'ר'].map(normKey));

/** "[מיוחס להריטבא]" / "(מהדורה ב)" annotations are not part of the name. */
const stripAnnotations = (s) => String(s || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');

/** Normalized key of a commentator name (pins and expansion state are keyed by it). */
function commentatorKey(name) {
  return normKey(stripAnnotations(name));
}

/** Match forms of a name: the key, without a generic leading word, and their ktiv-chaser skeletons. */
function nameForms(name) {
  const k = commentatorKey(name);
  const forms = new Set();
  if (!k) return forms;
  forms.add(k);
  const w = k.split(' ');
  if (w.length > 1 && GENERIC_LEAD.has(w[0])) forms.add(w.slice(1).join(' '));
  for (const f of [...forms]) forms.add(skeletonPhrase(f));
  return forms;
}

/**
 * Commentator part of a book title (as shared/commentary.js commentatorName): "רש"י על שבת" ->
 * "רש"י"; notes on a commentary keep their parent ("הערות על מלבים על בראשית" -> "הערות על
 * מלבים"); titles without " על " are kept whole.
 */
function commentatorOf(title) {
  const t = String(title || '').trim();
  const i = t.lastIndexOf(' על ');
  return i > 0 ? t.slice(0, i) : t;
}

// Precomputed: corpus -> [{ display, aliases: string[], forms: Set, index }]
const CORE = {};
for (const [corpus, list] of Object.entries(CORE_LISTS)) {
  CORE[corpus] = list.map((spec, index) => {
    const aliases = spec.split('|');
    const forms = new Set();
    for (const a of aliases) for (const f of nameForms(a)) forms.add(f);
    return { display: aliases[0], aliases, forms, index, corpus };
  });
}
const ALL_CORPORA = Object.keys(CORE_LISTS);

const intersects = (a, b) => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * Core entry of a commentator in a corpus: { entry, alias } (alias = the list spelling that
 * matched, for display), or null when not core there. `corpus` null/unknown searches every list
 * (the earliest position wins). `title` is the full book title, used for series titles without
 * "על" ("יכין ברכות" -> יכין) when the name itself does not match.
 */
function findCore(name, corpus, title) {
  const lists = corpus && CORE[corpus] ? [CORE[corpus]] : ALL_CORPORA.map((c) => CORE[c]);
  const forms = nameForms(name);
  let best = null;
  for (const list of lists) {
    for (const e of list) {
      if (intersects(forms, e.forms) && (!best || e.index < best.index)) best = e;
    }
  }
  if (best) return { entry: best, alias: best.aliases.find((a) => intersects(forms, nameForms(a))) || best.display };
  // Series without "על": the title starts with a core name followed by the base ("באר היטב אורח חיים").
  const t = String(title || name || '');
  if (t.includes(' על ')) return null;
  const tk = commentatorKey(t);
  const tks = skeletonPhrase(tk);
  let alias = null;
  let bestLen = 0;
  for (const list of lists) {
    for (const e of list) {
      for (const a of e.aliases) {
        for (const f of nameForms(a)) {
          if (f.length > bestLen && f.length >= 3 && (tk.startsWith(f + ' ') || tks.startsWith(f + ' '))) {
            best = e;
            alias = a;
            bestLen = f.length;
          }
        }
      }
    }
  }
  return best ? { entry: best, alias } : null;
}

// ---------------------------------------------------------------------------
// Corpus & era detection (Otzaria folder layout)
// ---------------------------------------------------------------------------

const K = (s) => normKey(s);
const TOP_CORPUS = new Map([
  [K('תנך'), 'tanach'],
  [K('משנה'), 'mishna'],
  [K('תלמוד בבלי'), 'bavli'],
  [K('תלמוד ירושלמי'), 'yerushalmi'],
]);
const HALACHA_DIR = new Map([
  [K('משנה תורה'), 'rambam'],
  [K('רמבם'), 'rambam'],
  [K('שולחן ערוך'), 'shulchan_aruch'],
  [K('שלחן ערוך'), 'shulchan_aruch'],
  [K('טור'), 'tur'],
]);
const ERA_DIRS = new Map([
  [K('תרגומים'), 'targum'],
  [K('ראשונים'), 'rishonim'],
  [K('אחרונים'), 'acharonim'],
  [K('מחברי זמננו'), 'modern'],
  [K('מחברי זמנינו'), 'modern'],
]);

/** Corpus named by a title: "משנה תורה, הלכות שבת", "X על שולחן ערוך אורח חיים", "משנה ברכות". */
function corpusOfTitle(title) {
  const t = K(title);
  if (!t) return null;
  if (/(^| )משנה תורה( |$)/.test(t) || /^רמבמ הלכות /.test(t)) return 'rambam';
  if (/(^| )(שולחנ|שלחנ) ערוכ( |$)/.test(t) && !/(שולחנ|שלחנ) ערוכ הרב/.test(t)) return 'shulchan_aruch';
  if (/(^| )על טור( |$)|^טור( |$)/.test(t)) return 'tur';
  if (/(^| )(על )?תלמוד ירושלמי( |$)|(^| )ירושלמי /.test(t)) return 'yerushalmi';
  if (/(^| )על משנה (?!תורה|ברורה|למלכ)/.test(t) || /^משנה (?!תורה|ברורה|למלכ|אחרונה)/.test(t)) return 'mishna';
  return null;
}

/**
 * Corpus of a book from its Otzaria category path (and title): tanach / mishna / bavli /
 * yerushalmi / rambam / shulchan_aruch / tur, or null.
 */
function detectCorpus(categoryPath, title) {
  const dirs = String(categoryPath || '').split('/').filter(Boolean).map(K);
  for (const d of dirs) if (HALACHA_DIR.has(d)) return HALACHA_DIR.get(d);
  const byTitle = corpusOfTitle(title);
  if (byTitle) return byTitle;
  if (dirs.length && TOP_CORPUS.has(dirs[0])) return TOP_CORPUS.get(dirs[0]);
  return null;
}

/** Era of a commentary from its folder ("תנך/ראשונים/…" -> rishonim), or its link type. */
function eraOf(categoryPath, linkType) {
  for (const d of String(categoryPath || '').split('/').filter(Boolean).map(K)) {
    if (ERA_DIRS.has(d)) return ERA_DIRS.get(d);
  }
  if (linkType === 'targum' || linkType === 'translation') return 'targum';
  return null;
}

/**
 * Corpus of the passage: the reading book's own (when known), else the majority of its
 * linked books (commentaries live in the corpus' folder tree).
 */
function inferCorpus(items, context) {
  const ctx = context || {};
  const own = ctx.corpus || detectCorpus(ctx.categoryPath, ctx.title);
  if (own) return own;
  const votes = new Map();
  for (const it of items || []) {
    const c = detectCorpus(it.categoryPath, it.bookTitle);
    if (c) votes.set(c, (votes.get(c) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [c, v] of votes) if (v > n) [best, n] = [c, v];
  return best;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator('he') : null;
const compareNames = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

/**
 * Classifies one linked book. `item`: { bookTitle, name?, linkType?, categoryPath? }.
 * Returns { key, displayName, corpus, core, coreIndex, era, tier, isSource }.
 */
function classifyCommentary(item, corpus) {
  const name = item.name || commentatorOf(item.bookTitle);
  const isSource = item.linkType === 'source';
  const hit = isSource ? null : findCore(name, corpus, item.bookTitle);
  const entry = hit ? hit.entry : null;
  const era = eraOf(item.categoryPath, item.linkType);
  // The list's spelling of the name that matched ("רשי" -> רש"י, "יכין ברכות" -> יכין); another
  // work of the same author keeps its own title ("חידושי אגדות").
  const displayName = hit ? hit.alias : name;
  let tier;
  if (isSource) tier = TIERS.source;
  else if (entry) tier = TIERS.core;
  else if (era === 'targum') tier = TIERS.targum;
  else if (era === 'rishonim') tier = TIERS.rishonim;
  else if (era === 'acharonim') tier = TIERS.acharonim;
  else tier = TIERS.other;
  return {
    // Canonical for core commentators, so a ⭐ on רש"י holds on every book ("רשי על שבת" too).
    key: entry ? commentatorKey(entry.display) : commentatorKey(name),
    displayName,
    corpus: corpus || null,
    core: !!entry,
    coreIndex: entry ? entry.index : null,
    era,
    tier,
    isSource,
  };
}

/**
 * Orders linked commentary groups (any objects with bookTitle / name / linkType / categoryPath /
 * bookId) by priority. Options:
 *   pinned:  commentator keys (commentatorKey) pinned by the user, in pin order;
 *   corpus:  force a corpus; otherwise inferred from `context` ({ title, categoryPath } of the book
 *            being read) or from the groups' own folders.
 * Returns new objects: the group's fields + classifyCommentary() + { pinned, pinIndex, rank }.
 */
function rankCommentaries(groups, opts) {
  const o = opts || {};
  const list = (groups || []).map((g) => ({ ...g, name: g.name || commentatorOf(g.bookTitle) }));
  const corpus = o.corpus || inferCorpus(list, o.context);
  const pinIdx = new Map((o.pinned || []).map((k, i) => [k, i]));
  const ranked = list.map((g) => {
    const c = classifyCommentary(g, corpus);
    const pinIndex = pinIdx.has(c.key) ? pinIdx.get(c.key) : null;
    return { ...g, ...c, pinned: pinIndex != null, pinIndex };
  });
  const inf = Number.POSITIVE_INFINITY;
  const sortKey = (r) => [
    r.pinned ? r.pinIndex : inf,
    r.isSource ? 0 : 1,
    r.core ? r.coreIndex : inf,
    r.era && ERA_RANK[r.era] !== undefined ? ERA_RANK[r.era] : UNKNOWN_ERA_RANK,
  ];
  ranked.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return compareNames(a.displayName, b.displayName) || (a.bookId || 0) - (b.bookId || 0);
  });
  ranked.forEach((r, i) => (r.rank = i));
  return ranked;
}

/**
 * Commentator keys expanded by default: pinned favorites + the first `top` (3) others in
 * priority order (the primary commentators whenever the passage has any). Short lists
 * (<= `allBelow`, default 3 groups) open entirely.
 */
function defaultExpandedKeys(ranked, opts) {
  const top = opts && opts.top != null ? opts.top : 3;
  const allBelow = opts && opts.allBelow != null ? opts.allBelow : 3;
  const out = new Set();
  if (ranked.length <= allBelow) {
    for (const r of ranked) out.add(r.key);
    return out;
  }
  let n = 0;
  for (const r of ranked) {
    if (r.pinned) out.add(r.key);
    else if (n < top) {
      out.add(r.key);
      n++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Name filter (Hebrew + Torah abbreviations)
// ---------------------------------------------------------------------------

/** Searchable normalized forms of a ranked item: names, core aliases and their acronyms. */
function searchForms(item) {
  const out = new Set();
  const add = (s) => {
    const k = commentatorKey(s);
    if (!k) return;
    out.add(k);
    out.add(skeletonPhrase(k));
    for (const a of acronyms(k)) out.add(a);
  };
  add(item.name || commentatorOf(item.bookTitle));
  if (item.displayName) add(item.displayName);
  if (item.core) {
    const hit = findCore(item.name || commentatorOf(item.bookTitle), item.corpus, item.bookTitle);
    if (hit) for (const a of hit.entry.aliases) add(a);
  }
  return out;
}

/** `q` starts one of the words of `form` ("רמ" is in "רמבנ", not in "בעל הטורימ"). */
const startsWord = (form, q) => form.startsWith(q) || form.includes(' ' + q);

/**
 * True when `item` matches the typed filter: the start of a word of any of its names / aliases
 * (punctuation-, niqqud- and final-letter-insensitive: "רש", "תוס'", "אבן עז", "מלבים"), an
 * acronym ("מ"ב", "אב"ע"), or a dictionary expansion of an abbreviation ("ט"ז" -> טורי זהב).
 */
function matchesCommentatorQuery(query, item) {
  const q = normKey(query);
  if (!q) return true;
  const forms = searchForms(item);
  const qs = [q, skeletonPhrase(q)];
  for (const f of forms) for (const x of qs) if (x && startsWord(f, x)) return true;
  for (const full of expandAbbreviation(query)) {
    const fk = normKey(full);
    const fs = skeletonPhrase(fk);
    for (const f of forms) if (f === fk || f === fs || (fk.length >= 3 && startsWord(f, fk))) return true;
  }
  return false;
}

/**
 * Applies the drawer's view chip and name filter to ranked items.
 * view: 'all' | 'core' (עיקריים + the base text) | 'pinned'.
 */
function filterCommentaries(ranked, opts) {
  const view = (opts && opts.view) || 'all';
  const query = (opts && opts.query) || '';
  return ranked.filter((r) => {
    if (view === 'core' && !(r.core || r.isSource)) return false;
    if (view === 'pinned' && !r.pinned) return false;
    return matchesCommentatorQuery(query, r);
  });
}

module.exports = {
  CORE_LISTS,
  CORPUS_LABEL,
  TIERS,
  commentatorKey,
  commentatorOf,
  findCore,
  detectCorpus,
  eraOf,
  inferCorpus,
  classifyCommentary,
  rankCommentaries,
  defaultExpandedKeys,
  matchesCommentatorQuery,
  filterCommentaries,
};
