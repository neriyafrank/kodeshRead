/**
 * Shared Hebrew text utilities.
 *
 * Plain CommonJS so the same code runs in the Node build script
 * (scripts/build-db.js) and in the React Native app (via Metro).
 * Index-time and query-time normalization MUST stay identical, so both
 * sides import this one file. Types live in ./hebrew.d.ts.
 */
'use strict';

// Niqqud + cantillation (te'amim) + Hebrew punctuation marks.
const NIQQUD_RE = /[֑-ׇ]/g;
// Maqaf (־) and Paseq (׀) are inside the range above but separate words,
// so they become spaces instead of being deleted.
const WORD_SEPARATORS_RE = /[־׀]/g;
const GERSHAYIM_RE = /["״“”]/g;
const GERESH_RE = /['׳‘’`]/g;
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const FINALS_RE = /[ךםןףץ]/g;

const HTML_ENTITIES = {
  nbsp: ' ',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lrm: '‎',
  rlm: '‏',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const v = HTML_ENTITIES[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const BLOCK_TAG_RE = /<\/?(br|p|div|h[1-6]|li|ul|ol|tr|td|table|hr)\b[^>]*>/gi;

/** Remove tags. Block-level tags become a space; inline tags vanish so "<big>בְּ</big>רֵאשִׁית" stays one word. */
function stripHtml(text) {
  return text.replace(BLOCK_TAG_RE, ' ').replace(/<[^>]*>/g, '');
}

function stripNiqqud(text) {
  return text.replace(WORD_SEPARATORS_RE, ' ').replace(NIQQUD_RE, '');
}

function normalizeFinals(text) {
  return text.replace(FINALS_RE, (c) => FINALS[c]);
}

/**
 * Normalize Hebrew for indexing and for user queries.
 * - strips HTML tags + entities, niqqud/cantillation, gershayim and geresh
 * - normalizes final letters (ך->כ ...)
 * - collapses whitespace
 *
 * @param {string} text
 * @param {{ keepAmud?: boolean, keepPunctuation?: boolean }} [opts]
 *   keepAmud: keep `.` and `:` (Talmudic amud shorthand, e.g. "ב." / "ב:").
 *   keepPunctuation: keep all other punctuation (default true for indexing
 *   fidelity; the quick-jump parser passes false).
 */
function normalizeHebrew(text, opts) {
  if (!text) return '';
  const keepAmud = !!(opts && opts.keepAmud);
  const keepPunctuation = !opts || opts.keepPunctuation !== false;
  let t = decodeEntities(stripHtml(String(text)));
  t = stripNiqqud(t);
  t = t.replace(GERSHAYIM_RE, '').replace(GERESH_RE, '');
  t = normalizeFinals(t);
  t = t.replace(/[‎‏  ]/g, ' ');
  if (!keepPunctuation) {
    // Keep letters, digits, whitespace and (optionally) amud markers.
    t = keepAmud ? t.replace(/[^\p{L}\p{N}\s.:]/gu, ' ') : t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    if (keepAmud) {
      // Detach amud markers from the following word but keep them glued to the daf: "ב.ג" -> "ב. ג"
      t = t.replace(/([.:])(?=\S)/g, '$1 ').replace(/\s+([.:])/g, '$1');
      // Lone markers are noise.
      t = t.replace(/(^|\s)[.:]+(?=\s|$)/g, ' ');
    }
  }
  return t.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// TOC reference keys
// ---------------------------------------------------------------------------

/** Structural words stripped from headings (already normalized: no finals). */
const REF_PREFIXES = [
  'סימנ', 'סימן', 'סי', 'סעיפ', 'סעיף', 'סעיפים', 'סעיפימ', 'פרק', 'פרקימ', 'הלכה', 'הלכות', 'משנה', 'משניות',
  'דפ', 'דף', 'עמוד', 'עמ', 'פסוק', 'פסוקימ', 'פרשת', 'פרשה', 'מסכת', 'מסכתא', 'אות', 'שער', 'מאמר', 'ספר',
].map((w) => normalizeFinals(w));

const AMUD_ALEF = new Set(['א', 'עא']);
const AMUD_BET = new Set(['ב', 'עב']);

/**
 * Turn a heading title into a compact reference key.
 *   "סימן כה"         -> "כה"
 *   "סעיף ה"          -> "ה"
 *   "פרק א"           -> "א"
 *   "דף ב."           -> "ב."
 *   "דף ב עמוד א"     -> "ב."      (canonical amud alef)
 *   "דף ב ע\"ב"       -> "ב:"      (canonical amud bet)
 *   "ב:"              -> "ב:"
 *   "סימן א - דין..." -> "א"
 */
function extractRefKey(headingTitle) {
  if (!headingTitle) return '';
  let raw = decodeEntities(stripHtml(String(headingTitle)));
  // Cut descriptive suffixes: "סימן א - דין השכמה", "פרק ב, ..." , "(...)"
  raw = raw.split(/\s[-–—]\s|[,;(]/)[0];
  const isDaf = /(^|\s)(דף|עמוד)(\s|$)|ע["״']?[אב](\s|$)/.test(stripNiqqud(raw));
  let t = normalizeHebrew(raw, { keepAmud: true, keepPunctuation: false });
  let tokens = t.split(' ').filter(Boolean);
  while (tokens.length > 1 && REF_PREFIXES.includes(tokens[0].replace(/[.:]$/, ''))) tokens.shift();
  // Drop structural words that appear mid-key ("ב עמוד א" -> "ב א").
  tokens = tokens.filter((tok, i) => i === 0 || !REF_PREFIXES.includes(tok));
  if (tokens.length === 0) return '';

  // Talmudic amud forms.
  if (tokens.length === 2 && isDaf && !/[.:]$/.test(tokens[0])) {
    if (AMUD_ALEF.has(tokens[1])) return tokens[0] + '.';
    if (AMUD_BET.has(tokens[1])) return tokens[0] + ':';
  }
  if (tokens.length === 1 && /^[^.:]+[.:]$/.test(tokens[0])) return tokens[0];
  return tokens.join(' ');
}

// ---------------------------------------------------------------------------
// Book aliases
// ---------------------------------------------------------------------------

/** Well-known shorthand for series / works (normalized form, no finals). */
const KNOWN_SHORTHAND = {
  'משנה תורה': ['רמבמ', 'יד החזקה'],
  'רמבמ': ['משנה תורה'],
  'שולחנ ערוכ': ['שוע', 'שע'],
  'תלמוד בבלי': ['בבלי', 'גמרא', 'תלמוד'],
  'תלמוד ירושלמי': ['ירושלמי', 'ירוש'],
  'משנה ברורה': ['מב', 'משב'],
  'ארבעה טורימ': ['טור'],
  'טור': ['ארבעה טורימ'],
  'קיצור שולחנ ערוכ': ['קשוע', 'קיצור'],
  'תנכ': [],
  'תורה': [],
};

/** Title prefixes that carry no identifying information. */
const TITLE_PREFIXES = ['הלכות', 'מסכת', 'ספר', 'פירוש', 'פרשת'].map(normalizeFinals);

/** Category names that are too generic to be used as an alias prefix. */
const GENERIC_CATEGORIES = new Set(
  ['תנכ', 'תורה', 'נביאימ', 'כתובימ', 'הלכה', 'משנה', 'מדרש', 'קבלה', 'חסידות', 'מחשבת ישראל', 'ספרי מוסר',
    'מוסר', 'שות', 'סדר זרעימ', 'סדר מועד', 'סדר נשימ', 'סדר נזיקינ', 'סדר קדשימ', 'סדר טהרות', 'ראשונימ',
    'אחרונימ', 'מפרשימ', 'אוצריא', 'ספרימ', 'כללי', 'שונות'].map(normalizeFinals),
);

function aliasKey(s) {
  return normalizeHebrew(s, { keepPunctuation: false });
}

/**
 * Acronym variants for a multi-word phrase (Hebrew rashei teivot are irregular,
 * so several plausible forms are produced):
 *   "אורח חיים" -> "אח", "אוח"     "אבן העזר" -> "אה", "אבה", "אהע"
 *   "שולחן ערוך" -> "שע", "שוע"
 */
function acronyms(phrase) {
  const words = aliasKey(phrase).split(' ').filter(Boolean);
  if (words.length < 2) return [];
  const out = new Set();
  const first = words.map((w) => w[0]).join('');
  out.add(first);
  if (words[0].length > 1) out.add(words[0].slice(0, 2) + words.slice(1).map((w) => w[0]).join(''));
  // Definite-article words contribute two letters: "אבן העזר" -> "אהע".
  out.add(words.map((w) => (w.length > 1 && w[0] === 'ה' ? w.slice(0, 2) : w[0])).join(''));
  return [...out].filter((a) => a.length >= 2);
}

function stripTitlePrefix(title) {
  const words = title.split(' ');
  if (words.length > 1 && TITLE_PREFIXES.includes(words[0])) return words.slice(1).join(' ');
  return title;
}

/** Forms of a series name: itself + well-known shorthand, or its acronyms if it has none. */
function seriesForms(series) {
  const known = KNOWN_SHORTHAND[series];
  if (known && known.length) return [series, ...known];
  return [series, ...acronyms(series)];
}

/**
 * Generate normalized aliases for a book.
 *
 * @param {string[]|string} categoryPath  e.g. ["הלכה","שולחן ערוך"] or "הלכה/שולחן ערוך"
 * @param {string} bookTitle             e.g. "אורח חיים" or "שולחן ערוך אורח חיים"
 * @param {string[]} [extra]              manual overrides from aliases.json
 * @returns {string[]} unique normalized aliases (the normalized title is always first)
 *
 *   (["שולחן ערוך"], "אורח חיים")             -> "אורח חיימ", "אוח", "שוע אוח", "שולחנ ערוכ אורח חיימ", ...
 *   (["משנה תורה","ספר זמנים"], "הלכות שבת") -> "הלכות שבת", "רמבמ שבת", "משנה תורה הלכות שבת", ...
 */
function generateBookAliases(categoryPath, bookTitle, extra) {
  const cats = (Array.isArray(categoryPath) ? categoryPath : String(categoryPath || '').split('/'))
    .map(aliasKey)
    .filter(Boolean);
  const title = aliasKey(bookTitle);
  const out = new Set(title ? [title] : []);
  const add = (s) => {
    const k = aliasKey(s);
    if (k && k.length >= 2) out.add(k);
  };

  // 1. Detect "<series> <sub-title>": a known series (or the parent folder) that the
  //    title starts with, else the nearest known series among the ancestors, else a
  //    non-generic parent folder.
  let series = null;
  let sub = title;
  let seriesInTitle = false;
  const parent = cats[cats.length - 1];
  const prefixCandidates = Object.keys(KNOWN_SHORTHAND).concat(cats).sort((a, b) => b.length - a.length);
  for (const s of prefixCandidates) {
    if (title.startsWith(s + ' ')) {
      series = s;
      sub = title.slice(s.length + 1);
      seriesInTitle = true;
      break;
    }
  }
  if (!series) {
    for (let i = cats.length - 1; i >= 0; i--) {
      const k = KNOWN_SHORTHAND[cats[i]];
      if (k && k.length) {
        series = cats[i];
        break;
      }
    }
  }
  if (!series && parent && !GENERIC_CATEGORIES.has(parent) && parent !== title) series = parent;

  // 2. Forms of the sub-title. A prefixed title ("הלכות שבת", "מסכת ברכות") also gets its bare form.
  const bare = stripTitlePrefix(sub);
  const subForms = new Set([sub, bare]);
  for (const s of KNOWN_SHORTHAND[sub] || []) subForms.add(s);
  const subAcronyms = acronyms(bare);
  for (const a of subAcronyms) subForms.add(a);

  // 3. Standalone aliases. A bare single-word sub-title is only standalone when there
  //    is no series (so Rambam "הלכות שבת" does not claim the alias "שבת").
  if (!series) {
    for (const f of subForms) add(f);
  } else {
    if (seriesInTitle) add(sub);
    for (const a of subAcronyms) add(a); // "אוח"
  }
  for (const s of KNOWN_SHORTHAND[title] || []) add(s);

  // 4. "<series> <sub>" combinations: "שוע אוח", "רמבמ שבת", "שולחנ ערוכ אורח חיימ".
  if (series) for (const s of seriesForms(series)) for (const b of subForms) add(s + ' ' + b);

  for (const e of extra || []) add(e);
  return [...out];
}

// ---------------------------------------------------------------------------
// Display vocalization: cantillation (טעמים) and vowel points (ניקוד) separately
// ---------------------------------------------------------------------------

/** Cantillation marks (te'amim) U+0591–U+05AF. Vowels, dagesh, shin/sin dots and maqaf are kept. */
const CANTILLATION_MARKS_RE = /[\u0591-\u05AF]/g;
/**
 * Vowel points & diacritics: shva..meteg (U+05B0–U+05BD), rafe (U+05BF), shin/sin dots
 * (U+05C1–U+05C2), upper/lower dots (U+05C4–U+05C5), qamats qatan (U+05C7). Maqaf (U+05BE),
 * paseq (U+05C0), sof pasuq (U+05C3) and nun hafukha (U+05C6) are punctuation and stay.
 */
const NIKKUD_MARKS_RE = /[\u05B0-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7]/g;

function stripCantillationMarks(text) {
  return text ? String(text).replace(CANTILLATION_MARKS_RE, '') : '';
}

/** Vowel points only (cantillation untouched). */
function stripNikkudMarks(text) {
  return text ? String(text).replace(NIKKUD_MARKS_RE, '') : '';
}

/**
 * Applies the reader's display toggles. Hiding nikkud also hides cantillation (trope
 * without vowels is unreadable); hiding cantillation alone keeps clean vocalized text.
 * Accepts `showNikkud` (or the older `showNiqqud`) and `showCantillation`; both default true.
 */
function applyVocalization(text, opts) {
  const o = opts || {};
  const nikkud = o.showNikkud !== undefined ? o.showNikkud !== false : o.showNiqqud !== false;
  const cantillation = o.showCantillation !== false;
  if (!nikkud) return stripNikkudMarks(stripCantillationMarks(text));
  if (!cantillation) return stripCantillationMarks(text);
  return text == null ? '' : String(text);
}

/** Hebrew numerals (gematria) <-> integers, used for numeric fallbacks. */
const GEMATRIA = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };

function hebrewNumeralToInt(s) {
  const t = normalizeFinals(String(s).replace(/[.:"'״׳]/g, ''));
  if (!t || !/^[א-ת]+$/.test(t)) return null;
  let n = 0;
  for (const c of t) n += GEMATRIA[c] || 0;
  return n;
}

const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];

function hebrewLetters(n) {
  let v = n;
  let out = '';
  while (v >= 400) { out += 'ת'; v -= 400; }
  if (v >= 300) { out += 'ש'; v -= 300; }
  if (v >= 200) { out += 'ר'; v -= 200; }
  if (v >= 100) { out += 'ק'; v -= 100; }
  if (v === 15) return out + 'טו';
  if (v === 16) return out + 'טז';
  return out + TENS[Math.floor(v / 10)] + ONES[v % 10];
}

/** 1..499 -> plain Hebrew numeral without gershayim ("טו", "קנז"); null outside that range. */
function intToHebrew(n) {
  if (!Number.isInteger(n) || n <= 0 || n >= 500) return null;
  return hebrewLetters(n);
}

/** Hebrew numeral with gershayim / geresh, as printed (1..999): 13 -> 'י"ג', 5 -> "ה'", 787 -> 'תשפ"ז'. */
function formatHebrewNumeral(n) {
  const plain = Number.isInteger(n) && n > 0 && n < 1000 ? hebrewLetters(n) : null;
  if (!plain) return String(n);
  return plain.length === 1 ? `${plain}'` : `${plain.slice(0, -1)}"${plain.slice(-1)}`;
}

module.exports = {
  normalizeHebrew,
  normalizeFinals,
  stripNiqqud,
  stripHtml,
  decodeEntities,
  extractRefKey,
  generateBookAliases,
  acronyms,
  aliasKey,
  hebrewNumeralToInt,
  intToHebrew,
  formatHebrewNumeral,
  CANTILLATION_MARKS_RE,
  NIKKUD_MARKS_RE,
  stripCantillationMarks,
  stripNikkudMarks,
  applyVocalization,
};
