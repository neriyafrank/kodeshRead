import type { LibraryDb } from './sources';

export type LearningKey = 'parasha' | 'dafYomi' | 'mishna' | 'rambam1' | 'rambam3';

export type TargetLocation =
  | { kind: 'verse'; chapter: number; verse: number }
  | { kind: 'daf'; daf: number; amud: 'א' | 'ב' }
  | { kind: 'chapter'; chapter: number; sub?: number }
  | { kind: 'start' };

export interface LearningTarget {
  /** Otzaria path without ".txt" ("תנך/תורה/בראשית"). */
  path: string;
  bookTitle: string;
  /** Short label of this target ("שני", "כל הפרשה", "נגעים ג, א"). */
  label: string;
  loc: TargetLocation;
  /** Printed reference ('בראשית ל"ב י"ד'). */
  ref: string;
}

export interface LearningItem {
  key: LearningKey;
  /** "פרשת השבוע", "דף היומי", ... */
  label: string;
  /** Today's passage ("וישלח · שני", "ערכין דף ו", "נגעים ג, א-ב"). */
  title: string;
  detail: string;
  targets: LearningTarget[];
  parsha?: { names: string[]; nums: number[]; aliyah: string };
  daf?: { tractate: string; blatt: number };
  mishnayot?: { tractate: string; chapter: number; mishna: number }[];
  rambam?: { name: string; perek: number | string }[];
}

export interface LearningSchedule {
  date: Date;
  /** "2026-11-23" */
  dateKey: string;
  il: boolean;
  /** 'י"ג בכסלו תשפ"ז' */
  hebrewDate: string;
  /** 0 = Sunday ... 6 = Shabbat. */
  weekday: number;
  items: LearningItem[];
  /** Schedules that could not be computed for the date (e.g. before a cycle began). */
  errors: string[];
}

export interface ResolvedTarget extends LearningTarget {
  available: boolean;
  bookId: number | null;
  libraryTitle: string | null;
  line: number | null;
  /** The whole location was found (false: only part, or the book start). */
  exact: boolean;
}
export interface ResolvedItem extends Omit<LearningItem, 'targets'> {
  targets: ResolvedTarget[];
  available: boolean;
}
export interface ResolvedSchedule extends Omit<LearningSchedule, 'items'> {
  items: ResolvedItem[];
}

export const BAVLI: Record<string, [string, string, string?]>;
export const MISHNA: Record<string, [number, string]>;
export const RAMBAM: Record<string, [string, string]>;
export const SEDARIM: string[];
export const SHEKALIM_DAF: Record<number, [number, number]>;
export const WEEKDAY_ALIYAH: string[];

export function hebrewDateLabel(hd: unknown): string;
export function weeklyParsha(hd: unknown, il: boolean): { parshiot: import('./torahParshiot').Parsha[]; shabbat: unknown };
export function computeDailyLearning(date?: Date, opts?: { il?: boolean }): LearningSchedule;
export function findLibraryBooks(db: LibraryDb, paths: string[]): Promise<Map<string, { id: number; title: string; totalLines: number }>>;
export function resolveTarget(db: LibraryDb, book: { id: number; totalLines: number }, loc: TargetLocation): Promise<{ line: number; exact: boolean; path: string[] }>;
export function resolveDailyLearning(db: LibraryDb, schedule: LearningSchedule): Promise<ResolvedSchedule>;
