/**
 * The one long-running library job at a time (download / build / import / delete) and
 * its live progress. Not persisted: a job lives in this JS session, so the progress bar
 * survives leaving and re-opening the manager screen. What survives a restart is the
 * ingestion checkpoint inside the target database (see shared/indexer.js, ingestion_state).
 *
 * Ingestion jobs (buildCore / importFiles / importFolder) are `resumable`: "pause" (or the app
 * going to the background) stops them after the current book commits; "cancel" stops them
 * the same way and then discards the partial import.
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
  /** Ingestion job: can be paused and resumed later. */
  resumable: boolean;
  /** Ingestion phase (scan / books / links / finalize), for the Android progress notification. */
  phase?: string | null;
  /** Items done / total of the current phase (null when unknown). */
  current?: number | null;
  total?: number | null;
}

export interface JobResult {
  kind: JobKind;
  ok: boolean;
  message: string;
  /** The job stopped with a resumable checkpoint (paused, interrupted). */
  paused?: boolean;
  /** Books that failed and were skipped: { path, message } (first few). */
  errors?: { path: string; message: string }[];
}

export type StopRequest = 'pause' | 'cancel' | null;

interface JobsState {
  job: JobProgress | null;
  result: JobResult | null;
  cancelRequested: boolean;
  /** Pause / cancel request for a resumable job (honoured between books). */
  stopRequested: StopRequest;
  /** The last pause came from the app leaving the foreground: resume when it returns. */
  autoPaused: boolean;
  /** Bumped whenever a checkpoint may have changed (resume card re-reads it). */
  checkpointGeneration: number;
  start: (kind: JobKind, stage: string, opts?: { resumable?: boolean }) => boolean;
  update: (patch: Partial<Omit<JobProgress, 'kind'>>) => void;
  finish: (result: Omit<JobResult, 'kind'>) => void;
  requestCancel: () => void;
  requestPause: (auto?: boolean) => void;
  setAutoPaused: (v: boolean) => void;
  /** The app came back before an automatic pause took effect: keep running. */
  withdrawAutoPause: () => void;
  bumpCheckpoint: () => void;
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
  stopRequested: null,
  autoPaused: false,
  checkpointGeneration: 0,
  start: (kind, stage, opts) => {
    if (get().job) return false;
    set({ job: { kind, stage, fraction: null, detail: null, resumable: !!opts?.resumable }, result: null, cancelRequested: false, stopRequested: null, autoPaused: false });
    return true;
  },
  update: (patch) => set((s) => (s.job ? { job: { ...s.job, ...patch } } : s)),
  finish: (r) =>
    set((s) => ({
      job: null,
      cancelRequested: false,
      stopRequested: null,
      checkpointGeneration: s.checkpointGeneration + 1,
      result: { kind: s.job?.kind ?? 'delete', ...r },
    })),
  requestCancel: () => set((s) => ({ cancelRequested: true, stopRequested: s.job?.resumable ? 'cancel' : s.stopRequested, autoPaused: false })),
  requestPause: (auto = false) => set((s) => (s.job?.resumable && s.stopRequested !== 'cancel' ? { stopRequested: 'pause', autoPaused: auto } : s)),
  setAutoPaused: (v) => set({ autoPaused: v }),
  // autoPaused stays set: if the job had already seen the pause, it finishes as paused and
  // IngestionLifecycle resumes it; if not, it simply keeps running.
  withdrawAutoPause: () => set((s) => (s.job && s.stopRequested === 'pause' && s.autoPaused ? { stopRequested: null } : s)),
  bumpCheckpoint: () => set((s) => ({ checkpointGeneration: s.checkpointGeneration + 1 })),
  clearResult: () => set({ result: null }),
}));

/** The pending pause / cancel request of the running ingestion job (polled between books). */
export function stopRequest(): StopRequest {
  return useLibraryJobs.getState().stopRequested;
}

/** Throws CancelledError once the user pressed "cancel". */
export function throwIfCancelled(): void {
  if (useLibraryJobs.getState().cancelRequested) throw new CancelledError();
}

export const formatMB = (bytes: number | null | undefined) => (bytes == null ? '?' : (bytes / 1024 / 1024).toFixed(1));
