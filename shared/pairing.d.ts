export interface PairBook {
  id: number;
  title: string;
  aliases?: string[];
  categoryPath?: string;
}
export interface MultiScope {
  corpus: string;
  dir?: string | null;
  seder?: string;
}
export type Pairs = { commId: number; baseId: number; how: string }[] & { multi?: { commId: number; scope: MultiScope }[] };
export const KNOWN_BASES: Record<string, string[]>;
export const COMMENTARY_DIRS: Set<string>;
export function isCommentaryTitle(title: string): boolean;
export function splitCommentaryTitle(title: string): { commentator: string; base: string } | null;
/** Base-name splits at every " על " (first split first). */
export function commentarySplits(title: string): string[];
export function nameVariants(name: string): string[];
export function placeOf(categoryPath: string | null | undefined): { dirs: string[]; corpus: string; primary: boolean; owner: string | null };
export function pairCommentaries(books: PairBook[]): Pairs;
/** pairCommentaries, awaiting `pause()` every few hundred books (never blocks the JS thread for long). */
export function pairCommentariesAsync(books: PairBook[], pause?: () => Promise<void>): Promise<Pairs>;
export function multiTargets(books: PairBook[], scope: MultiScope): Map<string, number>;
export function headingBookKey(title: string): string;
export function scopeOfMulti(name: string, place: ReturnType<typeof placeOf>): MultiScope | null;
