import type { SearchScope } from './search';

export type GroupMode = 'category' | 'corpus' | 'hilchot' | 'book' | 'folder' | 'section';
export interface GroupContext {
  bookInfo?: (id: number) => { title?: string; categoryPath?: string } | undefined;
  scope?: SearchScope | null;
  isCommentary?: (id: number) => boolean;
}
export interface ResultGroup {
  key: string;
  label: string;
  count: number;
  /** Index (in the full result list) of the group's first row. */
  first: number;
}
interface GroupRow {
  book_id: number;
  book_title?: string;
  toc_path?: string | null;
}
export interface GroupTracker {
  mode: GroupMode;
  add(rows: GroupRow[]): GroupTracker;
  groups(): ResultGroup[];
  size(): number;
  keyOf(row: GroupRow): string;
}
export const BROAD_LABELS: Map<string, string>;
export function shortTitle(title: string): string;
export function broadCategory(categoryPath: string, bookId: number): { key: string; label: string };
export function groupModeFor(scope: SearchScope | null | undefined): GroupMode;
export function topSection(tocPath: string | null | undefined): string;
export function groupOf(row: GroupRow, mode: GroupMode, ctx?: GroupContext): { key: string; label: string };
export function createGroupTracker(mode: GroupMode, ctx?: GroupContext): GroupTracker;
export function summarizeGroups(rows: GroupRow[], mode: GroupMode, ctx?: GroupContext): ResultGroup[];
export function filterByGroup<T extends GroupRow>(rows: T[], groupKey: string | null | undefined, tracker: GroupTracker): T[];
