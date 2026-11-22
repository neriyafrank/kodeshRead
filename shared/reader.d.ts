import type { LibraryDb } from './sources';

export interface ParagraphRow {
  line_index: number;
  display_text: string;
  is_heading: number;
  toc_path: string | null;
}
export interface LineRange {
  from: number;
  to: number;
}
export interface TocNodeLike {
  id: number;
  parent_id: number | null;
  level: number;
  start_line: number;
}

export const SAFE_TAGS: string[];
export const RLM: string;
export const WINDOW_SIZE: number;
export const CHUNK_SIZE: number;
export const MAX_WINDOW: number;
export function sanitizeInlineHtml(html: string | null | undefined): string;
export function stripNiqqudForDisplay(text: string | null | undefined): string;
export function needsRtlMark(text: string): boolean;
/** showCantillation: false strips only the te'amim (U+0591–U+05AF); showNiqqud: false strips both. */
export function prepareDisplayText(html: string, opts?: { showNiqqud?: boolean; showCantillation?: boolean }): string;
export function stripCantillation(text: string): string;
export function windowAround(target: number, totalLines: number, size?: number): LineRange;
export function nextChunk(range: LineRange, direction: 'forward' | 'backward', totalLines: number, chunk?: number): LineRange | null;
export function mergeChunk<T extends { line_index: number }>(
  rows: T[],
  range: LineRange,
  chunkRows: T[],
  chunkRange: LineRange,
  direction: 'forward' | 'backward',
  max?: number,
): { rows: T[]; range: LineRange };
export function indexOfLine(rows: { line_index: number }[], line: number): number;
export function fetchRange(db: LibraryDb, bookId: number, from: number, to: number): Promise<ParagraphRow[]>;
export function tocTrail(nodes: TocNodeLike[], line: number): number[];
export function estimateItemSize(fontSize: number, lineHeight: number, avgChars?: number): number;
