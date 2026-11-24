/** Parallel-works engine (see parallelWorks.js). */
import type { LibraryDb } from './sources';

export type ParallelFamily = 'turim' | 'shas' | 'parasha';
export type ParallelWork =
  | 'tur' | 'shulchan_aruch' | 'levush' | 'aruch_hashulchan' | 'sa_harav'
  | 'mishna' | 'bavli' | 'yerushalmi' | 'tosefta' | 'rif' | 'rosh'
  | 'chumash' | 'midrash_rabbah' | 'tanchuma' | 'tanchuma_buber' | 'zohar' | 'chinuch';

export interface ParallelMember {
  family: ParallelFamily;
  work: ParallelWork;
  workLabel: string;
  order: number;
  /** Shulchan Aruch part (0 או"ח, 1 יו"ד, 2 אה"ע, 3 חו"מ) of a per-part book, else null (read from headings). */
  section: number | null;
  /** Canonical tractate index (Mishnah order). */
  tractate: number | null;
  /** Chumash book of a per-book member (בראשית רבה -> בראשית). */
  chumash: string | null;
  edition: string | null;
}

export interface ParallelSegment {
  key: string;
  label: string;
  name: string;
  start: number;
  end: number;
  num?: number;
}

export interface ParallelHit {
  family: ParallelFamily;
  work: ParallelWork;
  workLabel: string;
  /** Card / chip name ("טור", "בראשית רבה", "תוספתא (מהדורת ליברמן)"). */
  name: string;
  bookId: number;
  bookTitle: string;
  categoryPath: string;
  key: string;
  /** "או"ח סימן יב" / "שבת פרק א" / "פרשת נח". */
  label: string;
  start: number;
  end: number;
  order: number;
  preview: { line: number; display_text: string; toc_path: string | null }[];
}

export interface ParallelResult {
  family: ParallelFamily | null;
  familyLabel: string;
  coordinate: { key: string; label: string; start: number; end: number } | null;
  parallels: ParallelHit[];
}

export const FAMILIES: Record<ParallelFamily, { id: ParallelFamily; label: string; unit: string }>;
export const WORKS: Record<ParallelWork, { family: ParallelFamily; label: string; order: number; group?: 'mishna' | 'bavli' }>;
export const EXCLUDED_TITLES: string[];
export const DIVERGENT: Map<number, number[] | 'all'>;
export function sectionIndex(text: string): number | null;
export function sectionLabel(i: number): string;
export function tractateIndex(name: string): number | null;
export function tractateName(i: number): string;
export function parashaOfHeading(title: string): number[];
export function bereishitRabbahParasha(n: number | null): number | null;
export function memberOf(book: { title: string; categoryPath?: string | null }): ParallelMember | null;
export function displayName(member: ParallelMember | null, title: string): string;
export function segmentsFromUnits(member: ParallelMember, units: object[], extra?: object): ParallelSegment[];
export function segmentAt(segments: ParallelSegment[], line: number): ParallelSegment | null;
export function familyIndex(db: LibraryDb, books?: { id: number; title: string; categoryPath?: string; personal?: boolean }[]): Promise<{ byId: Map<number, object>; byFamily: Map<ParallelFamily, object[]> }>;
export function parallelMember(db: LibraryDb, bookId: number, opts?: { books?: { id: number; title: string; categoryPath?: string }[] }): Promise<ParallelMember | null>;
export function findParallels(
  db: LibraryDb,
  bookId: number,
  line: number,
  opts?: { books?: { id: number; title: string; categoryPath?: string }[]; previewLines?: number },
): Promise<ParallelResult>;
export function clearParallelCache(db?: object | null): void;
export function auditPaths(paths: string[]): Record<ParallelFamily, Record<string, string[]>>;
