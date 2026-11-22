import type { LibraryDb } from './sources';

export type SearchScope =
  | { kind: 'all' }
  | { kind: 'category'; path: string; name: string }
  | { kind: 'book'; bookId: number; title: string };

export type QueryAlt =
  | { type: 'term'; text: string; prefix: boolean }
  | { type: 'phrase'; tokens: string[]; prefix: boolean }
  | { type: 'and'; groups: QueryGroup[] };
/** OR of alternatives; a query is the AND of its groups. */
export interface QueryGroup {
  alts: QueryAlt[];
}

export interface ParsedQuery {
  /** Safe FTS5 MATCH expression (every token / phrase double-quoted; groups AND-ed). */
  match: string;
  /**
   * Highlight patterns: normalized tokens ("שבת"); in smart mode also prefix patterns
   * ("ושלחנ*") and multi-word phrases ("בית דינ"). See makeTermMatcher.
   */
  terms: string[];
  phrases: string[][];
  groups: QueryGroup[];
  /** True for "חיפוש מורחב" (morphological / abbreviation expansion). */
  smart: boolean;
  /** Number of FTS5 terms generated (smart mode). */
  variantCount?: number;
  empty: boolean;
}

export interface TermMatcher {
  empty: boolean;
  /** `words`: tokens of each displayed word; returns which words are (part of) a hit. */
  hits(words: string[][]): boolean[];
}

export interface SearchRow {
  id: number;
  book_id: number;
  line_index: number;
  toc_path: string | null;
  display_text: string;
  is_heading: number;
  book_title: string;
}

export interface KwicSegment {
  text: string;
  hit: boolean;
}
export interface Kwic {
  segments: KwicSegment[];
  hitCount: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

export const FTS_RESERVED_RE: RegExp;
export const PAGE_SIZE: number;
export const COUNT_CAP: number;
/** Upper bound on FTS5 OR-variants in one smart query. */
export const MAX_QUERY_VARIANTS: number;
export function splitPhrases(input: string): { text: string; phrase: boolean }[];
/** `smart`: abbreviation / ktiv / prefix-suffix expansion ("חיפוש מורחב"); default exact. */
export function parseSearchQuery(input: string, opts?: { smart?: boolean }): ParsedQuery;
export function scopeClause(scope: SearchScope | null | undefined): { sql: string; params: (string | number)[] };
/** False on SQLite builds without FTS5 (web preview); the app then uses a LIKE fallback. */
export function hasFts5(db: LibraryDb): Promise<boolean>;
export function searchParagraphs(
  db: LibraryDb,
  query: string | ParsedQuery,
  opts?: { scope?: SearchScope; afterId?: number; limit?: number; fts?: boolean; smart?: boolean },
): Promise<{ rows: SearchRow[]; hasMore: boolean; query: ParsedQuery }>;
export function countMatches(
  db: LibraryDb,
  query: string | ParsedQuery,
  opts?: { scope?: SearchScope; cap?: number; fts?: boolean; smart?: boolean },
): Promise<{ count: number; capped: boolean }>;
export function buildKwic(displayText: string, terms: string[], opts?: { before?: number; after?: number; showNikkud?: boolean; showNiqqud?: boolean; showCantillation?: boolean }): Kwic;
export function makeTermMatcher(terms: string[] | null | undefined): TermMatcher;
/** Wraps words of sanitized inline HTML matching `terms` (tokens, "x*" prefixes, phrases) in <mark>…</mark>. */
export function markTerms(html: string, terms: string[]): string;
export function formatTocPath(tocPath: string | null | undefined): string;
