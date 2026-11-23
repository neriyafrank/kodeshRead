import type { LibraryDb } from './sources';

export type ChumashBook = 'בראשית' | 'שמות' | 'ויקרא' | 'במדבר' | 'דברים';
export interface VerseRef {
  chapter: number;
  verse: number;
}
export interface Aliyah {
  /** 0 = ראשון ... 6 = שביעי, 7 = מפטיר. */
  index: number;
  name: string;
  start: VerseRef;
}
export interface Parsha {
  /** 0-based position in the yearly cycle. */
  index: number;
  /** 1-based number (hebcal's Sedra.lookup().num). */
  num: number;
  /** "וישלח" */
  name: string;
  /** "פרשת וישלח" */
  title: string;
  /** hebcal name ("Vayishlach"). */
  en: string;
  book: ChumashBook;
  bookIndex: number;
  start: VerseRef;
  /** Last verse (inclusive). */
  end: VerseRef;
  /** ראשון..שביעי. */
  aliyot: Aliyah[];
  /** null only for וזאת הברכה (its maftir is read from Numbers). */
  maftir: Aliyah | null;
}
export interface Divider extends VerseRef {
  /** "פרשת וישלח" when a parsha starts here. */
  parsha: string | null;
  parshaIndex: number | null;
  /** Aliyot starting here other than ראשון (e.g. ['שביעי', 'מפטיר']). */
  aliyot: string[];
}
export interface LineDivider extends Divider {
  line: number;
}
export interface ResolvedReading extends Aliyah {
  line: number | null;
  /** "לב, יד" */
  label: string;
}
export interface ResolvedParsha extends Parsha {
  line: number | null;
  readings: ResolvedReading[];
}

export const CHUMASH_BOOKS: ChumashBook[];
export const ALIYAH_NAMES: string[];
export const CHAPTER_VERSES: Record<ChumashBook, number[]>;
export const PARSHIOT: Parsha[];
export function cmpRef(a: VerseRef, b: VerseRef): number;
export function readingsOf(parsha: Parsha): Aliyah[];
export function parshiotOfBook(book: string): Parsha[];
export function parshaByNumber(num: number): Parsha | null;
export function findParsha(name: string): Parsha | null;
export function parshaAt(book: string, ref: VerseRef): Parsha | null;
export function chumashBookOf(title: string, categoryPath?: string | null): ChumashBook | null;
export function bookDividers(book: string): Divider[];
export function refLabel(ref: VerseRef): string;
export function fullRefLabel(book: string, ref: VerseRef): string;
export function chumashVerseLines(db: LibraryDb, bookId: number): Promise<Map<string, number>>;
export function lineOfVerse(verseLines: Map<string, number>, ref: VerseRef): number | null;
export function dividerLines(book: string, verseLines: Map<string, number>): Map<number, LineDivider>;
export function parshiotWithLines(book: string, verseLines: Map<string, number>): ResolvedParsha[];
export function parshaForLine<P extends { line: number | null }>(resolved: P[], line: number): P | null;

/** 'בראשית ל״ב:י״ד' */
export function printedRef(book: string, ref: VerseRef): string;
export const PARSHA_VARIANTS: Record<string, string[]>;
export interface ParshaQuery {
  parsha: Parsha;
  /** 0 = ראשון ... 6 = שביעי, 7 = מפטיר. */
  readingIndex: number;
  reading: Aliyah;
  /** Typed with "פרשת". */
  explicit: boolean;
  /** Clearly a parsha reference (false: a bare Chumash book name, the book comes first). */
  strong: boolean;
}
export function parseParshaQuery(input: string | string[]): ParshaQuery | null;
