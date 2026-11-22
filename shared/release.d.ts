export type Compression = 'gzip' | 'zip' | 'none';

export interface ReleaseManifest {
  format?: number;
  name?: string;
  version: string;
  schemaVersion?: number;
  builtAt?: string;
  source?: string;
  books?: number;
  categories?: number;
  paragraphs?: number;
  links?: number;
  tocNodes?: number;
  /** Asset file name, resolved relative to the manifest URL. */
  file?: string;
  /** Absolute asset URL (overrides `file`). */
  url?: string;
  compression: Compression;
  /** Compressed size in bytes. */
  size: number | null;
  /** SHA-256 (hex) of the compressed asset. */
  sha256: string | null;
  /** Decompressed DB size in bytes. */
  dbSize: number | null;
  dbSha256?: string;
}

export interface DecompressIO {
  read(n: number): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  totalIn?: number | null;
  onProgress?: (p: { bytesIn: number; bytesOut: number; totalIn: number | null }) => void;
  isCancelled?: () => boolean;
  chunkSize?: number;
  format?: Compression;
}

export const MANIFEST_FORMAT: number;
export function isDirectAssetUrl(url: string): boolean;
export function resolveAssetUrl(manifestUrl: string, manifest: { file?: string; url?: string }): string;
export function compressionOf(nameOrUrl: string): Compression;
export function validateManifest(m: unknown, appSchemaVersion?: number): ReleaseManifest;
export function detectFormat(head: Uint8Array): Compression | null;
export function decompressStream(io: DecompressIO): Promise<{ bytesIn: number; bytesOut: number; format: Compression; entry: string | null }>;
