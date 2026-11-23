/**
 * Persisted Torah-study preferences: the daily-learning location (ארץ ישראל / חו"ל, which only
 * changes the weekly parsha on some weeks), the Chumash TOC mode (פרקים / פרשות) and whether the
 * "לימוד יומי" sections are expanded in the TOC drawer and on the Library screen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type TocMode = 'chapters' | 'parshiot';

interface LearningState {
  /** true = ארץ ישראל (default), false = חו"ל. */
  il: boolean;
  tocMode: TocMode;
  /** "לימוד יומי" expanded inside the TOC drawer. */
  tocDailyOpen: boolean;
  /** "לימוד יומי" card expanded on the Library screen. */
  libraryDailyOpen: boolean;
  setIl: (il: boolean) => void;
  setTocMode: (mode: TocMode) => void;
  setTocDailyOpen: (open: boolean) => void;
  setLibraryDailyOpen: (open: boolean) => void;
}

export const useLearning = create<LearningState>()(
  persist(
    (set) => ({
      il: true,
      tocMode: 'chapters',
      tocDailyOpen: false,
      libraryDailyOpen: false,
      setIl: (il) => set({ il }),
      setTocMode: (tocMode) => set({ tocMode }),
      setTocDailyOpen: (tocDailyOpen) => set({ tocDailyOpen }),
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
          tocDailyOpen: typeof p.tocDailyOpen === 'boolean' ? p.tocDailyOpen : current.tocDailyOpen,
          libraryDailyOpen: typeof p.libraryDailyOpen === 'boolean' ? p.libraryDailyOpen : current.libraryDailyOpen,
        };
      },
      partialize: ({ il, tocMode, tocDailyOpen, libraryDailyOpen }) => ({ il, tocMode, tocDailyOpen, libraryDailyOpen }),
    },
  ),
);
