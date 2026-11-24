/**
 * Parallel-works engine (pure JS + read-only queries; no schema change).
 *
 * Independent standalone books that share one structural coordinate system are PARALLEL WORKS:
 * neither is a commentary of the other. Each family links its members bidirectionally at ONE
 * coordinate level only:
 *
 *   turim    ארבעה טורים: טור · שולחן ערוך · לבוש · ערוך השולחן · שולחן ערוך הרב
 *            by part (או"ח / יו"ד / אה"ע / חו"מ) + סימן. Never by סעיף (the Tur has none; ערוך
 *            השולחן / לבוש / שו"ע הרב number their own). Tapping any seif of סימן N shows סימן N.
 *   shas     משנה · תלמוד בבלי · תלמוד ירושלמי · תוספתא · רי"ף · רא"ש
 *            by tractate (canonical identity, שביעית is never שבועות) + perek. The Bavli has no
 *            perek headings in Otzaria: its perakim are cut at the Vilna "הדרן עלך" lines.
 *            Known perek-order divergences between the Bavli order (בבלי / רי"ף / רא"ש) and the
 *            Mishnah order (משנה / ירושלמי / תוספתא) are linked by perek NAME only, else not at all.
 *   parasha  חומש · מדרש רבה (5 Torah books) · מדרש תנחומא · תנחומא בובר · זוהר · ספר החינוך
 *            by weekly parasha (spelling variants: לך-לך, שלח לך, כי תשא ...). Chumash parashiot
 *            come from shared/torahParshiot.js (verse level, no headings needed).
 *
 * Membership is an explicit allow-list of canonical titles in their Otzaria folders (verified
 * against otzaria_index_only.txt by scripts/audit-parallels.js and scripts/selftest.js), so a
 * book is never pulled in by a loose name match. Strict exclusions (different numbering):
 * קיצור שולחן ערוך, חיי אדם, חכמת אדם, בן איש חי, ערוך השולחן העתיד; ספר המצוות / סמ"ג /
 * ספר החינוך are NEVER linked by mitzvah number (their enumerations differ).
 *
 * Coordinates are resolved at query time from each book's own TOC (toc_nodes), so existing
 * libraries need no rebuild: `findParallels(db, bookId, line)`.
 */
'use strict';

const { aliasKey, formatHebrewNumeral, normalizeHebrew } = require('./hebrew');
const refAlign = require('./refAlign');
const torah = require('./torahParshiot');
const pairing = require('./pairing');
const { sourcesOf, adapterForBook, USER_ID_BASE } = require('./sources');
const L = require('./canonLists');

const K = (s) => aliasKey(s);

// ---------------------------------------------------------------------------
// Families and works
// ---------------------------------------------------------------------------

const FAMILIES = {
  turim: { id: 'turim', label: 'ארבעה טורים', unit: 'סימן' },
  shas: { id: 'shas', label: 'משנה ותלמוד', unit: 'פרק' },
  parasha: { id: 'parasha', label: 'פרשת השבוע', unit: 'פרשה' },
};

/** work id -> { family, label (chip / card name), order inside the family, group (perek order) } */
const WORKS = {
  tur: { family: 'turim', label: 'טור', order: 0 },
  shulchan_aruch: { family: 'turim', label: 'שולחן ערוך', order: 1 },
  levush: { family: 'turim', label: 'לבוש', order: 2 },
  aruch_hashulchan: { family: 'turim', label: 'ערוך השולחן', order: 3 },
  sa_harav: { family: 'turim', label: 'שולחן ערוך הרב', order: 4 },
  mishna: { family: 'shas', label: 'משנה', order: 0, group: 'mishna' },
  bavli: { family: 'shas', label: 'בבלי', order: 1, group: 'bavli' },
  yerushalmi: { family: 'shas', label: 'ירושלמי', order: 2, group: 'mishna' },
  tosefta: { family: 'shas', label: 'תוספתא', order: 3, group: 'mishna' },
  rif: { family: 'shas', label: 'רי"ף', order: 4, group: 'bavli' },
  rosh: { family: 'shas', label: 'רא"ש', order: 5, group: 'bavli' },
  chumash: { family: 'parasha', label: 'חומש', order: 0 },
  midrash_rabbah: { family: 'parasha', label: 'מדרש רבה', order: 1 },
  tanchuma: { family: 'parasha', label: 'מדרש תנחומא', order: 2 },
  tanchuma_buber: { family: 'parasha', label: 'תנחומא בובר', order: 3 },
  zohar: { family: 'parasha', label: 'זוהר', order: 4 },
  chinuch: { family: 'parasha', label: 'ספר החינוך', order: 5 },
};

/**
 * Never members of a parallel family, even where a title looks close (different numbering /
 * different works). Documented here and asserted by the self-tests; membership itself is an
 * allow-list, so these could only ever slip in through a future loosening of the rules.
 */
const EXCLUDED_TITLES = [
  'קיצור שולחן ערוך',
  'קיצור שלחן ערוך',
  'חיי אדם',
  'חכמת אדם',
  'בן איש חי',
  'ערוך השולחן העתיד',
  'הערות על ערוך השולחן העתיד',
  'ספר המצוות',
  'ספר המצוות לרסג',
  'סמג',
  'ספר מצוות גדול',
  'ספר מצוות קטן',
  'זוהר חדש',
  'תקוני הזהר',
  'מנחת חינוך',
  'לבוש מרדכי',
  'לבוש האורה',
  'לבושי שרד',
];
const EXCLUDED = new Set(EXCLUDED_TITLES.map(K));

/**
 * Perek-order divergences between the Bavli order and the Mishnah order (perek numbers affected;
 * 'all' = the whole tractate). Those perakim link across the two orders by perek name only.
 */
const DIVERGENT = new Map(
  Object.entries({ מגילה: [3, 4], סנהדרין: [10, 11], מנחות: 'all', תמיד: 'all' }).map(([t, v]) => [L.TRACTATE_INDEX.get(t), v]),
);

// --- names ------------------------------------------------------------------

const SECTION_FORMS = [
  ['אורח חיים', 'אוח', 'אורח חיימ'],
  ['יורה דעה', 'יוד', 'יורה דעה'],
  ['אבן העזר', 'אהע', 'אבן עזר'],
  ['חושן משפט', 'חשן משפט', 'חומ'],
].map((forms) => forms.map(K));

/** Part of the Shulchan Aruch named by a text (title suffix or heading), or null. */
function sectionIndex(text) {
  const t = K(text);
  if (!t) return null;
  const words = t.split(' ');
  for (let i = 0; i < SECTION_FORMS.length; i++) {
    for (const f of SECTION_FORMS[i]) {
      if (f.includes(' ') ? t === f || t.startsWith(f + ' ') || t.endsWith(' ' + f) || t.includes(' ' + f + ' ') : words.includes(f)) return i;
    }
  }
  return null;
}

const sectionLabel = (i) => L.SHULCHAN_ARUCH_ABBR[i] || '';

/** "מסכת שבת" / "שבת" -> canonical tractate index (MISHNA order), or null. */
function tractateIndex(name) {
  const n = K(name).replace(/^מסכת /, '').trim();
  if (!n) return null;
  const i = L.TRACTATE_INDEX.get(n);
  return i == null ? null : i;
}
const tractateName = (i) => L.MISHNA_FLAT[i] || '';

const SEDER_KEYS = new Set(L.SEDARIM.flatMap((s) => [L.canon(s), L.canon('סדר ' + s)]));
const isSederDir = (d) => SEDER_KEYS.has(L.canon(d));

// --- parasha names -------------------------------------------------------------

const qnorm = (s) => normalizeHebrew(s, { keepAmud: true, keepPunctuation: false });
let parashaMap = null;
/** normalized parasha name / single-parasha variant -> parasha index (PARSHIOT order). */
function parashaNames() {
  if (parashaMap) return parashaMap;
  const all = [];
  for (const p of torah.PARSHIOT) for (const f of [p.name, ...((torah.PARSHA_VARIANTS || {})[p.name] || [])]) all.push([qnorm(f), p.index]);
  const map = new Map();
  for (const [k, i] of all) if (!map.has(k)) map.set(k, i);
  // Joint-week spellings ("ויקהל פקודי", "מטות מסעי") name TWO parashiot: resolved by splitting.
  for (const [k] of all) {
    const w = k.split(' ');
    for (let j = 1; j < w.length; j++) {
      const x = map.get(w.slice(0, j).join(' '));
      const y = map.get(w.slice(j).join(' '));
      if (x != null && y != null && y === x + 1) {
        map.delete(k);
        break;
      }
    }
  }
  parashaMap = map;
  return map;
}

const PARASHA_LEAD = new Set(['פרשת', 'פרשה', 'פרשיות', 'פרשות', 'סדר', 'סדרה', 'סדרת', 'פ'].map(qnorm));

/**
 * Weekly parashiot named by a heading: "פרשת נח" -> [1], "לך-לך" -> [2], "שלח לך" -> [36],
 * "ויקהל-פקודי" -> [21, 22]; "פרשה א", "סימן ב", "מצוה ג" -> [].
 */
function parashaOfHeading(title) {
  const plain = String(title || '').replace(/<[^>]*>/g, ' ');
  const head = plain.split(/\s[-–—]\s|[,;:(]/)[0];
  let words = qnorm(head).split(' ').filter(Boolean);
  while (words.length > 1 && PARASHA_LEAD.has(words[0])) words = words.slice(1);
  if (!words.length || words.length > 4) return [];
  const map = parashaNames();
  const whole = words.join(' ');
  if (map.has(whole)) return [map.get(whole)];
  // Two names together ("ויקהל פקודי", "מטות-מסעי", "אחרי מות קדושים").
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    if (map.has(a) && map.has(b) && map.get(b) === map.get(a) + 1) return [map.get(a), map.get(b)];
  }
  return [];
}

/**
 * Bereishit Rabbah is divided into 100 numbered parashiyot (not weekly ones); when its TOC names no
 * weekly parasha, "פרשה N" maps onto the weekly parasha it opens (פרשה ל = אלה תולדות נח).
 */
const BEREISHIT_RABBAH_STARTS = [1, 30, 39, 48, 58, 63, 68, 75, 84, 89, 93, 96];
function bereishitRabbahParasha(n) {
  if (!n || n < 1 || n > 100) return null;
  let idx = 0;
  for (let i = 0; i < BEREISHIT_RABBAH_STARTS.length; i++) if (n >= BEREISHIT_RABBAH_STARTS[i]) idx = i;
  return idx; // PARSHIOT 0..11 = Bereishit .. Vayechi
}

// ---------------------------------------------------------------------------
// Membership (pure, from title + folder)
// ---------------------------------------------------------------------------

const TOP = (place) => (place.dirs[0] ? L.canon(place.dirs[0]) : '');
const IS = (place, name) => TOP(place) === L.canon(name);

function make(work, extra) {
  const w = WORKS[work];
  return { family: w.family, work, workLabel: w.label, order: w.order, section: null, tractate: null, chumash: null, edition: null, ...extra };
}

/**
 * Parallel-family membership of a book, or null.
 * @param {{ title: string, categoryPath?: string | null }} book
 * @returns {{ family, work, workLabel, order, section: number|null, tractate: number|null, chumash: string|null, edition: string|null } | null}
 */
function memberOf(book) {
  const title = String((book && book.title) || '').trim();
  if (!title) return null;
  const t = K(title);
  if (EXCLUDED.has(t)) return null;
  const categoryPath = String((book && book.categoryPath) || '');
  const place = pairing.placeOf(categoryPath);
  const rawDirs = categoryPath.split('/').filter(Boolean);
  if (!place.dirs.length) return null;

  // ---- weekly parasha ----
  const ch = torah.chumashBookOf(title, categoryPath);
  if (ch && IS(place, 'תנך')) return make('chumash', { chumash: ch });
  if (IS(place, 'מדרש') && place.primary) {
    const r = ['בראשית רבה', 'שמות רבה', 'ויקרא רבה', 'במדבר רבה', 'דברים רבה'].findIndex((n) => K(n) === t);
    if (r >= 0) return make('midrash_rabbah', { chumash: L.TORAH[r] });
    if (t === K('מדרש תנחומא') || t === K('תנחומא')) return make('tanchuma');
    if (t === K('תנחומא בובר') || t === K('מדרש תנחומא בובר') || t === K('מדרש תנחומא (בובר)')) return make('tanchuma_buber');
  }
  if (IS(place, 'קבלה') && place.primary) {
    const z = /^(?:ספר )?ה?(?:זהר|זוהר)(?: על)?(?: (?:ה?תורה|(בראשית|שמות|ויקרא|במדבר|דברימ)))?$/.exec(t);
    if (z) return make('zohar', { chumash: z[1] ? L.TORAH[L.TORAH.map(K).indexOf(z[1])] : null });
  }
  if (IS(place, 'הלכה') && (t === K('ספר החינוך') || t === K('החינוך'))) return make('chinuch');

  // ---- ארבעה טורים ----
  if (IS(place, 'הלכה') && place.primary) {
    const rest = (prefix) => {
      for (const p of prefix) {
        const k = K(p);
        if (t === k) return '';
        if (t.startsWith(k + ' ')) return t.slice(k.length + 1);
      }
      return null;
    };
    const withSection = (work, r) => {
      if (r === '') return make(work);
      const s = sectionIndex(r);
      return s != null && K(r).split(' ').length <= 3 ? make(work, { section: s }) : null;
    };
    let r = rest(['שולחן ערוך הרב', 'שלחן ערוך הרב']);
    if (r != null) return withSection('sa_harav', r);
    r = rest(['שולחן ערוך', 'שלחן ערוך']);
    if (r != null) return withSection('shulchan_aruch', r);
    r = rest(['ארבעה טורים', 'טור']);
    if (r != null) return withSection('tur', r);
    r = rest(['ערוך השולחן', 'ערוך השלחן']);
    if (r != null) return withSection('aruch_hashulchan', r);
    const levushVolumes = { 'לבוש התכלת': 0, 'לבוש החור': 0, 'לבוש עטרת זהב': 1, 'לבוש הבוץ וארגמן': 2, 'לבוש בוץ וארגמן': 2, 'לבוש עיר שושן': 3 };
    for (const [name, s] of Object.entries(levushVolumes)) if (t === K(name)) return make('levush', { section: s });
    r = rest(['לבוש מלכות', 'לבוש', 'לבושים']);
    if (r != null) return withSection('levush', r);
  }

  // ---- משנה / תלמוד ----
  const hasSeder = rawDirs.some(isSederDir);
  if (IS(place, 'משנה') && place.primary && hasSeder && t.startsWith(K('משנה') + ' ')) {
    const i = tractateIndex(t.slice(K('משנה').length + 1));
    if (i != null) return make('mishna', { tractate: i });
  }
  if (IS(place, 'תלמוד בבלי')) {
    if (place.primary && rawDirs[1] && isSederDir(rawDirs[1])) {
      const i = tractateIndex(t);
      if (i != null && L.BAVLI_SET.has(i)) return make('bavli', { tractate: i });
    }
    const keys = place.dirs;
    const mIdx = keys.indexOf(K('מפרשים'));
    const rifIdx = keys.indexOf(K('ריף'));
    if (rifIdx > 0 && (mIdx < 0 || mIdx < rifIdx)) {
      const m = /^(?:ה)?ריפ (?:על )?(.+)$/.exec(t);
      const i = m ? tractateIndex(m[1]) : null;
      if (i != null && L.BAVLI_SET.has(i)) return make('rif', { tractate: i });
    }
    const roshIdx = keys.indexOf(K('ראש'));
    if (roshIdx > 0 && (mIdx < 0 || mIdx < roshIdx)) {
      const m = /^(?:פסקי )?(?:ה)?ראש (?:על )?(.+)$/.exec(t);
      const i = m ? tractateIndex(m[1]) : null;
      if (i != null && L.BAVLI_SET.has(i)) return make('rosh', { tractate: i });
    }
  }
  if (IS(place, 'תלמוד ירושלמי') && place.primary && rawDirs[1] && isSederDir(rawDirs[1])) {
    const n = t.replace(/^(?:תלמוד )?ירושלמי /, '');
    const i = tractateIndex(n);
    if (i != null) return make('yerushalmi', { tractate: i });
  }
  // "תוספתא שבת (ליברמן)": the edition in brackets is not part of the tractate name.
  const tb = K(title.replace(/\s*\([^)]*\)\s*$/, ''));
  if (IS(place, 'תוספתא') && place.primary && tb.startsWith(K('תוספתא') + ' ')) {
    const i = tractateIndex(tb.slice(K('תוספתא').length + 1));
    if (i != null) return make('tosefta', { tractate: i, edition: rawDirs[1] && !isSederDir(rawDirs[1]) && rawDirs[1] !== 'מועד' ? rawDirs[1] : null });
  }
  return null;
}

/** Card / chip name of a member book ("בראשית רבה", "תוספתא (מהדורת ליברמן)", "טור"). */
function displayName(member, title) {
  if (!member) return String(title || '');
  if (member.work === 'chumash' || member.work === 'midrash_rabbah') return String(title || member.workLabel);
  if (member.work === 'tosefta' && member.edition) return `${member.workLabel} (${member.edition})`;
  return member.workLabel;
}

// ---------------------------------------------------------------------------
// Coordinates (segments) of one book
// ---------------------------------------------------------------------------

/**
 * Coordinate segments of one family member from its TOC units (refAlign.bookUnits) - pure.
 * `extra`: { hadran: [{ line, name }], parshiot: [{ index, title, line }], totalLines }.
 * @returns {{ key: string, label: string, name: string, start: number, end: number, num?: number }[]}
 */
function segmentsFromUnits(member, units, extra) {
  const ex = extra || {};
  const total = ex.totalLines || units.reduce((m, u) => Math.max(m, u.end), 0);
  const out = [];
  const seen = new Set();
  const push = (seg) => {
    if (seen.has(seg.key)) return;
    seen.add(seg.key);
    out.push(seg);
  };
  if (member.family === 'turim') {
    for (const u of units) {
      const leaf = u.labels[u.labels.length - 1];
      if (!leaf || leaf.type !== 'סימן') continue;
      const n = refAlign.numberKey(leaf.key);
      if (!n) continue;
      let sec = member.section;
      if (sec == null) {
        for (const l of u.labels.slice(0, -1)) {
          const s = sectionIndex(l.key);
          if (s != null) sec = s;
        }
      }
      if (sec == null) continue;
      push({ key: `${sec}:${n}`, label: `${sectionLabel(sec)} סימן ${formatHebrewNumeral(n)}`, name: '', start: u.start, end: u.end, num: n });
    }
  } else if (member.family === 'shas') {
    const tName = tractateName(member.tractate);
    for (const u of units) {
      const leaf = u.labels[u.labels.length - 1];
      if (!leaf || leaf.type !== 'פרק') continue;
      const n = refAlign.numberKey(leaf.key);
      if (!n) continue;
      push({ key: `${member.tractate}:${n}`, label: `${tName} פרק ${formatHebrewNumeral(n)}`, name: refAlign.perekName(u.title), start: u.start, end: u.end, num: n });
    }
    if (!out.length && ex.hadran && ex.hadran.length) {
      let start = 1;
      ex.hadran.forEach((h, i) => {
        const n = i + 1;
        push({ key: `${member.tractate}:${n}`, label: `${tName} פרק ${formatHebrewNumeral(n)}`, name: h.name || '', start, end: h.line, num: n });
        start = h.line + 1;
      });
    }
  } else if (member.family === 'parasha') {
    if (member.work === 'chumash') {
      const list = (ex.parshiot || []).filter((p) => p.line != null).sort((a, b) => a.line - b.line);
      list.forEach((p, i) => push({ key: String(p.index), label: p.title, name: '', start: p.line, end: i + 1 < list.length ? list[i + 1].line - 1 : total, num: p.index }));
    } else {
      const named = units.map((u) => ({ u, ids: parashaOfHeading(u.title) })).filter((x) => x.ids.length);
      for (const { u, ids } of named) {
        // A heading named after a Chumash book that holds other parashiot is the book, not a parasha.
        if (named.some((o) => o.u !== u && o.u.start >= u.start && o.u.start <= u.end && o.u.labels.length > u.labels.length)) continue;
        for (const idx of ids) push({ key: String(idx), label: torah.PARSHIOT[idx].title, name: '', start: u.start, end: u.end, num: idx });
      }
      if (!out.length && member.work === 'midrash_rabbah' && member.chumash === 'בראשית') {
        const byParasha = new Map();
        for (const u of units) {
          const leaf = u.labels[u.labels.length - 1];
          if (!leaf || leaf.type !== 'פרשה') continue;
          const idx = bereishitRabbahParasha(refAlign.numberKey(leaf.key));
          if (idx == null) continue;
          const cur = byParasha.get(idx);
          if (!cur) byParasha.set(idx, { start: u.start, end: u.end });
          else byParasha.set(idx, { start: Math.min(cur.start, u.start), end: Math.max(cur.end, u.end) });
        }
        for (const [idx, r] of [...byParasha].sort((a, b) => a[1].start - b[1].start)) push({ key: String(idx), label: torah.PARSHIOT[idx].title, name: '', start: r.start, end: r.end, num: idx });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The most specific segment containing `line` (the latest start), or null. */
function segmentAt(segments, line) {
  let best = null;
  for (const s of segments) if (s.start <= line && s.end >= line && (!best || s.start >= best.start)) best = s;
  return best;
}

const nameMatch = (a, b) => {
  const x = K(a).split(' ').slice(0, 2).join(' ');
  const y = K(b).split(' ').slice(0, 2).join(' ');
  return !!x && x === y;
};

/**
 * The sibling segment matching `here` (a segment of `self`), or null. Shas: perakim of a tractate
 * whose order diverges between the Bavli order and the Mishnah order match by name only.
 */
function matchSegment(self, here, sib, sibSegments) {
  if (self.family === 'shas') {
    const sameOrder = WORKS[self.work].group === WORKS[sib.work].group;
    const div = DIVERGENT.get(self.tractate);
    const affected = div && (div === 'all' || div.includes(here.num));
    if (!sameOrder && affected) {
      if (!here.name) return null;
      return sibSegments.find((s) => s.name && nameMatch(s.name, here.name)) || null;
    }
  }
  const hit = sibSegments.find((s) => s.key === here.key) || null;
  if (hit && self.family === 'shas' && !(WORKS[self.work].group === WORKS[sib.work].group)) {
    // Never across orders into an affected perek of the sibling either.
    const div = DIVERGENT.get(self.tractate);
    if (div && (div === 'all' || div.includes(hit.num))) return null;
  }
  return hit;
}

/** May `sib` hold the coordinate `here` of `self` at all (same tractate / part / Chumash book)? */
function compatible(self, sib, here) {
  if (self.family !== sib.family || self.work === sib.work) return false;
  if (self.family === 'shas') return self.tractate === sib.tractate;
  if (self.family === 'turim') return sib.section == null || String(sib.section) === here.key.split(':')[0];
  if (self.family === 'parasha') {
    const p = torah.PARSHIOT[Number(here.key)];
    return !sib.chumash || !p || sib.chumash === p.book;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Database resolution (read-only, cached per library adapter)
// ---------------------------------------------------------------------------

const caches = new WeakMap();
function cacheOf(db) {
  let c = caches.get(db);
  if (!c) {
    c = { index: null, segments: new Map() };
    caches.set(db, c);
  }
  return c;
}

/** Forget cached families / coordinates (after the library changed). */
function clearParallelCache(db) {
  if (db) caches.delete(db);
}

/**
 * Members of every family in a library: { byId: Map(id -> { id, title, categoryPath, member }),
 * byFamily: Map(family -> entries[]) }. `books` ([{ id, title, categoryPath }]) skips the query.
 * Personal books (ids >= USER_ID_BASE) never join a family.
 */
function familyIndex(db, books) {
  const c = cacheOf(db);
  if (c.index && !books) return c.index;
  const build = async () => {
    let list = books;
    if (!list) {
      list = [];
      for (const s of sourcesOf(db)) {
        if ((s.idBase || 0) >= USER_ID_BASE) continue;
        const rows = await s.adapter.all('SELECT b.id, b.title, c.path AS category_path FROM books b LEFT JOIN categories c ON c.id = b.category_id', []);
        for (const r of rows) list.push({ id: Number(r.id), title: r.title, categoryPath: r.category_path || '' });
      }
    }
    const byId = new Map();
    const byFamily = new Map();
    for (const b of list) {
      if (b.id >= USER_ID_BASE || b.personal) continue;
      const member = memberOf(b);
      if (!member) continue;
      const e = { id: b.id, title: b.title, categoryPath: b.categoryPath || '', member };
      byId.set(b.id, e);
      if (!byFamily.has(member.family)) byFamily.set(member.family, []);
      byFamily.get(member.family).push(e);
    }
    return { byId, byFamily };
  };
  const p = build();
  c.index = p;
  p.catch(() => {
    if (c.index === p) c.index = null;
  });
  return p;
}

/** Coordinate segments of one member book (one TOC query + one family-specific query, cached). */
function bookSegments(db, entry) {
  const c = cacheOf(db);
  if (c.segments.has(entry.id)) return c.segments.get(entry.id);
  const p = (async () => {
    const a = adapterForBook(db, entry.id);
    const [nodes, total] = await Promise.all([
      a.all('SELECT id, parent_id, level, title, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [entry.id]),
      a.all('SELECT total_lines FROM books WHERE id = ?', [entry.id]),
    ]);
    const totalLines = Number((total[0] && total[0].total_lines) || 0);
    const units = refAlign.bookUnits(nodes, totalLines);
    const extra = { totalLines };
    const m = entry.member;
    if (m.family === 'shas' && !units.some((u) => u.labels.length && u.labels[u.labels.length - 1].type === 'פרק')) {
      const rows = await a.all("SELECT line_index, clean_text FROM paragraphs WHERE book_id = ? AND is_heading = 0 AND clean_text LIKE '%הדרנ עלכ%' ORDER BY line_index", [entry.id]);
      extra.hadran = rows.map((r) => ({ line: Number(r.line_index), name: refAlign.hadranName(r.clean_text) })).filter((h) => h.name != null);
    }
    if (m.work === 'chumash') {
      const verseLines = await torah.chumashVerseLines(db, entry.id);
      extra.parshiot = torah.parshiotWithLines(m.chumash, verseLines).map((p) => ({ index: p.index, title: p.title, line: p.line }));
    }
    return segmentsFromUnits(m, units, extra);
  })();
  if (c.segments.size > 300) c.segments.clear();
  c.segments.set(entry.id, p);
  p.catch(() => c.segments.delete(entry.id));
  return p;
}

/** The family member record of a book (null: not a parallel work). */
async function parallelMember(db, bookId, opts) {
  const idx = await familyIndex(db, opts && opts.books);
  const e = idx.byId.get(Number(bookId));
  return e ? e.member : null;
}

/**
 * Parallel works of the paragraph at `line` of `bookId`.
 * @returns {Promise<{ family: string|null, familyLabel: string, coordinate: { key, label, start, end } | null,
 *   parallels: { family, work, workLabel, name, bookId, bookTitle, categoryPath, key, label, start, end, order,
 *   preview: { line, display_text, toc_path }[] }[] }>}
 */
async function findParallels(db, bookId, line, opts) {
  const o = opts || {};
  const idx = await familyIndex(db, o.books);
  const self = idx.byId.get(Number(bookId));
  const none = { family: self ? self.member.family : null, familyLabel: self ? FAMILIES[self.member.family].label : '', coordinate: null, parallels: [] };
  if (!self) return none;
  const here = segmentAt(await bookSegments(db, self), line);
  if (!here) return none;
  const previewLines = o.previewLines == null ? 3 : o.previewLines;
  const out = [];
  for (const sib of idx.byFamily.get(self.member.family) || []) {
    if (sib.id === self.id || !compatible(self.member, sib.member, here)) continue;
    const target = matchSegment(self.member, here, sib.member, await bookSegments(db, sib));
    if (!target) continue;
    const preview = previewLines
      ? await adapterForBook(db, sib.id).all(
          'SELECT line_index AS line, display_text, toc_path FROM paragraphs WHERE book_id = ? AND line_index BETWEEN ? AND ? AND is_heading = 0 ORDER BY line_index LIMIT ?',
          [sib.id, target.start, target.end, previewLines],
        )
      : [];
    out.push({
      family: sib.member.family,
      work: sib.member.work,
      workLabel: sib.member.workLabel,
      name: displayName(sib.member, sib.title),
      bookId: sib.id,
      bookTitle: sib.title,
      categoryPath: sib.categoryPath,
      key: target.key,
      label: target.label,
      start: target.start,
      end: target.end,
      order: sib.member.order,
      preview: preview.map((r) => ({ line: Number(r.line), display_text: r.display_text, toc_path: r.toc_path })),
    });
  }
  // The edition ("תוספתא (מהדורת ליברמן)") only tells two editions of one work apart.
  const perWork = new Map();
  for (const p of out) perWork.set(p.work, (perWork.get(p.work) || 0) + 1);
  for (const p of out) if (perWork.get(p.work) === 1 && p.work === 'tosefta') p.name = p.workLabel;
  out.sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)) || a.bookId - b.bookId);
  return { family: self.member.family, familyLabel: FAMILIES[self.member.family].label, coordinate: { key: here.key, label: here.label, start: here.start, end: here.end }, parallels: out };
}

// ---------------------------------------------------------------------------
// Audit over a library map (otzaria_index_only.txt)
// ---------------------------------------------------------------------------

/**
 * Family members of a list of "folder/.../title" paths (no ".txt"):
 * { turim: { tur: [paths], ... }, shas: {...}, parasha: {...} }.
 */
function auditPaths(paths) {
  const out = {};
  for (const f of Object.keys(FAMILIES)) out[f] = {};
  for (const w of Object.keys(WORKS)) out[WORKS[w].family][w] = [];
  for (const p of paths) {
    const parts = String(p).split('/');
    const title = parts.pop();
    const m = memberOf({ title, categoryPath: parts.join('/') });
    if (m) out[m.family][m.work].push(p);
  }
  return out;
}

module.exports = {
  FAMILIES,
  WORKS,
  EXCLUDED_TITLES,
  DIVERGENT,
  sectionIndex,
  sectionLabel,
  tractateIndex,
  tractateName,
  parashaOfHeading,
  bereishitRabbahParasha,
  memberOf,
  displayName,
  segmentsFromUnits,
  segmentAt,
  matchSegment,
  compatible,
  familyIndex,
  bookSegments,
  parallelMember,
  findParallels,
  clearParallelCache,
  auditPaths,
};
