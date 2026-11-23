/**
 * Hebrew query engine for full-text search (pure JS, zero native code, no schema change).
 *
 * One builder serves both search experiences:
 *   - Simple Search ("חיפוש רגיל", SIMPLE_DEFAULTS): literal FTS5 — every word is matched as
 *     typed (whole token), quoted text is an exact phrase, no operators, no expansion.
 *   - Advanced Search ("חיפוש מתקדם", ADVANCED_DEFAULTS): structured fields (main query + "any of"
 *     + "exclude"), inline operators (a|b, -word, word*, "exact"), linguistic toggles and word
 *     proximity / order.
 *
 * Linguistic toggles (all work at query time on the normalized index form: no niqqud, no
 * gershayim / geresh, final letters folded — "שלום" is the token "שלומ"):
 *   - prefixesAndSuffixes (תחיליות וסופיות): the grammatical proclitics מש"ה וכל"ב and their
 *     legal compounds (PREFIXES; never "הב" / "בה"), and real noun suffixes, including the
 *     feminine ה -> ת construct (תפילה -> תפילת, תפילתו, תפילות). A word is matched as
 *     prefix? + one of inflections(lemma), checked exactly per token.
 *   - pleneDefective (כתיב מלא/חסר): pleneVariants() — curated pairs + pattern rules for a
 *     medial mater (ו / י) that never drop an initial ו / י or a final letter, never touch the
 *     final syllable (שלום != שלם) and never touch words of 3 letters (שיר != שר / שור).
 *   - acronyms (ראשי תיבות): bidirectional via shared/hebrewTorahDict.js (שו"ע <-> שולחן ערוך).
 *   - aramaicEquiv (עברית <-> ארמית): curated Talmudic pairs (מותר <-> שרי, הלכה <-> הלכתא ...).
 *
 * buildQuery() returns a plan: FTS5 MATCH expressions (a candidate superset when needed), the
 * exact-only sub-plan (exact matches are ranked first), highlight patterns, and evaluate()
 * decides each candidate precisely from its clean_text tokens (morphology, proximity, order).
 * shared/search.js runs plans (searchPlan / countPlan), including the no-FTS5 web fallback.
 *
 * Highlight / word patterns (strings, so they can travel to the reader with the tab):
 *   "x"   the token x          "x*"  any token starting with x (FTS5 prefix query)
 *   "^x"  prefix? + x          "%x"  (prefix | Aramaic ד-prefix)? + x
 *   "~x"  prefix? + inflections(x) (morphological)
 *   "a b" consecutive words, each one of the above.
 */
'use strict';

const { normalizeHebrew } = require('./hebrew');
const dict = require('./hebrewTorahDict');

// ---------------------------------------------------------------------------
// Tokens (identical to the FTS5 index: normalizeHebrew + letters / digits only)
// ---------------------------------------------------------------------------

const FTS_RESERVED_RE = /["'\-*():^|]/g;
const PHRASE_QUOTES = new Set(['"', '“', '”', '„', '״']);

/** Normalize a piece of text into plain index tokens. */
function toTokens(segment) {
  return normalizeHebrew(segment)
    .replace(FTS_RESERVED_RE, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Split raw input into [{ text, phrase }] on word-boundary quotes (gershayim inside a word stay). */
function splitQuoted(input) {
  const s = String(input || '');
  const out = [];
  let buf = '';
  let inPhrase = false;
  const isSpace = (ch) => ch === undefined || /[\s,;.!?()[\]{}|]/.test(ch);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (PHRASE_QUOTES.has(ch)) {
      const prev = s[i - 1];
      const next = s[i + 1];
      // `-"a b"`: a minus right before an opening quote still opens the phrase.
      const opens = (isSpace(prev) || prev === '-') && !isSpace(next);
      if (!inPhrase && opens) {
        out.push({ text: buf, phrase: false });
        buf = '';
        inPhrase = true;
        continue;
      }
      if (inPhrase && isSpace(next)) {
        out.push({ text: buf, phrase: true });
        buf = '';
        inPhrase = false;
        continue;
      }
    }
    buf += ch;
  }
  out.push({ text: buf, phrase: inPhrase });
  return out.filter((x) => x.text.trim());
}

const norm = (w) => dict.normKey(w);
const uniq = (list) => [...new Set(list.filter(Boolean))];

// ---------------------------------------------------------------------------
// Prefixes & suffixes (תחיליות וסופיות)
// ---------------------------------------------------------------------------

/** Proclitics מש"ה וכל"ב and their legal compounds (never "הב", "בה", "לב" ...). */
const PREFIXES = ['ו', 'ש', 'ה', 'ב', 'כ', 'ל', 'מ', 'וב', 'וכ', 'ול', 'ומ', 'וה', 'וש', 'שב', 'שכ', 'של', 'שמ', 'שה', 'כש', 'לכ', 'מב', 'מה', 'ושב', 'ושל', 'וכש'];
/** Aramaic genitive ד and its compounds (for Aramaic equivalents only). */
const ARAMAIC_PREFIXES = ['ד', 'וד', 'בד', 'דב', 'דל', 'דמ'];
const PREFIX_SET = new Set(PREFIXES);
const ARAMAIC_PREFIX_SET = new Set([...PREFIXES, ...ARAMAIC_PREFIXES]);

/** Hebrew & Rabbinic noun suffixes (index form: ים -> ימ, ך -> כ, ...). */
const SUFFIXES = ['ימ', 'ינ', 'ות', 'י', 'ו', 'ה', 'כ', 'נו', 'כמ', 'המ', 'הנ', 'יו', 'יה', 'יהמ'];
/** Endings on a plain stem (שבת -> שבתות, שבתו, שבתם ...). */
const STEM_SUFFIXES = ['', ...SUFFIXES, 'מ', 'נ', 'כנ', 'יהנ', 'יכמ', 'ינו', 'יכ'];
/** Possessives after the feminine construct ־ת (תפילתו, ברכתנו, תפילתם). */
const CONSTRUCT_SUFFIXES = ['', 'ו', 'י', 'ה', 'כ', 'נו', 'כמ', 'כנ', 'מ', 'נ'];
/** Possessives after a plural ־ות (תפילותיו, שבתותיהם). */
const PLURAL_SUFFIXES = ['', 'י', 'יו', 'יה', 'יכ', 'ינו', 'יכמ', 'יהמ', 'יהנ'];

/** Words this short are never prefixed, inflected or respelled. */
const SHORT_WORD = 2;

/** True for a legal proclitic sequence (PREFIXES). */
function isValidPrefix(p) {
  return PREFIX_SET.has(p);
}

const isFeminine = (lemma) => lemma.length >= 3 && lemma.endsWith('ה');

/**
 * Inflected forms of one lemma (no prefixes), in index form.
 *   inflections('שבת')   -> שבת, שבתות, שבתו, שבתי, שבתותיו, ...
 *   inflections('תפילה') -> תפילה, תפילת, תפילתו, תפילות, תפילותיו, ...
 *   inflections('מצוה')  -> מצוה, מצות, מצותו, מצוות, ...
 * A typed plural also reaches its lemma: ברכות -> ברכה forms, דברים -> דבר forms.
 */
const inflectionCache = new Map();
function inflections(word) {
  const w = String(word || '');
  if (inflectionCache.has(w)) return inflectionCache.get(w);
  const out = new Set([w]);
  if (w.length > SHORT_WORD && !/\d|[a-z]/i.test(w)) {
    const add = (base, list) => list.forEach((s) => out.add(base + s));
    const lemmas = [w];
    if (w.length >= 5 && w.endsWith('ות')) lemmas.push(w.slice(0, -2) + 'ה');
    if (w.length >= 5 && (w.endsWith('ימ') || w.endsWith('ינ'))) lemmas.push(w.slice(0, -2));
    for (const l of lemmas) {
      out.add(l);
      if (isFeminine(l)) {
        const s = l.slice(0, -1);
        add(s + 'ת', CONSTRUCT_SUFFIXES);
        add(s + 'ות', PLURAL_SUFFIXES);
      } else {
        add(l, STEM_SUFFIXES);
        add(l + 'ות', PLURAL_SUFFIXES);
      }
    }
  }
  if (inflectionCache.size > 4000) inflectionCache.clear();
  inflectionCache.set(w, out);
  return out;
}

/**
 * FTS5 roots covering every inflection of `word` (prefix queries, `star`), before prefixes.
 * Masculine: one prefix query on the stem; feminine: the lemma + ־ת* + ־ות*.
 */
function morphRoots(word) {
  const w = String(word || '');
  if (w.length <= SHORT_WORD) return [{ text: w, star: false }];
  const roots = [];
  const lemmas = [w];
  if (w.length >= 5 && w.endsWith('ות')) lemmas.push(w.slice(0, -2) + 'ה');
  if (w.length >= 5 && (w.endsWith('ימ') || w.endsWith('ינ'))) lemmas.push(w.slice(0, -2));
  for (const l of lemmas) {
    if (isFeminine(l)) {
      const s = l.slice(0, -1);
      roots.push({ text: l, star: false }, { text: s + 'ת', star: true }, { text: s + 'ות', star: true });
    } else roots.push({ text: l, star: true });
  }
  // A root covered by a shorter prefix-query root is redundant.
  return roots.filter((r, i) => !roots.some((o, j) => j !== i && o.star && r.text.startsWith(o.text) && (o.text !== r.text || j < i)));
}

/** True when `token` = legal prefix? + an inflection of `lemma`. */
function matchesMorph(token, lemma) {
  const forms = inflections(lemma);
  if (forms.has(token)) return true;
  if (lemma.length <= SHORT_WORD) return false;
  for (let n = 1; n <= 3 && n < token.length; n++) if (PREFIX_SET.has(token.slice(0, n)) && forms.has(token.slice(n))) return true;
  return false;
}

/** True when `token` = legal prefix? + `word` (Aramaic ד-prefixes too when `aramaic`). */
function matchesPrefixed(token, word, aramaic) {
  if (token === word) return true;
  const set = aramaic ? ARAMAIC_PREFIX_SET : PREFIX_SET;
  for (let n = 1; n <= 3 && n < token.length; n++) if (token.slice(n) === word && set.has(token.slice(0, n))) return true;
  return false;
}

/** Prefixed spellings of a word ("שבת" -> ["שבת", "ושבת", "בשבת", ...]); none for short words. */
function prefixedForms(word, aramaic) {
  if (word.length <= SHORT_WORD) return [word];
  return [word, ...(aramaic ? [...PREFIXES, ...ARAMAIC_PREFIXES] : PREFIXES).map((p) => p + word)];
}

// ---------------------------------------------------------------------------
// Smart plene / defective spelling (כתיב מלא / חסר)
// ---------------------------------------------------------------------------

/** Curated spelling families (both directions). */
const PLENE_PAIRS = [
  ['אלהים', 'אלוהים'], ['אלהינו', 'אלוהינו'], ['אלהי', 'אלוהי'], ['דוד', 'דויד'], ['יעקב', 'יעקוב'], ['ירושלים', 'ירושלם'],
  ['פינחס', 'פנחס'], ['תצוה', 'תצווה'], ['תפילין', 'תפלין'], ['מצוה', 'מצווה'], ['מצות', 'מצוות'], ['עניין', 'ענין'],
  ['בניין', 'בנין'], ['כוונה', 'כונה'], ['תפילה', 'תפלה'], ['לימוד', 'למוד'], ['דיבור', 'דבור'], ['קידושין', 'קדושין'],
  ['שולחן', 'שלחן'], ['חוכמה', 'חכמה'], ['כולם', 'כלם'], ['תשובה', 'תשבה'], ['כותל', 'כתל'], ['כוהן', 'כהן'],
  ['אוהל', 'אהל'], ['ציצית', 'צצית'], ['כיפורים', 'כפורים'], ['צווה', 'צוה'], ['עוון', 'עון'], ['מזוזה', 'מזזה'],
  ['ראשון', 'ראשן'], ['שמונה', 'שמנה'], ['תיקון', 'תקון'], ['סיפור', 'ספור'], ['ביטול', 'בטול'], ['גירושין', 'גרושין'],
].map((g) => g.map(norm));
const PLENE_MAP = new Map();
for (const g of PLENE_PAIRS) for (const w of g) PLENE_MAP.set(w, uniq([...(PLENE_MAP.get(w) || []), ...g.filter((x) => x !== w)]));

/** Spellings that are different words and must never be linked. */
const PLENE_FORBIDDEN = new Set(
  [['שלום', 'שלם'], ['שיר', 'שר'], ['שיר', 'שור'], ['שור', 'שר'], ['עיר', 'ער'], ['בוקר', 'בקר'], ['דין', 'דיין'], ['דברי', 'דבר'], ['ילד', 'לד']]
    .map((p) => p.map(norm))
    .flatMap(([a, b]) => [a + '|' + b, b + '|' + a]),
);

const isMater = (c) => c === 'ו' || c === 'י';
/** A word ending in a plural suffix over a stem of at most 3 letters (שירים, ערים) is left alone. */
const shortPluralStem = (w) => /(ימ|ינ|ות)$/.test(w) && w.length - 2 <= 3;

/**
 * Full / defective spelling variants of one normalized word (the word itself excluded), most
 * plausible first:
 *   pleneVariants('מצווה') -> ['מצוה', ...]   pleneVariants('ענינ') -> ['עניינ', ...]
 *   pleneVariants('שולחנ') -> ['שלחנ', ...]   pleneVariants('תפלה') -> [..., 'תפילה', ...]
 * Never: drop an initial ו / י (ילד), drop a final letter (דברי), touch the final syllable
 * (שלום -> שלם) or touch a word of 3 letters (שיר -> שר).
 */
function pleneVariants(word, max) {
  const limit = max == null ? 8 : max;
  const w = String(word || '');
  const out = [];
  const push = (v) => {
    if (!v || v === w || v.length < 3 || out.includes(v) || PLENE_FORBIDDEN.has(w + '|' + v)) return;
    if (v[0] !== w[0] || v[v.length - 1] !== w[w.length - 1]) return; // first / last letter are never changed
    out.push(v);
  };
  for (const v of PLENE_MAP.get(w) || []) push(v);
  if (w.length >= 4 && !/\d|[a-z]/i.test(w) && !shortPluralStem(w)) {
    const n = w.length;
    // 1. Doubled consonantal ו / י -> single (מצווה -> מצוה, עניינ -> ענינ).
    if (n >= 5) for (let i = 1; i < n - 2; i++) if (isMater(w[i]) && w[i + 1] === w[i] && !isMater(w[i - 1]) && !isMater(w[i + 2])) push(w.slice(0, i) + w.slice(i + 1));
    // 2. Male -> chaser: one medial mater dropped, never in the final syllable (index n-2).
    if (n >= 5) for (let i = 1; i <= n - 3; i++) if (isMater(w[i]) && !isMater(w[i - 1]) && !isMater(w[i + 1])) push(w.slice(0, i) + w.slice(i + 1));
    // 3. Chaser -> male: one mater inserted between two consonants, never before the last letter;
    //    only into a fully defective word, or a long one (קדושינ -> קידושינ): שלום must not reach שילום.
    const medialMater = [...w.slice(1, -1)].some(isMater);
    for (let p = 1; p <= n - 2 && (!medialMater || n >= 6); p++) {
      if (isMater(w[p - 1]) || isMater(w[p])) continue;
      push(w.slice(0, p) + 'י' + w.slice(p));
      push(w.slice(0, p) + 'ו' + w.slice(p));
    }
    // 4. Single consonantal ו / י -> doubled (מצוה -> מצווה, ענינ -> עניינ, כונה -> כוונה).
    for (let i = 1; i <= n - 2; i++) {
      if (!isMater(w[i]) || isMater(w[i - 1]) || isMater(w[i + 1])) continue;
      if ((i === n - 2 && /[הנת]$/.test(w)) || (i === n - 3 && w.endsWith('ה'))) push(w.slice(0, i + 1) + w[i] + w.slice(i + 1));
    }
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Hebrew <-> Aramaic (עברית <-> ארמית)
// ---------------------------------------------------------------------------

const ARAMAIC_GROUPS = [
  ['מותר', 'שרי'], ['אסור', 'אסיר'], ['קושיה', 'קשיא', 'קושיא'], ['תירוץ', 'תרוצא', 'תירוצא'], ['ספק', 'ספיקא', 'ספקא'],
  ['הלכה', 'הלכתא'], ['טעם', 'טעמא'], ['ראיה', 'ראייתא', 'ראיתא'], ['מים', 'מיא'], ['שבת', 'שבתא'], ['דין', 'דינא'],
  ['כסף', 'כספא', 'ממונא'], ['ממון', 'ממונא'], ['עדים', 'סהדי'], ['עד', 'סהדא'], ['אדם', 'איניש', 'גברא'], ['אשה', 'אתתא'],
  ['בית', 'ביתא'], ['שנה', 'שתא'], ['יום', 'יומא'], ['דבר', 'מילתא', 'מלתא'], ['למה', 'אמאי'], ['כאן', 'הכא'], ['שם', 'התם'],
  ['יש', 'איכא'], ['אין', 'ליכא'], ['גדול', 'רבה'], ['קטן', 'זוטא'], ['לילה', 'ליליא'], ['אמת', 'קושטא'],
].map((g) => g.map(norm));
const ARAMAIC_MAP = new Map();
for (const g of ARAMAIC_GROUPS) for (const w of g) ARAMAIC_MAP.set(w, uniq([...(ARAMAIC_MAP.get(w) || []), ...g.filter((x) => x !== w)]));

/** Hebrew <-> Aramaic equivalents of a normalized word: aramaicEquivalents('מותר') -> ['שרי']. */
function aramaicEquivalents(word) {
  return (ARAMAIC_MAP.get(String(word || '')) || []).slice();
}

// ---------------------------------------------------------------------------
// Torah acronyms (ראשי תיבות)
// ---------------------------------------------------------------------------

/** Full phrases of a typed abbreviation (normalized): 'ק"ו' -> ['קל וחומר']. */
function acronymExpansions(raw) {
  return dict.expandAbbreviation(raw, { strict: true }).slice(0, 3);
}

/** Abbreviations of a normalized phrase ('קל וחומר' -> ['קו', 'קוח']), noisy common words excluded. */
function acronymsFor(phrase) {
  return dict.abbreviationsFor(phrase).filter((a) => a.length >= 2 && !dict.STOP_WORDS.has(a) && a !== phrase);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Simple Search: literal FTS5 (no operators, no expansion). */
const SIMPLE_DEFAULTS = Object.freeze({
  prefixesAndSuffixes: false,
  pleneDefective: false,
  acronyms: false,
  aramaicEquiv: false,
  operators: false,
  proximity: Object.freeze({ mode: 'paragraph', distance: 5, ordered: false }),
});

/** Advanced Search screen defaults. */
const ADVANCED_DEFAULTS = Object.freeze({
  prefixesAndSuffixes: true,
  pleneDefective: false,
  acronyms: false,
  aramaicEquiv: false,
  operators: true,
  proximity: Object.freeze({ mode: 'paragraph', distance: 5, ordered: false }),
});

const NEAR_DISTANCES = [3, 5, 10];

function resolveOptions(opts, base) {
  const o = { ...(base || SIMPLE_DEFAULTS), ...(opts || {}) };
  const p = { ...(base || SIMPLE_DEFAULTS).proximity, ...((opts && opts.proximity) || {}) };
  if (!['paragraph', 'phrase', 'near'].includes(p.mode)) p.mode = 'paragraph';
  p.distance = Math.max(0, Math.min(50, Math.floor(Number(p.distance) || 5)));
  p.ordered = !!p.ordered;
  o.proximity = p;
  return o;
}

// ---------------------------------------------------------------------------
// Parsing the fields
// ---------------------------------------------------------------------------

/**
 * Atoms of one field: { tokens, raw, phrase, wildcard, neg, orNext }.
 * With operators: "a b" phrase, a|b OR, -word NOT, word* prefix wildcard.
 */
function parseAtoms(input, withOperators) {
  const atoms = [];
  let negNext = false;
  for (const seg of splitQuoted(input)) {
    if (seg.phrase) {
      const tokens = toTokens(seg.text);
      if (tokens.length) atoms.push({ tokens, raw: seg.text, phrase: true, wildcard: false, neg: negNext });
      negNext = false;
      continue;
    }
    let text = seg.text;
    if (withOperators) text = text.replace(/\|/g, ' | ');
    const raws = text.split(/[\s,;!?()[\]{}]+/).filter(Boolean);
    for (let i = 0; i < raws.length; i++) {
      let raw = raws[i];
      if (withOperators && raw === '|') {
        if (atoms.length && !atoms[atoms.length - 1].neg) atoms[atoms.length - 1].orNext = true;
        continue;
      }
      let neg = false;
      let wildcard = false;
      if (withOperators) {
        if (/^[-−]/.test(raw)) {
          neg = true;
          raw = raw.replace(/^[-−]+/, '');
          if (!raw) {
            if (i === raws.length - 1) negNext = true; // `-"a b"`
            continue;
          }
        }
        if (/\*+$/.test(raw)) {
          wildcard = true;
          raw = raw.replace(/\*+$/, '');
        }
      }
      const tokens = toTokens(raw);
      if (!tokens.length) continue;
      if (tokens.length === 1) atoms.push({ tokens, raw, phrase: false, wildcard, neg });
      else tokens.forEach((t, k) => atoms.push({ tokens: [t], raw: t, phrase: false, wildcard: wildcard && k === tokens.length - 1, neg }));
    }
  }
  return atoms;
}

/** Atoms -> OR-chains (a | b | c) of positive atoms + the negated atoms. */
function chainAtoms(atoms) {
  const chains = [];
  const negs = [];
  let open = false;
  for (const a of atoms) {
    if (a.neg) {
      negs.push(a);
      open = false;
      continue;
    }
    if (open && chains.length) chains[chains.length - 1].push(a);
    else chains.push([a]);
    open = !!a.orNext;
  }
  return { chains, negs };
}

// ---------------------------------------------------------------------------
// Expansion: atom -> alternatives
// ---------------------------------------------------------------------------

// Alternative: { kind: 'word', pat, exact } | { kind: 'seq', pats: [...], exact }
const wordAlt = (pat, exact) => ({ kind: 'word', pat, exact: !!exact });
const seqAlt = (pats, exact) => ({ kind: 'seq', pats, exact: !!exact });
const altKey = (a) => (a.kind === 'word' ? a.pat : 'seq:' + a.pats.join(' '));

/** Budgets (FTS5 terms) so every query stays fast on the full library. */
const MAX_TERMS_PER_WORD = 220;
const MAX_QUERY_TERMS = 640;
const MAX_ATOMS = 16;

/** Expanded alternatives of one atom (exact first). */
function expandAtom(atom, o, budget) {
  const alts = [];
  let used = 0;
  const add = (alt) => {
    if (alts.some((a) => altKey(a) === altKey(alt))) return true;
    const cost = altCost(alt);
    if (alts.length && used + cost > budget) return false;
    alts.push(alt);
    used += cost;
    return true;
  };
  if (atom.phrase) {
    add(atom.tokens.length > 1 ? seqAlt(atom.tokens, true) : wordAlt(atom.tokens[0], true));
    return alts;
  }
  const tok = atom.tokens[0];
  if (atom.wildcard) {
    add(wordAlt(tok + '*', true));
    return alts;
  }
  add(wordAlt(tok, true));
  const plain = /^\d+$/.test(tok) || /[a-z]/i.test(tok);
  if (plain) return alts;
  const ps = o.prefixesAndSuffixes;
  const short = tok.length <= SHORT_WORD;
  // 1. The typed word, inflected (an abbreviation such as שו"ע only takes prefixes: בשו"ע).
  const marked = dict.hasAbbrevMark(atom.raw);
  if (ps && !short) add(wordAlt((marked ? '^' : '~') + tok)) || add(wordAlt('^' + tok));
  // 2. Torah acronyms.
  if (o.acronyms) {
    for (const full of marked || tok.length >= 3 ? acronymExpansions(atom.raw) : []) {
      const words = full.split(' ');
      if (words.length > 1) add(seqAlt([(ps ? '^' : '') + words[0], ...words.slice(1)]));
      else add(wordAlt((ps ? '~' : '') + full));
      for (const a of acronymsFor(full)) if (a !== tok) add(wordAlt((ps ? '^' : '') + a));
    }
    for (const a of acronymsFor(tok)) add(wordAlt((ps ? '^' : '') + a));
  }
  // 3. Plene / defective spellings (each inflected when prefixes & suffixes are on).
  if (o.pleneDefective && !short) {
    for (const v of pleneVariants(tok, 6)) {
      if (!(ps && add(wordAlt('~' + v)))) add(wordAlt(v));
    }
  }
  // 4. Hebrew <-> Aramaic.
  if (o.aramaicEquiv) {
    for (const e of aramaicEquivalents(tok)) {
      if (!(ps && e.length > SHORT_WORD && add(wordAlt('%' + e)))) add(wordAlt(e));
    }
  }
  return alts;
}

/** A typed dictionary phrase ("קל וחומר") with acronyms on: the phrase OR its acronyms. */
function phraseAlts(tokens, o) {
  const ps = o.prefixesAndSuffixes;
  const alts = [seqAlt(tokens, true)];
  if (ps) alts.push(seqAlt(['^' + tokens[0], ...tokens.slice(1)]));
  for (const a of acronymsFor(tokens.join(' '))) alts.push(wordAlt((ps ? '^' : '') + a));
  return alts;
}

// ---------------------------------------------------------------------------
// Patterns: matching tokens and FTS5 terms
// ---------------------------------------------------------------------------

function parsePattern(p) {
  const c = p[0];
  if (c === '~') return { type: 'morph', text: p.slice(1) };
  if (c === '^') return { type: 'pre', text: p.slice(1) };
  if (c === '%') return { type: 'aram', text: p.slice(1) };
  if (p.endsWith('*')) return { type: 'star', text: p.slice(0, -1) };
  return { type: 'exact', text: p };
}

const matcherCache = new Map();
/** Compiled token predicate of one word pattern. */
function compilePattern(p) {
  let fn = matcherCache.get(p);
  if (fn) return fn;
  const { type, text } = parsePattern(p);
  if (!text) fn = () => false;
  else if (type === 'morph') fn = (t) => matchesMorph(t, text);
  else if (type === 'pre') fn = (t) => matchesPrefixed(t, text, false);
  else if (type === 'aram') fn = (t) => matchesPrefixed(t, text, true);
  else if (type === 'star') fn = (t) => t.startsWith(text);
  else fn = (t) => t === text;
  if (matcherCache.size > 4000) matcherCache.clear();
  matcherCache.set(p, fn);
  return fn;
}

/** FTS5 terms of one word pattern ("x", "x"*). `superset`: true when the terms over-match. */
function patternFts(p) {
  const { type, text } = parsePattern(p);
  if (type === 'exact') return { terms: [`"${text}"`], superset: false };
  if (type === 'star') return { terms: [`"${text}"*`], superset: false };
  if (type === 'pre' || type === 'aram') return { terms: prefixedForms(text, type === 'aram').map((f) => `"${f}"`), superset: false };
  const terms = [];
  const roots = morphRoots(text);
  const pres = text.length <= SHORT_WORD ? [''] : ['', ...PREFIXES];
  for (const r of roots) for (const pre of pres) terms.push(`"${pre}${r.text}"${r.star ? '*' : ''}`);
  return { terms: uniq(terms), superset: roots.some((r) => r.star) };
}

/** FTS5 terms of a consecutive sequence: only its first word may carry prefixes. */
function seqFts(pats) {
  const first = parsePattern(pats[0]);
  const rest = pats.slice(1).map((x) => parsePattern(x).text);
  const heads = first.type === 'pre' || first.type === 'aram' ? prefixedForms(first.text, first.type === 'aram') : [first.text];
  const superset = pats.slice(1).some((x) => parsePattern(x).type !== 'exact') || !['exact', 'pre', 'aram'].includes(first.type);
  return { terms: heads.map((h) => `"${[h, ...rest].join(' ')}"`), superset };
}

function altFts(a) {
  return a.kind === 'word' ? patternFts(a.pat) : seqFts(a.pats);
}
function altCost(a) {
  return altFts(a).terms.length;
}

/** LIKE substrings that every match of an alternative contains (no-FTS5 fallback). */
function altLike(a) {
  if (a.kind === 'seq') return [a.pats.map((x) => parsePattern(x).text).join(' ')];
  const { type, text } = parsePattern(a.pat);
  if (type === 'morph' && text.length > SHORT_WORD) return uniq(morphRoots(text).map((r) => r.text));
  return [text];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const orExpr = (terms) => (terms.length === 1 ? terms[0] : '(' + terms.join(' OR ') + ')');

function groupFts(g) {
  const terms = [];
  let superset = false;
  for (const a of g.alts) {
    const f = altFts(a);
    terms.push(...f.terms);
    superset = superset || f.superset;
  }
  return { expr: orExpr(uniq(terms)), count: uniq(terms).length, superset };
}

/** FTS5 terms of a NOT-group that never over-match (morph forms only exactly: verification does the rest). */
function notGroupFts(g) {
  const terms = [];
  for (const a of g.alts) {
    const f = altFts(a);
    if (!f.superset) terms.push(...f.terms);
    else if (a.kind === 'word') terms.push(`"${parsePattern(a.pat).text}"`);
  }
  return uniq(terms);
}

const nativeWord = (g) => g.alts.length === 1 && ((g.alts[0].kind === 'word' && parsePattern(g.alts[0].pat).type === 'exact') || (g.alts[0].kind === 'seq' && g.alts[0].pats.every((x) => parsePattern(x).type === 'exact')));
const groupTokens = (g) => (g.alts[0].kind === 'word' ? [g.alts[0].pat] : g.alts[0].pats);

/** Compiles groups + proximity into FTS5 expressions. */
function compile(must, any, not, prox) {
  let variantCount = 0;
  let superset = false;
  const mustFts = must.map(groupFts);
  const anyFts = any.map(groupFts);
  for (const f of [...mustFts, ...anyFts]) {
    variantCount += f.count;
    superset = superset || f.superset;
  }
  let mustExpr = mustFts.map((f) => f.expr).join(' AND ');
  let proxVerify = false;
  if (must.length > 1 && prox.mode !== 'paragraph') {
    const native = must.every(nativeWord);
    if (native && prox.mode === 'phrase') mustExpr = `"${must.flatMap(groupTokens).join(' ')}"`;
    else if (native) {
      mustExpr = `NEAR(${must.map((g) => `"${groupTokens(g).join(' ')}"`).join(' ')}, ${prox.distance})`;
      proxVerify = prox.ordered;
    } else proxVerify = true;
  }
  const positive = [mustExpr, anyFts.length ? orExpr(anyFts.map((f) => f.expr)) : ''].filter(Boolean).map((e, i, arr) => (arr.length > 1 && / OR | AND /.test(e) && !e.startsWith('(') ? `(${e})` : e));
  const positiveMatch = positive.join(' AND ');
  const notTerms = uniq(not.flatMap(notGroupFts));
  const notSuperset = not.some((g) => g.alts.some((a) => altFts(a).superset));
  const lhs = / (AND|OR) /.test(positiveMatch.replace(/"[^"]*"/g, '""')) ? `(${positiveMatch})` : positiveMatch;
  const match = positiveMatch ? (notTerms.length ? `${lhs} NOT ${orExpr(notTerms)}` : positiveMatch) : '';
  return { match, positiveMatch, variantCount, needsVerify: superset || notSuperset || proxVerify };
}

/** Highlight patterns of positive groups (words + consecutive sequences). */
function groupTerms(groups) {
  const out = [];
  for (const g of groups) for (const a of g.alts) out.push(a.kind === 'word' ? a.pat : a.pats.join(' '));
  return uniq(out);
}

/**
 * Build a search plan.
 * @param {string | { query?: string, anyOf?: string, exclude?: string }} fields
 * @param {object} [options]  SIMPLE_DEFAULTS when omitted; pass ADVANCED_DEFAULTS (or a merge) for advanced.
 */
function buildQuery(fields, options) {
  const f = typeof fields === 'string' ? { query: fields } : fields || {};
  const o = resolveOptions(options, options && options.operators ? ADVANCED_DEFAULTS : SIMPLE_DEFAULTS);
  const main = parseAtoms(f.query, o.operators);
  const { chains, negs } = chainAtoms(main);
  const anyAtoms = parseAtoms(f.anyOf, false);
  const exclAtoms = [...negs, ...parseAtoms(f.exclude, false)];

  // Budgets: per-word terms shrink as the query grows.
  const atomCount = Math.max(1, chains.reduce((n, c) => n + c.length, 0) + anyAtoms.length + exclAtoms.length);
  const budget = Math.max(26, Math.min(MAX_TERMS_PER_WORD, Math.floor(MAX_QUERY_TERMS / atomCount)));
  let atomsLeft = MAX_ATOMS;
  const take = () => atomsLeft-- > 0;

  const must = [];
  for (const chain of chains) {
    const alts = [];
    for (const a of chain) if (take()) for (const x of expandAtom(a, o, budget)) if (!alts.some((y) => altKey(y) === altKey(x))) alts.push(x);
    if (alts.length) must.push({ alts, atoms: chain });
  }
  if (o.acronyms) mergeDictionaryPhrases(must, o);
  const any = [];
  for (const a of anyAtoms) if (take()) any.push({ alts: expandAtom(a, o, budget), atoms: [a] });
  const not = [];
  for (const a of exclAtoms) if (take()) not.push({ alts: expandAtom({ ...a, neg: false }, o, budget), atoms: [a] });

  const plan = finish(must, any, not, o);
  const exactOf = (gs) => gs.map((g) => ({ alts: g.alts.filter((a) => a.exact), atoms: g.atoms }));
  const hasExpansions = [...must, ...any].some((g) => g.alts.some((a) => !a.exact));
  if (hasExpansions && !plan.empty) {
    plan.exact = finish(exactOf(must), exactOf(any), not, o);
    plan.exactTerms = plan.exact.terms;
  } else plan.exact = null;
  plan.hasExpansions = hasExpansions;
  return plan;
}

function finish(must, any, not, o) {
  const empty = must.length === 0 && any.length === 0;
  const c = empty ? { match: '', positiveMatch: '', variantCount: 0, needsVerify: false } : compile(must, any, not, o.proximity);
  return {
    kind: 'hebrewSearch',
    must,
    any,
    not,
    options: o,
    proximity: o.proximity,
    match: c.match,
    positiveMatch: c.positiveMatch,
    variantCount: c.variantCount,
    needsVerify: c.needsVerify,
    terms: groupTerms([...must, ...any]),
    empty,
  };
}

/** Consecutive single-word groups that spell a dictionary phrase ("קל וחומר") -> one group. */
function mergeDictionaryPhrases(must, o) {
  const maxN = dict.maxFullPhraseWords();
  for (let i = 0; i < must.length; i++) {
    const single = (g) => g && g.atoms.length === 1 && !g.atoms[0].phrase && !g.atoms[0].wildcard;
    for (let n = Math.min(maxN, must.length - i); n >= 2; n--) {
      const slice = must.slice(i, i + n);
      if (!slice.every(single)) continue;
      const tokens = slice.map((g) => g.atoms[0].tokens[0]);
      if (!dict.isFullPhrase(tokens)) continue;
      must.splice(i, n, { alts: phraseAlts(tokens, o), atoms: slice.flatMap((g) => g.atoms) });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Precise evaluation of one paragraph (clean_text tokens)
// ---------------------------------------------------------------------------

/** Spans [start, end] where a group matches. */
function groupSpans(g, tokens) {
  const spans = [];
  for (const a of g.alts) {
    if (a.kind === 'word') {
      const m = compilePattern(a.pat);
      for (let i = 0; i < tokens.length; i++) if (m(tokens[i])) spans.push([i, i]);
    } else {
      const ms = a.pats.map(compilePattern);
      for (let i = 0; i + ms.length <= tokens.length; i++) {
        let ok = true;
        for (let j = 0; j < ms.length && ok; j++) ok = ms[j](tokens[i + j]);
        if (ok) spans.push([i, i + ms.length - 1]);
      }
    }
  }
  return spans;
}

const MAX_SPANS = 80;

/** Proximity / order over the groups' spans (FTS5 NEAR semantics: tokens between first end and last start <= distance). */
function proximityOk(lists, prox) {
  if (lists.length < 2 || prox.mode === 'paragraph') return true;
  const L = lists.map((l) => l.slice(0, MAX_SPANS).sort((a, b) => a[0] - b[0]));
  if (prox.mode === 'phrase') {
    const rec = (k, prevEnd) => k === L.length || L[k].some((s) => s[0] === prevEnd + 1 && rec(k + 1, s[1]));
    return L[0].some((s) => rec(1, s[1]));
  }
  const d = prox.distance;
  const ordered = prox.ordered;
  const chosen = [];
  const overlaps = (s) => chosen.some((c) => !(s[1] < c[0] || s[0] > c[1]));
  const gap = () => {
    let first = chosen[0];
    let lastStart = -Infinity;
    for (const c of chosen) {
      if (c[0] < first[0]) first = c;
      if (c[0] > lastStart) lastStart = c[0];
    }
    return lastStart - first[1] - 1;
  };
  let steps = 0;
  const rec = (k) => {
    if (k === L.length) return true;
    for (const s of L[k]) {
      if (++steps > 20000) return false;
      if (overlaps(s)) continue;
      if (ordered && k > 0 && s[0] <= chosen[k - 1][1]) continue;
      chosen.push(s);
      const ok = gap() <= d && rec(k + 1);
      chosen.pop();
      if (ok) return true;
    }
    return false;
  };
  return rec(0);
}

/** True when a paragraph (its clean_text tokens) satisfies the plan exactly. */
function evaluate(plan, tokens) {
  if (!plan || plan.empty) return false;
  const lists = [];
  for (const g of plan.must) {
    const s = groupSpans(g, tokens);
    if (!s.length) return false;
    lists.push(s);
  }
  if (plan.any.length && !plan.any.some((g) => groupSpans(g, tokens).length)) return false;
  for (const g of plan.not) if (groupSpans(g, tokens).length) return false;
  return proximityOk(lists, plan.proximity);
}

/** evaluate() on raw clean_text. */
function matchesText(plan, cleanText) {
  return evaluate(plan, toTokens(cleanText));
}

/** LIKE fallback: per positive group, substrings (any of) that a match must contain. */
function likeGroups(plan) {
  return {
    must: plan.must.map((g) => uniq(g.alts.flatMap(altLike))),
    any: plan.any.length ? uniq(plan.any.flatMap((g) => g.alts.flatMap(altLike))) : null,
  };
}

/** True when the advanced options differ from ADVANCED_DEFAULTS (for a "reset" hint). */
function optionsEqual(a, b) {
  const x = resolveOptions(a, ADVANCED_DEFAULTS);
  const y = resolveOptions(b, ADVANCED_DEFAULTS);
  return ['prefixesAndSuffixes', 'pleneDefective', 'acronyms', 'aramaicEquiv'].every((k) => x[k] === y[k]) && x.proximity.mode === y.proximity.mode && x.proximity.distance === y.proximity.distance && x.proximity.ordered === y.proximity.ordered;
}

module.exports = {
  PREFIXES,
  ARAMAIC_PREFIXES,
  SUFFIXES,
  SIMPLE_DEFAULTS,
  ADVANCED_DEFAULTS,
  NEAR_DISTANCES,
  MAX_QUERY_TERMS,
  toTokens,
  splitQuoted,
  isValidPrefix,
  inflections,
  morphRoots,
  matchesMorph,
  matchesPrefixed,
  pleneVariants,
  aramaicEquivalents,
  acronymExpansions,
  acronymsFor,
  parseAtoms,
  buildQuery,
  compilePattern,
  patternFts,
  evaluate,
  matchesText,
  likeGroups,
  resolveOptions,
  optionsEqual,
};
