/**
 * Topical divisions (הלכות ...) of Shulchan Aruch and Tur, bundled as static data (shared/halachaTopics.json, built once by
 * scripts/fetch-sa-topics.js from Sefaria's Index API; the app never calls Sefaria).
 *
 *   data:  { pending, sa: { oc, yd, eh, cm: [{ t: 'הלכות ציצית', from: 8, to: 24 }] }, tur: { ... }, turFallback: [...] }
 *
 * Used by the reader's TOC (`groupTocTree`: simanim grouped under "הלכות ציצית (ח׳–כ״ד)" headers, flat fallback when the
 * headings do not match cleanly) and by Quick Jump (`matchTopics`: "שוע ציצית" -> the section book + the topic's first siman).
 * Every function takes the topic data as an optional last argument (tests inject fixtures); with `pending` data (JSON not
 * fetched yet) everything is a no-op.
 */
'use strict';

const { normalizeHebrew, extractRefKey, hebrewNumeralToInt } = require('./hebrew');
const { intToHebrewNumeral } = require('./hebrewTorahDict');
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
const sirNumber = (node) => {
  if (!N(node.title).startsWith(SIMAN)) return null;
  const key = node.ref_key != null && node.ref_key !== '' ? node.ref_key : extractRefKey(node.title);
  if (/^\d+$/.test(key)) return Number(key);
  return hebrewNumeralToInt(key);
};

/**
 * Groups the simanim of a Shulchan Aruch / Tur TocTree under their topic headers (synthetic nodes with negative ids,
 * `synthetic: true`, titles like "הלכות ציצית (ח׳–כ״ד)"). Returns the SAME tree when nothing can be grouped cleanly
 * (not a halacha-section book, fewer than 80% of a container's headings are numbered simanim, no topic data).
 * @param {{roots, children: Map, byId: Map, depth: number}} tree
 * @param {{ title: string, categoryPath?: string }} book
 */
function groupTocTree(tree, book, data) {
  const d = data || active();
  if (!tree || !hasData(d)) return tree;
  const info = sectionOfBook(book.title, book.categoryPath);
  if (!info) return tree;
  const containers = [];
  if (info.sec) containers.push({ parent: null, sec: info.sec });
  else for (const r of tree.roots) {
    const sec = SECTION_KEYS.find((k) => N(r.title).includes(SECTION_NAME[k]));
    if (sec) containers.push({ parent: r.id, sec });
  }
  const children = new Map(tree.children);
  const byId = new Map(tree.byId);
  let nextId = -1;
  let grouped = false;
  for (const { parent, sec } of containers) {
    const kids = tree.children.get(parent) || [];
    const nums = kids.map(sirNumber);
    const numbered = nums.filter((x) => x != null).length;
    if (kids.length < 5 || numbered < kids.length * 0.8) continue;
    const topics = topicsFor(info.kind, sec, d);
    const out = [];
    const byTopic = new Map();
    kids.forEach((k, i) => {
      const t = nums[i] != null ? topicOfSiman(topics, nums[i]) : null;
      if (!t) return out.push(k);
      let node = byTopic.get(t);
      if (!node) {
        node = { id: nextId--, parent_id: parent, level: k.level, title: topicLabel(t), ref_key: '~topic', start_line: k.start_line, synthetic: true };
        byTopic.set(t, node);
        byId.set(node.id, node);
        children.set(node.id, []);
        out.push(node);
      }
      const moved = { ...k, parent_id: node.id };
      byId.set(k.id, moved);
      children.get(node.id).push(moved);
    });
    if (!byTopic.size) continue;
    grouped = true;
    children.set(parent, out);
  }
  if (!grouped) return tree;
  return { roots: children.get(null) || [], children, byId, depth: tree.depth + 1 };
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

module.exports = { DATA, setTopicData, hasData, SECTION_KEYS, SECTION_NAME, SECTION_ALIASES, SECTION_LABEL, sectionOfBook, simanLabel, rangeLabel, topicLabel, topicKey, topicsFor, topicOfSiman, groupTocTree, matchTopics };
