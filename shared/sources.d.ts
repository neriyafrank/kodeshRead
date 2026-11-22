import type { QueryAdapter } from './quickJump';

export interface LibrarySource {
  /** 'core' | 'user' in the app ('main' for a plain adapter). */
  name: string;
  adapter: QueryAdapter;
  /** Lowest id of this database's namespace (0 for core, USER_ID_BASE for user). */
  idBase: number;
  /** Top-level folder that holds all of this source's categories (user: "הספרים שלי"). */
  categoryRoot?: string;
}

export interface LibraryRouter {
  sources: LibrarySource[];
  /** Adapter of the database that owns `bookId`. */
  forBook(bookId: number): QueryAdapter;
}

/** A single database adapter or a router over several. */
export type LibraryDb = QueryAdapter | LibraryRouter;

export interface CatalogCategory {
  id: number;
  parent_id: number | null;
  name: string;
  path: string;
  source: string;
}
export interface CatalogBook {
  id: number;
  category_id: number | null;
  title: string;
  total_lines: number;
  source: string;
}

export const USER_ID_BASE: number;
export const USER_ROOT_NAME: string;
export function isRouter(db: unknown): db is LibraryRouter;
export function sourcesOf(db: LibraryDb): LibrarySource[];
export function sourceForId(sources: LibrarySource[], id: number): LibrarySource | null;
export function adapterForBook(db: LibraryDb, bookId: number): QueryAdapter;
export function createRouter(sources: (LibrarySource | null | undefined)[]): LibraryRouter;
export function sourcesForCategory(db: LibraryDb, path: string): LibrarySource[];
export function loadCatalog(db: LibraryDb): Promise<{ categories: CatalogCategory[]; books: CatalogBook[] }>;
