import type { QueryAdapter } from './quickJump';

export interface LinkedEntry {
  book_id: number;
  book_title: string;
  line: number;
  link_type: string | null;
  display_text: string | null;
  toc_path: string | null;
  category_path: string | null;
}

export interface CommentaryGroup {
  bookId: number;
  bookTitle: string;
  /** Short commentator name ("רש"י" for "רש"י על שבת"). */
  name: string;
  linkType: string | null;
  rank: number;
  entries: LinkedEntry[];
}

export function fetchLinkCounts(db: QueryAdapter, bookId: number, from: number, to: number): Promise<Map<number, number>>;
export function attachLinkCounts<T extends { line_index: number }>(rows: T[], counts: Map<number, number>): (T & { link_count: number })[];
export function fetchLinkedEntries(db: QueryAdapter, bookId: number, line: number): Promise<LinkedEntry[]>;
export function commentatorName(title: string): string;
export function groupLinkedEntries(entries: LinkedEntry[]): CommentaryGroup[];
