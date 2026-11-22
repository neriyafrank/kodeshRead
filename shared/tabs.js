/**
 * Open-tab helpers shared by the tab switcher and scripts/selftest.js: location labels and an
 * abbreviation-aware quick filter (hebrewTorahDict) over book titles, folders and locations.
 */
'use strict';

const { normalizeHebrew } = require('./hebrew');
const { bookMatchScore } = require('./hebrewTorahDict');

/** "פרק א > פסוק ד" -> "פרק א › פסוק ד" (the last `max` levels). */
function tabLocation(tocPath, max) {
  if (!tocPath) return '';
  const parts = String(tocPath).split(/\s*>\s*/).filter(Boolean);
  return parts.slice(-(max || 2)).join(' › ');
}

/** Short subtitle for a tab pill: the innermost heading. */
function tabSubtitle(tocPath) {
  return tabLocation(tocPath, 1);
}

const norm = (s) => normalizeHebrew(s || '', { keepPunctuation: false });
const atWordStart = (text, q) => (' ' + text).includes(' ' + q);

/**
 * Filters open tabs. A tab matches when the query is a substring of its normalized title, folder
 * or location, or names it through an abbreviation / other spelling ("רמב\"ם שבת", "שו\"ע או\"ח",
 * "ב\"ק"). Best matches first; ties keep the given order.
 * @param {{ bookTitle: string, tocPath?: string|null }[]} tabs
 * @param {string} query
 * @param {(tab) => string|undefined} [categoryOf]  folder path of a tab's book
 */
function filterTabs(tabs, query, categoryOf) {
  const q = norm(query);
  if (!q) return tabs.slice();
  const scored = [];
  tabs.forEach((t, i) => {
    const cat = categoryOf ? categoryOf(t) || '' : '';
    const title = norm(t.bookTitle);
    let score = 0;
    if (title.startsWith(q)) score = 5;
    else if (title.includes(q)) score = 4;
    else {
      const abbr = bookMatchScore(query, t.bookTitle, cat);
      if (abbr > 0) score = 2 + abbr / 2;
      // Folders and locations match at word starts only ("רה" must not match "תורה").
      else if (atWordStart(norm(cat.replace(/\//g, ' ')), q) || atWordStart(norm(t.tocPath), q)) score = 1;
    }
    if (score > 0) scored.push({ t, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.t);
}

module.exports = { tabLocation, tabSubtitle, filterTabs };
