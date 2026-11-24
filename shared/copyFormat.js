/**
 * Copy / citation formatting of the long-press paragraph toolbar (reader + commentary drawer).
 * Pure JS (no React, no DB): shared by the app and scripts/selftest.js.
 *
 *   plainText(html)                      sanitized display HTML -> clean one-line-per-paragraph text
 *   locationOf(tocPath, bookTitle)       "בראשית א ‹ פרק ב" style path -> "פרק ב" (the book is cited separately)
 *   formatCopy(items, { citation })      items: [{ bookTitle, tocPath?, html }]
 *
 * With a citation each run of paragraphs of one book is quoted once:
 *     «טקסט הפסקה»
 *     — שם הספר, פרק א
 * several paragraphs of one book are quoted together (one per line) and cite the first and last location
 * ("— שבת, דף ב. – דף ג."); runs of different books are separated by an empty line. Without a citation the
 * paragraphs are simply the clean text, one per line.
 */
'use strict';

const { stripHtml, decodeEntities } = require('./hebrew');

const BIDI_MARKS_RE = /[‎‏‪-‮⁦-⁩]/g;

/** Clean plain text of a paragraph: no tags / entities / bidi marks, whitespace collapsed. */
function plainText(html) {
  return decodeEntities(stripHtml(String(html == null ? '' : html)))
    .replace(BIDI_MARKS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Citation location of a "a > b > c" heading path: the segments joined by ", " (empty when none). */
function locationOf(tocPath, bookTitle) {
  const segs = String(tocPath || '')
    .split(' > ')
    .map((x) => plainText(x))
    .filter((x) => x && x !== plainText(bookTitle));
  return segs.join(', ');
}

/** "— שם הספר, מיקום" (the location part only when there is one). */
function citationLine(bookTitle, location) {
  const title = plainText(bookTitle);
  return `— ${[title, location].filter(Boolean).join(', ')}`;
}

/**
 * Text to put on the clipboard.
 * @param {{ bookTitle: string, tocPath?: string|null, html: string }[]} items paragraphs in reading order
 * @param {{ citation?: boolean }} [opts]
 */
function formatCopy(items, opts) {
  const list = (items || []).map((it) => ({ ...it, text: plainText(it.html) })).filter((it) => it.text);
  if (!list.length) return '';
  if (!opts || !opts.citation) return list.map((it) => it.text).join('\n');
  const runs = [];
  for (const it of list) {
    const last = runs[runs.length - 1];
    if (last && last.bookTitle === it.bookTitle) last.items.push(it);
    else runs.push({ bookTitle: it.bookTitle, items: [it] });
  }
  return runs
    .map((run) => {
      const first = locationOf(run.items[0].tocPath, run.bookTitle);
      const end = locationOf(run.items[run.items.length - 1].tocPath, run.bookTitle);
      const where = first && end && first !== end ? `${first} – ${end}` : first || end;
      return `«${run.items.map((it) => it.text).join('\n')}»\n${citationLine(run.bookTitle, where)}`;
    })
    .join('\n\n');
}

module.exports = { plainText, locationOf, citationLine, formatCopy };
