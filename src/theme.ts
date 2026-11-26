/**
 * App palettes (Light / Sepia / Dark) and the hook that picks the active one from the persisted
 * appearance settings. Dark is a low-glare charcoal (not pure black) with warm off-white text
 * and a slate-indigo active-verse highlight.
 */
import { useMemo } from 'react';

import { useSettings, type ThemeName } from './state/settingsStore';

export interface Palette {
  name: ThemeName;
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  /** Jump-target glow (2 s). */
  highlight: string;
  /** Warm glow behind searched words after opening a search result ("r, g, b"; alpha fades). */
  termGlow: string;
  /** Background of the active verse / paragraph (the one the commentary drawer shows). */
  selection: string;
  /** Margin verse numbers. */
  verseNumber: string;
  danger: string;
  backdrop: string;
  statusBar: 'dark' | 'light';
}

export const palettes: Record<ThemeName, Palette> = {
  light: {
    name: 'light',
    background: '#FBF8F1',
    surface: '#FFFFFF',
    surfaceMuted: '#F3EEE2',
    border: '#E4DCC8',
    text: '#1F1B16',
    textMuted: '#6B6255',
    accent: '#8A5A12',
    accentSoft: '#F4E7CF',
    highlight: '#FFE9A8',
    termGlow: '255, 170, 0',
    selection: '#F4E7CF',
    verseNumber: '#9A8F7E',
    danger: '#A3361F',
    backdrop: 'rgba(20, 14, 4, 0.38)',
    statusBar: 'dark',
  },
  sepia: {
    name: 'sepia',
    background: '#F3E9D2',
    surface: '#F8F0DD',
    surfaceMuted: '#EADDBE',
    border: '#D8C69E',
    text: '#3A2C1A',
    textMuted: '#7A6648',
    accent: '#8B4A1C',
    accentSoft: '#E6D4AE',
    highlight: '#EFCF7C',
    termGlow: '230, 130, 10',
    selection: '#E6D4AE',
    verseNumber: '#9A8462',
    danger: '#9C3317',
    backdrop: 'rgba(40, 24, 6, 0.4)',
    statusBar: 'dark',
  },
  dark: {
    name: 'dark',
    background: '#212121',
    surface: '#2A2A2A',
    surfaceMuted: '#303030',
    border: '#3B3B3B',
    text: '#E8E6E3',
    textMuted: '#A29E97',
    accent: '#D2AE6D',
    accentSoft: '#3A3428',
    highlight: '#3D4769',
    termGlow: '255, 184, 64',
    selection: '#2D3347',
    verseNumber: '#8C8A86',
    danger: '#F08A6E',
    backdrop: 'rgba(0, 0, 0, 0.55)',
    statusBar: 'light',
  },
};

/** Light palette, for code that runs outside React (boot screen). */
export const colors = palettes.light;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 6, md: 10, lg: 14 };

export function useAppTheme(): Palette {
  return palettes[useSettings((s) => s.theme)] ?? palettes.light;
}

/** `factory` must be a stable (module-level) function. */
export function useThemedStyles<T>(factory: (c: Palette) => T): T {
  const c = useAppTheme();
  return useMemo(() => factory(c), [c, factory]);
}
