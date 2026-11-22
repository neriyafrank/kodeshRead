/**
 * The one long-running library job at a time (download / build / import / delete) and
 * its live progress. Not persisted: a job lives in this JS session, so the progress bar
 * survives leaving and re-opening the manager screen.
 */
import { create } from 'zustand';

export type JobKind = 'download' | 'buildCore' | 'importFiles' | 'importFolder' | 'delete';

export interface JobProgress {
  kind: JobKind;
  /** Short Hebrew stage label ("מוריד…", "מאמת…", …). */
  stage: string;
  /** 0..1, or null for an indeterminate step. */
  fraction: number | null;
  /** e.g. "12 / 140 · בראשית" or "35.2 / 410.0 MB". */
  detail: string | null;
}

export interface JobResult {
  kind: JobKind;
  ok: boolean;
  message: string;
}

interface JobsState {
  job: JobProgress | null;
  result: JobResult | null;
  cancelRequested: boolean;
  start: (kind: JobKind, stage: string) => boolean;
  update: (patch: Partial<Omit<JobProgress, 'kind'>>) => void;
  finish: (result: Omit<JobResult, 'kind'>) => void;
  requestCancel: () => void;
  clearResult: () => void;
}

export class CancelledError extends Error {
  constructor() {
    super('בוטל');
  }
}

export const useLibraryJobs = create<JobsState>()((set, get) => ({
  job: null,
  result: null,
  cancelRequested: false,
  start: (kind, stage) => {
    if (get().job) return false;
    set({ job: { kind, stage, fraction: null, detail: null }, result: null, cancelRequested: false });
    return true;
  },
  update: (patch) => set((s) => (s.job ? { job: { ...s.job, ...patch } } : s)),
  finish: (r) => set((s) => ({ job: null, cancelRequested: false, result: { kind: s.job?.kind ?? 'delete', ...r } })),
  requestCancel: () => set({ cancelRequested: true }),
  clearResult: () => set({ result: null }),
}));

/** Throws CancelledError once the user pressed "cancel". */
export function throwIfCancelled(): void {
  if (useLibraryJobs.getState().cancelRequested) throw new CancelledError();
}

export const formatMB = (bytes: number | null | undefined) => (bytes == null ? '?' : (bytes / 1024 / 1024).toFixed(1));
