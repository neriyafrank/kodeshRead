import type { LibraryDb } from './sources';

export type SearchScope =
  | { kind: 'all' }
  | { kind: 'category'; path: string; name: string }
  | { kind: 'book'; bookId: number; title: string };

export interface ParsedQuery {
  /** Safe FTS5 MATCH expression (every token / phrase double-quoted, AND-ed). */
  match: string;
  /** Unique normalized tokens, for highlighting. */
  terms: string[];
  phrases: string[][];
  empty: boolean;
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
export function splitPhrases(input: string): { text: string; phrase: boolean }[];
export function parseSearchQuery(input: string): ParsedQuery;
export function scopeClause(scope: SearchScope | null | undefined): { sql: string; params: (string | number)[] };
/** False on SQLite builds without FTS5 (web preview); the app then uses a LIKE fallback. */
export function hasFts5(db: LibraryDb): Promise<boolean>;
export function searchParagraphs(
  db: LibraryDb,
  query: string | ParsedQuery,
  opts?: { scope?: SearchScope; afterId?: number; limit?: number; fts?: boolean },
): Promise<{ rows: SearchRow[]; hasMore: boolean; query: ParsedQuery }>;
export function countMatches(
  db: LibraryDb,
  query: string | ParsedQuery,
  opts?: { scope?: SearchScope; cap?: number; fts?: boolean },
): Promise<{ count: number; capped: boolean }>;
export function buildKwic(displayText: string, terms: string[], opts?: { before?: number; after?: number; showNiqqud?: boolean }): Kwic;
export function formatTocPath(tocPath: string | null | undefined): string;
