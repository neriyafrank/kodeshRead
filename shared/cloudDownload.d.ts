import type { CloudPart, PartsIO } from './multipart';

export type DownloadState = 'idle' | 'downloading' | 'paused' | 'waiting_for_network' | 'verifying' | 'completed' | 'error';
export const STATES: {
  readonly IDLE: 'idle';
  readonly DOWNLOADING: 'downloading';
  readonly PAUSED: 'paused';
  readonly WAITING: 'waiting_for_network';
  readonly VERIFYING: 'verifying';
  readonly COMPLETED: 'completed';
  readonly ERROR: 'error';
};
export const STATE_FILE: string;
export const PARTIAL_SUFFIX: string;
export const MAX_ATTEMPTS: number;
export function partialName(name: string): string;

export interface DownloadErrorInfo {
  file?: string | null;
  httpStatus?: number;
  bytes?: number | null;
  expected?: number | null;
  attempts?: number;
  serverBytes?: number | null;
  host?: string | null;
  reason?: string | null;
}
export class DownloadError extends Error {
  constructor(code: string, info?: DownloadErrorInfo, message?: string);
  code: string;
  info: DownloadErrorInfo;
  /** One line for "העתק פרטי שגיאה": code · file · HTTP status · bytes / expected · host · reason. */
  diagnostic: string;
}
export class DownloadPausedError extends Error {
  constructor(snapshot?: { doneBytes: number; totalBytes: number } | null);
  paused: true;
  snapshot: { doneBytes: number; totalBytes: number } | null;
}
export function isPausedError(e: unknown): e is DownloadPausedError;
export function downloadErrorFrom(plain: unknown): DownloadError;
export function formatDiagnostic(code: string, info?: DownloadErrorInfo): string;
export function hostOf(url: string): string | null;
export function isTransientNetworkError(e: unknown): boolean;
export function backoffDelayMs(attempt: number, baseMs?: number, capMs?: number): number;
export function parseContentRange(value: string | null | undefined): { start: number; end: number; total: number | null } | null;

export interface EngineFile {
  name: string;
  url: string;
  partial: string;
  sizeBytes: number;
}
export interface EngineTask {
  id: string;
  files: EngineFile[];
}
export type EnginePhase = 'idle' | 'queued' | 'running' | 'retrying' | 'waiting_for_network' | 'completed' | 'failed' | 'stopped';
export interface RetryInfo {
  attempt: number;
  maxAttempts?: number;
  delayMs?: number;
  reason?: string | null;
  offline: boolean;
}
export interface EngineStatus {
  phase: EnginePhase;
  taskId: string | null;
  fileName: string | null;
  fileBytes: number;
  retry: RetryInfo | null;
  error: DownloadError | null;
}
/** A transfer engine (JS http, Android WorkManager, expo-file-system DownloadTask). */
export interface DownloadEngine {
  kind?: string;
  start(task: EngineTask): void | Promise<void>;
  stop(): void | Promise<void>;
  poll(): EngineStatus | Promise<EngineStatus>;
}
export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body?: unknown;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}
export type HttpRequest = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<HttpResponseLike>;
export interface Connectivity {
  isOnline(): boolean | Promise<boolean>;
}
export function fetchRequest(doFetch?: typeof fetch): HttpRequest;
export function createHttpEngine(opts: {
  io: PartsIO;
  request?: HttpRequest;
  fetch?: typeof fetch;
  connectivity?: Connectivity;
  sleep?: (ms: number) => Promise<void>;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  maxAttempts?: number;
  onlinePollMs?: number;
}): DownloadEngine;
export function phaseFromWorkStatus(status: unknown, taskId: string | null): EngineStatus;

export interface DownloadSnapshot {
  state: DownloadState;
  doneBytes: number;
  totalBytes: number;
  partIndex: number;
  partCount: number;
  retry: RetryInfo | null;
  error: DownloadError | null;
}
export interface PersistedDownload {
  v: number;
  status?: DownloadState;
  kind?: 'core' | 'extended';
  progress?: { done: number; total: number };
  error?: { code: string; message: string; diagnostic: string } | null;
  packages?: Record<string, unknown>;
  updatedAt?: string;
  [key: string]: unknown;
}
export function readDownloadState(io: PartsIO): Promise<PersistedDownload | null>;
export function writeDownloadState(io: PartsIO, state: PersistedDownload): Promise<void>;
export function patchDownloadState(io: PartsIO, patch: Partial<PersistedDownload>): Promise<PersistedDownload>;
export function clearDownloadState(io: PartsIO): Promise<void>;
export function bytesOnDisk(io: PartsIO, parts: CloudPart[], live?: { fileName: string | null; fileBytes: number } | null): Promise<number>;
export function removePackageFiles(io: PartsIO, parts: CloudPart[]): Promise<void>;
export function downloadPackage(
  io: PartsIO,
  pkg: { kind?: 'core' | 'extended'; parts: CloudPart[]; totalZipBytes: number; fullZipSha256: string },
  opts: {
    engine: DownloadEngine;
    urlOf: (part: CloudPart) => string;
    isCancelled?: () => boolean;
    isPauseRequested?: () => boolean;
    onUpdate?: (s: DownloadSnapshot) => void;
    window?: { offset: number; total: number } | null;
    verifyRetries?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ status: 'completed' | 'paused'; doneBytes: number; totalBytes: number; downloaded?: number; skipped?: number }>;
