/** Otzaria reference alignment: heading-based commentary <-> base-book units. */

export interface UnitLabel {
  /** Canonical unit kind ("פרק", "פסוק", "דף", "עמוד", "סימן", "סעיף", "סעיף קטן", ...); '' when unnamed. */
  type: string;
  /** Normalized key ("א", "שכח", "הקדמה"). */
  key: string;
}

export interface BookUnit {
  id: number;
  level: number;
  title: string;
  labels: UnitLabel[];
  /** Canonical reference path: "פרק א|פסוק א". */
  refKey: string;
  start: number;
  /** End of the whole subtree. */
  end: number;
  /** End of the unit's own text (before its first sub-heading). */
  ownEnd: number;
}

export const UNIT_TYPES: Map<string, string>;
export const KNOWN_BASES: Record<string, string[]>;
export function unitLabels(title: string): UnitLabel[];
export function refKeyOf(labels: UnitLabel[]): string;
/** Inverse of refKeyOf (reads book_units.ref_key back into labels). */
export function labelsFromRefKey(refKey: string): UnitLabel[];
export function refPaths(nodes: { id: number; parent_id: number | null; title: string }[]): Map<number, { labels: UnitLabel[]; refKey: string }>;
export function bookUnits(nodes: { id: number; parent_id: number | null; level: number; title: string; start_line: number }[], totalLines: number): BookUnit[];
export function makeBaseIndex(units: BookUnit[]): { units: BookUnit[]; find(labels: UnitLabel[]): BookUnit | null };
export function isCommentaryTitle(title: string): boolean;
export function linkTypeFor(title: string): 'commentary' | 'targum';
export function splitCommentaryTitle(title: string): { commentator: string; base: string } | null;
export function pairCommentaries(books: { id: number; title: string; aliases?: string[]; categoryPath?: string }[]): import("./pairing").Pairs;
export function pairCommentariesAsync(books: { id: number; title: string; aliases?: string[]; categoryPath?: string }[], pause?: () => Promise<void>): Promise<import("./pairing").Pairs>;
/** Name of "(א)" units inside a heading: פסוק (Tanach), משנה, סעיף (סימן / כלל), else אות. */
export function inlineUnitWord(parentTitle: string, categoryPath?: string | null): string;
/** Paragraph number of a Bavli "שורה N" sub-heading (1-based body paragraph of the amud), or null. */
export function paragraphNumber(text: string | null | undefined): number | null;
export function markerKey(text: string | null | undefined): string | null;
/** `ordinal: false`: markers only (never "n-th line = verse n"). */
export function inlineUnits(contentLines: { line: number; text: string }[], unit: { start: number; end: number }, opts?: { ordinal?: boolean }): Map<string, { start: number; end: number }>;
export function alignUnits(
  baseUnits: BookUnit[],
  commUnits: BookUnit[],
  /** With `text`, a unit whose דיבורים carry "(ב)" markers is split per seif / verse. */
  commContent: number[] | Set<number> | { line: number; text?: string | null }[],
  baseContent?: (unit: BookUnit) => Promise<{ line: number; text: string }[]>,
  opts?: { splitMarkers?: boolean },
): Promise<{ refKey: string; baseStart: number; baseEnd: number; commStart: number; commEnd: number }[]>;
export function multiUnits(commUnits: BookUnit[], targets: Map<string, number>): Map<number, BookUnit[]>;
export function multiTargets(books: { id: number; title: string; aliases?: string[]; categoryPath?: string }[], scope: object): Map<string, number>;
export function headingBookKey(title: string): string;
/** False for the Shulchan Aruch / Tur (their commentaries number seifim katanim). */
export function sharesInlineNumbering(baseTitle: string): boolean;
