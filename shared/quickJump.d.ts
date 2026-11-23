import type { LibraryDb } from './sources';

export interface QueryAdapter {
  all<T = any>(sql: string, params: (string | number | null)[]): Promise<T[]>;
}

export interface IndexedBook {
  id: number;
  title: string;
  categoryPath: string;
  totalLines: number;
}

export interface BookIndex {
  byAlias: Map<string, { book: IndexedBook; exactTitle: boolean }[]>;
  books: Map<number, IndexedBook>;
  maxAliasTokens: number;
}

export interface JumpResult {
  bookId: number;
  bookTitle: string;
  categoryPath: string;
  /** Titles of the matched TOC nodes, outermost first. */
  path: string[];
  targetLine: number;
  /** Inline marker matched inside the deepest section (e.g. a verse "ג"). */
  marker: string | null;
  /** Query tokens that could not be resolved. */
  unmatched: string[];
  preview: string;
  complete: boolean;
  /** True when this is only a book-name completion for a partial query. */
  suggestion: boolean;
  /** Human label of the resolved location ("סימן שכח › סעיף ד"); '' for the book start. */
  location: string;
  /** Fully resolved reference to a place inside the book: shown as the "פתח: ספר — מיקום" card. */
  direct: boolean;
}

export interface RawToken {
  /** Normalized token (finals folded, no gershayim). */
  tok: string;
  /** As typed (keeps gershayim / geresh). */
  raw: string;
}

export interface LocationToken {
  /** Normalized ref token ("שכח", "ב.", "עב"). */
  key: string;
  /** Fallback when a combined abbreviation is ambiguous: פ"א -> key "פא" (81), alt "א" (פרק א). */
  alt?: string;
}

export function loadBookIndex(db: LibraryDb): Promise<BookIndex>;
export function resolveReference(db: LibraryDb, index: BookIndex, input: string, opts?: { limit?: number }): Promise<JumpResult[]>;
export function tokenize(input: string): string[];
export function rawTokens(input: string): RawToken[];
/** Location tokens after the book name: structural words dropped, digits -> gematria. */
export function parseLocation(words: RawToken[]): LocationToken[];
/** Book candidates for a normalized token sequence (literal alias, then abbreviation-expanded). */
export function lookupBook(index: BookIndex, tokens: string[], raws?: string[]): { book: IndexedBook; exactTitle: boolean }[] | null;
/**
 * Resolves location keys inside one book (TOC headings by ref_key, then an inline "(ג)" marker in
 * the deepest section): [{ key: 'לב' }, { key: 'יד' }] -> chapter לב, verse יד; [{ key: 'ב.' }] -> daf ב amud א.
 */
export function resolveInBook(
  db: LibraryDb,
  book: { id: number; totalLines: number },
  locTokens: LocationToken[],
): Promise<{ path: string[]; targetLine: number; marker: string | null; unmatched: string[] }>;
