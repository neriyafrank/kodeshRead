/**
 * The two-stage cloud library (pure JS, Node built-ins + shared modules only; used by scripts/split-library.js,
 * the app and scripts/selftest.js).
 *
 *   core      "ספריית יסוד"        the foundational texts + their primary commentators (small, fast download):
 *               - Tanakh (תורה / נביאים / כתובים) + רש"י, רמב"ן, אבן עזרא, אונקלוס, מצודות
 *               - Mishnah + ברטנורא
 *               - Talmud Bavli + רש"י, תוספות
 *               - Mishneh Torah (Rambam) + Shulchan Aruch (with the Rema glosses) + משנה ברורה
 *   extended  "הרחבה לספרייה מלאה"  EVERY other book and commentator (zero overlap with core).
 *
 * Each stage is its own SQLite database with its own FTS index. Ids stay unique across them by namespace:
 * core keeps the ids of the full build, extended ids (categories, books, toc_nodes, paragraphs) are shifted by
 * EXTENDED_ID_BASE, personal books start at USER_ID_BASE (shared/sources.js routes by these ranges).
 */
'use strict';

const { aliasKey } = require('./hebrew');
const { resolveCorpusBooks } = require('./corpora');
const { pairCommentaries } = require('./pairing');

const { EXTENDED_ID_BASE } = require('./indexer');

/** Base corpora of the core library (corpora.js preset ids). The Yerushalmi is NOT part of it. */
const CORE_CORPORA = ['tanach', 'mishna', 'bavli', 'rambam', 'shulchan-aruch'];

/**
 * Primary commentators included per base corpus, matched on the WHOLE commentator name (the title before " על "), so
 * other works with the same stem (תוספות הרא"ש, פסקי תוספות, כתב יד רש"י, אבן עזרא מהדורא תניינא, חידושי רמב"ן ...) stay extended.
 */
const CORE_COMMENTATORS = {
  tanach: ['רש"י', 'רמב"ן', 'אבן עזרא', 'אונקלוס', 'תרגום אונקלוס', 'מצודת דוד', 'מצודת ציון'],
  mishna: ['ברטנורא', 'עובדיה מברטנורא', 'רבי עובדיה מברטנורא'],
  bavli: ['רש"י', 'תוספות'],
  rambam: [],
  'shulchan-aruch': ['הגהות הרמ"א', 'רמ"א', 'משנה ברורה'],
};

const key = (s) => aliasKey(String(s || '')).toLowerCase();
const commentatorOf = (title) => {
  const t = String(title || '').trim();
  const i = t.lastIndexOf(' על ');
  return i > 0 ? t.slice(0, i) : t;
};

/**
 * Which books belong to the core library.
 * @param {{ id: number, title: string, aliases?: string[], categoryPath: string }[]} books  the full library
 * @returns {{ ids: Set<number>, bases: Set<number>, commentaries: Set<number>, baseCorpusOf: Map<number, string> }}
 */
function selectCoreBooks(books) {
  const baseCorpusOf = new Map();
  for (const corpus of CORE_CORPORA) for (const id of resolveCorpusBooks(books, [corpus])) if (!baseCorpusOf.has(id)) baseCorpusOf.set(id, corpus);
  const bases = new Set(baseCorpusOf.keys());
  const byId = new Map(books.map((b) => [b.id, b]));
  const commentaries = new Set();
  const pairs = pairCommentaries(books.map((b) => ({ id: b.id, title: b.title, aliases: b.aliases, categoryPath: b.categoryPath })));
  for (const { commId, baseId } of pairs) {
    const corpus = baseCorpusOf.get(baseId);
    if (!corpus || bases.has(commId)) continue;
    const name = key(commentatorOf(byId.get(commId).title));
    if ((CORE_COMMENTATORS[corpus] || []).some((t) => name === key(t))) commentaries.add(commId);
  }
  // משנה ברורה is a standalone book of Orach Chayim in Otzaria.
  for (const b of books) if (!bases.has(b.id) && key(b.title) === key('משנה ברורה')) commentaries.add(b.id);
  return { ids: new Set([...bases, ...commentaries]), bases, commentaries, baseCorpusOf };
}

/** Id as stored in the extended database. */
const toExtendedId = (id) => id + EXTENDED_ID_BASE;
const isExtendedId = (id) => id >= EXTENDED_ID_BASE && id < 1000000000;

module.exports = { EXTENDED_ID_BASE, CORE_CORPORA, CORE_COMMENTATORS, selectCoreBooks, toExtendedId, isExtendedId };
