/**
 * Canonical book-role classification (pure JS, deterministic; verified against the full Otzaria
 * map otzaria_index_only.txt by scripts/selftest.js and scripts/audit-parallels.js).
 *
 * Every book gets exactly one role:
 *   base        ספרי יסוד - a standalone work (also every unpaired book: nothing is hidden by a guess);
 *   parallel    ספרים מקבילים - a standalone work of a parallel family (shared/parallelWorks.js:
 *               טור / שו"ע / ערוך השולחן ..., משנה / בבלי / ירושלמי / תוספתא / רי"ף / רא"ש, חומש /
 *               מדרש רבה / תנחומא / זוהר / ספר החינוך). Never a commentary of another member;
 *   commentary  מפרשים - ONLY when explicitly matched to its target work by shared/pairing.js:
 *               "<מפרש> על <ספר>" titles, the curated standalone list (משנה ברורה ...), a
 *               "<series> <book>" title or the owner of a "<X>/מפרשים/" folder - the last two only
 *               inside a commentary context (a "מפרשים" folder, or the era folders of the scripture
 *               corpora תנ"ך / משנה / בבלי / ירושלמי / תוספתא). A halacha / machshava book in an era
 *               folder ("הלכה/אחרונים/חפץ חיים") is a standalone work, never nested by name similarity;
 *   targum      תרגומים - אונקלוס / יונתן / ירושלמי / "תרגום <ספר>" (a תרגומים folder or a targum
 *               title): verse-aligned with its book like a commentary, but listed and badged apart.
 *
 * Commentaries / targumim whose target is a whole corpus ("… על התורה", "… על השס") or that name a
 * book missing from the library ("X על Y", Y not found) are general (no base book).
 */
'use strict';

const { aliasKey } = require('./hebrew');
const pairing = require('./pairing');
const parallelWorks = require('./parallelWorks');

const ROLES = { BASE: 'base', PARALLEL: 'parallel', COMMENTARY: 'commentary', TARGUM: 'targum' };
const ROLE_LABELS = { base: 'ספרי יסוד', parallel: 'ספרים מקבילים', commentary: 'מפרשים', targum: 'תרגומים' };

const TARGUM_DIR = aliasKey('תרגומים');
const MEFARSHIM = aliasKey('מפרשים');
/** Corpora whose era folders (ראשונים / אחרונים / מחברי זמננו) hold commentaries on the corpus' texts. */
const SCRIPTURE_CORPORA = new Set(['tanach', 'mishna', 'bavli', 'yerushalmi', 'tosefta']);
const TARGUM_TITLE_RE = /^(?:תרגום|אונקלוס|תפסיר)(?:\s|$)/;

/** A translation: in a תרגומים folder, or titled "תרגום ..." / "אונקלוס ..." / "תפסיר ...". */
function isTargum(info, place) {
  const p = place || pairing.placeOf(info.categoryPath);
  if (p.dirs.includes(TARGUM_DIR)) return true;
  const t = String(info.title || '').trim();
  if (TARGUM_TITLE_RE.test(t)) return true;
  const split = pairing.splitCommentaryTitle(t);
  return !!split && TARGUM_TITLE_RE.test(split.commentator);
}

/** Inside a commentary context ("…/מפרשים/…", a תרגומים folder, or an era folder of a scripture corpus)? */
function commentaryContext(place) {
  if (place.dirs.some((d) => d === MEFARSHIM || d.startsWith(MEFARSHIM + ' '))) return true;
  if (place.dirs.includes(TARGUM_DIR)) return true;
  return !place.primary && SCRIPTURE_CORPORA.has(place.corpus);
}

/** Pairing methods that read the target from the title itself (explicit anywhere). */
const TITLE_METHODS = new Set(['title', 'contains']);

/**
 * Classifies one library (books of ONE database: the importer pairs within one).
 * @param {{ id, title, categoryPath }[]} infos
 * @param {{ pairs: { commId, baseId, how }[], multi: { commId, scope }[] }} pairResult  shared/pairing.js output
 * @returns {{ roles: Map<number, string>, baseOf: Map<number, number>, general: Set<number>, members: Map<number, object> }}
 *   baseOf: commentary / targum id -> the book it directly comments on.
 */
function classifyBooks(infos, pairResult) {
  const byId = new Map(infos.map((i) => [i.id, i]));
  const places = new Map(infos.map((i) => [i.id, pairing.placeOf(i.categoryPath)]));
  const members = new Map();
  for (const i of infos) {
    const m = parallelWorks.memberOf(i);
    if (m) members.set(i.id, m);
  }
  const roles = new Map();
  const baseOf = new Map();
  const general = new Set();
  const dependent = (id) => (isTargum(byId.get(id), places.get(id)) ? ROLES.TARGUM : ROLES.COMMENTARY);

  for (const p of (pairResult && pairResult.pairs) || []) {
    const comm = byId.get(p.commId);
    const base = byId.get(p.baseId);
    if (!comm || !base || comm === base || members.has(comm.id)) continue;
    const place = places.get(comm.id);
    const baseCorpus = places.get(base.id).corpus;
    // Locality: a commentary folder, or a note inside the base's own corpus ("הערות על בראשית" in
    // תנך/תורה) - a midrash that comments on Tanach ("מדרש לקח טוב על איכה") stays a work of its own.
    if (place.primary && place.corpus !== baseCorpus) continue;
    // Explicit target: "X על Y" titles anywhere; series / owner / curated pairs only in a commentary context.
    if (!TITLE_METHODS.has(p.how) && !commentaryContext(place)) continue;
    baseOf.set(comm.id, base.id);
    roles.set(comm.id, dependent(comm.id));
  }
  for (const m of (pairResult && pairResult.multi) || []) {
    const comm = byId.get(m.commId);
    if (!comm || members.has(comm.id) || roles.has(comm.id)) continue;
    const place = places.get(comm.id);
    if (!place.primary || place.corpus === (m.scope && m.scope.corpus)) {
      general.add(comm.id);
      roles.set(comm.id, dependent(comm.id));
    }
  }
  for (const i of infos) {
    if (roles.has(i.id)) continue;
    if (members.has(i.id)) {
      roles.set(i.id, ROLES.PARALLEL);
      continue;
    }
    const place = places.get(i.id);
    // Unpaired, but explicitly a commentary / translation - by title inside a commentary context ("X על
    // Y" whose Y is not in this library; "תרגום ירושלמי"), or filed by Otzaria in a "מפרשים" folder
    // ("שולחן ערוך/מפרשים/אורים ותומים"): general, never nested under a guessed base book. Unpaired
    // books of an era folder (ראשונים / אחרונים) are standalone works.
    const inMefarshim = place.dirs.some((d) => d === MEFARSHIM || d.startsWith(MEFARSHIM + ' '));
    if (commentaryContext(place) && (pairing.isCommentaryTitle(i.title) || isTargum(i, place) || inMefarshim)) {
      general.add(i.id);
      roles.set(i.id, dependent(i.id));
      continue;
    }
    roles.set(i.id, ROLES.BASE);
  }
  return { roles, baseOf, general, members };
}

/** Relation of a linked book seen from the book being read: 'parallel' | 'targum' | 'commentary' | 'source'. */
function relationOf(fromRole, toRole, toIsBaseOfFrom) {
  if (toIsBaseOfFrom) return 'source';
  if ((fromRole === ROLES.PARALLEL || fromRole === ROLES.BASE) && toRole === ROLES.PARALLEL) return 'parallel';
  if (toRole === ROLES.TARGUM) return 'targum';
  return 'commentary';
}

module.exports = { ROLES, ROLE_LABELS, isTargum, commentaryContext, classifyBooks, relationOf };
