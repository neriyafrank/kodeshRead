import type { SearchScope } from './search';

export interface Corpus {
  id: string;
  label: string;
  /** true = base books only; false = the commentary preset ("מפרשים"). */
  base: boolean;
}
export const CORPORA: Corpus[];

export interface CorpusBook {
  id: number;
  title: string;
  categoryPath: string;
  personal?: boolean;
}
export interface CorpusOptions {
  /** The library catalog's derived commentary flag (extra exclusion for base presets, inclusion for "מפרשים"). */
  isCommentary?: (id: number) => boolean;
}

export function inCorpus(book: CorpusBook, id: string, opts?: CorpusOptions): boolean;
export function isCommentaryTitle(title: string): boolean;
export function isCommentaryDir(normalizedDir: string): boolean;
export function folderFacts(categoryPath: string): { dirs: string[]; root: string; rest: string[] };
export function resolveCorpusBooks(books: CorpusBook[], ids: string[], opts?: CorpusOptions): number[];
export function corpusCounts(books: CorpusBook[], opts?: CorpusOptions): Record<string, number>;
export function corpusName(ids: string[], bookCount: number): string;
export function countText(n: number): string;
/** Presets -> a `books` scope that remembers its presets; no preset = `{ kind: 'all' }`. */
export function corpusScope(books: CorpusBook[], ids: string[], opts?: CorpusOptions): SearchScope;
