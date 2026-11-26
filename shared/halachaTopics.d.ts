import type { TocTree } from './tocColumns';

export interface HalachaTopic {
  /** Hebrew title, e.g. "הלכות ציצית". */
  t: string;
  from: number;
  to: number;
}
export type SectionKey = 'oc' | 'yd' | 'eh' | 'cm';
export interface HalachaTopicData {
  source?: string;
  fetched?: string | null;
  /** true until scripts/fetch-sa-topics.js has produced real data. */
  pending?: boolean;
  sa: Record<SectionKey, HalachaTopic[]>;
  tur: Record<SectionKey, HalachaTopic[]>;
  turFallback?: SectionKey[];
}
export const DATA: HalachaTopicData;
export function setTopicData(d: HalachaTopicData | null): HalachaTopicData;
export const SECTION_KEYS: SectionKey[];
export const SECTION_NAME: Record<SectionKey, string>;
export const SECTION_ALIASES: Record<SectionKey, string[]>;
export const SECTION_LABEL: Record<SectionKey, string>;
export function hasData(data?: HalachaTopicData): boolean;
export function sectionOfBook(title: string, categoryPath?: string): { kind: 'sa' | 'tur'; sec: SectionKey | null } | null;
export const MAX_SIMAN: Record<SectionKey, number>;
/** Every book sharing the Shulchan Aruch / Tur siman numbering (base books, commentaries, standalone works); sec null = several parts. */
export function tocSectionOfBook(title: string, categoryPath?: string): { kind: 'sa' | 'tur'; sec: SectionKey | null } | null;
export function simanLabel(n: number): string;
export function rangeLabel(t: HalachaTopic): string;
export function topicLabel(t: HalachaTopic): string;
export function topicKey(t: HalachaTopic): string;
export function topicsFor(kind: 'sa' | 'tur', sec: SectionKey, data?: HalachaTopicData): HalachaTopic[];
export function topicOfSiman(topics: HalachaTopic[], n: number): HalachaTopic | null;
export function groupTocTree<T extends { id: number; parent_id: number | null; level: number; title: string; start_line: number; ref_key?: string }>(
  tree: TocTree<T>,
  book: { title: string; categoryPath?: string },
  data?: HalachaTopicData,
): TocTree<T>;
export function matchTopics(kind: 'sa' | 'tur', rest: string[], opts?: { sec?: SectionKey }, data?: HalachaTopicData): { sec: SectionKey; topic: HalachaTopic; score: number }[];
