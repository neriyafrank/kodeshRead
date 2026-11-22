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
export function refPaths(nodes: { id: number; parent_id: number | null; title: string }[]): Map<number, { labels: UnitLabel[]; refKey: string }>;
export function bookUnits(nodes: { id: number; parent_id: number | null; level: number; title: string; start_line: number }[], totalLines: number): BookUnit[];
export function makeBaseIndex(units: BookUnit[]): { units: BookUnit[]; find(labels: UnitLabel[]): BookUnit | null };
export function isCommentaryTitle(title: string): boolean;
export function linkTypeFor(title: string): 'commentary' | 'targum';
export function splitCommentaryTitle(title: string): { commentator: string; base: string } | null;
export function pairCommentaries(books: { id: number; title: string; aliases?: string[]; categoryPath?: string }[]): { commId: number; baseId: number }[];
export function inlineUnits(contentLines: { line: number; text: string }[], unit: { start: number; end: number }): Map<string, { start: number; end: number }>;
export function alignUnits(
  baseUnits: BookUnit[],
  commUnits: BookUnit[],
  commContent: number[] | Set<number>,
  baseContent?: (unit: BookUnit) => Promise<{ line: number; text: string }[]>,
): Promise<{ refKey: string; baseStart: number; baseEnd: number; commStart: number; commEnd: number }[]>;
