/**
 * Bundled Hebrew reading fonts (regular + bold of each family).
 *
 * Taamey Frank CLM (assets/fonts, Culmus project) is the default: its OpenType GPOS mark-to-base
 * and mark-to-mark tables position niqqud and te'amim, which Android's system fonts and most web
 * fonts do not, so the marks never collide or clip. The .ttf files are embedded natively by the
 * `expo-font` config plugin (app.json; family name = file name) and also loaded with `useFonts`
 * (web @font-face, Expo Go). "מערכת" uses the platform font.
 */
import { Assistant_400Regular } from '@expo-google-fonts/assistant/400Regular';
import { Assistant_700Bold } from '@expo-google-fonts/assistant/700Bold';
import { DavidLibre_400Regular } from '@expo-google-fonts/david-libre/400Regular';
import { DavidLibre_700Bold } from '@expo-google-fonts/david-libre/700Bold';
import { FrankRuhlLibre_400Regular } from '@expo-google-fonts/frank-ruhl-libre/400Regular';
import { FrankRuhlLibre_700Bold } from '@expo-google-fonts/frank-ruhl-libre/700Bold';
import { Heebo_400Regular } from '@expo-google-fonts/heebo/400Regular';
import { Heebo_700Bold } from '@expo-google-fonts/heebo/700Bold';

import { DEFAULT_FONT } from '../shared/typography';

export type FontFamilyKey = 'taameyFrank' | 'frankRuhl' | 'david' | 'assistant' | 'heebo' | 'system';

export interface ReaderFont {
  key: FontFamilyKey;
  label: string;
  hebrewLabel: string;
  /** Family names (undefined = the platform font). */
  regular: string | undefined;
  bold: string | undefined;
  /** Full cantillation support (GPOS mark positioning). */
  biblical?: boolean;
}

export const TAAMEY_FRANK = { regular: 'TaameyFrankCLM-Medium', bold: 'TaameyFrankCLM-Bold' } as const;

export const READER_FONTS: ReaderFont[] = [
  { key: 'taameyFrank', label: 'Taamey Frank CLM', hebrewLabel: 'טעמי פרנק', regular: TAAMEY_FRANK.regular, bold: TAAMEY_FRANK.bold, biblical: true },
  { key: 'frankRuhl', label: 'Frank Ruhl Libre', hebrewLabel: 'פרנק רוהל', regular: 'FrankRuhlLibre_400Regular', bold: 'FrankRuhlLibre_700Bold' },
  { key: 'david', label: 'David Libre', hebrewLabel: 'דוד', regular: 'DavidLibre_400Regular', bold: 'DavidLibre_700Bold' },
  { key: 'assistant', label: 'Assistant', hebrewLabel: 'אסיסטנט', regular: 'Assistant_400Regular', bold: 'Assistant_700Bold' },
  { key: 'heebo', label: 'Heebo', hebrewLabel: 'היבו', regular: 'Heebo_400Regular', bold: 'Heebo_700Bold' },
  { key: 'system', label: 'System', hebrewLabel: 'מערכת', regular: undefined, bold: undefined },
];

export const fontAssets = {
  [TAAMEY_FRANK.regular]: require('../assets/fonts/TaameyFrankCLM-Medium.ttf'),
  [TAAMEY_FRANK.bold]: require('../assets/fonts/TaameyFrankCLM-Bold.ttf'),
  FrankRuhlLibre_400Regular,
  FrankRuhlLibre_700Bold,
  DavidLibre_400Regular,
  DavidLibre_700Bold,
  Assistant_400Regular,
  Assistant_700Bold,
  Heebo_400Regular,
  Heebo_700Bold,
};

let fontsAvailable = true;
/** Called by the root layout if font loading failed (fall back to the system font). */
export function setFontsAvailable(ok: boolean) {
  fontsAvailable = ok;
}

export function readerFont(key: FontFamilyKey): { regular: string | undefined; bold: string | undefined } {
  if (!fontsAvailable) return { regular: undefined, bold: undefined };
  const f = READER_FONTS.find((x) => x.key === key) ?? READER_FONTS.find((x) => x.key === DEFAULT_FONT)!;
  return { regular: f.regular, bold: f.bold };
}
