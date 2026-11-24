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
  /** refPath: canonical unit reference ("פרק א|פסוק א", "דף ב|עמוד א") used for commentary alignment. */
  toc: { parentIdx: number | null; level: number; title: string; refKey: string; refPath: string; startLine: number }[];
  totalLines: number;
}

/** Text chunks of one file, then null (shared/bookStream.js openTextReader). */
export interface TextChunkReader {
  read(): Promise<string | null>;
  close(): unknown;
}

/** Incremental line parser behind parseBook (only the TOC is retained). */
export function createBookParser(fallbackTitle: string): {
  line(text: string): ParsedBook['paragraphs'][number] | null;
  finish(): Omit<ParsedBook, 'paragraphs'>;
};

export interface BookProgress {
  index: number;
  total: number;
  relPath: string;
  title: string;
  lines: number;
  tocNodes: number;
  /** True when the book was finished by an interrupted run and skipped on resume. */
  skipped?: boolean;
}

export type TargetDb = 'core' | 'user';
export type IngestionStatus = 'in_progress' | 'paused' | 'completed';
export type StopReason = 'pause' | 'cancel';

/** Row of the ingestion_state checkpoint table (id = 1). */
export interface IngestionState {
  source_uri: string;
  source_name: string | null;
  source_kind: 'folder' | 'files' | string;
  target_db: TargetDb;
  status: IngestionStatus;
  phase: 'scan' | 'books' | 'links' | 'finalize' | string;
  processed_count: number;
  total_count: number;
  error_count: number;
  base_book_id: number;
  last_book_path: string | null;
  /** v6: non-text files skipped by the scan. */
  skipped_count?: number;
  /** v6: folders scanned so far. */
  scanned_dirs?: number;
  /** v6: links-phase cursor (commentary jobs committed) / total. */
  links_done?: number;
  links_total?: number;
  /** Unit of work running when the checkpoint was written ("book:<queue id>", "links:<cursor>"). */
  inflight_key?: string | null;
  /** Runs that started this unit without finishing it (killed); skipped once it reaches the limit. */
  inflight_attempts?: number;
  /** Finalize sub-progress of a core build: 'index' (optimizations ran), 'meta' (ready to install). */
  finalize_step?: string | null;
  /** "step · message" of the last failure of this run (shown on the resume card). */
  last_error?: string | null;
  started_at: string;
  updated_at: string;
}

export interface IngestionError {
  file_path: string;
  message: string;
  at: string;
}

export interface IngestionOptions {
  sourceUri: string;
  sourceName?: string | null;
  sourceKind?: 'folder' | 'files';
  targetDb: TargetDb;
  /** Continue the interrupted checkpoint (skip books it completed) instead of starting over. */
  resume?: boolean;
}

export interface IndexBooksStats {
  books: number;
  paragraphs: number;
  tocNodes: number;
  categories: number;
  bookIds: number[];
  /** Completed by the interrupted run and skipped (resume). */
  skipped: number;
  /** Books that threw and were rolled back (see errors). */
  failed: number;
  errors: { relPath: string; message: string }[];
  /** Files handled so far (indexed + skipped + failed). */
  processed: number;
  /** Set when shouldStop() ended the run early (everything before it is committed). */
  stopped: StopReason | null;
}

export interface IndexBooksOptions<H = unknown> {
  files: ScannedBook<H>[];
  dirs?: string[][];
  idBase?: number;
  categoryPrefix?: string[];
  aliasOverrides?: Record<string, string[]>;
  replaceExisting?: boolean;
  booksPerTransaction?: number;
  maxLinesPerTransaction?: number;
  ingestion?: IngestionOptions;
  shouldStop?: () => StopReason | null;
  onError?: (e: { relPath: string; error: unknown }) => void;
  onCommit?: () => Promise<void>;
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
  /** Heading-aligned commentary units (schema v4 ref_links). */
  refLinks: number;
  /** Persisted heading units (schema v6 book_units). */
  bookUnits: number;
  tocNodes: number;
}

export interface RefLinkStats {
  /** Commentary / base book pairs found. */
  pairs: number;
  /** Pairs aligned in this run. */
  aligned: number;
  /** ref_links rows written. */
  units: number;
  stopped: 'pause' | 'cancel' | null;
  /** Jobs committed (resume point). */
  cursor: number;
}

export interface BookWriteResult {
  ok: true;
  id: number;
  title: string;
  lines: number;
  tocNodes: number;
  units: number;
}
export interface BookWriter {
  ensureCategory(parts: string[]): Promise<number>;
  write(job: {
    file: { name: string; rel: string[]; dir: string[] };
    relPath: string;
    oldIds?: number[];
    /** Streamed text chunks (the device): the book is parsed and written as it arrives. */
    open?: () => Promise<TextChunkReader>;
    /** The whole text at once (the PC build). One of open / read is required. */
    read?: () => Promise<string>;
    onFileRead?: (relKey: string, raw: string) => void;
  }): Promise<BookWriteResult | { ok: false; error: unknown }>;
  readonly newCategories: number;
  readonly lastBookId: number;
}

export const SCHEMA: string;
export const INGESTION_SCHEMA: string;
export const REF_LINKS_SCHEMA: string;
export const BOOK_UNITS_SCHEMA: string;
export const IMPORT_QUEUE_SCHEMA: string;
export function createBookWriter(
  db: WriterDb,
  opts?: { idBase?: number; categoryPrefix?: string[]; aliasOverrides?: Record<string, string[]>; isolate?: boolean },
): Promise<BookWriter>;
export function insertMany<T>(db: WriterDb, head: string, cols: number, items: T[], map?: (item: T, index: number) => unknown[]): Promise<void>;
export function maxId(db: WriterDb, table: string, base: number): Promise<number>;
export function hasTable(db: { all: WriterDb['all'] }, name: string): Promise<boolean>;
export function loadBookUnits(db: WriterDb, bookId: number, totalLines: number, unitsTable: boolean): Promise<unknown[]>;
export function refLinkJobs(db: WriterDb, bookIds?: number[], pause?: () => Promise<void>): Promise<{ books: unknown[]; jobs: { commId: number; baseId?: number; scope?: unknown }[] }>;
export function nowIso(): string;
export function errorMessage(e: unknown): string;
export class IngestionStopped extends Error {
  constructor(reason?: StopReason);
  reason: StopReason;
}
export function migrateSchema(db: WriterDb): Promise<void>;
export function readIngestionState(db: { all: WriterDb['all'] }): Promise<IngestionState | null>;
export function writeIngestionState(db: WriterDb, patch: Partial<IngestionState>): Promise<void>;
export function clearIngestionState(db: WriterDb): Promise<void>;
export function readIngestionErrors(db: { all: WriterDb['all'] }, limit?: number): Promise<IngestionError[]>;
export function isResumableState(st: IngestionState | null | undefined): st is IngestionState;
export function isIgnoredEntry(e: { name: string; isDir: boolean }): boolean;
export function isBookFileName(name: string): boolean;
export const SCHEMA_VERSION: number;
export const USER_ID_BASE: number;
export const USER_ROOT_NAME: string;
export const CANONICAL_ORDER: string[];
export function ensureSchema(db: WriterDb, opts?: { kind?: 'core' | 'user' | 'starter' }): Promise<boolean>;
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
): Promise<IndexBooksStats>;
/** Heading-based (Otzaria reference-alignment) commentary links; idempotent per commentary book. */
export function indexRefLinks(
  db: WriterDb,
  opts?: {
    bookIds?: number[];
    booksPerTransaction?: number;
    cursor?: number;
    /** A refLinkJobs() result to reuse instead of pairing the library again. */
    plan?: { books: unknown[]; jobs: { commId: number; baseId?: number; scope?: unknown }[] };
    /** At most this many jobs from `cursor` in this call. */
    limit?: number;
    shouldStop?: () => 'pause' | 'cancel' | null | undefined;
    beforeCommit?: (next: number, total: number) => Promise<void>;
    onBook?: (p: { index: number; total: number; title: string }) => void;
    onCommit?: () => Promise<void>;
    yieldEvery?: () => Promise<void>;
  },
): Promise<RefLinkStats>;
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
export function finalizeIndex(
  db: WriterDb,
  opts?: { analyze?: boolean; analysisLimit?: number; incremental?: boolean; mergePages?: number; maxSteps?: number; onStep?: (step: number) => Promise<void>; shouldStop?: () => unknown; optimize?: boolean },
): Promise<void>;
export function libraryCounts(db: WriterDb): Promise<LibraryCounts>;
