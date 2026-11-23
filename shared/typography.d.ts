export type ReaderFontKey = 'taameyFrank' | 'frankRuhl' | 'david' | 'assistant' | 'heebo' | 'system';
export type ReaderThemeName = 'light' | 'sepia' | 'dark';

export interface Range {
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface MarkOptions {
  showNikkud?: boolean;
  showCantillation?: boolean;
}

export interface PersistedAppearance {
  fontFamily: ReaderFontKey;
  fontSize: number;
  lineHeight: number;
  theme: ReaderThemeName;
  showNikkud: boolean;
  showCantillation: boolean;
  [key: string]: unknown;
}

export const FONT_KEYS: ReaderFontKey[];
export const DEFAULT_FONT: ReaderFontKey;
export const THEMES: ReaderThemeName[];
export const DEFAULT_THEME: ReaderThemeName;
export const FONT_SIZE: Range;
export const LINE_HEIGHT: Range;
export const VOCALIZATION_LEADING: { nikkud: number; cantillation: number };
export const MAX_EFFECTIVE_LINE_HEIGHT: number;
export const APPEARANCE_VERSION: number;

export function visibleMarks(opts?: MarkOptions): { nikkud: boolean; cantillation: boolean };
export function lineHeightMultiplier(base: number, opts?: MarkOptions): number;
export function lineHeightPx(fontSize: number, base: number, opts?: MarkOptions): number;
export function hebrewNumeralValue(s: string): number;
export function toHebrewNumeral(n: number): string;
export function splitVerseMarker(prepared: string): { marker: string | null; text: string };
export function verseGutterWidth(fontSize: number): number;
export function sanitizeAppearance(p: Record<string, unknown> | null | undefined): PersistedAppearance;
export function migrateAppearance(persisted: Record<string, unknown> | null | undefined, version: number): PersistedAppearance;
