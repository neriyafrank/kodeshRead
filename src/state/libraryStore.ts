import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface LibraryUiState {
  /** Expanded category ids in the library tree. */
  expanded: Record<number, true>;
  toggle: (categoryId: number) => void;
  expandMany: (ids: number[]) => void;
  collapseAll: () => void;
}

export const useLibraryUi = create<LibraryUiState>()(
  persist(
    (set) => ({
      expanded: {},
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
