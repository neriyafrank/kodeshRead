import type { IngestionState, LibraryCounts, WriterDb } from './indexer';
import type { FinalizeWarning } from './pipeline';

export const STEPS: {
  ftsOptimize: 'finalize:fts_optimize';
  analyze: 'finalize:analyze';
  pragmaOptimize: 'finalize:pragma_optimize';
  indexState: 'finalize:index_state';
  counts: 'finalize:counts';
  writeMeta: 'finalize:write_meta';
  dropQueue: 'finalize:drop_queue';
  checkpoint: 'finalize:checkpoint';
  journalMode: 'finalize:journal_mode';
  closeBuild: 'finalize:close_build_db';
  cleanStaging: 'finalize:clean_staging';
  checkStaged: 'finalize:check_staged';
  closeDb: 'finalize:close_db';
  removeSidecars: 'finalize:remove_sidecars';
  swapFile: 'finalize:swap_file';
  reopenDb: 'finalize:reopen_db';
};
export const FINALIZE_INDEX_DONE: 'index';
export const FINALIZE_READY: 'meta';
export const SIDE_SUFFIXES: string[];

export class StepError extends Error {
  constructor(step: string, cause: unknown);
  step: string;
  detail: string;
  cause: unknown;
  code: string | null;
  retryable: boolean;
  readonly diagnostic: string;
}

export function describeError(e: unknown): string;
export function diagnosticOf(e: unknown): string;
export function step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
export function softStep(name: string, fn: () => Promise<unknown> | unknown, warn?: (w: FinalizeWarning) => void): Promise<boolean>;

export function optimizeIndex(
  db: WriterDb,
  opts?: {
    incremental?: boolean;
    mergePages?: number;
    maxSteps?: number;
    analyze?: boolean;
    analysisLimit?: number;
    shouldStop?: () => unknown;
    onStep?: (step: number) => Promise<void>;
    warn?: (w: FinalizeWarning) => void;
  },
): Promise<unknown>;

export function writeBuildMeta(
  db: WriterDb,
  o?: { version?: string; source?: string; warn?: (w: FinalizeWarning) => void },
): Promise<{ version: string; counts: Pick<LibraryCounts, 'books' | 'paragraphs' | 'links' | 'categories' | 'tocNodes'>; reused: boolean }>;

export function adoptCompletedBuild(db: WriterDb): Promise<IngestionState | null>;
export function isReadyToInstall(st: IngestionState | null | undefined): boolean;
export function needsFinalizeOnly(st: IngestionState | null | undefined): boolean;

export interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}
export function verifiedCheckpoint(
  checkpoint: () => Promise<CheckpointRow | null | undefined>,
  opts?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<CheckpointRow | null | undefined>;

export function sealBuild(
  env: {
    checkpoint: () => Promise<CheckpointRow | null | undefined>;
    setJournalDelete: () => Promise<unknown>;
    close: () => Promise<void>;
    removeSideFiles: () => void | Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  },
  opts?: { attempts?: number; delayMs?: number; warn?: (w: FinalizeWarning) => void },
): Promise<void>;

export function installFile<T>(
  env: {
    exists: (name: string) => boolean | Promise<boolean>;
    remove: (name: string) => void | Promise<void>;
    move: (from: string, to: string) => Promise<void>;
    closeCore: () => Promise<void>;
    reopenCore: () => Promise<T>;
    sleep?: (ms: number) => Promise<void>;
  },
  o: { from: string; to: string; settleMs?: number; warn?: (w: FinalizeWarning) => void },
): Promise<T>;
