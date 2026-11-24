export const EXTENDED_ID_BASE: number;
export const CORE_CORPORA: string[];
export const CORE_COMMENTATORS: Record<string, string[]>;
export function selectCoreBooks(books: { id: number; title: string; aliases?: string[]; categoryPath: string }[]): {
  ids: Set<number>;
  bases: Set<number>;
  commentaries: Set<number>;
  baseCorpusOf: Map<number, string>;
};
export function toExtendedId(id: number): number;
export function isExtendedId(id: number): boolean;
