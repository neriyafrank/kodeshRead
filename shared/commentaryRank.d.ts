/** Corpus-aware commentary priority ranking (see commentaryRank.js). */

export type Corpus = 'tanach' | 'mishna' | 'bavli' | 'yerushalmi' | 'rambam' | 'shulchan_aruch' | 'tur';
export type Era = 'targum' | 'rishonim' | 'acharonim' | 'modern';
/** Display group of a linked book. */
export type CommentaryTier = 'מקור' | 'עיקריים' | 'תרגומים' | 'ראשונים' | 'אחרונים' | 'נוספים';
export type CommentaryView = 'all' | 'core' | 'pinned';

/** Canonical core commentators per corpus, in priority order ('display|alias|alias'). */
export const CORE_LISTS: Record<Corpus, string[]>;
export const CORPUS_LABEL: Record<Corpus, string>;
export const TIERS: { source: 'מקור'; core: 'עיקריים'; targum: 'תרגומים'; rishonim: 'ראשונים'; acharonim: 'אחרונים'; other: 'נוספים' };

export interface RankInput {
  bookId?: number;
  bookTitle: string;
  /** Commentator name; derived from bookTitle when absent. */
  name?: string;
  linkType?: string | null;
  categoryPath?: string | null;
}

export interface CommentaryClass {
  /** Normalized commentator key (canonical for core commentators): pins / expansion state. */
  key: string;
  /** Name to show ("רש"י" for an Otzaria "רשי על בראשית"). */
  displayName: string;
  corpus: Corpus | null;
  core: boolean;
  coreIndex: number | null;
  era: Era | null;
  tier: CommentaryTier;
  /** The base text of a commentary (link_type 'source'). */
  isSource: boolean;
}

export type Ranked<T extends RankInput> = T & CommentaryClass & { name: string; pinned: boolean; pinIndex: number | null; rank: number };

export function commentatorKey(name: string): string;
export function commentatorOf(title: string): string;
export function findCore(name: string, corpus?: Corpus | null, title?: string): { entry: { display: string; aliases: string[]; index: number; corpus: Corpus }; alias: string } | null;
export function detectCorpus(categoryPath: string | null | undefined, title?: string | null): Corpus | null;
export function eraOf(categoryPath: string | null | undefined, linkType?: string | null): Era | null;
export function inferCorpus(items: RankInput[], context?: { title?: string | null; categoryPath?: string | null; corpus?: Corpus | null }): Corpus | null;
export function classifyCommentary(item: RankInput, corpus: Corpus | null): CommentaryClass;
export function rankCommentaries<T extends RankInput>(
  groups: T[],
  opts?: { pinned?: string[]; corpus?: Corpus | null; context?: { title?: string | null; categoryPath?: string | null } },
): Ranked<T>[];
export function defaultExpandedKeys(ranked: { key: string; pinned: boolean }[], opts?: { top?: number; allBelow?: number }): Set<string>;
export function matchesCommentatorQuery(query: string, item: RankInput & Partial<CommentaryClass>): boolean;
export function filterCommentaries<T extends RankInput & CommentaryClass & { pinned: boolean }>(ranked: T[], opts?: { view?: CommentaryView; query?: string }): T[];
export function nextSelection(selection: string[], key: string, gesture: 'tap' | 'longpress'): string[];
export function selectCommentaries<T extends { key: string }>(ranked: T[], selection: string[]): T[];
