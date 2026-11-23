import type { FsAdapter, StopReason, TargetDb, WriterDb } from './indexer';

/** File adapter of the streaming pipeline: queued folders / files are persisted by URI. */
export interface PipelineFs<H = unknown> extends FsAdapter<H> {
  uriOf?(handle: H): string;
  fromUri?(uri: string, isDir: boolean): H;
  /** Streamed text chunks of a book file (preferred over readText when present). */
  open?(handle: H): Promise<import('./indexer').TextChunkReader>;
}

export type PipelinePhase = 'scan' | 'books' | 'links' | 'finalize';

export interface PipelineProgress {
  phase: PipelinePhase;
  /** scan: folders scanned; books / links: items done; finalize: merge step. */
  current: number | null;
  /** scan: book files found so far; books / links: items in the phase. */
  total: number | null;
  detail: string | null;
}

export interface RunImportOptions<H = unknown> {
  source: { kind: 'folder'; root: H } | { kind: 'files'; files: { name: string; handle: H }[] };
  sourceUri?: string;
  sourceName?: string | null;
  targetDb?: TargetDb;
  idBase?: number;
  categoryPrefix?: string[];
  aliasOverrides?: Record<string, string[]>;
  resume?: boolean;
  shouldStop?: () => StopReason | null;
  onProgress?: (p: PipelineProgress) => void;
  onError?: (e: { relPath: string; error: unknown }) => void;
  yieldToUI?: () => Promise<void>;
  walCheckpoint?: (mode: 'PASSIVE' | 'TRUNCATE') => Promise<void>;
  checkpointEvery?: number;
  linksPerTransaction?: number;
  /** Only (re)align commentary pairs that involve these books. */
  linkBookIds?: number[];
  finalize?: false | { analyze?: boolean; analysisLimit?: number; mergePages?: number; maxSteps?: number };
  skipRootDirs?: Set<string>;
}

export interface RunImportResult {
  stopped: StopReason | null;
  /** 'done' when every phase finished, else the phase the run stopped in. */
  phase: PipelinePhase | 'done' | string;
  books: number;
  paragraphs: number;
  failed: number;
  skippedFiles: number;
  errors: { relPath: string; message: string }[];
  refLinks: { pairs: number; units: number };
}

export interface QueueCounts {
  dirs: number;
  dirsPending: number;
  files: number;
  filesPending: number;
  filesDone: number;
  filesFailed: number;
}

export const PHASES: PipelinePhase[];
export const SKIPPED_ROOT_DIRS: Set<string>;
export const MAX_ATTEMPTS: number;
export const CRASH_MESSAGE: string;
export function runImport<H>(db: WriterDb, fsa: PipelineFs<H>, opts: RunImportOptions<H>): Promise<RunImportResult>;
export function completeImport(db: WriterDb): Promise<void>;
export function queueCounts(db: WriterDb): Promise<QueueCounts>;
