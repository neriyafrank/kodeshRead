/** Bundled Hebrew reading fonts (regular + bold of each family). */
import { Assistant_400Regular } from '@expo-google-fonts/assistant/400Regular';
import { Assistant_700Bold } from '@expo-google-fonts/assistant/700Bold';
import { DavidLibre_400Regular } from '@expo-google-fonts/david-libre/400Regular';
import { DavidLibre_700Bold } from '@expo-google-fonts/david-libre/700Bold';
import { FrankRuhlLibre_400Regular } from '@expo-google-fonts/frank-ruhl-libre/400Regular';
import { FrankRuhlLibre_700Bold } from '@expo-google-fonts/frank-ruhl-libre/700Bold';
import { Heebo_400Regular } from '@expo-google-fonts/heebo/400Regular';
import { Heebo_700Bold } from '@expo-google-fonts/heebo/700Bold';

export type FontFamilyKey = 'frankRuhl' | 'david' | 'assistant' | 'heebo';

export interface ReaderFont {
  key: FontFamilyKey;
  label: string;
  hebrewLabel: string;
  regular: string;
  bold: string;
}

export const READER_FONTS: ReaderFont[] = [
  { key: 'frankRuhl', label: 'Frank Ruhl Libre', hebrewLabel: 'פרנק רוהל', regular: 'FrankRuhlLibre_400Regular', bold: 'FrankRuhlLibre_700Bold' },
  { key: 'david', label: 'David Libre', hebrewLabel: 'דוד', regular: 'DavidLibre_400Regular', bold: 'DavidLibre_700Bold' },
  { key: 'assistant', label: 'Assistant', hebrewLabel: 'אסיסטנט', regular: 'Assistant_400Regular', bold: 'Assistant_700Bold' },
  { key: 'heebo', label: 'Heebo', hebrewLabel: 'היבו', regular: 'Heebo_400Regular', bold: 'Heebo_700Bold' },
];

export const fontAssets = {
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
  const f = READER_FONTS.find((x) => x.key === key) ?? READER_FONTS[0];
  return { regular: f.regular, bold: f.bold };
}
