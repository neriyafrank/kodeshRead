/** Hebrew Torah linguistic & abbreviation engine. All returned strings are in normalized index form (finals folded). */

/** Proclitic prefixes (ו ה ב כ ל מ ש + combinations), most frequent first. */
export const PREFIXES: string[];
/** Plural / construct / possessive endings (normalized: ים -> ימ). */
export const SUFFIXES: string[];
/** Words shorter than this are never prefix-expanded or wildcarded. */
export const MIN_EXPAND_LEN: number;
/** Maximum FTS5 OR-variants generated for one word. */
export const MAX_VARIANTS_PER_WORD: number;
/** Common short words an un-marked abbreviation key is never expanded from / to. */
export const STOP_WORDS: Set<string>;

/** normalizeHebrew without punctuation: `רמבם`, `רמב"ם`, `רמב״ם` -> "רמבמ". */
export function normKey(s: string): string;
/** True when a raw token carries gershayim inside or a trailing geresh. */
export function hasAbbrevMark(raw: string): boolean;
/** Defective-spelling skeleton (internal ו / י removed), for spelling-insensitive comparison. */
export function skeleton(word: string): string;
export function skeletonPhrase(phrase: string): string;

/**
 * Full forms of an abbreviation: expandAbbreviation('שו"ע') -> ['שולחנ ערוכ'].
 * strict (search mode): un-marked tokens expand only when >= 3 letters and not a common word;
 * truncations (ישע') only with their geresh.
 */
export function expandAbbreviation(token: string, opts?: { strict?: boolean; truncNeedsMark?: boolean; kinds?: string[] }): string[];
/** Abbreviations of a full phrase (spelling-insensitive): abbreviationsFor('בית דין') -> ['בד', 'ביד']. */
export function abbreviationsFor(phrase: string, opts?: { strict?: boolean }): string[];
/** True when the normalized word sequence is a dictionary full phrase. */
export function isFullPhrase(words: string[] | string): boolean;
export function maxFullPhraseWords(): number;

/** Ktiv male / chaser variants of a normalized word (itself excluded), most plausible first. */
export function ktivVariants(word: string, max?: number): string[];
/** Prefixed forms ("ושבת", "בשבת", ...); none for words shorter than MIN_EXPAND_LEN. */
export function prefixVariants(word: string, max?: number): string[];
/** Uninflected stems ("שבתות" -> "שבת", "מצוות" -> "מצוה"). */
export function suffixStems(word: string): string[];
/** Stems with a leading ו-proclitic stripped ("ובשבת" -> "שבת"). */
export function prefixStems(word: string): string[];
/** FTS5 term variants of a word (trailing `*` = FTS5 prefix query), capped at `max`. */
export function expandWordVariants(word: string, max?: number, opts?: { wildcard?: boolean }): string[];
/** Abbreviation- and spelling-insensitive keys of a normalized token sequence (book lookup). */
export function canonicalForms(tokens: string[], max?: number, opts?: { typed?: boolean }): string[];

/** Abbreviation-aware book filter score (0 = no match; 2 = full canonical match). */
export function bookMatchScore(query: string, title: string, categoryPath?: string | null): number;

/** 1..9999 -> normalized Hebrew numeral (328 -> "שכח", 15 -> "טו"). */
export function intToHebrewNumeral(n: number): string | null;
export function isHebrewNumeral(token: string): boolean;
/** Hebrew numeral or digits -> integer ("קכ\"ד" -> 124). */
export function parseHebrewNumber(token: string): number | null;
export function dictionaryStats(): { entries: number; abbreviations: number; fullPhrases: number; byKind: Record<string, number> };
