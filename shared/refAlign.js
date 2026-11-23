/**
 * Otzaria Reference-Alignment: heading-based commentary <-> base-book unit links.
 *
 * In Otzaria a base book and its commentaries share parallel heading trees
 * (Book > פרק / דף / סימן > פסוק / עמוד / סעיף). All commentary paragraphs
 * (דיבורים המתחילים) under e.g. "פרק א" > "פסוק א" belong to that verse. This module
 *
 *  1. turns every heading into canonical unit labels ("סימן שכח", "דף ב" + "עמוד א")
 *     and every TOC node into a canonical reference path (ref_key "פרק א|פסוק א");
 *  2. pairs commentary books with their base book (Otzaria naming: "<מפרש> על <ספר>",
 *     plus well-known standalone commentaries such as משנה ברורה -> אורח חיים);
 *  3. aligns each commentary unit with the base unit of the same ref_key and stores
 *     the pair of line ranges in `ref_links` (shared/indexer.js schema v4);
 *     a base book without verse headings (Tanach: one verse per line, or "(א)" markers)
 *     gets its verse resolved inside the matching chapter.
 *
 * Shared by scripts/build-db.js and the on-device indexer (links phase), so it is
 * idempotent per commentary book (delete + insert in one transaction) and can stop
 * between books (pause / resume re-runs the phase).
 */
'use strict';

const { normalizeHebrew, extractRefKey, aliasKey, decodeEntities, stripHtml, stripNiqqud, intToHebrew, hebrewNumeralToInt } = require('./hebrew');

const plainHeadingText = (html) => decodeEntities(stripHtml(String(html || ''))).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// 1. Canonical unit labels and reference paths
// ---------------------------------------------------------------------------

/** Structural words (normalized: finals folded) -> canonical unit type. */
const UNIT_TYPES = new Map(
  Object.entries({
    פרק: 'פרק', פרקים: 'פרק', פ: 'פרק',
    פסוק: 'פסוק', פסוקים: 'פסוק',
    דף: 'דף', דפים: 'דף',
    עמוד: 'עמוד', עמ: 'עמוד',
    סימן: 'סימן', סי: 'סימן', סימנים: 'סימן',
    סעיף: 'סעיף', סע: 'סעיף', סעיפים: 'סעיף',
    // משנה ברורה / ש"ך numbering is not the Shulchan Aruch's seifim: its own unit kind.
    'סעיף קטן': 'סעיף קטן', סק: 'סעיף קטן',
    משנה: 'משנה', משניות: 'משנה',
    הלכה: 'הלכה', הל: 'הלכה',
    // Bavli commentaries (Otzaria): "שורה ה" under a daf / amud = the 5th paragraph of that amud.
    שורה: 'שורה', שורות: 'שורה', פסקה: 'שורה', פיסקה: 'שורה', פסקא: 'שורה', פיסקא: 'שורה',
    אות: 'אות', כלל: 'כלל', מאמר: 'מאמר', שער: 'שער', פרשה: 'פרשה', פרשת: 'פרשה', מזמור: 'מזמור',
  }).map(([k, v]) => [normalizeHebrew(k, { keepPunctuation: false }), v]),
);

/** Leaf types that may be resolved inside a base unit with no such headings. */
const INLINE_TYPES = new Set(['פסוק', 'סעיף', 'אות', 'משנה', 'הלכה', '']);

/** Hebrew numeral / amud-marked numeral ("כה", "ב.", "ב:"). */
const NUMERAL_RE = /^[א-ת]{1,4}[.:]?$/;

/**
 * Canonical labels of one heading (0, 1 or 2 labels):
 *   "סימן שכ\"ח"        -> [{ type: 'סימן', key: 'שכח' }]
 *   "דף ב."  / "דף ב ע\"א" -> [{ type: 'דף', key: 'ב' }, { type: 'עמוד', key: 'א' }]
 *   "פרק א - בריאת העולם" -> [{ type: 'פרק', key: 'א' }]
 *   "הקדמה"             -> [{ type: '', key: 'הקדמה' }]
 *   ""                  -> []
 */
/**
 * Daf + amud spellings that carry the amud letter after a comma / dash / "ע" marker ("דף ב, א",
 * "דף ב - עמוד ב", "דף ב ע א", "דף ב עמוד א.", bare "ע\"ב") -> the canonical "דף ב עמוד א" (the
 * punctuation-based forms "דף ב." / "דף ב:" and "דף ב ע\"א" are handled below).
 */
const DAF_AMUD_RE = /^דף\s+([א-ת]{1,3}(?:["״'׳][א-ת])?)['׳]?(?:\s*[,\-–—]\s*|\s+)(?:(?:עמוד|עמ|ע)['׳.]?\s*)?["״]?([אב])['׳]?\s*[.:]?$/;
function canonicalDafAmud(plain) {
  const bare = /^ע["״]([אב])$/.exec(plain);
  if (bare) return `עמוד ${bare[1]}`;
  const m = DAF_AMUD_RE.exec(plain);
  return m ? `דף ${m[1]} עמוד ${m[2]}` : plain;
}

function unitLabels(title) {
  const plain = canonicalDafAmud(plainHeadingText(title));
  if (!plain) return [];
  const head = plain.split(/\s[-–—]\s|[,;(]/)[0];
  const tokens = normalizeHebrew(head, { keepAmud: true, keepPunctuation: false }).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  let type = undefined;
  let key;
  if (tokens.length > 2 && UNIT_TYPES.has(tokens.slice(0, 2).join(' '))) {
    // Two-word unit names ("סעיף קטן ג").
    type = UNIT_TYPES.get(tokens.slice(0, 2).join(' '));
    key = tokens.slice(2).join(' ');
  } else {
    type = UNIT_TYPES.get(tokens[0].replace(/[.:]$/, ''));
    key = extractRefKey(head);
    // Unit words extractRefKey does not know ("כלל א", "מזמור ג"): drop the word itself.
    if (type && tokens.length > 1 && key.split(' ')[0] === tokens[0]) key = tokens.slice(1).join(' ');
  }
  // "שורה טז:" / "שורה 12" / "פסקה ה" -> one canonical key per paragraph number ("טז", "יב", "ה").
  if (type === 'שורה') {
    const n = paragraphNumber(`שורה ${key}`);
    if (n != null) key = intToHebrew(n) || String(n);
  }
  const amud = /^(.+?)([.:])$/.exec(key);
  if (amud && (type === 'דף' || type === undefined) && NUMERAL_RE.test(key)) {
    return [{ type: 'דף', key: amud[1] }, { type: 'עמוד', key: amud[2] === '.' ? 'א' : 'ב' }];
  }
  if (type) return key ? [{ type, key }] : [];
  // No structural prefix: a bare numeral ("<h3>כה</h3>") or a named section ("הקדמה").
  if (tokens.length === 1 && NUMERAL_RE.test(tokens[0])) return [{ type: '', key: tokens[0] }];
  return [{ type: '', key: tokens.join(' ') }];
}

/**
 * Paragraph number of a Bavli sub-heading ("שורה ה", "שורה טו", "שורה א'", "שורה ב:", "שורה 12",
 * "פסקה ה" / "פיסקה ה"): the 1-based index of a body paragraph inside the daf / amud above it,
 * NOT a visual line. null for anything else (a longer paragraph, a non-canonical numeral).
 * Accepts the raw heading / line text (HTML, niqqud, geresh / gershayim and trailing punctuation
 * are ignored).
 */
const PARAGRAPH_MARKER_RE = /^(?:שורה|שורות|פסקה|פיסקה|פסקא|פיסקא)\s*[-–:]?\s*(\S{1,8})$/;
function paragraphNumber(text) {
  const plain = stripNiqqud(plainHeadingText(text)).replace(/[\u200E\u200F]/g, '').trim();
  const m = PARAGRAPH_MARKER_RE.exec(plain);
  if (!m) return null;
  const tok = m[1].replace(/["״'׳.:,;()[\]]/g, '');
  if (/^\d{1,3}$/.test(tok)) return Number(tok) > 0 ? Number(tok) : null;
  if (!/^[א-ת]{1,4}$/.test(tok)) return null;
  const n = hebrewNumeralToInt(tok);
  // Only canonical numerals ("טו" / "טז", never "יה"): a stray word cannot pass for a number.
  return n && intToHebrew(n) === normalizeHebrew(tok, { keepPunctuation: false }) ? n : null;
}

const labelText = (l) => (l.type ? `${l.type} ${l.key}` : l.key);

/** "פרק א|פסוק א" from labels. */
function refKeyOf(labels) {
  return labels.map(labelText).join('|');
}

/** Canonical unit type names (the values of UNIT_TYPES); two-word types first. */
const CANONICAL_TYPES = [...new Set(UNIT_TYPES.values())].sort((a, b) => b.length - a.length);

/**
 * Inverse of refKeyOf(): "פרק א|פסוק ג" -> [{ type: 'פרק', key: 'א' }, { type: 'פסוק', key: 'ג' }].
 * Unambiguous because unitLabels() only leaves a label untyped when its first word is not a unit
 * word, and every canonical type is itself a unit word. Used to read book_units back.
 */
function labelsFromRefKey(refKey) {
  if (!refKey) return [];
  return String(refKey)
    .split('|')
    .map((seg) => {
      for (const t of CANONICAL_TYPES) {
        if (seg.length > t.length + 1 && seg.startsWith(t + ' ')) return { type: t, key: seg.slice(t.length + 1) };
      }
      return { type: '', key: seg };
    });
}

/**
 * Canonical reference paths of TOC nodes (parents before children, i.e. in start_line order).
 * @param {{ id, parent_id, title }[]} nodes
 * @returns {Map<id, { labels: object[], refKey: string }>}
 */
function refPaths(nodes) {
  const out = new Map();
  for (const n of nodes) {
    const parent = n.parent_id == null ? null : out.get(n.parent_id);
    const labels = (parent ? parent.labels : []).concat(unitLabels(n.title));
    out.set(n.id, { labels, refKey: refKeyOf(labels) });
  }
  return out;
}

/**
 * Units of a book from its TOC (sorted by start_line):
 *   subtree: [start_line, line before the next heading of the same or a higher level]
 *   own:     [start_line, line before the next heading of any level] (the unit's own text)
 */
function bookUnits(nodes, totalLines) {
  const sorted = nodes.slice().sort((a, b) => a.start_line - b.start_line || a.level - b.level);
  const paths = refPaths(sorted);
  const units = [];
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    let subEnd = totalLines;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].level <= n.level) {
        subEnd = sorted[j].start_line - 1;
        break;
      }
    }
    const ownEnd = i + 1 < sorted.length ? sorted[i + 1].start_line - 1 : totalLines;
    const p = paths.get(n.id);
    if (!p.labels.length) continue;
    units.push({ id: n.id, level: n.level, title: n.title, labels: p.labels, refKey: p.refKey, start: n.start_line, end: Math.max(n.start_line, subEnd), ownEnd: Math.max(n.start_line, ownEnd) });
  }
  return units;
}

// --- base-side lookup ---------------------------------------------------------

const looseKey = (labels) => labels.map((l) => l.key).join('|');

/** Same unit kind: equal types, or one side has no structural word ("<h3>כה</h3>"). */
const typesCompatible = (a, b) => a.type === b.type || !a.type || !b.type;

/**
 * Suffix index of a base book's units. A commentary path matches the base unit with the
 * longest equal path suffix (always including the leaf), as long as that suffix is unique in
 * the base book. This tolerates extra levels on either side ("פרשת נח > פרק ו > פסוק א" vs
 * "פרק ו > פסוק א"); labels compare by key with compatible types.
 */
function makeBaseIndex(units) {
  const byKeys = new Map();
  for (const u of units) {
    for (let k = 1; k <= u.labels.length; k++) {
      const key = k + '#' + looseKey(u.labels.slice(-k));
      const cur = byKeys.get(key);
      if (!cur) byKeys.set(key, [u]);
      else cur.push(u);
    }
  }
  return {
    units,
    find(labels) {
      for (let k = labels.length; k >= 1; k--) {
        const suf = labels.slice(-k);
        const cands = (byKeys.get(k + '#' + looseKey(suf)) || []).filter((u) => u.labels.slice(-k).every((l, i) => typesCompatible(l, suf[i])));
        if (!cands.length) continue;
        // Prefer exact types; duplicate identical paths (repeated headings) take the first.
        const exact = cands.filter((u) => refKeyOf(u.labels.slice(-k)) === refKeyOf(suf));
        const pool = exact.length ? exact : cands;
        if (pool.length === 1 || (k === labels.length && pool.every((u) => u.refKey === pool[0].refKey))) return pool[0];
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Commentary <-> base book pairing
// ---------------------------------------------------------------------------

// Pairing lives in ./pairing.js (calibrated on the full Otzaria library index).
const { KNOWN_BASES, isCommentaryTitle, splitCommentaryTitle, pairCommentaries, pairCommentariesAsync, multiTargets, headingBookKey } = require('./pairing');

/**
 * Whether a commentary's inline "(א)" numbering can be the base's own units. Not for the Shulchan
 * Aruch / Tur: their commentaries (משנה ברורה, מגן אברהם, ט"ז, ש"ך ...) number seifim katanim,
 * a different sequence than the base's seifim, so those align at the siman.
 */
function sharesInlineNumbering(baseTitle) {
  return !/^(שולחנ ערוכ|שלחנ ערוכ|טור)( |$)/.test(aliasKey(baseTitle));
}

/** link_type of an aligned book: translations (אונקלוס, תרגום ...) rank after commentaries. */
function linkTypeFor(title) {
  return /אונקלוס|תרגום|targum/i.test(String(title || '')) ? 'targum' : 'commentary';
}

/**
 * Units of a corpus-wide commentary ("… על השס", "… על התורה") split per base book: a heading in
 * the top two levels that names a base book ("מסכת ברכות", "בראשית", "הלכות שבת") starts that
 * book's section; its descendants are re-rooted below it ("ברכות|דף ב|עמוד א" -> "דף ב|עמוד א").
 * @param {object[]} commUnits  bookUnits() of the commentary
 * @param {Map<string, number>} targets  multiTargets(): bare book key -> base book id
 * @returns {Map<number, object[]>} base book id -> re-rooted commentary units
 */
function multiUnits(commUnits, targets) {
  const out = new Map();
  const sorted = commUnits.slice().sort((a, b) => a.start - b.start || a.labels.length - b.labels.length);
  for (const head of sorted) {
    if (head.labels.length > 2) continue;
    const baseId = targets.get(headingBookKey(head.title));
    if (baseId == null) continue;
    const depth = head.labels.length;
    const list = out.get(baseId) || [];
    for (const u of sorted) {
      if (u === head || u.start < head.start || u.start > head.end || u.labels.length <= depth) continue;
      if (refKeyOf(u.labels.slice(0, depth)) !== head.refKey) continue;
      const labels = u.labels.slice(depth);
      list.push({ ...u, labels, refKey: refKeyOf(labels) });
    }
    if (list.length) out.set(baseId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Alignment
// ---------------------------------------------------------------------------

const VERSE_MARKER_RE = /^\s*[([]\s*([א-ת]{1,4})\s*[)\]]/;

/**
 * Name of the inline units ("(א) ..." lines) inside a heading, as Otzaria books use them:
 * verses in a Tanach chapter, mishnayot in a Mishnah chapter, seifim in a סימן / כלל of a
 * halacha book (ערוך השולחן העתיד, חכמת אדם), otherwise plain letters (אות).
 */
function inlineUnitWord(parentTitle, categoryPath) {
  const labels = unitLabels(parentTitle);
  const type = labels.length ? labels[labels.length - 1].type : '';
  const cat = String(categoryPath || '');
  if (type === 'פרק') return /(^|\/)משנה(\/|$)/.test(cat) ? 'משנה' : /תנ"?ך|תנך/.test(cat) || !cat ? 'פסוק' : 'הלכה';
  if (type === 'סימן' || type === 'כלל' || type === 'הלכה') return 'סעיף';
  if (type === 'מזמור') return 'פסוק';
  return 'אות';
}

/** Marker key of a content line ("(יא) ..." -> "יא"), or null. */
function markerKey(text) {
  const m = VERSE_MARKER_RE.exec(String(text || ''));
  return m ? normalizeHebrew(m[1], { keepPunctuation: false }) : null;
}

/**
 * Inline units of a base unit: "(א) ..." markers (verses, mishnayot, seifim). Without markers,
 * and only for verses (`ordinal`: Otzaria Tanach is one verse per line), the n-th content line
 * is verse n; a halacha paragraph is never taken for a seif. Returns Map<key, { start, end }>.
 */
function inlineUnits(contentLines, unit, opts) {
  const ordinal = !opts || opts.ordinal !== false;
  const lines = contentLines.filter((l) => l.line > unit.start && l.line <= unit.end);
  const out = new Map();
  const marked = lines.filter((l) => VERSE_MARKER_RE.test(l.text));
  if (marked.length) {
    for (let i = 0; i < marked.length; i++) {
      const key = normalizeHebrew(VERSE_MARKER_RE.exec(marked[i].text)[1], { keepPunctuation: false });
      const end = i + 1 < marked.length ? marked[i + 1].line - 1 : unit.end;
      if (!out.has(key)) out.set(key, { start: marked[i].line, end });
    }
    return out;
  }
  if (!ordinal) return out;
  // Otzaria Tanach: one verse per line.
  lines.forEach((l, i) => {
    const key = intToHebrew(i + 1);
    if (key) out.set(key, { start: l.line, end: l.line });
  });
  return out;
}

/**
 * Aligns one commentary book with its base book.
 * @param {object[]} baseUnits   bookUnits() of the base book
 * @param {object[]} commUnits   bookUnits() of the commentary
 * @param {number[]|Set<number>|{ line: number, text?: string }[]} commContent  non-heading lines of the
 *        commentary (with `text`, a unit whose דיבורים carry "(ב)" markers is split per seif / verse)
 * @param {(unit) => Promise<{ line, text }[]>} [baseContent]  content lines of a base unit
 *        (only loaded when a verse / seif has to be resolved inline)
 * @param {{ splitMarkers?: boolean }} [opts]  splitMarkers: false when the commentary's "(א)" numbering
 *        is its own (seif katan of the Shulchan Aruch commentaries), not the base's units
 * @returns {Promise<{ refKey, baseStart, baseEnd, commStart, commEnd }[]>}
 */
async function alignUnits(baseUnits, commUnits, commContent, baseContent, opts) {
  const splitMarkers = !opts || opts.splitMarkers !== false;
  const index = makeBaseIndex(baseUnits);
  const raw = Array.isArray(commContent) ? commContent : [...commContent];
  const content = raw.map((x) => (typeof x === 'number' ? { line: x, text: null } : x)).sort((a, b) => a.line - b.line);
  const linesIn = (from, to) => {
    let lo = 0;
    let hi = content.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (content[mid].line < from) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < content.length && content[i].line <= to; i++) out.push(content[i]);
    return out;
  };
  const inlineCache = new Map();
  const inlineOf = async (parent, leafType) => {
    const k = parent.id + ':' + (leafType === 'פסוק' || leafType === '' ? 'o' : 'm');
    let v = inlineCache.get(k);
    if (!v) {
      v = inlineUnits(baseContent ? await baseContent(parent) : [], parent, { ordinal: leafType === 'פסוק' || leafType === '' });
      inlineCache.set(k, v);
    }
    return v;
  };
  // Bavli paragraph-level alignment ("שורה N" = the N-th body paragraph of the amud, see
  // paragraphNumber): the paragraphs (line numbers) of a base daf / amud unit, loaded once each.
  const isAmudUnit = (b) => !!b && b.labels.length > 0 && ['עמוד', 'דף'].includes(b.labels[b.labels.length - 1].type);
  const paraCache = new Map();
  const paragraphsOf = async (amud) => {
    let v = paraCache.get(amud.id);
    if (!v) {
      v = baseContent ? (await baseContent(amud)).map((l) => l.line).sort((a, b) => a - b) : [];
      paraCache.set(amud.id, v);
    }
    return v;
  };
  /** { amud, paras } of the base daf / amud a commentary unit refers to, or null. */
  const amudOf = async (labels) => {
    const amud = index.find(labels);
    if (!isAmudUnit(amud)) return null;
    const paras = await paragraphsOf(amud);
    return paras.length ? { amud, paras } : null;
  };
  // N clamps to the last paragraph (noisy texts: more "שורה" numbers than base paragraphs).
  const paraLine = (paras, n) => paras[Math.min(Math.max(n, 1), paras.length) - 1];
  const leafOf = (u) => u.labels[u.labels.length - 1];
  const numberOf = (u) => {
    const leaf = leafOf(u);
    if (!leaf || leaf.type !== 'שורה' || u.labels.length < 2) return null;
    const n = paragraphNumber(u.title);
    return n != null ? n : paragraphNumber('שורה ' + leaf.key);
  };
  // daf / amud units of the commentary that have "שורה N" sub-headings.
  const withParagraphs = new Set();
  for (const u of commUnits) if (numberOf(u) != null) withParagraphs.add(refKeyOf(u.labels.slice(0, -1)));

  const out = [];
  for (const u of commUnits) {
    // Only units with their own text (the דיבורים under this heading, before any sub-heading).
    const own = u.ownEnd > u.start ? linesIn(u.start + 1, u.ownEnd) : [];
    if (!own.length) continue;

    // "שורה N" sub-heading: its entries belong to body paragraph N of the daf / amud above it.
    const lineNo = numberOf(u);
    if (lineNo != null && !index.find(u.labels)) {
      const target = await amudOf(u.labels.slice(0, -1));
      if (target) {
        const line = paraLine(target.paras, lineNo);
        out.push({ refKey: u.refKey, baseStart: line, baseEnd: line, commStart: u.start, commEnd: u.ownEnd });
        continue;
      }
    }
    // The daf / amud's own text before its first "שורה": paragraph 1 (nothing is dropped, and the
    // rest of the amud is not shown for every paragraph).
    if (withParagraphs.has(u.refKey)) {
      const target = await amudOf(u.labels);
      if (target) {
        out.push({ refKey: u.refKey, baseStart: target.paras[0], baseEnd: target.paras[0], commStart: u.start, commEnd: u.ownEnd });
        continue;
      }
    }
    // Same markers as plain paragraphs under the daf / amud (not headings): split the amud per marker.
    const marks = own.filter((l) => l.text != null && l.text.length < 12 && paragraphNumber(l.text) != null);
    if (marks.length) {
      const target = await amudOf(u.labels);
      if (target) {
        if (own[0].line < marks[0].line) {
          out.push({ refKey: u.refKey, baseStart: target.paras[0], baseEnd: target.paras[0], commStart: u.start, commEnd: marks[0].line - 1 });
        }
        for (let i = 0; i < marks.length; i++) {
          const segEnd = i + 1 < marks.length ? marks[i + 1].line - 1 : u.ownEnd;
          if (!own.some((l) => l.line > marks[i].line && l.line <= segEnd)) continue; // marker with no entries
          const n = paragraphNumber(marks[i].text);
          const line = paraLine(target.paras, n);
          out.push({ refKey: `${u.refKey}|שורה ${intToHebrew(n) || n}`, baseStart: line, baseEnd: line, commStart: marks[i].line, commEnd: segEnd });
        }
        continue;
      }
    }

    const base = index.find(u.labels);
    let range = base ? { start: base.start, end: base.end } : null;
    // No heading for the leaf in the base book: resolve the verse / seif inside the matching parent
    // ("פרק א|פסוק ג" against a chapter of "(ג) ..." lines, or one verse per line).
    const leaf = u.labels[u.labels.length - 1];
    if (!range && u.labels.length >= 2 && INLINE_TYPES.has(leaf.type) && baseContent) {
      const parent = index.find(u.labels.slice(0, -1));
      if (parent) {
        const v = (await inlineOf(parent, leaf.type)).get(leaf.key);
        if (v) range = v;
      }
    }
    // A leaf kind the base book does not have (ס"ק of משנה ברורה vs סעיפים of the Shulchan
    // Aruch, אות, דיבור ...): the unit belongs to the nearest common ancestor (the siman).
    // Verse-like leaves (INLINE_TYPES) never fall back, so a verse cannot bleed into its chapter.
    if (!range && !INLINE_TYPES.has(leaf.type)) {
      for (let k = u.labels.length - 1; k >= 1 && !range; k--) {
        const anc = index.find(u.labels.slice(0, k));
        if (anc) range = { start: anc.start, end: anc.end };
      }
    }
    if (!range) continue;

    // The commentary marks its דיבורים per seif / verse inline, like the base ("(ב) ..." under
    // "סימן א"): split the unit so each segment links to that seif / verse only.
    const markers = own.filter((l) => l.text != null && markerKey(l.text));
    if (splitMarkers && base && markers.length >= 1 && baseContent && !(base.labels.length > u.labels.length)) {
      const word = inlineUnitWord(base.title);
      // Verses may also be one per line (no markers in the base); seifim always need markers.
      const inline = await inlineOf(base, word === 'פסוק' ? 'פסוק' : 'סעיף');
      if (inline.size) {
        const firstMarked = markers[0].line;
        if (firstMarked > own[0].line) out.push({ refKey: u.refKey, baseStart: range.start, baseEnd: range.end, commStart: u.start, commEnd: firstMarked - 1 });
        for (let i = 0; i < markers.length; i++) {
          const key = markerKey(markers[i].text);
          const segEnd = i + 1 < markers.length ? markers[i + 1].line - 1 : u.ownEnd;
          const target = inline.get(key);
          if (target) out.push({ refKey: `${u.refKey}|${word} ${key}`, baseStart: target.start, baseEnd: target.end, commStart: markers[i].line, commEnd: segEnd });
          else out.push({ refKey: u.refKey, baseStart: range.start, baseEnd: range.end, commStart: markers[i].line, commEnd: segEnd });
        }
        continue;
      }
    }
    out.push({ refKey: u.refKey, baseStart: range.start, baseEnd: range.end, commStart: u.start, commEnd: u.ownEnd });
  }
  return out;
}

module.exports = {
  UNIT_TYPES,
  unitLabels,
  refKeyOf,
  labelsFromRefKey,
  refPaths,
  bookUnits,
  makeBaseIndex,
  KNOWN_BASES,
  multiTargets,
  multiUnits,
  headingBookKey,
  isCommentaryTitle,
  linkTypeFor,
  sharesInlineNumbering,
  splitCommentaryTitle,
  pairCommentaries,
  pairCommentariesAsync,
  inlineUnitWord,
  markerKey,
  paragraphNumber,
  inlineUnits,
  alignUnits,
};
