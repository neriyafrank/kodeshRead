/**
 * Topical divisions (הלכות ...) of Shulchan Aruch and Tur, bundled as static data (shared/halachaTopics.json, built once by
 * scripts/fetch-sa-topics.js from Sefaria's Index API; the app never calls Sefaria).
 *
 *   data:  { pending, sa: { oc, yd, eh, cm: [{ t: 'הלכות ציצית', from: 8, to: 24 }] }, tur: { ... }, turFallback: [...] }
 *
 * Used by the reader's TOC (`groupTocTree`: simanim grouped under "הלכות ציצית" headers, flat fallback when the
 * headings do not match cleanly) and by Quick Jump (`matchTopics`: "שוע ציצית" -> the section book + the topic's first siman).
 * Every function takes the topic data as an optional last argument (tests inject fixtures); with `pending` data (JSON not
 * fetched yet) everything is a no-op.
 */
'use strict';

const { normalizeHebrew, extractRefKey, hebrewNumeralToInt } = require('./hebrew');
const { intToHebrewNumeral, isHebrewNumeral } = require('./hebrewTorahDict');
const DATA = require('./halachaTopics.json');
let CURRENT = DATA;
/** e2e hook: `globalThis.__KODESHREAD_HALACHA_TOPICS__` replaces the bundled data (like the other __KODESHREAD_*__ test hooks). */
const active = () => globalThis.__KODESHREAD_HALACHA_TOPICS__ || CURRENT;
/** Test hook: swap the active topic data (null restores the bundled JSON). Returns the previous data. */
function setTopicData(d) {
  const prev = CURRENT;
  CURRENT = d || DATA;
  return prev;
}

const N = (s) => normalizeHebrew(String(s || ''), { keepPunctuation: false });
const SECTION_KEYS = ['oc', 'yd', 'eh', 'cm'];
/** Section name as it appears in a book title (normalized). */
const SECTION_NAME = { oc: N('אורח חיים'), yd: N('יורה דעה'), eh: N('אבן העזר'), cm: N('חושן משפט') };
/** Short names typed in Quick Jump ("שוע אוח ...", "טור יוד ..."). */
const SECTION_ALIASES = {
  oc: ['אורח חיים', 'אוח', 'או"ח', 'אורח'].map(N),
  yd: ['יורה דעה', 'יוד', 'יו"ד', 'יורד', 'ידע'].map(N),
  eh: ['אבן העזר', 'אהע', 'אה"ע', 'אבהע'].map(N),
  cm: ['חושן משפט', 'חומ', 'חו"מ', 'חמ'].map(N),
};
const SECTION_LABEL = { oc: 'אורח חיים', yd: 'יורה דעה', eh: 'אבן העזר', cm: 'חושן משפט' };

const hasData = (data) => ((data = data || active()), !!data) && !data.pending && SECTION_KEYS.every((k) => data.sa && data.sa[k] && data.sa[k].length) && SECTION_KEYS.every((k) => data.tur && data.tur[k] && data.tur[k].length);

/** Which section book is this? -> { kind: 'sa' | 'tur', sec: 'oc'|... | null } (Tur in one file: sec null) or null. Commentaries never match. */
function sectionOfBook(title, categoryPath) {
  const t = N(title);
  const segs = String(categoryPath || '').split('/').map(N);
  if (segs.includes(N('מפרשים')) || / על /.test(` ${t} `)) return null;
  const words = t.split(' ');
  const sectionIn = () => SECTION_KEYS.find((k) => t.includes(SECTION_NAME[k])) || null;
  if ((words[0] === N('שולחן') || words[0] === N('שלחן')) && words[1] === N('ערוך')) {
    const sec = sectionIn();
    return sec ? { kind: 'sa', sec } : null;
  }
  if (words[0] === N('טור') && (words.length === 1 || sectionIn())) return { kind: 'tur', sec: sectionIn() };
  return null;
}

// --- every book that shares the Shulchan Aruch / Tur siman numbering ---------------------------------------

/** Different siman numbering (or not siman-based): never grouped, even inside the Shulchan Aruch / Tur folders. */
const EXCLUDED = [/(^| )קיצור( |$)/, /(^| )חיי אדמ( |$)/, /(^| )חכמת אדמ( |$)/, /(^| )בנ איש חי( |$)/, /(^| )שות( |$)/, /שאלות ותשובות/, /(^| )העתיד( |$)/, /(^| )הערות על /, /(^| )פסקי רקנאטי/, /(^| )הלכות גדולות/].map((re) => re);
const EXCLUDED_DIRS = ['שות', 'שאלות ותשובות', 'תשובות', 'פסקי דין'].map(N);

/**
 * Works that follow the Shulchan Aruch / Tur simanim without living in their folders (normalized title prefix ->
 * { kind, sec }): `sec` only when the work covers a single part (a work covering several parts finds them in its headings).
 */
const KNOWN_WORKS = [
  ['משנה ברורה', 'sa', 'oc'], ['ביאור הלכה', 'sa', 'oc'], ['שער הציון', 'sa', 'oc'], ['אליה רבה', 'sa', 'oc'], ['מחצית השקל', 'sa', 'oc'],
  ['מגן אברהם', 'sa', 'oc'], ['אשל אברהם', 'sa', 'oc'], ['שערי תשובה', 'sa', 'oc'], ['שולחן ערוך הרב', 'sa', null], ['שלחן ערוך הרב', 'sa', null],
  ['ערוך השולחן', 'sa', null], ['ערוך השלחן', 'sa', null], ['כף החיים', 'sa', null], ['פסקי תשובות', 'sa', 'oc'], ['פרי חדש', 'sa', 'yd'], ['חוות דעת', 'sa', 'yd'],
  ['קצות החושן', 'sa', 'cm'], ['נתיבות המשפט', 'sa', 'cm'], ['סמע', 'sa', 'cm'], ['ספר מאירת עינים', 'sa', 'cm'], ['שך', 'sa', null], ['טז', 'sa', null], ['טורי זהב', 'sa', null],
  ['בית שמואל', 'sa', 'eh'], ['חלקת מחוקק', 'sa', 'eh'], ['באר היטב', 'sa', null], ['פתחי תשובה', 'sa', null], ['ביאור הגרא', 'sa', null], ['הגהות הרמא', 'sa', null], ['פרי מגדים', 'sa', null],
  ['בית יוסף', 'tur', null], ['דרכי משה', 'tur', null], ['בית חדש', 'tur', null], ['בח', 'tur', null], ['פרישה', 'tur', null], ['דרישה', 'tur', null], ['בנימין זאב', 'tur', null], ['הגהות ב"ח', 'tur', null],
].map(([name, kind, sec]) => [N(name), kind, sec]);

/**
 * Every book whose simanim are the Shulchan Aruch's / Tur's: the base books, their commentaries (by folder: `שולחן ערוך/מפרשים`,
 * `טור/מפרשים`, or by name: בית יוסף, ב"ח, מגן אברהם, ש"ך ...) and the standalone works that follow the same simanim (משנה ברורה,
 * ערוך השולחן, כף החיים ...). -> { kind: 'sa' | 'tur', sec: 'oc' | ... | null } or null. `sec` null = several / unknown parts:
 * the TOC's own headings decide (groupTocTree). Different numbering (קיצור שו"ע, שו"ת, חיי אדם, חכמת אדם, בן איש חי ...) is excluded.
 */
function tocSectionOfBook(title, categoryPath) {
  const t = N(title).replace(/^[‎‏]+/, '');
  const segs = String(categoryPath || '').split('/').map(N);
  if (EXCLUDED.some((re) => re.test(t)) || segs.some((g) => EXCLUDED_DIRS.includes(g))) return null;
  const base = sectionOfBook(title, categoryPath);
  if (base) return base;
  const sectionIn = (text) => SECTION_KEYS.find((k) => text.includes(SECTION_NAME[k])) || null;
  const secOfTitle = sectionIn(t);
  const inTur = segs.includes(N('טור'));
  const inSa = segs.includes(N('שולחן ערוך')) || segs.includes(N('שלחן ערוך'));
  // Tur / Shulchan Aruch themselves (several parts in one file, or "טור, אורח חיים") are handled by sectionOfBook; here:
  if (/^(שולחנ|שלחנ) ערוכ( |$)/.test(t) && !/ הרב( |$)/.test(t)) return null; // "שולחן ערוך, הקדמה" and the like: not a part
  const known = KNOWN_WORKS.find(([name]) => t === name || t.startsWith(name + ' ') || t.startsWith(name + ','));
  if (!inTur && !inSa && !known) return null;
  return { kind: inTur ? 'tur' : known ? known[1] : 'sa', sec: secOfTitle || (known ? known[2] : null) };
  return null;
}

/** Gematria with geresh / gershayim: 8 -> ח׳, 24 -> כ״ד. */
function simanLabel(n) {
  const h = intToHebrewNumeral(n);
  if (!h) return String(n);
  return h.length === 1 ? `${h}׳` : `${h.slice(0, -1)}״${h.slice(-1)}`;
}

/** "ח׳–כ״ד" (a single siman: "ח׳"). */
function rangeLabel(t) {
  return t.from === t.to ? simanLabel(t.from) : `${simanLabel(t.from)}–${simanLabel(t.to)}`;
}

/** "הלכות ציצית (ח׳–כ״ד)". */
function topicLabel(t) {
  return `${t.t} (${rangeLabel(t)})`;
}

/** Topic name without the leading "הלכות" / "הל'", normalized: "הלכות בשר בחלב" -> "בשר בחלב". */
function topicKey(t) {
  return N(t.t).replace(/^(הלכות|הלכה|הל)\s+/, '');
}

function topicsFor(kind, sec, data) {
  const d = data || active();
  return (d && d[kind] && d[kind][sec]) || [];
}

function topicOfSiman(topics, n) {
  return topics.find((t) => n >= t.from && n <= t.to) || null;
}

const SIMAN = N('סימן'); // normalized: final letters are folded (סימנ)
/** Number of a siman heading: "סימן כה", "סימן 25", or a bare numeral heading ("כה", "כה."); null for anything else. */
const sirNumber = (node) => {
  const title = N(node.title);
  let key = null;
  if (title.startsWith(SIMAN)) key = node.ref_key != null && node.ref_key !== '' ? node.ref_key : extractRefKey(node.title);
  else {
    const bare = title.replace(/[.:]+$/, '').trim();
    if (/^\d+$/.test(bare) || (/^[א-ת]{1,4}$/.test(bare) && hebrewNumeralToInt(bare) != null && isHebrewNumeral(bare))) key = bare;
  }
  if (key == null) return null;
  if (/^\d+$/.test(key)) return Number(key);
  return hebrewNumeralToInt(key);
};

/** Largest siman of each part (the Shulchan Aruch and the Tur share them): numbers beyond it mean the wrong part. */
const MAX_SIMAN = { oc: 697, yd: 403, eh: 178, cm: 427 };

/** Part named by a heading text ("אורח חיים", "טור אורח חיים", "חלק יורה דעה"), or null. */
const sectionInTitle = (text) => {
  const t = N(text);
  const words = ` ${t} `;
  return SECTION_KEYS.find((k) => t.includes(SECTION_NAME[k]) || SECTION_ALIASES[k].some((a) => a.length > 1 && words.includes(` ${a} `))) || null;
};

/** [{ from, to }] index ranges of strictly rising runs of `nums` (a drop = the numbering restarts in the next part). */
function risingRuns(nums) {
  const runs = [];
  let from = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] <= nums[i - 1]) {
      runs.push({ from, to: i - 1 });
      from = i;
    }
  }
  runs.push({ from, to: nums.length - 1 });
  return runs;
}

/**
 * Groups the simanim of any Shulchan Aruch / Tur siman-numbered book (see tocSectionOfBook) under their topic headers
 * (synthetic nodes with negative ids, `synthetic: true`, plain topic names such as "הלכות ציצית": the range is visible in the
 * siman column). Containers are found in the tree itself, wherever a heading list is (≥ 80%, ≥ 5) numbered simanim:
 *   - at the root (single-part books, or a flat multi-part list whose numbering restarts: synthetic part headers are added),
 *   - under part headings (single-file Tur: אורח חיים / יורה דעה / ... each holding its simanim).
 * The part of a container: its own / ancestors' heading, else the book's (title, folder, known work). Topics without a single
 * siman in the book are not shown (partial works). Returns the SAME tree when nothing can be grouped cleanly (not such a book,
 * no part found, simanim beyond the part's last siman, no topic data).
 * @param {{roots, children: Map, byId: Map, depth: number}} tree
 * @param {{ title: string, categoryPath?: string }} book
 */
function groupTocTree(tree, book, data) {
  const d = data || active();
  if (!tree || !hasData(d)) return tree;
  const info = tocSectionOfBook(book.title, book.categoryPath);
  if (!info) return tree;
  const children = new Map(tree.children);
  const byId = new Map(tree.byId);
  let nextId = -1;
  let grouped = false;

  const partOf = (parentId) => {
    for (let n = parentId != null ? tree.byId.get(parentId) : null; n; n = n.parent_id != null ? tree.byId.get(n.parent_id) : null) {
      const sec = sectionInTitle(n.title);
      if (sec) return sec;
    }
    return info.sec;
  };

  /** Topic header nodes over `kids` (one part); returns the new child list for the container. */
  const groupKids = (parent, kids, nums, sec) => {
    const topics = topicsFor(info.kind, sec, d);
    const out = [];
    const byTopic = new Map();
    kids.forEach((k, i) => {
      const t = nums[i] != null ? topicOfSiman(topics, nums[i]) : null;
      if (!t) return out.push(k);
      let node = byTopic.get(t);
      if (!node) {
        node = { id: nextId--, parent_id: parent, level: k.level, title: t.t, ref_key: '~topic', start_line: k.start_line, synthetic: true };
        byTopic.set(t, node);
        byId.set(node.id, node);
        children.set(node.id, []);
        out.push(node);
      }
      const moved = { ...k, parent_id: node.id };
      byId.set(k.id, moved);
      children.get(node.id).push(moved);
    });
    return byTopic.size ? out : null;
  };

  const unnamed = []; // containers under part headings whose names are not recognised (taken in order, see below)
  for (const [parent, kids] of tree.children) {
    if (parent != null && parent < 0) continue;
    const nums = kids.map(sirNumber);
    const numbered = nums.filter((x) => x != null).length;
    if (kids.length < 5 || numbered < kids.length * 0.8) continue;
    const sec = partOf(parent);
    if (sec) {
      // One part: the numbers must fit it and rise.
      const real = nums.filter((x) => x != null);
      if (Math.max(...real) > MAX_SIMAN[sec]) continue;
      const out = groupKids(parent, kids, nums, sec);
      if (!out) continue;
      grouped = true;
      children.set(parent, out);
    } else if (parent != null) {
      unnamed.push({ parent, kids, nums });
    } else {
      // Several parts in one flat list (no part headings): the numbering restarts at every part.
      const real = nums.map((x, i) => [x, i]).filter(([x]) => x != null);
      const runs = risingRuns(real.map(([x]) => x));
      if (runs.length < 2 || runs.length > 4 || runs[0].from !== 0) continue;
      const parts = runs.map((r, ri) => ({ sec: SECTION_KEYS[ri], kids: kids.slice(real[r.from][1], ri + 1 < runs.length ? real[runs[ri + 1].from][1] : kids.length), nums: nums.slice(real[r.from][1], ri + 1 < runs.length ? real[runs[ri + 1].from][1] : kids.length) }));
      if (parts.some((p) => Math.max(...p.nums.filter((x) => x != null)) > MAX_SIMAN[p.sec])) continue;
      const rootOut = [];
      let any = false;
      for (const p of parts) {
        const header = { id: nextId--, parent_id: null, level: p.kids[0].level, title: SECTION_LABEL[p.sec], ref_key: '~part', start_line: p.kids[0].start_line, synthetic: true };
        byId.set(header.id, header);
        const inner = groupKids(header.id, p.kids, p.nums, p.sec);
        for (const k of p.kids) byId.set(k.id, { ...k, parent_id: header.id });
        children.set(header.id, inner || p.kids.map((k) => byId.get(k.id)));
        if (inner) any = true;
        rootOut.push(header);
      }
      if (!any) continue;
      grouped = true;
      children.set(null, rootOut);
    }
  }
  // Sibling part headings with unrecognised names: 2-4 of them are the four parts, in order.
  const byUp = new Map();
  for (const u of unnamed) {
    const up = tree.byId.get(u.parent).parent_id;
    byUp.set(up, [...(byUp.get(up) || []), u]);
  }
  for (const list of byUp.values()) {
    if (list.length < 2 || list.length > 4) continue;
    list.sort((a, b) => tree.byId.get(a.parent).start_line - tree.byId.get(b.parent).start_line);
    list.forEach((u, i) => {
      const sec = SECTION_KEYS[i];
      if (Math.max(...u.nums.filter((x) => x != null)) > MAX_SIMAN[sec]) return;
      const out = groupKids(u.parent, u.kids, u.nums, sec);
      if (!out) return;
      grouped = true;
      children.set(u.parent, out);
    });
  }
  if (!grouped) return tree;
  let depth = 0;
  const walk = (id, level) => {
    for (const n of children.get(id) || []) {
      depth = Math.max(depth, level);
      walk(n.id, level + 1);
    }
  };
  walk(null, 1);
  return { roots: children.get(null) || [], children, byId, depth };
}

/**
 * Quick Jump topics: `rest` = normalized tokens after "שוע" / "טור" (and the optional section, already removed by the caller).
 * Matches whole words in order against topic names (without "הלכות"), a word start for the last token; best first.
 * @returns {{ sec, topic, score }[]}  score 3 exact name, 2 name starts with the query, 1 words inside; optional `sec` limits the sections.
 */
function matchTopics(kind, rest, opts, data) {
  const d = data || active();
  if (!hasData(d)) return [];
  let q = rest.filter(Boolean);
  while (q.length > 1 && /^(הלכות|הלכה|הל)$/.test(q[0])) q = q.slice(1);
  if (!q.length || /^(הלכות|הלכה|הל)$/.test(q[0])) return [];
  const secs = opts && opts.sec ? [opts.sec] : SECTION_KEYS;
  const strip = (w) => (w.length > 2 && w[0] === 'ו' ? w.slice(1) : w);
  const out = [];
  for (const sec of secs) {
    for (const t of topicsFor(kind, sec, d)) {
      const name = topicKey(t).split(' ');
      for (const prefix of [false, true]) {
        let score = 0;
        for (let at = 0; at + q.length <= name.length && !score; at++) {
          let ok = true;
          for (let i = 0; i < q.length && ok; i++) {
            const n = name[at + i];
            const last = i === q.length - 1;
            ok = q[i] === n || q[i] === strip(n) || (prefix && last && q[i].length >= 2 && (n.startsWith(q[i]) || strip(n).startsWith(q[i])));
          }
          if (ok) score = q.length === name.length && at === 0 ? 3 : at === 0 ? 2 : 1;
        }
        if (score) {
          out.push({ sec, topic: t, score });
          break;
        }
      }
    }
  }
  out.sort((a, b) => b.score - a.score || SECTION_KEYS.indexOf(a.sec) - SECTION_KEYS.indexOf(b.sec) || a.topic.from - b.topic.from);
  return out;
}

module.exports = { DATA, setTopicData, hasData, SECTION_KEYS, SECTION_NAME, SECTION_ALIASES, SECTION_LABEL, sectionOfBook, tocSectionOfBook, MAX_SIMAN, simanLabel, rangeLabel, topicLabel, topicKey, topicsFor, topicOfSiman, groupTocTree, matchTopics };
