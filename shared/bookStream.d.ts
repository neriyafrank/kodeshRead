/** Streaming text input for book ingestion (see bookStream.js). */
export const MAX_LINE_CHARS: number;
export const DEFAULT_CHUNK_BYTES: number;
export class LineTooLongError extends Error {
  constructor(max: number);
}
export interface Utf8Decoder {
  write(bytes: Uint8Array): string;
  end(): string;
}
/** forceJs: use the pure-JS decoder even where TextDecoder exists (tests). */
export function createUtf8Decoder(opts?: { forceJs?: boolean }): Utf8Decoder;
export function createLineSplitter(opts?: { maxLineChars?: number }): { push(text: string): string[]; end(): string[] };
/** A byte source: an expo-file-system FileHandle wrapper, or a node fd in tests. */
export interface ByteSource {
  read(length: number): Promise<Uint8Array | null>;
  close(): unknown;
}
export function openTextReader(
  openBytes: () => Promise<ByteSource> | ByteSource,
  opts?: { chunkBytes?: number; forceJs?: boolean },
): Promise<{ read(): Promise<string | null>; close(): Promise<void> }>;
/** A reported entry name, URL-decoded, without path / document-id prefix. */
export function cleanName(name: string): string;
/** Name carried by a file:// or path-based SAF URI, else null. */
export function nameFromUri(uri: string): string | null;
