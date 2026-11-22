export interface NormalizeOptions {
  /** Keep `.` and `:` (Talmudic amud shorthand: "ב." / "ב:"). */
  keepAmud?: boolean;
  /** Keep punctuation other than amud markers (default true). */
  keepPunctuation?: boolean;
}
export function normalizeHebrew(text: string | null | undefined, opts?: NormalizeOptions): string;
export function normalizeFinals(text: string): string;
export function stripNiqqud(text: string): string;
export function stripHtml(text: string): string;
export function decodeEntities(text: string): string;
export function extractRefKey(headingTitle: string): string;
export function generateBookAliases(categoryPath: string[] | string, bookTitle: string, extra?: string[]): string[];
export function acronyms(phrase: string): string[];
export function aliasKey(s: string): string;
export function hebrewNumeralToInt(s: string): number | null;
