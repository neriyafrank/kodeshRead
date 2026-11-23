/**
 * Persisted Torah-study preferences: the daily-learning location (ארץ ישראל / חו"ל, which only
 * changes the weekly parsha on some weeks), the Chumash TOC mode (פרקים / פרשות) and whether the
 * Library screen's "לימוד יומי" card is expanded.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type TocMode = 'chapters' | 'parshiot';

interface LearningState {
  /** true = ארץ ישראל (default), false = חו"ל. */
  il: boolean;
  tocMode: TocMode;
  /** "לימוד יומי" card expanded on the Library screen. */
  libraryDailyOpen: boolean;
  setIl: (il: boolean) => void;
  setTocMode: (mode: TocMode) => void;
  setLibraryDailyOpen: (open: boolean) => void;
}

export const useLearning = create<LearningState>()(
  persist(
    (set) => ({
      il: true,
      tocMode: 'chapters',
      libraryDailyOpen: false,
      setIl: (il) => set({ il }),
      setTocMode: (tocMode) => set({ tocMode }),
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
          il: typeof p.il === 'boolean' ? p.il : current.il,
          tocMode: p.tocMode === 'parshiot' || p.tocMode === 'chapters' ? p.tocMode : current.tocMode,
          libraryDailyOpen: typeof p.libraryDailyOpen === 'boolean' ? p.libraryDailyOpen : current.libraryDailyOpen,
        };
      },
      partialize: ({ il, tocMode, libraryDailyOpen }) => ({ il, tocMode, libraryDailyOpen }),
    },
  ),
);
