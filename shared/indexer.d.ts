/** Async writer adapter over a SQLite connection (node:sqlite or expo-sqlite). */
export interface WriterDb {
  exec(sql: string): Promise<unknown>;
  run(sql: string, params: (string | number | null)[]): Promise<unknown>;
  all<T = any>(sql: string, params: (string | number | null)[]): Promise<T[]>;
}

export interface FsEntry<H = unknown> {
  name: string;
  isDir: boolean;
  handle: H;
}
/** Async file adapter (node fs or expo-file-system). */
export interface FsAdapter<H = unknown> {
  list(dir: H): Promise<FsEntry<H>[]>;
  readText(file: H): Promise<string>;
}

export interface ScannedBook<H = unknown> {
  handle: H;
  name: string;
  rel: string[];
  dir: string[];
}
export interface ScannedLinkFile<H = unknown> {
  handle: H;
  name: string;
  rel: string[];
}

export interface ParsedBook {
  title: string;
  paragraphs: { lineIndex: number; tocPath: string | null; display: string; clean: string; isHeading: number }[];
  toc: { parentIdx: number | null; level: number; title: string; refKey: string; startLine: number }[];
  totalLines: number;
}

export interface BookProgress {
  index: number;
  total: number;
  relPath: string;
  title: string;
  lines: number;
  tocNodes: number;
}

export interface IndexBooksOptions<H = unknown> {
  files: ScannedBook<H>[];
  dirs?: string[][];
  idBase?: number;
  categoryPrefix?: string[];
  aliasOverrides?: Record<string, string[]>;
  replaceExisting?: boolean;
  booksPerTransaction?: number;
  onFileRead?: (relPath: string, raw: string) => void;
  onBook?: (p: BookProgress) => void;
  yieldEvery?: () => Promise<void>;
}

export interface LinkStats {
  files: number;
  parsed: number;
  kept: number;
  duplicates: number;
  outOfRange: number;
  invalid: number;
  unmatched: Map<string, number>;
}

export interface LibraryCounts {
  books: number;
  categories: number;
  paragraphs: number;
  links: number;
  tocNodes: number;
}

export const SCHEMA: string;
export const SCHEMA_VERSION: number;
export const USER_ID_BASE: number;
export const USER_ROOT_NAME: string;
export const CANONICAL_ORDER: string[];
export function ensureSchema(db: WriterDb, opts?: { kind?: 'core' | 'user' }): Promise<boolean>;
export function readMeta(db: WriterDb | { all: WriterDb['all'] }): Promise<Record<string, string> | null>;
export function writeMeta(db: WriterDb, entries: Record<string, string | number>): Promise<void>;
export function sanitizeDisplay(html: string): string;
export function plainHeading(html: string): string;
export function parseBook(raw: string, fallbackTitle: string): ParsedBook;
export function sortEntries<T extends { name: string; isDir: boolean }>(entries: T[], localOrder?: string[] | null): T[];
export function scanBooks<H>(fsa: FsAdapter<H>, root: H, rel?: string[]): Promise<{ dirs: string[][]; files: ScannedBook<H>[] }>;
export function scanLinkFiles<H>(fsa: FsAdapter<H>, root: H, rel?: string[]): Promise<ScannedLinkFile<H>[]>;
export function mergeAliasOverrides(objects: (Record<string, string | string[]> | null | undefined)[]): Record<string, string[]>;
export function parseCsv(text: string): string[][];
export function linkBookKey(name: string): string;
export function makeBookMatcher(books: { id: number; title: string; filePath: string; aliases: string[] }[]): (name: string) => number | null;
export function parseLinkFile(fileName: string, raw: string): [string, unknown, string, unknown, unknown][];
export function deleteBook(db: WriterDb, bookId: number): Promise<void>;
export function pruneEmptyCategories(db: WriterDb, keepIds?: number[]): Promise<void>;
export function indexBooks<H>(
  db: WriterDb,
  fsa: FsAdapter<H>,
  opts: IndexBooksOptions<H>,
): Promise<{ books: number; paragraphs: number; tocNodes: number; categories: number; bookIds: number[] }>;
export function indexLinks<H>(
  db: WriterDb,
  fsa: FsAdapter<H>,
  linkFiles: ScannedLinkFile<H>[],
  opts?: {
    onFileRead?: (f: ScannedLinkFile<H>, raw: string) => void;
    onFile?: (p: { index: number; total: number; name: string }) => void;
    onError?: (f: ScannedLinkFile<H>, e: unknown) => void;
  },
): Promise<LinkStats>;
export function finalizeIndex(db: WriterDb, opts?: { analyze?: boolean }): Promise<void>;
export function libraryCounts(db: WriterDb): Promise<LibraryCounts>;
