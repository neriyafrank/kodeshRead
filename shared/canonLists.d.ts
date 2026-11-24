/** Canonical book lists (see canonLists.js). */
export function canon(s: string): string;
export function nameKey(s: string): string;
export class NameIndex {
  constructor(list: string[]);
  get(raw: string): number | undefined;
}
export const TORAH: string[];
export const NEVIIM: string[];
export const KETUVIM: string[];
export const SEDARIM: string[];
export const MISHNA_TRACTATES: string[][];
export const MISHNA_FLAT: string[];
export const BAVLI_TRACTATES: string[];
export const SHULCHAN_ARUCH_PARTS: string[];
export const SHULCHAN_ARUCH_ABBR: string[];
export const MIDRASH_RABBAH: string[];
export const TRACTATE_INDEX: NameIndex;
export const BAVLI_SET: Set<number>;
