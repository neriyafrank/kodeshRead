/**
 * Full-text search session: the last query + scope (persisted so the Search
 * screen reopens where the user left it) and a short recent-queries list.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { SearchScope } from '../../shared/search';

const MAX_RECENT = 8;

interface SearchState {
  query: string;
  scope: SearchScope;
  recent: string[];
  setQuery: (q: string) => void;
  setScope: (scope: SearchScope) => void;
  remember: (q: string) => void;
  clearRecent: () => void;
}

export const useSearch = create<SearchState>()(
  persist(
    (set) => ({
      query: '',
      scope: { kind: 'all' },
      recent: [],
      setQuery: (query) => set({ query }),
      setScope: (scope) => set({ scope }),
      remember: (q) =>
        set((s) => {
          const t = q.trim();
          if (!t) return s;
          return { recent: [t, ...s.recent.filter((r) => r !== t)].slice(0, MAX_RECENT) };
        }),
      clearRecent: () => set({ recent: [] }),
    }),
    {
      name: 'kodeshread.search',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: ({ query, scope, recent }) => ({ query, scope, recent }),
    },
  ),
);

export function scopeLabel(scope: SearchScope): string {
  if (scope.kind === 'category') return scope.name;
  if (scope.kind === 'book') return scope.title;
  return 'כל הספרייה';
}
