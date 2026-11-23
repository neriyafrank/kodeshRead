/**
 * The 54 weekly Torah portions (פרשות השבוע) with their 7 aliyot + maftir, as a compact static
 * dataset, and the helpers that place them on the lines of an Otzaria Chumash book.
 *
 * Otzaria's תנך/תורה/<book>.txt files are divided only by "פרק" headings with "(א) ..." verse
 * lines, so the parsha / aliyah boundaries are computed here and rendered as inline dividers
 * (the stored lines, line indices and commentary links are untouched).
 *
 * Coordinates are the standard (Ashkenazi printed Chumash) full-kriyah aliyot, Hebrew
 * (Masoretic) chapter / verse numbering, cross-checked against @hebcal/leyning's aliyot table.
 * Notes:
 *  - עקב and נצבים: the maftir repeats the whole shevi'i (same start verse).
 *  - וזאת הברכה has no maftir inside Deuteronomy (on Simchat Torah it is read from Numbers
 *    29:35), so its `maftir` slot is null.
 *
 * Shared by the reader (src/components/reader), the TOC drawer, the daily-learning resolver and
 * scripts/selftest.js. Pure data + async helpers over the { all(sql, params) } adapter.
 */
'use strict';

const { hebrewNumeralToInt, intToHebrew, formatHebrewNumeral, normalizeHebrew } = require('./hebrew');
const { adapterForBook } = require('./sources');

const CHUMASH_BOOKS = ['בראשית', 'שמות', 'ויקרא', 'במדבר', 'דברים'];
const ALIYAH_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי', 'מפטיר'];

/** Verses per chapter (Masoretic numbering), index 0 = chapter 1. */
const CHAPTER_VERSES = {
  בראשית: [31, 25, 24, 26, 32, 22, 24, 22, 29, 32, 32, 20, 18, 24, 21, 16, 27, 33, 38, 18, 34, 24, 20, 67, 34, 35, 46, 22, 35, 43, 54, 33, 20, 31, 29, 43, 36, 30, 23, 23, 57, 38, 34, 34, 28, 34, 31, 22, 33, 26],
  שמות: [22, 25, 22, 31, 23, 30, 29, 28, 35, 29, 10, 51, 22, 31, 27, 36, 16, 27, 25, 23, 37, 30, 33, 18, 40, 37, 21, 43, 46, 38, 18, 35, 23, 35, 35, 38, 29, 31, 43, 38],
  ויקרא: [17, 16, 17, 35, 26, 23, 38, 36, 24, 20, 47, 8, 59, 57, 33, 34, 16, 30, 37, 27, 24, 33, 44, 23, 55, 46, 34],
  במדבר: [54, 34, 51, 49, 31, 27, 89, 26, 23, 36, 35, 16, 33, 45, 41, 35, 28, 32, 22, 29, 35, 41, 30, 25, 19, 65, 23, 31, 39, 17, 54, 42, 56, 29, 34, 13],
  דברים: [46, 37, 29, 49, 30, 25, 26, 20, 29, 22, 32, 31, 19, 29, 23, 22, 20, 22, 21, 20, 23, 29, 26, 22, 19, 19, 26, 69, 28, 20, 30, 52, 29, 12],
};

// [name, hebcal name, book 1-5, "chapter:verse" starts of ראשון שני שלישי רביעי חמישי שישי שביעי מפטיר]
const DATA = [
  ['בראשית', 'Bereshit', 1, '1:1 2:4 2:20 3:22 4:19 4:23 5:25 6:5'],
  ['נח', 'Noach', 1, '6:9 7:1 7:17 8:15 9:8 9:18 11:1 11:29'],
  ['לך לך', 'Lech-Lecha', 1, '12:1 12:14 13:5 14:1 14:21 15:7 17:7 17:24'],
  ['וירא', 'Vayera', 1, '18:1 18:15 19:1 19:21 21:5 21:22 22:1 22:20'],
  ['חיי שרה', 'Chayei Sara', 1, '23:1 23:17 24:10 24:27 24:53 25:1 25:12 25:16'],
  ['תולדות', 'Toldot', 1, '25:19 26:6 26:13 26:23 26:30 27:28 28:5 28:7'],
  ['ויצא', 'Vayetzei', 1, '28:10 29:1 29:18 30:14 30:28 31:17 31:43 32:1'],
  ['וישלח', 'Vayishlach', 1, '32:4 32:14 32:31 33:6 34:1 35:12 36:20 36:40'],
  ['וישב', 'Vayeshev', 1, '37:1 37:12 37:23 38:1 39:1 39:7 40:1 40:20'],
  ['מקץ', 'Miketz', 1, '41:1 41:15 41:39 41:53 42:19 43:16 43:30 44:14'],
  ['ויגש', 'Vayigash', 1, '44:18 44:31 45:8 45:19 45:28 46:28 47:11 47:25'],
  ['ויחי', 'Vayechi', 1, '47:28 48:10 48:17 49:1 49:19 49:27 50:21 50:23'],
  ['שמות', 'Shemot', 2, '1:1 1:18 2:11 3:1 3:16 4:18 5:1 5:22'],
  ['וארא', 'Vaera', 2, '6:2 6:14 6:29 7:8 8:7 8:19 9:17 9:33'],
  ['בא', 'Bo', 2, '10:1 10:12 10:24 11:4 12:21 12:29 13:1 13:14'],
  ['בשלח', 'Beshalach', 2, '13:17 14:9 14:15 14:26 15:27 16:11 17:1 17:14'],
  ['יתרו', 'Yitro', 2, '18:1 18:13 18:24 19:1 19:7 19:20 20:15 20:19'],
  ['משפטים', 'Mishpatim', 2, '21:1 21:20 22:4 22:27 23:6 23:20 23:26 24:15'],
  ['תרומה', 'Terumah', 2, '25:1 25:17 26:1 26:15 26:31 27:1 27:9 27:17'],
  ['תצוה', 'Tetzaveh', 2, '27:20 28:13 28:31 29:1 29:19 29:38 30:1 30:8'],
  ['כי תשא', 'Ki Tisa', 2, '30:11 31:18 33:12 33:17 34:1 34:10 34:27 34:33'],
  ['ויקהל', 'Vayakhel', 2, '35:1 35:21 35:30 36:8 36:20 37:17 38:1 38:18'],
  ['פקודי', 'Pekudei', 2, '38:21 39:2 39:22 39:33 40:1 40:17 40:28 40:34'],
  ['ויקרא', 'Vayikra', 3, '1:1 1:14 2:7 3:1 4:1 4:27 5:11 5:24'],
  ['צו', 'Tzav', 3, '6:1 6:12 7:11 8:1 8:14 8:22 8:30 8:33'],
  ['שמיני', 'Shmini', 3, '9:1 9:17 9:24 10:12 10:16 11:1 11:33 11:45'],
  ['תזריע', 'Tazria', 3, '12:1 13:6 13:18 13:24 13:29 13:40 13:55 13:57'],
  ['מצורע', 'Metzora', 3, '14:1 14:13 14:21 14:33 14:54 15:16 15:29 15:31'],
  ['אחרי מות', 'Achrei Mot', 3, '16:1 16:18 16:25 17:1 17:8 18:6 18:22 18:28'],
  ['קדושים', 'Kedoshim', 3, '19:1 19:15 19:23 19:33 20:1 20:8 20:23 20:25'],
  ['אמור', 'Emor', 3, '21:1 21:16 22:17 23:1 23:23 23:33 24:1 24:21'],
  ['בהר', 'Behar', 3, '25:1 25:14 25:19 25:25 25:29 25:39 25:47 25:55'],
  ['בחוקותי', 'Bechukotai', 3, '26:3 26:6 26:10 27:1 27:16 27:22 27:29 27:32'],
  ['במדבר', 'Bamidbar', 4, '1:1 1:20 2:1 3:1 3:14 3:40 4:1 4:17'],
  ['נשא', 'Nasso', 4, '4:21 4:38 5:1 5:11 7:1 7:42 7:72 7:87'],
  ['בהעלותך', "Beha'alotcha", 4, '8:1 8:15 9:1 9:15 10:11 10:35 11:30 12:14'],
  ['שלח', "Sh'lach", 4, '13:1 13:21 14:8 14:26 15:8 15:17 15:27 15:37'],
  ['קרח', 'Korach', 4, '16:1 16:14 16:20 17:9 17:16 17:25 18:21 18:30'],
  ['חקת', 'Chukat', 4, '19:1 19:18 20:7 20:14 20:22 21:10 21:21 21:34'],
  ['בלק', 'Balak', 4, '22:2 22:13 22:21 22:39 23:13 23:27 24:14 25:7'],
  ['פינחס', 'Pinchas', 4, '25:10 26:5 26:52 27:6 28:1 28:16 29:12 29:35'],
  ['מטות', 'Matot', 4, '30:2 31:1 31:13 31:25 31:42 32:1 32:20 32:39'],
  ['מסעי', 'Masei', 4, '33:1 33:11 33:50 34:16 35:1 35:9 36:1 36:11'],
  ['דברים', 'Devarim', 5, '1:1 1:11 1:22 1:39 2:2 2:31 3:15 3:20'],
  ['ואתחנן', 'Vaetchanan', 5, '3:23 4:5 4:41 5:1 5:19 6:4 7:1 7:9'],
  ['עקב', 'Eikev', 5, '7:12 8:11 9:4 10:1 10:12 11:10 11:22 11:22'],
  ['ראה', "Re'eh", 5, '11:26 12:11 12:29 14:1 14:22 15:1 15:19 16:13'],
  ['שופטים', 'Shoftim', 5, '16:18 17:14 18:1 18:6 18:14 19:14 20:10 21:7'],
  ['כי תצא', 'Ki Teitzei', 5, '21:10 21:22 22:8 23:8 23:25 24:5 24:14 25:17'],
  ['כי תבוא', 'Ki Tavo', 5, '26:1 26:12 26:16 27:1 27:11 28:7 29:1 29:6'],
  ['נצבים', 'Nitzavim', 5, '29:9 29:12 29:15 30:1 30:7 30:11 30:15 30:15'],
  ['וילך', 'Vayeilech', 5, '31:1 31:4 31:7 31:10 31:14 31:20 31:25 31:28'],
  ['האזינו', "Ha'azinu", 5, '32:1 32:7 32:13 32:19 32:29 32:40 32:44 32:48'],
  ['וזאת הברכה', 'Vezot Haberakhah', 5, '33:1 33:8 33:13 33:18 33:22 33:27 34:1'],
];

const ref = (s) => {
  const [chapter, verse] = s.split(':').map(Number);
  return { chapter, verse };
};

/** Compare two { chapter, verse } coordinates. */
function cmpRef(a, b) {
  return a.chapter - b.chapter || a.verse - b.verse;
}

/** The verse before a coordinate inside its book (null before 1:1). */
function prevVerse(book, r) {
  if (r.verse > 1) return { chapter: r.chapter, verse: r.verse - 1 };
  if (r.chapter <= 1) return null;
  return { chapter: r.chapter - 1, verse: CHAPTER_VERSES[book][r.chapter - 2] };
}

function lastVerse(book) {
  const v = CHAPTER_VERSES[book];
  return { chapter: v.length, verse: v[v.length - 1] };
}

/**
 * @type {{ index: number, num: number, name: string, title: string, en: string, book: string,
 *          bookIndex: number, start: {chapter:number,verse:number}, end: {chapter:number,verse:number},
 *          aliyot: { index: number, name: string, start: {chapter:number,verse:number} }[],
 *          maftir: { index: number, name: string, start: {chapter:number,verse:number} } | null }[]}
 */
const PARSHIOT = DATA.map(([name, en, bookNo, starts], index) => {
  const book = CHUMASH_BOOKS[bookNo - 1];
  const refs = starts.split(' ').map(ref);
  const all = refs.map((start, i) => ({ index: i, name: ALIYAH_NAMES[i], start }));
  return { index, num: index + 1, name, title: `פרשת ${name}`, en, book, bookIndex: bookNo - 1, start: refs[0], end: null, aliyot: all.slice(0, 7), maftir: all[7] || null };
});
// A parsha ends where the next one in its book starts (or at the end of the book).
PARSHIOT.forEach((p, i) => {
  const next = PARSHIOT[i + 1];
  p.end = next && next.book === p.book ? prevVerse(p.book, next.start) : lastVerse(p.book);
});

/** Aliyot + maftir of a parsha, in reading order (7 or 8 entries). */
function readingsOf(parsha) {
  return parsha.maftir ? [...parsha.aliyot, parsha.maftir] : parsha.aliyot.slice();
}

/** Parshiot of one Chumash book, in order. */
function parshiotOfBook(book) {
  return PARSHIOT.filter((p) => p.book === book);
}

/** By hebcal's 1-based parsha number (Sedra.lookup().num). */
function parshaByNumber(num) {
  return PARSHIOT[num - 1] || null;
}

/** By hebcal's English name ("Vayishlach") or the Hebrew name ("וישלח" / "פרשת וישלח"). */
function findParsha(name) {
  const n = String(name || '').replace(/^פרשת\s+/, '').trim();
  return PARSHIOT.find((p) => p.en === n || p.name === n) || null;
}

/** The parsha containing a verse of a Chumash book (null outside the book's range). */
function parshaAt(book, r) {
  const list = parshiotOfBook(book);
  let pick = null;
  for (const p of list) {
    if (cmpRef(p.start, r) <= 0) pick = p;
    else break;
  }
  return pick && cmpRef(r, pick.end) <= 0 ? pick : null;
}

/**
 * The Chumash book a library book is, or null: the title must be exactly one of the five books
 * and the folder must be Tanach / Torah (so "רשי על בראשית" or a Midrash named "בראשית" is not).
 */
function chumashBookOf(title, categoryPath) {
  const t = String(title || '').trim();
  if (!CHUMASH_BOOKS.includes(t)) return null;
  const cat = String(categoryPath || '');
  if (!cat) return t;
  return /(^|\/)(תנ"?ך|תורה|חומש|מקרא)(\/|$)/.test(cat) && !/מפרשים|תרגום/.test(cat) ? t : null;
}

/**
 * Divider points of a Chumash book, one per verse that starts a parsha or an aliyah:
 * { chapter, verse, parsha: 'פרשת וישלח' | null, aliyot: ['שביעי', 'מפטיר'] }. A parsha's
 * ראשון is implied by its parsha divider and not repeated.
 */
function bookDividers(book) {
  const map = new Map();
  const at = (r) => {
    const key = `${r.chapter}:${r.verse}`;
    if (!map.has(key)) map.set(key, { chapter: r.chapter, verse: r.verse, parsha: null, parshaIndex: null, aliyot: [] });
    return map.get(key);
  };
  for (const p of parshiotOfBook(book)) {
    const d = at(p.start);
    d.parsha = p.title;
    d.parshaIndex = p.index;
    for (const a of readingsOf(p)) if (a.index > 0) at(a.start).aliyot.push(a.name);
  }
  return [...map.values()].sort(cmpRef);
}

/** "לב, יד" for a coordinate. */
function refLabel(r) {
  return `${intToHebrew(r.chapter)}, ${intToHebrew(r.verse)}`;
}

/** 'בראשית ל"ב י"ד' for a coordinate (printed numerals). */
function fullRefLabel(book, r) {
  return `${book} ${formatHebrewNumeral(r.chapter)} ${formatHebrewNumeral(r.verse)}`;
}

/** 'בראשית ל״ב:י״ד' (printed gershayim / geresh, chapter:verse) for Quick Jump cards. */
function printedRef(book, r) {
  const f = (n) => formatHebrewNumeral(n).replace(/"/g, '״').replace(/'/g, '׳');
  return `${book} ${f(r.chapter)}:${f(r.verse)}`;
}

// --- typed parsha / aliyah references (Quick Jump) -------------------------------------------

/**
 * Other spellings / short forms users type for a parsha (matched after normalizeHebrew, so niqqud,
 * gershayim, hyphens and final letters never matter). A doubled week's name ("ויקהל פקודי") opens
 * its first parsha.
 */
const PARSHA_VARIANTS = {
  נח: ['נוח'],
  'חיי שרה': ['חיי'],
  תולדות: ['תולדת'],
  תצוה: ['תצווה'],
  'כי תשא': ['כי תישא', 'תשא', 'תישא'],
  ויקהל: ['ויקהל פקודי'],
  תזריע: ['תזריע מצורע'],
  מצורע: ['מצרע'],
  'אחרי מות': ['אחרי', 'אחרי מות קדושים', 'אחרי קדושים'],
  קדושים: ['קדשים'],
  אמור: ['אמר'],
  בהר: ['בהר סיני', 'בהר בחוקותי', 'בהר בחקתי'],
  בחוקותי: ['בחקתי', 'בחוקתי', 'בחקותי'],
  במדבר: ['במדבר סיני'],
  נשא: ['נשוא'],
  בהעלותך: ['בהעלתך'],
  שלח: ['שלח לך'],
  קרח: ['קורח'],
  חקת: ['חוקת', 'חקת בלק', 'חוקת בלק'],
  פינחס: ['פנחס'],
  מטות: ['מטות מסעי', 'מטת'],
  שופטים: ['שפטים'],
  'כי תצא': ['תצא', 'כי תיצא'],
  'כי תבוא': ['כי תבא', 'תבוא', 'תבא'],
  נצבים: ['ניצבים', 'נצבים וילך', 'ניצבים וילך'],
  האזינו: ['האזנו'],
  'וזאת הברכה': ['זאת הברכה', 'וזאת', 'הברכה'],
};

const qnorm = (s) => normalizeHebrew(s, { keepAmud: true, keepPunctuation: false });

let nameIndex = null;
/** normalized name -> parsha; and the longest name length in tokens. */
function parshaNameIndex() {
  if (nameIndex) return nameIndex;
  const map = new Map();
  for (const p of PARSHIOT) {
    for (const n of [p.name, ...(PARSHA_VARIANTS[p.name] || [])]) {
      const k = qnorm(n);
      if (!map.has(k)) map.set(k, p);
    }
  }
  let max = 1;
  for (const k of map.keys()) max = Math.max(max, k.split(' ').length);
  nameIndex = { map, max };
  return nameIndex;
}

/** Leading words naming a parsha ("פרשת וישלח"). */
const PARSHA_PREFIX = new Set(['פרשת', 'פרשה', 'פרש'].map(qnorm));
/** Words before an aliyah ("עלייה חמישית"). */
const ALIYAH_PREFIX = new Set(['עליה', 'עלייה', 'עלית', 'בעליה', 'בעלייה'].map(qnorm));
/** Aliyah ordinals as words (masculine / feminine / common spellings) -> reading index (7 = מפטיר). */
const ALIYAH_WORDS = new Map(
  [
    [0, ['ראשון', 'ראשונה', 'ראשונ']],
    [1, ['שני', 'שניה', 'שנייה']],
    [2, ['שלישי', 'שלישית']],
    [3, ['רביעי', 'רביעית']],
    [4, ['חמישי', 'חמישית', 'חמשי']],
    [5, ['שישי', 'ששי', 'שישית', 'ששית']],
    [6, ['שביעי', 'שביעית']],
    [7, ['מפטיר', 'מפטירה', 'למפטיר']],
  ].flatMap(([i, words]) => words.map((w) => [qnorm(w), i])),
);

/**
 * A typed reference to a parsha / aliyah ("וישלח", "פרשת וישלח שני", "וישלח ב", "וישלח 2",
 * "תצוה עלייה חמישית", "בראשית מפטיר"), or null.
 *   { parsha, readingIndex (0 = ראשון ... 7 = מפטיר), explicit, strong }
 * The five Chumash book names are parsha names too; they stay book references unless the query
 * says otherwise: "בראשית א" / "בראשית לב יד" -> null (chapter / verse lookup), "בראשית" alone ->
 * weak (the book first, the parsha as an extra suggestion), "פרשת בראשית", "בראשית שני",
 * "בראשית מפטיר" -> strong. Every other parsha name is strong.
 * @param {string | string[]} input  the query, or its normalized tokens
 */
function parseParshaQuery(input) {
  const tokens = Array.isArray(input) ? input.slice() : qnorm(input).split(' ').filter(Boolean);
  if (!tokens.length) return null;
  let i = 0;
  const explicit = PARSHA_PREFIX.has(tokens[0]);
  if (explicit) i = 1;
  if (i >= tokens.length) return null;
  const { map, max } = parshaNameIndex();
  let parsha = null;
  let used = 0;
  for (let n = Math.min(max, tokens.length - i); n >= 1 && !parsha; n--) {
    const hit = map.get(tokens.slice(i, i + n).join(' '));
    if (hit) {
      parsha = hit;
      used = n;
    }
  }
  if (!parsha) return null;
  let rest = tokens.slice(i + used);
  let aliyahPrefix = false;
  if (rest.length && ALIYAH_PREFIX.has(rest[0])) {
    aliyahPrefix = true;
    rest = rest.slice(1);
  }
  let readingIndex = 0;
  let wordOrdinal = false;
  if (rest.length > 1) return null;
  if (rest.length === 1) {
    const t = rest[0];
    if (ALIYAH_WORDS.has(t)) {
      readingIndex = ALIYAH_WORDS.get(t);
      wordOrdinal = true;
    } else if (/^[1-8]$/.test(t)) readingIndex = Number(t) - 1;
    else if (/^[א-ח]$/.test(t)) readingIndex = hebrewNumeralToInt(t) - 1;
    else return null;
  } else if (aliyahPrefix) return null;
  const reading = readingsOf(parsha)[readingIndex];
  if (!reading || (readingIndex === 7 && !parsha.maftir)) return null;
  const bookName = CHUMASH_BOOKS.includes(parsha.name);
  const given = rest.length === 1;
  if (bookName && !explicit && !aliyahPrefix && given && !wordOrdinal) return null; // "בראשית א": chapter א
  const strong = explicit || !bookName || wordOrdinal || aliyahPrefix;
  return { parsha, readingIndex, reading, explicit, strong };
}

// --- library resolution ----------------------------------------------------------------------

const VERSE_RE = /^\s*[([]\s*([א-ת]{1,4})\s*[)\]]/;

/**
 * Line of every verse of a Chumash book in the library: Map("chapter:verse" -> line_index).
 * Chapters come from the book's "פרק X" TOC headings; verses from "(א) ..." markers inside each
 * chapter, or (an unmarked chapter, one verse per line as Otzaria writes Tanach) the n-th content
 * line. Two indexed queries (+1 per unmarked chapter); a whole Chumash is ~1,500 short rows.
 */
async function chumashVerseLines(db, bookId) {
  const a = adapterForBook(db, bookId);
  const [nodes, total] = await Promise.all([
    a.all('SELECT title, ref_key, level, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [bookId]),
    a.all('SELECT total_lines FROM books WHERE id = ?', [bookId]),
  ]);
  const totalLines = (total[0] && total[0].total_lines) || 0;
  const chapters = [];
  for (const n of nodes) {
    if (!/^\s*פרק(\s|$)/.test(n.title)) continue;
    const num = hebrewNumeralToInt(n.ref_key || String(n.title).replace(/^\s*פרק\s*/, ''));
    if (num) chapters.push({ num, start: n.start_line });
  }
  chapters.forEach((c, i) => (c.end = i + 1 < chapters.length ? chapters[i + 1].start - 1 : totalLines));
  const out = new Map();
  if (!chapters.length) return out;
  const marked = await a.all(
    `SELECT line_index, substr(clean_text, 1, 12) AS head FROM paragraphs
      WHERE book_id = ? AND is_heading = 0 AND (clean_text LIKE '(%' OR clean_text LIKE '[%')
      ORDER BY line_index`,
    [bookId],
  );
  let ci = 0;
  const seen = new Set();
  for (const r of marked) {
    while (ci < chapters.length && r.line_index > chapters[ci].end) ci++;
    const ch = chapters[ci];
    if (!ch || r.line_index <= ch.start) continue;
    const m = VERSE_RE.exec(r.head);
    const verse = m ? hebrewNumeralToInt(m[1]) : null;
    if (!verse) continue;
    const key = `${ch.num}:${verse}`;
    if (!out.has(key)) out.set(key, r.line_index);
    seen.add(ch.num);
  }
  for (const ch of chapters) {
    if (seen.has(ch.num)) continue;
    const lines = await a.all('SELECT line_index FROM paragraphs WHERE book_id = ? AND line_index > ? AND line_index <= ? AND is_heading = 0 ORDER BY line_index', [bookId, ch.start, ch.end]);
    lines.forEach((l, i) => out.set(`${ch.num}:${i + 1}`, l.line_index));
  }
  return out;
}

/** Line of a verse, from chumashVerseLines(); null when the book lacks it. */
function lineOfVerse(verseLines, r) {
  const l = verseLines.get(`${r.chapter}:${r.verse}`);
  return l == null ? null : l;
}

/**
 * Inline dividers for a Chumash book in the library: Map(line_index -> { parsha, aliyot, ... }).
 * Points whose verse is not in the book (a partial book) are skipped.
 */
function dividerLines(book, verseLines) {
  const out = new Map();
  for (const d of bookDividers(book)) {
    const line = lineOfVerse(verseLines, d);
    if (line != null) out.set(line, { ...d, line });
  }
  return out;
}

/**
 * Parshiot of a book with the resolved lines of the parsha and each aliyah (line null = not in
 * the library book), for the TOC's פרשות mode.
 */
function parshiotWithLines(book, verseLines) {
  return parshiotOfBook(book).map((p) => ({
    ...p,
    line: lineOfVerse(verseLines, p.start),
    readings: readingsOf(p).map((a) => ({ ...a, line: lineOfVerse(verseLines, a.start), label: refLabel(a.start) })),
  }));
}

/** The parsha (of the resolved list) that contains a line: the last one starting at or before it. */
function parshaForLine(resolved, line) {
  let pick = null;
  for (const p of resolved) {
    if (p.line != null && p.line <= line) pick = p;
    else if (p.line != null && p.line > line) break;
  }
  return pick;
}

module.exports = {
  CHUMASH_BOOKS,
  ALIYAH_NAMES,
  CHAPTER_VERSES,
  PARSHIOT,
  cmpRef,
  readingsOf,
  parshiotOfBook,
  parshaByNumber,
  findParsha,
  parshaAt,
  chumashBookOf,
  bookDividers,
  refLabel,
  fullRefLabel,
  printedRef,
  PARSHA_VARIANTS,
  parseParshaQuery,
  chumashVerseLines,
  lineOfVerse,
  dividerLines,
  parshiotWithLines,
  parshaForLine,
};
