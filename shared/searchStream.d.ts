import type { SearchPlan } from './hebrewSearch';
import type { PlanCursor, SearchRow, SearchScope } from './search';
import type { LibraryDb } from './sources';

export const STREAM_CAP: number;
export const FIRST_BATCH: number;
export const STREAM_BATCH: number;

export interface SearchSession {
  begin(): { searchId: number; signal: AbortSignal | { aborted: boolean } };
  cancel(): void;
  isCurrent(id: number): boolean;
  current(): number;
}
export function createSearchSession(): SearchSession;

export interface StreamBatch {
  searchId: number;
  rows: (SearchRow & { phase: number })[];
  /** Rows delivered so far, this batch included. */
  total: number;
  batch: number;
  source: string;
  phase: number;
  /** searchPlan() continues after this batch. */
  cursor: PlanCursor;
}
export interface StreamResult {
  searchId: number;
  total: number;
  capped: boolean;
  hasMore: boolean;
  cursor: PlanCursor | null;
  batches: number;
  scanned: number;
}
export function streamPlan(
  db: LibraryDb,
  plan: SearchPlan,
  opts?: {
    scope?: SearchScope;
    fts?: boolean;
    signal?: { aborted: boolean };
    searchId?: number;
    isCurrent?: (id: number) => boolean;
    firstBatch?: number;
    batchSize?: number;
    maxRows?: number;
    onBatch?: (b: StreamBatch) => void;
    onProgress?: (p: { stage: 'verify'; scanned: number }) => void;
    pause?: (batch: number) => Promise<void>;
  },
): Promise<StreamResult>;
