import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface LibraryUiState {
  /** Expanded category ids in the library tree. */
  expanded: Record<number, true>;
  /** Selected folder in each column of the columns browser, root first (category ids). */
  columnPath: number[];
  setColumnPath: (path: number[]) => void;
  toggle: (categoryId: number) => void;
  expandMany: (ids: number[]) => void;
  collapseAll: () => void;
}

export const useLibraryUi = create<LibraryUiState>()(
  persist(
    (set) => ({
      expanded: {},
      columnPath: [],
      setColumnPath: (columnPath) => set({ columnPath }),
      toggle: (id) =>
        set((s) => {
          const next = { ...s.expanded };
          if (next[id]) delete next[id];
          else next[id] = true;
          return { expanded: next };
        }),
      expandMany: (ids) =>
        set((s) => {
          const next = { ...s.expanded };
          for (const id of ids) next[id] = true;
          return { expanded: next };
        }),
      collapseAll: () => set({ expanded: {} }),
    }),
    { name: 'kodeshread.libraryUi', storage: createJSONStorage(() => AsyncStorage), version: 1 },
  ),
);

interface LibrarySettingsState {
  /** Manifest (or direct .gz/.zip/.db) URL of the core library; null = app.json default. */
  manifestUrl: string | null;
  /** The first-launch onboarding card was dismissed. */
  onboardingDismissed: boolean;
  setManifestUrl: (url: string | null) => void;
  dismissOnboarding: (dismissed?: boolean) => void;
}

/** Library & Updates Manager preferences (persisted). */
export const useLibrarySettings = create<LibrarySettingsState>()(
  persist(
    (set) => ({
      manifestUrl: null,
      onboardingDismissed: false,
      setManifestUrl: (url) => set({ manifestUrl: url && url.trim() ? url.trim() : null }),
      dismissOnboarding: (dismissed = true) => set({ onboardingDismissed: dismissed }),
    }),
    { name: 'kodeshread.librarySettings', storage: createJSONStorage(() => AsyncStorage), version: 1 },
  ),
);
