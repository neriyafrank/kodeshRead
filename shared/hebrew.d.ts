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
/** 1..499 -> plain Hebrew numeral ('טו', 'קנז'); null outside that range. */
export function intToHebrew(n: number): string | null;
/** Printed form with gershayim / geresh: 13 -> 'י"ג', 5 -> "ה'". */
export function formatHebrewNumeral(n: number): string;
export interface VocalizationOptions {
  showNikkud?: boolean;
  /** Older spelling of showNikkud. */
  showNiqqud?: boolean;
  showCantillation?: boolean;
}
/** Cantillation marks (U+0591–U+05AF). */
export const CANTILLATION_MARKS_RE: RegExp;
/** Vowel points & diacritics ([U+05B0–U+05BD U+05BF U+05C1–U+05C2 U+05C4–U+05C5 U+05C7]). */
export const NIKKUD_MARKS_RE: RegExp;
export function stripCantillationMarks(text: string | null | undefined): string;
export function stripNikkudMarks(text: string | null | undefined): string;
/** Hiding nikkud hides cantillation too; hiding cantillation keeps the vowels. */
export function applyVocalization(text: string | null | undefined, opts?: VocalizationOptions): string;
