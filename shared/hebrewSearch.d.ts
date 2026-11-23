/** Hebrew query engine for Simple / Advanced Search (see shared/hebrewSearch.js). */

export type ProximityMode = 'paragraph' | 'phrase' | 'near';

export interface SearchOptions {
  /** תחיליות וסופיות */
  prefixesAndSuffixes: boolean;
  /** כתיב מלא / חסר */
  pleneDefective: boolean;
  /** ראשי תיבות */
  acronyms: boolean;
  /** עברית <-> ארמית */
  aramaicEquiv: boolean;
  /** Inline operators a|b, -word, word*, "exact" (Advanced only). */
  operators: boolean;
  proximity: { mode: ProximityMode; distance: number; ordered: boolean };
}

export type SearchOptionsInput = Partial<Omit<SearchOptions, 'proximity'>> & { proximity?: Partial<SearchOptions['proximity']> };

export interface PlanAlt {
  kind: 'word' | 'seq';
  pat?: string;
  pats?: string[];
  exact: boolean;
}
export interface PlanGroup {
  alts: PlanAlt[];
  atoms: unknown[];
}

export interface SearchPlan {
  kind: 'hebrewSearch';
  must: PlanGroup[];
  any: PlanGroup[];
  not: PlanGroup[];
  options: SearchOptions;
  proximity: SearchOptions['proximity'];
  /** FTS5 MATCH expression (a candidate superset when needsVerify). */
  match: string;
  positiveMatch: string;
  variantCount: number;
  needsVerify: boolean;
  /** Highlight patterns ("x", "x*", "~x", "^x", "%x", "a b"). */
  terms: string[];
  empty: boolean;
  /** The typed-words-only sub-plan (ranked first), or null when nothing was expanded. */
  exact?: SearchPlan | null;
  exactTerms?: string[];
  hasExpansions?: boolean;
}

export const PREFIXES: string[];
export const ARAMAIC_PREFIXES: string[];
export const SUFFIXES: string[];
export const SIMPLE_DEFAULTS: Readonly<SearchOptions>;
export const ADVANCED_DEFAULTS: Readonly<SearchOptions>;
export const NEAR_DISTANCES: number[];
export const MAX_QUERY_TERMS: number;

export function toTokens(text: string): string[];
export function splitQuoted(input: string): { text: string; phrase: boolean }[];
export function isValidPrefix(p: string): boolean;
export function inflections(word: string): Set<string>;
export function morphRoots(word: string): { text: string; star: boolean }[];
export function matchesMorph(token: string, lemma: string): boolean;
export function matchesPrefixed(token: string, word: string, aramaic?: boolean): boolean;
export function pleneVariants(word: string, max?: number): string[];
export function aramaicEquivalents(word: string): string[];
export function acronymExpansions(raw: string): string[];
export function acronymsFor(phrase: string): string[];
export function parseAtoms(input: string, withOperators: boolean): { tokens: string[]; raw: string; phrase: boolean; wildcard: boolean; neg: boolean; orNext?: boolean }[];
/** Simple Search: buildQuery(text). Advanced: buildQuery({ query, anyOf, exclude }, { ...ADVANCED_DEFAULTS, ... }). */
export function buildQuery(fields: string | { query?: string; anyOf?: string; exclude?: string }, options?: SearchOptionsInput): SearchPlan;
export function compilePattern(pattern: string): (token: string) => boolean;
export function patternFts(pattern: string): { terms: string[]; superset: boolean };
export function evaluate(plan: SearchPlan, tokens: string[]): boolean;
export function matchesText(plan: SearchPlan, cleanText: string): boolean;
export function likeGroups(plan: SearchPlan): { must: string[][]; any: string[] | null };
export function resolveOptions(opts: SearchOptionsInput | null | undefined, base?: SearchOptions): SearchOptions;
export function optionsEqual(a: SearchOptionsInput, b: SearchOptionsInput): boolean;
