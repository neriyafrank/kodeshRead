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
}

export function loadBookIndex(db: LibraryDb): Promise<BookIndex>;
export function resolveReference(db: LibraryDb, index: BookIndex, input: string, opts?: { limit?: number }): Promise<JumpResult[]>;
export function tokenize(input: string): string[];
