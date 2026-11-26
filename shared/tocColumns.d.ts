import type { LibraryDb } from './sources';

export interface TocNodeRow {
  id: number;
  parent_id: number | null;
  level: number;
  title: string;
  start_line: number;
  ref_key?: string;
}
export interface TocTree<N extends TocNodeRow = TocNodeRow> {
  roots: N[];
  children: Map<number | null, N[]>;
  byId: Map<number, N>;
  /** Heading levels (1 for a single-level book). */
  depth: number;
}
export interface TocColumn<N extends TocNodeRow = TocNodeRow> {
  depth: number;
  parentId: number | null;
  items: N[];
  selectedId: number | null;
}
export interface InlineVerse {
  key: string;
  title: string;
  line: number;
}

export function buildTocTree<N extends TocNodeRow>(nodes: N[]): TocTree<N>;
export function hasChildren(tree: TocTree, id: number): boolean;
export function tocColumns<N extends TocNodeRow>(tree: TocTree<N>, path: number[]): TocColumn<N>[];
export function pathForLine(tree: TocTree, line: number): number[];
export function nodeEnd(tree: TocTree, node: TocNodeRow, totalLines: number): number;
export function fetchInlineVerses(db: LibraryDb, bookId: number, start: number, end: number, word?: string): Promise<InlineVerse[]>;
export function verseForLine(verses: InlineVerse[], line: number): InlineVerse | null;
export function filterToc<N extends TocNodeRow>(tree: TocTree<N>, query: string, limit?: number): N[];
export function nodeTrail(tree: TocTree, id: number): string[];

export const TOC_COLUMN_WIDTH: { min: number; max: number };
export function estimateTextWidth(text: string, fontSize?: number): number;
export interface TocColumnWidthOptions {
  fontSize?: number;
  /** Horizontal padding + gaps of a row (px). */
  chrome?: number;
  /** Some rows open a deeper column (reserve the "‹" indicator). */
  branch?: boolean;
  branchSpace?: number;
  /** "לתחילת …" column header. */
  header?: string | null;
  headerFontSize?: number;
  headerChrome?: number;
  min?: number;
  max?: number;
}
export function tocColumnWidth(labels: string[], opts?: TocColumnWidthOptions): number;
export function tocPanelWidth(columnWidths: number[], opts?: { min?: number; cap?: number }): number;

/** Shrinks column widths to fit `cap` (columns above `minCol` give way proportionally); all-minCol columns scroll when still too wide. */
export function fitColumnWidths(widths: number[], cap: number, minCol?: number): number[];

/** false = the first child starts right after the parent (no "לתחילת" row); null = lines in between (ask `startRowNeeded`); true = no child. */
export function startRowByLines(parentLine: number, firstChildLine: number | null | undefined): boolean | null;
/** Whether body text lies between the parent heading and its first child, i.e. the "לתחילת <parent>" row is useful. */
export function startRowNeeded(db: LibraryDb, bookId: number, parentLine: number, firstChildLine: number | null | undefined): Promise<boolean>;
