/**
 * Canonical book lists of the traditional Jewish library (pure data + one spelling-insensitive
 * lookup), shared by the Library catalog (shared/libraryCatalog.js), the canonical book-role
 * classification (shared/bookRoles.js) and the parallel-works engine (shared/parallelWorks.js).
 */
'use strict';

const { aliasKey } = require('./hebrew');
const { skeletonPhrase } = require('./hebrewTorahDict');

/** Spelling-insensitive key (final letters, gershayim, niqqud, ktiv male/chaser). */
const canon = (s) => skeletonPhrase(aliasKey(s));

const TORAH = ['בראשית', 'שמות', 'ויקרא', 'במדבר', 'דברים'];
const NEVIIM = ['יהושע', 'שופטים', 'שמואל א', 'שמואל ב', 'מלכים א', 'מלכים ב', 'ישעיהו', 'ירמיהו', 'יחזקאל', 'הושע', 'יואל', 'עמוס', 'עובדיה', 'יונה', 'מיכה', 'נחום', 'חבקוק', 'צפניה', 'חגי', 'זכריה', 'מלאכי'];
const KETUVIM = ['תהילים', 'משלי', 'איוב', 'שיר השירים', 'רות', 'איכה', 'קהלת', 'אסתר', 'דניאל', 'עזרא', 'נחמיה', 'דברי הימים א', 'דברי הימים ב'];

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

const SHULCHAN_ARUCH_PARTS = ['אורח חיים', 'יורה דעה', 'אבן העזר', 'חושן משפט'];
/** Short forms of the four parts (as printed in references). */
const SHULCHAN_ARUCH_ABBR = ['או"ח', 'יו"ד', 'אה"ע', 'חו"מ'];
const MIDRASH_RABBAH = ['בראשית רבה', 'שמות רבה', 'ויקרא רבה', 'במדבר רבה', 'דברים רבה', 'שיר השירים רבה', 'רות רבה', 'איכה רבה', 'קהלת רבה', 'קוהלת רבה', 'אסתר רבה'];

/** Plural ending ין / ים unified ("עוקצין" / "עוקצים", "מכשירין"), then the ktiv-chaser skeleton. */
const nameKey = (s) =>
  skeletonPhrase(
    aliasKey(s)
      .split(' ')
      .map((w) => (w.length > 3 ? w.replace(/ינ$/, 'ימ') : w))
      .join(' '),
  );

/**
 * Position lookup by name: exact normalized spelling first, then the ktiv-chaser skeleton (which
 * is ambiguous for some names - שביעית / שבועות - so ambiguous skeletons are dropped: those
 * names only match exactly, never each other).
 */
class NameIndex {
  constructor(list) {
    this.exact = new Map();
    this.skel = new Map();
    const ambiguous = new Set();
    list.forEach((n, i) => {
      const e = aliasKey(n);
      if (!this.exact.has(e)) this.exact.set(e, i);
      const k = nameKey(n);
      if (this.skel.has(k) && this.skel.get(k) !== i) ambiguous.add(k);
      else this.skel.set(k, i);
    });
    for (const k of ambiguous) this.skel.delete(k);
    this.ambiguous = ambiguous;
  }

  get(raw) {
    const e = this.exact.get(aliasKey(raw));
    if (e != null) return e;
    const k = nameKey(raw);
    return this.ambiguous.has(k) ? undefined : this.skel.get(k);
  }
}

const TRACTATE_INDEX = new NameIndex(MISHNA_FLAT);
const BAVLI_SET = new Set(BAVLI_TRACTATES.map((t) => TRACTATE_INDEX.get(t)));

module.exports = {
  canon,
  nameKey,
  NameIndex,
  TORAH,
  NEVIIM,
  KETUVIM,
  SEDARIM,
  MISHNA_TRACTATES,
  MISHNA_FLAT,
  BAVLI_TRACTATES,
  SHULCHAN_ARUCH_PARTS,
  SHULCHAN_ARUCH_ABBR,
  MIDRASH_RABBAH,
  TRACTATE_INDEX,
  BAVLI_SET,
};
