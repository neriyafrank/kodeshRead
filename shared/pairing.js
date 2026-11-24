/**
 * Commentary <-> base-book pairing for the real Otzaria library layout (calibrated on the full
 * library index, otzaria_index_only.txt: 7,674 books, 76% of them "X על Y").
 *
 * Otzaria conventions handled:
 *  - "<מפרש> על <ספר>"; the base is named bare ("תוספות על ברכות"), with an explicit corpus
 *    ("ברטנורא על משנה ברכות", "… על תלמוד ירושלמי, מסכת יומא"), or by its full comma title
 *    ("אבן האזל על משנה תורה, הלכות ברכות", "… על שולחן ערוך אורח חיים");
 *  - primary texts carry a corpus prefix or comma form ("משנה ברכות", "תלמוד ירושלמי ברכות",
 *    "תוספתא ברכות", "שולחן ערוך, אורח חיים", "משנה תורה, הלכות שבת"); the Bavli does not
 *    ("תלמוד בבלי/סדר זרעים/ברכות");
 *  - commentaries on commentaries ("הערות על חברותא על בבא קמא" -> "חברותא על בבא קמא");
 *  - a commentary inside "<X>/מפרשים/" belongs to X's texts ("ריף/מפרשים/…/המאור הגדול על
 *    בבא קמא" -> the Rif, not the Bavli; "טור/מפרשים/בית יוסף" -> "טור");
 *  - "<series> <base>" without "על" in commentary folders ("באר היטב אורח חיים", "יכין
 *    ברכות", "גבורת ארי יומא", "אור הישר (זבחים)");
 *  - corpus-wide commentaries ("… על התורה", "… על השס", "… על סדר קדשים") are returned as
 *    `multi`: they are aligned per top-level heading that names a base book.
 *
 * Candidates are scored (exact title > corpus-stripped title > alias; explicit corpus; primary text
 * over another commentary; folder locality), so the same name in several corpora resolves to the
 * right one (Bavli / Mishnah / Yerushalmi / Tosefta "ברכות").
 */
'use strict';

const { aliasKey } = require('./hebrew');
const { expandAbbreviation } = require('./hebrewTorahDict');
const { TRACTATE_INDEX } = require('./canonLists');

/** Folders that hold commentaries / translations / later works rather than primary texts ("תנך/תרגומים/…/תרגום איוב" -> איוב). */
const COMMENTARY_DIRS = new Set(['מפרשים', 'ראשונים', 'אחרונים', 'מחברי זמננו', 'מחברי זמנינו', 'תרגומים'].map(aliasKey));

/** Top-level Otzaria folder -> corpus id. */
const CORPUS_OF_TOP = new Map(
  Object.entries({ 'תלמוד בבלי': 'bavli', 'תלמוד ירושלמי': 'yerushalmi', משנה: 'mishna', תוספתא: 'tosefta', תנך: 'tanach', 'תנ"ך': 'tanach', הלכה: 'halacha', מדרש: 'midrash' }).map(([k, v]) => [aliasKey(k), v]),
);

/** Explicit corpus words at the start of a base name ("משנה ברכות", "תלמוד ירושלמי, מסכת יומא"). */
const EXPLICIT_CORPUS = [
  ['תלמוד ירושלמי', 'yerushalmi'],
  ['ירושלמי', 'yerushalmi'],
  ['תלמוד בבלי', 'bavli'],
  ['בבלי', 'bavli'],
  ['תוספתא', 'tosefta'],
  ['משנה', 'mishna'],
].map(([w, c]) => [aliasKey(w), c]);
/** "משנה X" is a corpus prefix, except in these titles. */
const NOT_CORPUS = new Set(['משנה תורה', 'משנה ברורה', 'משנה למלך', 'משנה אחרונה'].map(aliasKey));

/** Words that may precede the bare name: "מסכת ברכות", "ספר דברים", "פרקי אבות". */
const LEADING_FILLERS = ['מסכת', 'ספר', 'פרקי'].map(aliasKey);

/** Corpus-wide targets: one commentary file over many base books. */
const MULTI_TARGETS = [
  [/^(ה)?תורה$|^חמשה חומשי תורה$|^החומש$/, { corpus: 'tanach', dir: 'תורה' }],
  [/^(ה)?שס$|^הגמרא$|^התלמוד$/, { corpus: 'bavli' }],
  [/^(ה)?משנה$|^המשניות$|^ששה סדרי משנה$/, { corpus: 'mishna' }],
  [/^(חמש|חמשה) מגילות$|^המגילות$/, { corpus: 'tanach' }],
  [/^(ה)?רמבמ$|^משנה תורה$|^(ה)?יד החזקה$/, { corpus: 'halacha', dir: 'משנה תורה' }],
  [/^(שולחנ|שלחנ) ערוכ$/, { corpus: 'halacha', dir: 'שולחן ערוך' }],
  [/^(ה)?נכ$|^נביאימ$|^כתובימ$|^(ה)?תנכ$/, { corpus: 'tanach' }],
  // Only the six orders: "סדר עולם רבה" or "סדר טרוייש" are books, not orders.
  [/^סדר (זרעימ|מועד|נשימ|נזיקינ|קדשימ|טהרות)$/, { seder: true }],
  [/^(?:תלמוד )?ירושלמי (?:סדר )?(זרעימ|מועד|נשימ|נזיקינ|קדשימ|טהרות)$/, { corpus: 'yerushalmi', seder: true }],
];

/** Generic last words that never name a base book in "<series> <base>" titles. */
const GENERIC = new Set(['הקדמה', 'מבוא', 'מפתח', 'מפתחות', 'השמטות', 'הוספות', 'קונטרס', 'חלק', 'כללים', 'סימנים', 'תשובות', 'ליקוטים', 'מילואים', 'אחרון', 'תנינא', 'קמא', 'מהדורא'].map(aliasKey));

/** Words of an introduction / index title: such a book never pairs by its trailing words. */
const INTRO_WORDS = new Set(['הקדמה', 'הקדמת', 'מבוא', 'מפתח', 'מפתחות', 'השמטות', 'הוספות', 'כללים'].map(aliasKey));

/**
 * Standalone commentaries whose title does not name their base book (exact titles; in Otzaria they
 * sit in "שולחן ערוך/מפרשים/<name>/", whose folder owns five base texts). Not here on purpose:
 * "כף החיים" (הלכה/אחרונים/כף החיים is another work; the SA one is "כף החיים על שולחן ערוך …") and
 * "באר היטב" (one file per part: "באר היטב אורח חיים" is paired by its suffix).
 */
const KNOWN_BASES = {
  'משנה ברורה': ['שולחן ערוך, אורח חיים'],
  'ביאור הלכה': ['שולחן ערוך, אורח חיים'],
  'שער הציון': ['שולחן ערוך, אורח חיים'],
  'מגן אברהם': ['שולחן ערוך, אורח חיים'],
  'בית שמואל': ['שולחן ערוך, אבן העזר'],
  'חלקת מחוקק': ['שולחן ערוך, אבן העזר'],
  'סמע': ['שולחן ערוך, חושן משפט'],
  'קצות החושן': ['שולחן ערוך, חושן משפט'],
  'נתיבות המשפט': ['שולחן ערוך, חושן משפט'],
};
const KNOWN_BASES_NORM = new Map(Object.entries(KNOWN_BASES).map(([k, v]) => [aliasKey(k), v.map(aliasKey)]));

/**
 * Spelling-insensitive form: internal ו / י removed (as hebrewTorahDict.skeleton) and the plural
 * ending ין / ים unified ("עוקצין" / "עוקצים", "נזיקין").
 */
function skel(phrase) {
  return String(phrase)
    .split(' ')
    .map((w) => {
      const u = w.length > 3 ? w.replace(/ינ$/, 'ימ') : w;
      return u.length <= 2 ? u : u[0] + u.slice(1, -1).replace(/[וי]/g, '') + u[u.length - 1];
    })
    .join(' ');
}

const isCommentaryTitle = (title) => / על /.test(String(title || ''));

/** "רש\"י על בראשית" -> { commentator, base } (first " על "; nested chains keep the rest). */
function splitCommentaryTitle(title) {
  const t = String(title || '').trim();
  const i = t.indexOf(' על ');
  if (i <= 0) return null;
  return { commentator: t.slice(0, i).trim(), base: t.slice(i + 4).trim() };
}

/** Folder facts of a book: corpus, primary text?, and the folder owning its "מפרשים" (if any). */
function placeOf(categoryPath) {
  const dirs = String(categoryPath || '').split('/').filter(Boolean);
  const keys = dirs.map(aliasKey);
  const corpus = CORPUS_OF_TOP.get(keys[0]) || keys[0] || '';
  const commIdx = keys.findIndex((k) => COMMENTARY_DIRS.has(k));
  // ".../ריף/מפרשים/..." -> owner ".../ריף" (only for a literal "מפרשים" folder).
  const mIdx = keys.lastIndexOf(aliasKey('מפרשים'));
  return { dirs: keys, corpus, primary: commIdx < 0, owner: mIdx > 0 ? keys.slice(0, mIdx).join('/') : null };
}

/** Corpus prefix of a (normalized) base name, if explicit. */
function explicitCorpus(name) {
  if ([...NOT_CORPUS].some((n) => name === n || name.startsWith(n + ' '))) return null;
  for (const [w, c] of EXPLICIT_CORPUS) if (name.startsWith(w + ' ')) return { corpus: c, rest: name.slice(w.length + 1) };
  return null;
}

function stripFillers(name) {
  let n = name;
  for (let again = true; again; ) {
    again = false;
    for (const f of LEADING_FILLERS) {
      if (n.startsWith(f + ' ')) {
        n = n.slice(f.length + 1);
        again = true;
      }
    }
  }
  return n;
}

/** Keys of a candidate base book with their strength (3 exact title, 2 corpus/series-stripped, 1 alias). */
function baseKeys(book, place) {
  const out = [];
  const add = (k, s) => {
    if (k && k.length >= 2) out.push([k, s]);
  };
  const title = aliasKey(book.title);
  add(title, 3);
  const ex = explicitCorpus(title);
  if (ex) add(stripFillers(ex.rest), 2);
  add(stripFillers(title), 2);
  // Comma titles: "שולחן ערוך, אורח חיים" -> "אורח חיים"; "משנה תורה, הלכות שבת" -> "הלכות שבת".
  const comma = String(book.title).split(/\s*,\s*/);
  if (comma.length > 1) add(stripFillers(aliasKey(comma.slice(1).join(' '))), 2);
  // Series prefix = an ancestor folder's name: ".../ריף/סדר נזיקין/ריף בבא קמא", ".../יכין/…/יכין
  // ברכות", ".../גמרא נוחה/גמרא נוחה מסכת ברכות".
  for (const dir of place.dirs.slice(1)) if (title.startsWith(dir + ' ')) add(stripFillers(title.slice(dir.length + 1)), 2);
  // "אור הישר (זבחים)": the parenthesised work.
  const paren = /\(([^)]+)\)\s*$/.exec(String(book.title));
  if (paren && !isCommentaryTitle(book.title)) add(stripFillers(aliasKey(paren[1])), 1);
  // Generated aliases (acronyms ...) only for primary texts.
  if (place.primary) for (const a of book.aliases || []) add(a, 1);
  return out;
}

/** Corpus affinity when the base name carries no explicit corpus. */
function affinity(commCorpus, candCorpus) {
  if (commCorpus === candCorpus) return 12;
  if (commCorpus === 'bavli' && candCorpus === 'mishna') return 6; // Mishnah-only tractates (זבים, מדות)
  if ((commCorpus === 'yerushalmi' || commCorpus === 'tosefta') && candCorpus === 'mishna') return 4;
  if (commCorpus === 'midrash' && candCorpus === 'tanach') return 4;
  return 0;
}

/**
 * Pairs commentary books with base books.
 * @param {{ id, title, aliases?: string[], categoryPath?: string }[]} books
 * @returns {{ commId: number, baseId: number, how: string }[] & { multi?: { commId, scope }[] }}
 *   Array of one-to-one pairs; `.multi` lists corpus-wide commentaries with their scope.
 */
/** Books handled between two pause points of pairCommentariesAsync (a few ms of work on a phone). */
const PAIR_SLICE = 150;

/** pairCommentaries in one go (the PC build, tests). */
function pairCommentaries(books) {
  const it = pairSteps(books);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * The same pairing, cooperatively: `pause()` is awaited every PAIR_SLICE books, so pairing the
 * whole Otzaria library on a phone never blocks the JS thread for more than a few milliseconds.
 */
async function pairCommentariesAsync(books, pause) {
  const it = pairSteps(books);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (pause) await pause();
  }
}

function* pairSteps(books) {
  let tick = 0;
  const info = books.map((b) => ({ b, place: placeOf(b.categoryPath) }));
  const byId = new Map(info.map((x) => [x.b.id, x]));
  const index = new Map(); // key -> [{ x, strength }]
  const sindex = new Map(); // skeleton key -> [{ x, strength }]
  for (const x of info) {
    if (++tick % PAIR_SLICE === 0) yield;
    for (const [k, s] of baseKeys(x.b, x.place)) {
      // A commentary is a base only under its exact title (nested chains); its stripped forms
      // ("יכין זבים" -> "זבים") are weaker than any primary text's.
      const strength = x.place.primary || s === 3 ? s : s - 1.5;
      for (const [map, key] of [[index, k], [sindex, skel(k)]]) {
        const list = map.get(key) || [];
        if (!list.some((c) => c.x === x && c.strength >= strength)) list.push({ x, strength });
        map.set(key, list);
      }
    }
  }

  const sharedDepth = (a, b) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  const best = (comm, names, explicit) => {
    let top = null;
    for (const name of names) {
      // The skeleton is only a fallback: when the exact spelling names a book, a different name
      // with the same skeleton (שביעית / שבועות, קודשים / קידושין) is never taken instead.
      const exactHit = (index.get(name) || []).some((c) => c.x !== comm && (!explicit || c.x.place.corpus === explicit));
      for (const [map, key, penalty] of exactHit ? [[index, name, 0]] : [[index, name, 0], [sindex, skel(name), 4]]) {
        for (const c of map.get(key) || []) {
          if (c.x === comm) continue;
          const cp = c.x.place;
          if (explicit && cp.corpus !== explicit) continue;
          let score = c.strength * 10 - penalty;
          score += explicit ? 25 : affinity(comm.place.corpus, cp.corpus);
          if (cp.primary) score += 8;
          // Locality: ".../X/מפרשים/..." prefers a text directly under ".../X".
          // Strong enough to beat an exact primary title elsewhere (the Bavli's "בבא קמא" for the Rif's).
          if (comm.place.owner && cp.dirs.join('/').startsWith(comm.place.owner) && !cp.dirs.slice(comm.place.owner.split('/').length).some((d) => COMMENTARY_DIRS.has(d))) score += 60;
          score += Math.min(4, sharedDepth(cp.dirs, comm.place.dirs));
          if (!top || score > top.score || (score === top.score && c.x.b.id < top.x.b.id)) top = { x: c.x, score };
        }
      }
    }
    return top;
  };

  const out = [];
  const multi = [];
  for (const x of info) {
    if (++tick % PAIR_SLICE === 0) yield;
    const { b, place } = x;
    const splits = commentarySplits(b.title);
    let found = null;
    let how = '';
    if (splits.length) {
      // Every " על " is a candidate split, first one first: "הערות על חברותא על בבא קמא" -> base
      // "חברותא על בבא קמא"; "קובץ על היד החזקה על משנה תורה, הלכות שבת" -> base "משנה תורה, …".
      for (const base of splits) {
        // The full name first (a real title may end with "מהדורא קמא"); trimmed tails are only fallbacks.
        const name = aliasKey(base);
        const multiScope = scopeOfMulti(aliasKey(trimTails(base)), place);
        if (multiScope) {
          found = { multi: multiScope };
          break;
        }
        const ex = explicitCorpus(name);
        const names = nameVariants(base);
        if (ex) names.push(...nameVariants(ex.rest));
        found = best(x, [...new Set(names)], ex ? ex.corpus : null);
        // "… על משנה ברכות" inside a Talmud folder when no Mishnah exists: fall back without the corpus.
        if (!found && ex) found = best(x, nameVariants(ex.rest), null);
        how = 'title';
        if (!found) {
          // Shortened section names: "הלכות לולב" -> "הלכות שופר וסוכה ולולב" (unique, same corpus).
          found = containing(x, ex ? ex.rest : name);
          if (found) how = 'contains';
        }
        if (found) break;
      }
      if (found && found.multi) {
        multi.push({ commId: b.id, scope: found.multi });
        continue;
      }
    } else {
      for (const k of KNOWN_BASES_NORM.get(aliasKey(b.title)) || []) {
        const hit = best(x, [k], null);
        if (hit) {
          found = hit;
          how = 'known';
          break;
        }
      }
    }
    if (!found && !splits.length && !place.primary) {
      // "<series> <base>": the longest trailing word sequence naming a primary text.
      const words = aliasKey(String(b.title).replace(/\(([^)]+)\)\s*$/, ' $1')).split(' ').filter(Boolean);
      // An introduction / index ("רמבם הקדמה לסדר קודשים") names no base book by its last words.
      const generic = words.some((w) => INTRO_WORDS.has(w) || INTRO_WORDS.has(w.replace(/^[לו]/, '')));
      for (let n = generic ? 0 : Math.min(4, words.length - 1); n >= 1 && !found; n--) {
        const tail = words.slice(words.length - n).join(' ');
        // "קמא" / "בתרא" are generic tails, except inside a tractate name ("יכין בבא קמא").
        const tractate = TRACTATE_INDEX.get(stripFillers(tail)) != null;
        if (n === 1 && !tractate && (GENERIC.has(tail) || tail.length < 3)) continue;
        if (!tractate && words.slice(words.length - n).some((w) => GENERIC.has(w))) continue;
        const hit = best(x, [tail, stripFillers(tail)], null);
        // A primary text of the same corpus, or a text of the folder owning this "מפרשים"
        // (".../ריף/מפרשים/השגות הראבד/השגות הראבד גיטין" -> the Rif's גיטין).
        const local = place.owner && hit && hit.x.place.dirs.join('/').startsWith(place.owner + '/');
        if (hit && ((hit.x.place.primary && hit.x.place.corpus === place.corpus) || local)) found = hit;
      }
      how = 'series';
      // ".../טור/מפרשים/בית יוסף": the single primary text of the folder owning "מפרשים".
      if (!found && place.owner) {
        const owned = info.filter((y) => y.place.primary && y.place.dirs.join('/') === place.owner);
        if (owned.length === 1) {
          found = { x: owned[0], score: 0 };
          how = 'owner';
        }
      }
    }
    if (found && found.x.b.id !== b.id) out.push({ commId: b.id, baseId: found.x.b.id, how });
  }
  out.multi = multi;
  return out;

  /** Primary texts of the commentary's corpus whose name contains every word of `name` (ו-prefix tolerant). */
  function containing(comm, name) {
    // Words compared by skeleton, without the article ("תפלה" = "תפילה", "הנפש" = "נפש").
    const norm = (w) => skel(w.length > 3 && w[0] === 'ה' ? w.slice(1) : w);
    const want = stripFillers(name).split(' ').filter((w) => w.length >= 2).map(norm);
    const strong = want.filter((w) => w.length >= 3 && !LEADING_FILLERS.includes(w) && w !== aliasKey('הלכות'));
    if (!strong.length) return null;
    const hits = [];
    for (const y of info) {
      if (y === comm || !y.place.primary || y.place.corpus !== comm.place.corpus) continue;
      const words = new Set(aliasKey(y.b.title).split(' ').flatMap((w) => (w.length > 3 && w[0] === 'ו' ? [w, w.slice(1)] : [w])).map(norm));
      if (want.every((w) => words.has(w))) hits.push(y);
    }
    if (!hits.length) return null;
    // The shortest such title (fewest extra words); ambiguous ties are rejected.
    hits.sort((a, b2) => a.b.title.length - b2.b.title.length);
    if (hits.length > 1 && hits[0].b.title.length === hits[1].b.title.length) return null;
    return { x: hits[0], score: 0 };
  }
}

/**
 * Drops edition / attribution tails from a raw base name (before normalization removes the
 * brackets): "מגילה מהדורא קמא", "שבת [מיוחס להריטבא]", "שמות; פירוש הקצר".
 */
function trimTails(raw) {
  return String(raw || '')
    .replace(/\s*;.*$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/\s+מהדורא\s+\S+$/, '')
    .trim();
}

/** Base-name splits of a commentary title, at every " על " (first split first). */
function commentarySplits(title) {
  const t = String(title || '').trim();
  const out = [];
  for (let i = t.indexOf(' על '); i > 0; i = t.indexOf(' על ', i + 1)) out.push(t.slice(i + 4).trim());
  return out;
}

/**
 * Spellings of a base name to look up: as written, without fillers ("מסכת", "ספר", "פרקי"),
 * without a volume suffix ("… חלק א", "… א-ב"), and with abbreviations expanded
 * ("שולחן ערוך יוד" -> "שולחן ערוך יורה דעה").
 */
function nameVariants(rawName) {
  const name = aliasKey(rawName);
  const trimmed = aliasKey(trimTails(rawName));
  const out = new Set([name, stripFillers(name), trimmed, stripFillers(trimmed)]);
  for (const n of [...out]) {
    const noVol = n.replace(/ (חלק|כרכ) [א-ת]{1,3}$/, '').replace(/ [א-ת]{1,2}-[א-ת]{1,2}$/, '');
    out.add(noVol);
    const words = noVol.split(' ');
    const expanded = words.map((w) => (w.length >= 3 ? expandAbbreviation(w)[0] || w : w)).join(' ');
    if (expanded !== noVol) out.add(aliasKey(expanded));
  }
  return [...out].filter(Boolean);
}

/** Scope of a corpus-wide commentary ("על התורה", "על השס", "על סדר קדשים"), or null. */
function scopeOfMulti(name, place) {
  for (const [re, s] of MULTI_TARGETS) {
    const m = re.exec(name);
    if (!m) continue;
    if (s.seder) return { corpus: s.corpus || place.corpus, seder: aliasKey('סדר ' + m[m.length - 1].replace(/^סדר /, '')) };
    return { corpus: s.corpus, dir: s.dir ? aliasKey(s.dir) : null };
  }
  return null;
}

/**
 * Base books a corpus-wide commentary may cover: primary texts of its corpus (and seder / folder),
 * keyed by their bare names so a top-level heading ("ברכות", "מסכת ברכות", "בראשית") finds one.
 * @returns {Map<string, number>}  key -> base book id
 */
function multiTargets(books, scope) {
  const out = new Map();
  for (const b of books) {
    const place = placeOf(b.categoryPath);
    if (!place.primary || place.corpus !== scope.corpus) continue;
    if (scope.dir && !place.dirs.includes(scope.dir)) continue;
    if (scope.seder && !place.dirs.some((d) => d === scope.seder || skel(d) === skel(scope.seder))) continue;
    for (const [k, s] of baseKeys(b, place)) if (s >= 2 && !out.has(k)) out.set(k, b.id);
  }
  return out;
}

/** Normalized key of a top-level heading of a corpus-wide commentary ("מסכת ברכות" -> "ברכות"). */
function headingBookKey(title) {
  return stripFillers(aliasKey(String(title || '').replace(/^\s*(פרשת|ספר|מסכת)\s+/, '')));
}

module.exports = { commentarySplits, nameVariants, KNOWN_BASES, COMMENTARY_DIRS, isCommentaryTitle, splitCommentaryTitle, placeOf, pairCommentaries, pairCommentariesAsync, multiTargets, headingBookKey, scopeOfMulti };
