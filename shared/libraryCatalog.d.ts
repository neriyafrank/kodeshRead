/** Unified canonical library catalog (see libraryCatalog.js). */

export interface CatalogNode {
  /** 'sec:<path>' | 'book:<id>' | 'comm:<id>' */
  id: string;
  kind: 'section' | 'book' | 'commentary';
  /** Display name (sections: the section name; books: the title). */
  name: string;
  order: number;
  /** Base books below a section (1 for a book). */
  count: number;
  children?: CatalogNode[];
  bookId?: number;
  title?: string;
  /** Linked commentaries of a base book. */
  commentaryCount?: number;
  categoryPath?: string;
}

export interface RankedCommentary {
  bookId: number;
  title: string;
  /** Commentator display name ("רש"י" for "רשי על שבת"). */
  name: string;
  key: string;
  tier: string;
  core: boolean;
  era: string | null;
  rank: number;
  categoryPath?: string | null;
}

export interface LibraryCatalog {
  /** Base-book tree in canonical order (empty sections hidden). */
  sections: CatalogNode[];
  /** Base books that have commentaries, same sections + a final "מפרשים כלליים". */
  commentarySections: CatalogNode[];
  generalCommentaries: { bookId: number; title: string }[];
  bookCount: number;
  /** "is_commentary = 1" (derived; no schema change). */
  isCommentary(id: number): boolean;
  isBase(id: number): boolean;
  /** Root base book a commentary belongs to (null: general / not a commentary). */
  baseOf(id: number): number | null;
  commentaryCount(baseId: number): number;
  /** All commentaries of a base book (ראשונים, אחרונים, תרגומים ... together) in canonical rank order. */
  commentariesOf(baseId: number, opts?: { pinned?: string[] }): RankedCommentary[];
  commentaryIds(baseId: number): number[];
  bookTitle(id: number): string;
  bookPath(id: number): string;
  bookIdsOf(node: CatalogNode): number[];
}

export interface CatalogInput {
  categories: { id: number; parent_id: number | null; name: string; path?: string; source?: string }[];
  books: { id: number; category_id: number | null; title: string; aliases?: string | string[]; source?: string }[];
}

export function buildLibraryCatalog(data: CatalogInput): LibraryCatalog;
export function buildLibraryCatalogAsync(data: CatalogInput, pause?: () => Promise<void>): Promise<LibraryCatalog>;
export function filterTree(nodes: CatalogNode[], query: string, extra?: (node: CatalogNode) => boolean): CatalogNode[];
export function titleMatches(query: string, title: string, categoryPath?: string): boolean;
export function treeBookIds(nodes: CatalogNode[]): number[];
export function canon(s: string): string;
export const GENERAL_COMMENTARIES: string;
export const TOP_SECTIONS: string[];
export const CANON: {
  TORAH: string[];
  NEVIIM: string[];
  KETUVIM: string[];
  SEDARIM: string[];
  MISHNA_TRACTATES: string[][];
  BAVLI_TRACTATES: string[];
  RAMBAM: [string, string[]][];
  SHULCHAN_ARUCH_PARTS: string[];
};
