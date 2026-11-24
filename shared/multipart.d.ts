export interface CloudPart {
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface CloudManifest {
  sourceRepo: string | null;
  scope: string | null;
  /** 'classic' | 'full' (manifest field, else derived from `scope`); null for an unknown scope. */
  edition: 'classic' | 'full' | null;
  version: string;
  builtAt: string | null;
  bookCount: number;
  paragraphCount: number;
  uncompressedDbBytes: number;
  totalZipBytes: number;
  fullZipSha256: string;
  parts: CloudPart[];
}

export interface PartReader {
  read(n: number): Promise<Uint8Array>;
  close(): void | Promise<void>;
}
export interface PartWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): void | Promise<void>;
}

/** Storage backend of the multi-part downloader (phone, node:fs or memory). */
export interface PartsIO {
  size(name: string): number | null | Promise<number | null>;
  remove(name: string): void | Promise<void>;
  sha256(name: string): Promise<string>;
  /** Moves `from` over `to` (the finished `.partial` -> the part name). */
  rename(from: string, to: string): void | Promise<void>;
  /**
   * Downloads into `name`. `resume.resumeFrom > 0`: `name` already holds that many bytes of the file and the
   * download continues after them (HTTP Range); bytes received before an error must stay in `name`.
   * `onProgress` reports the absolute bytes of the file.
   */
  download(
    url: string,
    name: string,
    onProgress: (bytesWritten: number, totalBytes: number) => void,
    isCancelled?: () => boolean,
    resume?: { resumeFrom: number; expectedBytes: number },
  ): Promise<void>;
  openRead(name: string): PartReader | Promise<PartReader>;
  openWrite(name: string, append: boolean): PartWriter | Promise<PartWriter>;
}

export interface PartProgress {
  partIndex: number;
  partCount: number;
  doneBytes: number;
  totalBytes: number;
  skipped: boolean;
}

export const CLOUD_RELEASE_TAG: string;
export const CLOUD_MANIFEST_NAME: string;
export const CLOUD_ZIP_NAME: string;
export const CLOUD_DB_NAME: string;
export const FREE_SPACE_MARGIN: number;
export const MAX_PART_BYTES: number;
export function partName(n: number): string;
export function cloudManifestUrl(repo: string, edition?: 'classic' | 'full'): string;
export function partUrl(manifestUrl: string, part: { name: string }): string;
export function validateCloudManifest(m: unknown): CloudManifest;
export function requiredFreeBytes(m: CloudManifest): number;
export function checkFreeSpace(m: CloudManifest, freeBytes: number | null): { ok: boolean; required: number; free: number | null };
export function formatBytes(n: number): string;
export function formatPartProgress(p: { partIndex: number; partCount: number; doneBytes: number; totalBytes: number }): string;
export function isValidPart(io: PartsIO, part: CloudPart): Promise<boolean>;
export interface RetryEvent {
  partIndex: number;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
  /** The failure happened while the app was not in the foreground (not counted as an attempt). */
  background: boolean;
}
export interface ResilienceOptions {
  /** Corrupt-part attempts (default 2). */
  retries?: number;
  /** Transient network retries per stall (default 4), exponential backoff. */
  networkRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isBackgrounded?: () => boolean;
  whenForeground?: () => Promise<void>;
}
export const PARTIAL_SUFFIX: string;
export function partialIdName(name: string): string;
export function existingBytes(io: PartsIO, manifest: CloudManifest): Promise<number>;
export const NETWORK_RETRY_STAGE: string;
export function partialName(name: string): string;
export function isTransientNetworkError(e: unknown): boolean;
export function backoffDelayMs(attempt: number, baseMs?: number, capMs?: number): number;
export function formatCloudNotification(stage: string, fraction: number | null, detail: string | null): { title: string; text: string; current: number; total: number };
export function downloadParts(
  io: PartsIO,
  manifest: CloudManifest,
  opts: ResilienceOptions & { manifestUrl: string; onRetry?: (e: RetryEvent) => void; onProgress?: (p: PartProgress) => void; isCancelled?: () => boolean },
): Promise<{ downloaded: number; skipped: number }>;
export function assembleParts(
  io: PartsIO,
  manifest: CloudManifest,
  zipName: string,
  opts?: { chunkSize?: number; onProgress?: (p: { doneBytes: number; totalBytes: number }) => void; isCancelled?: () => boolean },
): Promise<void>;
export function extractZip(
  io: PartsIO,
  manifest: CloudManifest,
  zipName: string,
  dbName: string,
  opts?: { onProgress?: (p: { bytesIn: number; bytesOut: number; totalIn: number | null }) => void; isCancelled?: () => boolean },
): Promise<{ bytesIn: number; bytesOut: number; format: string; entry: string | null }>;

export function createMemoryIO(opts?: { fetch?: typeof fetch }): PartsIO & { files: Map<string, Uint8Array> };
export function stageCloudLibrary(
  io: PartsIO,
  manifest: CloudManifest,
  opts: ResilienceOptions & {
    manifestUrl: string;
    zipName?: string;
    dbName?: string;
    /** Wraps assembly + extraction (wake lock); must run and await `fn`. */
    keepAwake?: (fn: () => Promise<void>) => Promise<void>;
    isCancelled?: () => boolean;
    report?: (p: { stage: string; fraction: number | null; detail: string | null }) => void;
  },
): Promise<void>;

export const RANGE_CHUNK_BYTES: number;
export interface RangeChunkEnv {
  partialSize(): number | Promise<number>;
  resolve(start: number, end: number): Promise<{ url: string; status: number }>;
  fetchChunk(url: string, range: string | null, onBytes: (n: number) => void): Promise<void>;
  chunkSize(): number | null | Promise<number | null>;
  discardChunk(): void | Promise<void>;
  appendChunk(): void | Promise<void>;
  adoptChunk(): void | Promise<void>;
  resetPartial(): void | Promise<void>;
}
export function downloadRangeChunks(
  env: RangeChunkEnv,
  opts: { expectedBytes: number; chunkBytes?: number; isCancelled?: () => boolean; onProgress?: (written: number, total: number) => void },
): Promise<void>;
