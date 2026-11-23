/** Persisted reading appearance (the `Aa` panel). Rules live in shared/typography.js. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  APPEARANCE_VERSION,
  DEFAULT_FONT,
  FONT_SIZE as FONT_SIZE_RANGE,
  LINE_HEIGHT as LINE_HEIGHT_RANGE,
  lineHeightMultiplier,
  migrateAppearance,
  sanitizeAppearance,
} from '../../shared/typography';
import type { FontFamilyKey } from '../fonts';

export type ThemeName = 'light' | 'sepia' | 'dark';

export const FONT_SIZE = FONT_SIZE_RANGE;
/** Slider range: leading of plain text; visible niqqud / te'amim add their own room on top. */
export const LINE_HEIGHT = LINE_HEIGHT_RANGE;

export interface AppearanceSettings {
  fontFamily: FontFamilyKey;
  fontSize: number;
  /** Multiplier of fontSize for plain text (see effectiveLineHeight). */
  lineHeight: number;
  theme: ThemeName;
  /** Vowel points (ניקוד). Hiding them hides cantillation too. */
  showNikkud: boolean;
  /** Cantillation marks (טעמי המקרא); hidden whenever nikkud is hidden. */
  showCantillation: boolean;
}

/** Commentary drawer: share of the reader height it takes. */
export const COMMENTARY_RATIO = { min: 0.22, max: 0.85, default: 0.42 };

interface SettingsState extends AppearanceSettings {
  /** Height of the commentary drawer as a fraction of the reader area. */
  commentaryRatio: number;
  /** The commentary drawer follows the paragraph at the reading line while scrolling. */
  commentaryFollow: boolean;
  set: (patch: Partial<AppearanceSettings>) => void;
  setCommentary: (patch: { ratio?: number; follow?: boolean }) => void;
  reset: () => void;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  fontFamily: DEFAULT_FONT as FontFamilyKey,
  fontSize: FONT_SIZE.default,
  lineHeight: LINE_HEIGHT.default,
  theme: 'light',
  showNikkud: true,
  showCantillation: true,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_APPEARANCE,
      commentaryRatio: COMMENTARY_RATIO.default,
      commentaryFollow: false,
      setCommentary: ({ ratio, follow }) =>
        set((s) => ({
          commentaryRatio: ratio == null ? s.commentaryRatio : clamp(Math.round(ratio * 1000) / 1000, COMMENTARY_RATIO.min, COMMENTARY_RATIO.max),
          commentaryFollow: follow ?? s.commentaryFollow,
        })),
      set: (patch) =>
        set((s) => ({
          ...patch,
          fontSize: clamp(Math.round(patch.fontSize ?? s.fontSize), FONT_SIZE.min, FONT_SIZE.max),
          lineHeight: clamp(Math.round((patch.lineHeight ?? s.lineHeight) * 100) / 100, LINE_HEIGHT.min, LINE_HEIGHT.max),
        })),
      reset: () => set(DEFAULT_APPEARANCE),
    }),
    {
      name: 'kodeshread.appearance',
      storage: createJSONStorage(() => AsyncStorage),
      // v2: showNiqqud -> showNikkud (+ showCantillation).
      // v3: Taamey Frank CLM default, plain-text slider (marks add their own leading).
      version: APPEARANCE_VERSION,
      migrate: (persisted, version) => migrateAppearance(persisted as Record<string, unknown>, version) as unknown as SettingsState,
      // Unknown font keys / themes in storage (e.g. from a newer build) fall back to the defaults.
      merge: (persisted, current) => ({ ...current, ...(sanitizeAppearance(persisted as Record<string, unknown>) as Partial<SettingsState>) }),
      partialize: ({ fontFamily, fontSize, lineHeight, theme, showNikkud, showCantillation, commentaryRatio, commentaryFollow }) => ({
        fontFamily,
        fontSize,
        lineHeight,
        theme,
        showNikkud,
        showCantillation,
        commentaryRatio,
        commentaryFollow,
      }),
    },
  ),
);

/** Line-height multiplier actually used for the text (slider + room for the visible marks). */
export function effectiveLineHeight(s: Pick<AppearanceSettings, 'lineHeight' | 'showNikkud' | 'showCantillation'>): number {
  return lineHeightMultiplier(s.lineHeight, s);
}

/** Hook: the effective line-height multiplier. */
export function useEffectiveLineHeight(): number {
  const lineHeight = useSettings((s) => s.lineHeight);
  const showNikkud = useSettings((s) => s.showNikkud);
  const showCantillation = useSettings((s) => s.showCantillation);
  return lineHeightMultiplier(lineHeight, { showNikkud, showCantillation });
}
