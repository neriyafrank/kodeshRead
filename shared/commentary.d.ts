import type { LibraryDb } from './sources';

export interface LinkedEntry {
  book_id: number;
  book_title: string;
  line: number;
  link_type: string | null;
  display_text: string | null;
  toc_path: string | null;
  category_path: string | null;
  /** Set for paragraphs of an aligned unit (Otzaria reference alignment). */
  block?: UnitBlock;
  /** An explicit link (Otzaria link file) points at exactly this paragraph. */
  direct?: boolean;
}

/** A range of the linked book aligned with the selected unit ("פרק א|פסוק א"). */
export interface UnitBlock {
  refKey: string;
  start: number;
  end: number;
  /** 'base': the selected book is the base, the block is commentary (and vice versa). */
  role?: 'base' | 'comm';
}

export interface UnitLink {
  role: 'base' | 'comm';
  otherBookId: number;
  refKey: string;
  /** Range of the unit in the selected book. */
  start: number;
  end: number;
  /** Range of the aligned unit in the other book. */
  otherStart: number;
  otherEnd: number;
  link_type: string | null;
}

export interface CommentaryGroup {
  bookId: number;
  bookTitle: string;
  /** Short commentator name ("רש"י" for "רש"י על שבת"). */
  name: string;
  /** Library folder of the linked book ("תנך/ראשונים/רמבן/תורה"): corpus + era for ranking. */
  categoryPath: string | null;
  linkType: string | null;
  rank: number;
  entries: LinkedEntry[];
  /** Whole aligned block in this book (open + highlight target), when heading-aligned. */
  block: { refKey: string; start: number; end: number } | null;
}

export const MAX_BLOCK_LINES: number;
/** Innermost aligned unit of every partner book containing `line` (both directions). */
export function fetchUnitLinks(db: LibraryDb, bookId: number, line: number): Promise<UnitLink[]>;
export function clearRefCache(db?: object | null): void;

export function fetchLinkCounts(db: LibraryDb, bookId: number, from: number, to: number): Promise<Map<number, number>>;
export function attachLinkCounts<T extends { line_index: number }>(rows: T[], counts: Map<number, number>): (T & { link_count: number })[];
export function fetchLinkedEntries(db: LibraryDb, bookId: number, line: number): Promise<LinkedEntry[]>;
export function commentatorName(title: string): string;
export function groupLinkedEntries(entries: LinkedEntry[]): CommentaryGroup[];
