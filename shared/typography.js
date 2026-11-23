/**
 * Reading typography rules shared by the app and scripts/selftest.js:
 *  - reader font keys (Taamey Frank CLM is the default: its GPOS mark / mkmk tables anchor
 *    niqqud and te'amim without collisions), themes, and the line-height slider range
 *  - vocalization-aware line height: marks above and below the letters need extra leading so
 *    stacked te'amim (רביעי, זרקא, אתנחתא, תביר...) never touch the neighbouring lines
 *  - leading verse / seif numbers "(א)" split off the text for the margin column
 *  - sanitizing / migrating the persisted appearance settings
 */
'use strict';

const RLM = '‏';

/** Reader font keys, in picker order. */
const FONT_KEYS = ['taameyFrank', 'frankRuhl', 'david', 'assistant', 'heebo', 'system'];
const DEFAULT_FONT = 'taameyFrank';

const THEMES = ['light', 'sepia', 'dark'];
const DEFAULT_THEME = 'light';

const FONT_SIZE = { min: 14, max: 36, step: 1, default: 20 };
/**
 * The slider sets the leading of plain text (multiplier of the font size); visible marks add
 * VOCALIZATION_LEADING on top of it.
 */
const LINE_HEIGHT = { min: 1.2, max: 2.4, step: 0.05, default: 1.55 };
/** Extra leading: niqqud alone -> 1.75x by default; niqqud + te'amim -> 1.85x. */
const VOCALIZATION_LEADING = { nikkud: 0.2, cantillation: 0.3 };
const MAX_EFFECTIVE_LINE_HEIGHT = 2.7;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

/** Which marks are on screen: te'amim are never shown without niqqud. */
function visibleMarks(opts) {
  const nikkud = !opts || opts.showNikkud !== false;
  const cantillation = nikkud && (!opts || opts.showCantillation !== false);
  return { nikkud, cantillation };
}

/** Effective line-height multiplier for the slider value `base` and the visible marks. */
function lineHeightMultiplier(base, opts) {
  const b = Number.isFinite(base) ? clamp(base, LINE_HEIGHT.min, LINE_HEIGHT.max) : LINE_HEIGHT.default;
  const m = visibleMarks(opts);
  const extra = m.cantillation ? VOCALIZATION_LEADING.cantillation : m.nikkud ? VOCALIZATION_LEADING.nikkud : 0;
  return round2(Math.min(MAX_EFFECTIVE_LINE_HEIGHT, b + extra));
}

/** Line height in px (rounded up, so the marks always fit inside the line box). */
function lineHeightPx(fontSize, base, opts) {
  return Math.ceil(fontSize * lineHeightMultiplier(base, opts));
}

// --- verse numbers -------------------------------------------------------------

/** Hebrew numeral letters (no final forms: "(שם)" / "(ען)" are words, not numbers). */
const NUMERAL_VALUE = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };
const VERSE_RE = /^\s*\(([א-ת]{1,4})\)\s*/;

const LETTERS_BY_VALUE = Object.entries(NUMERAL_VALUE).sort((a, b) => b[1] - a[1]);

/** Canonical Hebrew numeral for 1..1999 (157 -> "קנז", 15 -> "טו", 16 -> "טז"). */
function toHebrewNumeral(n) {
  let rest = n;
  let out = '';
  while (rest >= 400) {
    out += 'ת';
    rest -= 400;
  }
  for (const [ch, v] of LETTERS_BY_VALUE) {
    if (v >= 400) continue;
    if (rest === 15 || rest === 16) return out + (rest === 15 ? 'טו' : 'טז');
    if (rest >= v) {
      out += ch;
      rest -= v;
    }
  }
  return out;
}

/** Value of a Hebrew numeral in its standard spelling ("קנז" -> 157), else 0 ("בא", "שם"). */
function hebrewNumeralValue(s) {
  let total = 0;
  for (const ch of s) {
    const v = NUMERAL_VALUE[ch];
    if (!v) return 0;
    total += v;
  }
  if (!total) return 0;
  const canonical = toHebrewNumeral(total);
  // Traditional spellings that avoid a word: ער (270), שדמ (344), רחצ (298).
  return s === canonical || s === canonical.replace('רע', 'ער').replace('שמד', 'שדמ').replace('רצח', 'רחצ') ? total : 0;
}

/**
 * Split a leading verse / seif number ("(א) בְּרֵאשִׁית...") off prepared display text so the
 * reader can set it in the margin. Returns { marker, text }; marker is null when there is none.
 */
function splitVerseMarker(prepared) {
  const src = String(prepared || '');
  const s = src[0] === RLM ? src.slice(1) : src;
  const m = VERSE_RE.exec(s);
  if (!m || !hebrewNumeralValue(m[1]) || m[0].length >= s.length) return { marker: null, text: src };
  let text = s.slice(m[0].length);
  if (/[()[\]\d]/.test(text)) text = RLM + text;
  return { marker: m[1], text };
}

/** Width of the verse-number margin for the reader font size. */
function verseGutterWidth(fontSize) {
  return Math.round(fontSize * 1.45);
}

// --- persisted settings -------------------------------------------------------------

/** Version of the persisted appearance settings (zustand `persist`). */
const APPEARANCE_VERSION = 3;
/** Slider default before v3 (it then covered vocalized text too). */
const LEGACY_LINE_HEIGHT_DEFAULT = 1.7;

/** Repair an appearance object read from storage (unknown keys / out-of-range numbers). */
function sanitizeAppearance(p) {
  const out = { ...(p || {}) };
  if (!FONT_KEYS.includes(out.fontFamily)) out.fontFamily = DEFAULT_FONT;
  if (!THEMES.includes(out.theme)) out.theme = DEFAULT_THEME;
  out.fontSize = Number.isFinite(out.fontSize) ? clamp(Math.round(out.fontSize), FONT_SIZE.min, FONT_SIZE.max) : FONT_SIZE.default;
  out.lineHeight = Number.isFinite(out.lineHeight) ? clamp(round2(out.lineHeight), LINE_HEIGHT.min, LINE_HEIGHT.max) : LINE_HEIGHT.default;
  if (typeof out.showNikkud !== 'boolean') out.showNikkud = true;
  if (typeof out.showCantillation !== 'boolean') out.showCantillation = true;
  return out;
}

/**
 * Upgrade persisted appearance settings saved by an older app version:
 *  v1 -> v2: showNiqqud -> showNikkud
 *  v2 -> v3: the untouched old defaults (Frank Ruhl Libre, 1.7 leading) move to Taamey Frank CLM
 *            and the plain-text 1.55 leading (marks now add their own room); the slider value
 *            otherwise drops by the te'amim leading so vocalized text keeps its spacing.
 */
function migrateAppearance(persisted, version) {
  const p = { ...(persisted || {}) };
  const v = Number.isFinite(version) ? version : 0;
  if (v < 2 && typeof p.showNiqqud === 'boolean' && p.showNikkud === undefined) p.showNikkud = p.showNiqqud;
  delete p.showNiqqud;
  if (v < 3) {
    if (p.fontFamily === 'frankRuhl' || p.fontFamily === undefined) p.fontFamily = DEFAULT_FONT;
    if (typeof p.lineHeight === 'number') {
      p.lineHeight =
        Math.abs(p.lineHeight - LEGACY_LINE_HEIGHT_DEFAULT) < 0.001 ? LINE_HEIGHT.default : round2(p.lineHeight - VOCALIZATION_LEADING.cantillation);
    }
  }
  // Keep unrelated persisted fields (commentary drawer prefs) as they are.
  return { ...p, ...sanitizeAppearance(p) };
}

module.exports = {
  FONT_KEYS,
  DEFAULT_FONT,
  THEMES,
  DEFAULT_THEME,
  FONT_SIZE,
  LINE_HEIGHT,
  VOCALIZATION_LEADING,
  MAX_EFFECTIVE_LINE_HEIGHT,
  APPEARANCE_VERSION,
  visibleMarks,
  lineHeightMultiplier,
  lineHeightPx,
  hebrewNumeralValue,
  toHebrewNumeral,
  splitVerseMarker,
  verseGutterWidth,
  sanitizeAppearance,
  migrateAppearance,
};
