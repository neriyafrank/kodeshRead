import type { LibraryDb } from './sources';

export const PREFETCH_TARGETS: number;
export const PREFETCH_BEFORE: number;
export const PREFETCH_AFTER: number;
export const MIN_CONTEXT: number;
export const MAX_ENTRIES: number;
export const MAX_CHARS: number;

export interface ReaderWindow<Row = any> {
  bookId: number;
  line: number;
  total: number;
  range: { from: number; to: number };
  rows: Row[];
  at: number;
}
export interface LruCache<V = any> {
  get(key: string): V | undefined;
  peek(key: string): V | undefined;
  has(key: string): boolean;
  set(key: string, value: V): boolean;
  delete(key: string): void;
  clear(): void;
  keys(): string[];
  values(): V[];
  readonly size: number;
  readonly chars: number;
}
export function createLruCache<V = any>(opts?: { maxEntries?: number; maxChars?: number }): LruCache<V>;
export function prefetchRange(line: number, totalLines: number): { from: number; to: number };
export function covers(entry: ReaderWindow | null | undefined, bookId: number, line: number): boolean;
export function findWindow<Row = any>(cache: LruCache<ReaderWindow<Row>>, bookId: number, line: number): ReaderWindow<Row> | null;
export function loadReaderWindow(db: LibraryDb, bookId: number, line: number): Promise<ReaderWindow | null>;
export interface PrefetchTarget {
  bookId: number;
  line: number;
}
export interface PrefetchQueue {
  run(targets: PrefetchTarget[]): Promise<{ loaded: number; skipped: number; cancelled: boolean }>;
  cancel(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  isActive(): boolean;
  stats: { loaded: number; skipped: number; cancelled: number; failed: number };
}
export function createPrefetchQueue(opts: {
  load: (t: PrefetchTarget) => Promise<ReaderWindow | null>;
  cache: LruCache<ReaderWindow>;
  gapMs?: number;
  maxTargets?: number;
  sleep?: (ms: number) => Promise<void>;
}): PrefetchQueue;
export function keyOf(bookId: number, line: number): string;
