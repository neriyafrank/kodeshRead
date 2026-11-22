/**
 * App palettes (Light / Sepia / OLED Dark) and the hook that picks the active one
 * from the persisted appearance settings.
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
  highlight: string;
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
    danger: '#9C3317',
    backdrop: 'rgba(40, 24, 6, 0.4)',
    statusBar: 'dark',
  },
  dark: {
    name: 'dark',
    background: '#000000',
    surface: '#0E0E0E',
    surfaceMuted: '#181818',
    border: '#262626',
    text: '#E4DED2',
    textMuted: '#948C7F',
    accent: '#D8A54C',
    accentSoft: '#2A2114',
    highlight: '#4D3B0E',
    danger: '#FF7B5C',
    backdrop: 'rgba(0, 0, 0, 0.6)',
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
