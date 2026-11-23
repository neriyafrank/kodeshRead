export interface CloudPart {
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface CloudManifest {
  sourceRepo: string | null;
  scope: string | null;
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
  download(url: string, name: string, onProgress: (bytesWritten: number, totalBytes: number) => void, isCancelled?: () => boolean): Promise<void>;
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
export function cloudManifestUrl(repo: string): string;
export function partUrl(manifestUrl: string, part: { name: string }): string;
export function validateCloudManifest(m: unknown): CloudManifest;
export function requiredFreeBytes(m: CloudManifest): number;
export function checkFreeSpace(m: CloudManifest, freeBytes: number | null): { ok: boolean; required: number; free: number | null };
export function formatBytes(n: number): string;
export function formatPartProgress(p: { partIndex: number; partCount: number; doneBytes: number; totalBytes: number }): string;
export function isValidPart(io: PartsIO, part: CloudPart): Promise<boolean>;
export function downloadParts(
  io: PartsIO,
  manifest: CloudManifest,
  opts: { manifestUrl: string; retries?: number; onProgress?: (p: PartProgress) => void; isCancelled?: () => boolean },
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
  opts: {
    manifestUrl: string;
    zipName?: string;
    dbName?: string;
    retries?: number;
    isCancelled?: () => boolean;
    report?: (p: { stage: string; fraction: number | null; detail: string | null }) => void;
  },
): Promise<void>;
