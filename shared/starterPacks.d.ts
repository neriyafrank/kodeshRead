import type { WriterDb } from './indexer';

export const STARTER_RELEASE_TAG: string;
export const STARTER_CATALOG_NAME: string;
export const PACK_FORMAT: string;
export const PACK_FORMAT_VERSION: number;
export const PACK_COLUMNS: Record<string, string[]>;

export interface StarterSpec {
  slug: string;
  title: string;
  titles: string[];
  corpus: string | null;
  author: string;
  commentators: string[];
}
export const STARTER_BOOKS: StarterSpec[];

export interface StarterSelection {
  spec: StarterSpec;
  baseId: number;
  title: string;
  categoryPath: string;
  section: string[];
  commentaries: { id: number; title: string; key: string; name: string }[];
  rank: number;
}

export interface StarterCatalogEntry {
  slug: string;
  title: string;
  /** Top catalog section (תנ"ך, תלמוד בבלי, ...). */
  category: string;
  subcategory: string;
  author: string;
  packFile: string;
  sizeBytes: number;
  sha256: string;
  /** file_path of the base book: how the app recognises it as already loaded. */
  filePath: string;
  paragraphs: number;
  bundledCommentaries: { title: string; name: string }[];
}
export interface StarterCatalog {
  formatVersion: number;
  version: string;
  builtAt: string;
  books: StarterCatalogEntry[];
}

export interface StarterPack {
  format: string;
  formatVersion: number;
  slug: string;
  title: string;
  dbVersion: string | null;
  builtAt: string | null;
  baseBookId: number;
  categories: [number, number | null, string, string][];
  books: [number, number | null, string, string, string, number, 'base' | 'commentary'][];
  toc: [number, number, number | null, number, string, string, number][];
  paragraphs: [number, number, number, string | null, string, string, number][];
  refLinks: [number, number, number, number, number, number, string, string | null][];
  counts: { books: number; toc: number; paragraphs: number; refLinks: number };
}

export interface StarterImportResult {
  slug: string;
  /** Id of the base book inside the starter database. */
  bookId: number;
  title: string;
  added: number;
  skipped: number;
  paragraphs: number;
  refLinks: number;
  idMap: Record<number, number>;
}

export function packFileName(slug: string): string;
export function selectStarterBooks(data: { categories: unknown[]; books: unknown[] }, specs?: StarterSpec[]): StarterSelection[];
export function buildStarterPack(db: Pick<WriterDb, 'all'>, sel: StarterSelection, meta?: { dbVersion?: string | null; builtAt?: string | null }): Promise<StarterPack>;
export function packToBytes(pack: StarterPack): Uint8Array;
export function buildStarterCatalog(items: { sel: StarterSelection; pack: StarterPack; bytes: Uint8Array; sha256: string }[], meta?: { dbVersion?: string | null; builtAt?: string | null }): StarterCatalog;
export function validateStarterCatalog(json: unknown): StarterCatalog;
export function validatePack(pack: unknown): StarterPack;
export function decodePack(bytes: Uint8Array): StarterPack;
export function verifyPackBytes(bytes: Uint8Array, entry: Pick<StarterCatalogEntry, 'sizeBytes' | 'sha256'>): Promise<void>;
export function packUrl(catalogUrl: string, entry: Pick<StarterCatalogEntry, 'packFile'>): string;
export function sha256Hex(bytes: Uint8Array): Promise<string>;
export function sha256Js(bytes: Uint8Array): string;
export function importStarterPack(db: WriterDb, pack: StarterPack): Promise<StarterImportResult>;
export function loadedFilePaths(db: Pick<WriterDb, 'all'>): Promise<Set<string>>;
