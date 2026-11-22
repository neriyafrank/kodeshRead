/** Persisted reading appearance (the `Aa` panel). */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { FontFamilyKey } from '../fonts';

export type ThemeName = 'light' | 'sepia' | 'dark';

export const FONT_SIZE = { min: 14, max: 36, step: 1, default: 20 };
export const LINE_HEIGHT = { min: 1.2, max: 2.4, step: 0.05, default: 1.7 };

export interface AppearanceSettings {
  fontFamily: FontFamilyKey;
  fontSize: number;
  /** Multiplier of fontSize. */
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
  fontFamily: 'frankRuhl',
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
      // v2: showNiqqud -> showNikkud (+ showCantillation). Older saved settings keep their choice.
      version: 2,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2 && typeof p.showNiqqud === 'boolean' && p.showNikkud === undefined) {
          p.showNikkud = p.showNiqqud;
          delete p.showNiqqud;
        }
        return p as unknown as SettingsState;
      },
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
