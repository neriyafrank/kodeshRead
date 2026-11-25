import type { Connectivity, DownloadEngine, DownloadSnapshot, DownloadState, HttpRequest } from './cloudDownload';

export interface CloudPart {
  name: string;
  sizeBytes: number;
  sha256: string;
}

/** One stage of the two-stage library: the core database or the optional extended one. */
export interface CloudPackage {
  bookCount: number;
  paragraphCount: number;
  uncompressedDbBytes: number;
  totalZipBytes: number;
  fullZipSha256: string;
  parts: CloudPart[];
}

/** A package as the download pipeline sees it: the numbers of its stage + the file names of that stage. */
export interface CloudPackageView extends CloudPackage {
  version: string;
  kind: 'core' | 'extended';
  zipName: string;
  dbName: string;
}

export type CloudPlan = 'core' | 'extended' | 'full';

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
  /** The optional expansion pack (extended_library.db); null for releases that ship one database. */
  extended: CloudPackage | null;
}

export interface PartReader {
  read(n: number): Promise<Uint8Array>;
  close(): void | Promise<void>;
}
export interface PartWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): void | Promise<void>;
}

/** Storage backend of the multi-part pipeline (phone, node:fs or memory). Transfers go through a DownloadEngine. */
export interface PartsIO {
  size(name: string): number | null | Promise<number | null>;
  remove(name: string): void | Promise<void>;
  sha256(name: string): Promise<string>;
  /** Moves `from` over `to` (the finished `.partial` -> the part name). */
  rename(from: string, to: string): void | Promise<void>;
  openRead(name: string): PartReader | Promise<PartReader>;
  /** Writes must reach the file as they happen (an interrupted transfer keeps exactly the bytes it wrote). */
  openWrite(name: string, append: boolean): PartWriter | Promise<PartWriter>;
  readText(name: string): string | Promise<string>;
  /** Atomic (temp file + rename). */
  writeText(name: string, text: string): void | Promise<void>;
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
export const EXTENDED_ZIP_NAME: string;
export const EXTENDED_DB_NAME: string;
export function partName(n: number, kind?: 'core' | 'extended'): string;
export function packageOf(manifest: CloudManifest, kind: 'core' | 'extended'): CloudPackageView;
export function planPackages(manifest: CloudManifest, plan: CloudPlan): { plan: CloudPlan; packages: ('core' | 'extended')[]; totalZipBytes: number; uncompressedDbBytes: number; bookCount: number };
export function requiredFreeBytesForPlan(manifest: CloudManifest, plan: CloudPlan): number;
export function cloudManifestUrl(repo: string): string;
export function partUrl(manifestUrl: string, part: { name: string }): string;
export function validateCloudManifest(m: unknown): CloudManifest;
export function requiredFreeBytes(m: CloudManifest): number;
export function checkFreeSpace(m: CloudManifest, freeBytes: number | null): { ok: boolean; required: number; free: number | null };
export function formatBytes(n: number): string;
export function formatPartProgress(p: { partIndex: number; partCount: number; doneBytes: number; totalBytes: number; label?: string | null }): string;
export const PARTIAL_SUFFIX: string;
export function partialName(name: string): string;
export const WAITING_STAGE: string;
export const NETWORK_RETRY_STAGE: string;
export const VERIFY_STAGE: string;
export const PAUSED_STAGE: string;
export function existingBytes(io: PartsIO, pkg: CloudPackage): Promise<number>;
export function formatCloudNotification(stage: string, fraction: number | null, detail: string | null): { title: string; text: string; current: number; total: number };
export function describeSnapshot(
  snap: DownloadSnapshot,
  ctx: { overall: (bytes: number) => number; total: number; label?: string | null },
): { stage: string; fraction: number | null; detail: string | null };
export function assembleParts(
  io: PartsIO,
  manifest: CloudPackage,
  zipName: string,
  opts?: { chunkSize?: number; onProgress?: (p: { doneBytes: number; totalBytes: number }) => void; isCancelled?: () => boolean },
): Promise<void>;
export function extractZip(
  io: PartsIO,
  manifest: CloudPackage,
  zipName: string,
  dbName: string,
  opts?: { onProgress?: (p: { bytesIn: number; bytesOut: number; totalIn: number | null }) => void; isCancelled?: () => boolean },
): Promise<{ bytesIn: number; bytesOut: number; format: string; entry: string | null }>;

export function createMemoryIO(): PartsIO & { files: Map<string, Uint8Array> };
export function stageCloudLibrary(
  io: PartsIO,
  manifest: CloudPackage & { kind?: 'core' | 'extended'; zipName?: string; dbName?: string },
  opts: {
    manifestUrl: string;
    zipName?: string;
    dbName?: string;
    /** Transfer engine (default: the JS http engine over `io` + fetch). */
    engine?: DownloadEngine;
    request?: HttpRequest;
    connectivity?: Connectivity;
    /** Two-stage flow: maps this package's download bytes onto one bar (offset = bytes of earlier packages, total = whole flow). */
    window?: { offset: number; total: number; label?: string };
    /** Wraps assembly + extraction (wake lock / foreground service); must run and await `fn`. */
    keepAwake?: (fn: () => Promise<void>) => Promise<void>;
    isCancelled?: () => boolean;
    isPauseRequested?: () => boolean;
    report?: (p: { stage: string; fraction: number | null; detail: string | null; download?: DownloadState }) => void;
    sleep?: (ms: number) => Promise<void>;
    pollMs?: number;
    verifyRetries?: number;
    backoffBaseMs?: number;
    backoffCapMs?: number;
  },
): Promise<void>;
