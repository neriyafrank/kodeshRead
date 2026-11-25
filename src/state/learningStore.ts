/**
 * Persisted Torah-study preferences: the Chumash TOC mode (פרקים / פרשות) and whether the
 * Library screen's "לימוד יומי" card is expanded.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type TocMode = 'chapters' | 'parshiot';
/** Shulchan Aruch / Tur TOC mode: by siman (flat) or by הלכות topic (shared/halachaTopics.json). */
export type HalachaTocMode = 'simanim' | 'topics';

interface LearningState {
  tocMode: TocMode;
  halachaMode: HalachaTocMode;
  /** "לימוד יומי" card expanded on the Library screen. */
  libraryDailyOpen: boolean;
  setTocMode: (mode: TocMode) => void;
  setHalachaMode: (mode: HalachaTocMode) => void;
  setLibraryDailyOpen: (open: boolean) => void;
}

export const useLearning = create<LearningState>()(
  persist(
    (set) => ({
      tocMode: 'chapters',
      halachaMode: 'simanim',
      libraryDailyOpen: false,
      setTocMode: (tocMode) => set({ tocMode }),
      setHalachaMode: (halachaMode) => set({ halachaMode }),
      setLibraryDailyOpen: (libraryDailyOpen) => set({ libraryDailyOpen }),
    }),
    {
      name: 'kodeshread.learning',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<LearningState>;
        return {
          ...current,
          tocMode: p.tocMode === 'parshiot' || p.tocMode === 'chapters' ? p.tocMode : current.tocMode,
          halachaMode: p.halachaMode === 'topics' || p.halachaMode === 'simanim' ? p.halachaMode : current.halachaMode,
          libraryDailyOpen: typeof p.libraryDailyOpen === 'boolean' ? p.libraryDailyOpen : current.libraryDailyOpen,
        };
      },
      partialize: ({ tocMode, halachaMode, libraryDailyOpen }) => ({ tocMode, halachaMode, libraryDailyOpen }),
    },
  ),
);
