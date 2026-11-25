import type { LibraryCatalog } from './libraryCatalog';
import type { LibraryDb } from './sources';

export interface CatalogStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export interface CatalogTiming {
  cache: 'hit' | 'miss' | 'off';
  keyMs: number;
  readMs: number;
  queryMs: number;
  buildMs: number;
  totalMs: number;
}

export const CACHE_FORMAT: number;
export function sourceStats(db: LibraryDb): Promise<string[]>;
export function catalogCacheKey(db: LibraryDb, stages?: string): Promise<string>;
export function readCatalogCache(store: CatalogStore, key: string): Promise<LibraryCatalog | null>;
export function writeCatalogCache(store: CatalogStore, key: string, catalog: LibraryCatalog): Promise<void>;
export function loadCatalogCached(
  db: LibraryDb,
  opts?: { stages?: string; store?: CatalogStore | null; pause?: () => Promise<void>; now?: () => number; onTiming?: (t: CatalogTiming) => void; schedule?: (fn: () => void) => void },
): Promise<LibraryCatalog>;
