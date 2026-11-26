/**
 * Tosefta editions (pure JS). Otzaria carries two separate editions of the Tosefta:
 *   תוספתא/מהדורת ליברמן/<סדר>/תוספתא ברכות (ליברמן)   (the critical edition, the DEFAULT)
 *   תוספתא/דפוס וילנא/<סדר>/תוספתא ברכות                (the printed Vilna edition)
 * They are different books (never merged); wherever a Tosefta is listed, resolved or linked and an edition
 * has to be picked first, Lieberman wins and the other edition is the fallback (a tractate without a
 * Lieberman edition simply resolves to the one that exists).
 */

const norm = (s) => String(s || '').replace(/[֑-ׇ"'״׳]/g, '').replace(/\s+/g, ' ').trim();

/** Lower rank = earlier / default. */
const LIEBERMAN_RANK = 0;
const OTHER_EDITION_RANK = 1;

/** True when the folder name / title names Lieberman's edition ("מהדורת ליברמן", "(ליברמן)"). */
const isLiebermanText = (s) => norm(s).includes('ליברמן');

const titleOf = (b) => (b && (b.title != null ? b.title : b.bookTitle)) || '';

/**
 * A base Tosefta book (not one of the Lieberman-edition commentaries under `מפרשים`).
 * `book`: { title | bookTitle, categoryPath }.
 */
function isToseftaBook(book) {
  const dirs = String((book && book.categoryPath) || '').split('/').map(norm).filter(Boolean);
  const title = norm(titleOf(book));
  if (dirs[0] !== 'תוספתא' || dirs.includes('מפרשים')) return false;
  return /^תוספתא (?!כפשוטה)/.test(title) && !/ על /.test(title);
}

/** 0 for Lieberman's edition, 1 for any other edition. */
function editionRank(book) {
  if (!isToseftaBook(book)) return OTHER_EDITION_RANK;
  return isLiebermanText(book.categoryPath) || isLiebermanText(titleOf(book)) ? LIEBERMAN_RANK : OTHER_EDITION_RANK;
}

/** Comparator: Lieberman first (Tosefta books only; everything else compares equal). */
function compareEditions(a, b) {
  return isToseftaBook(a) && isToseftaBook(b) ? editionRank(a) - editionRank(b) : 0;
}

module.exports = { LIEBERMAN_RANK, OTHER_EDITION_RANK, isLiebermanText, isToseftaBook, editionRank, compareEditions };
