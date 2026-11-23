/**
 * Full-text search sessions (persisted so each screen reopens where the user left it):
 *  - Simple Search ("חיפוש רגיל"): one query + scope, literal matching only;
 *  - Advanced Search ("חיפוש מתקדם"): structured fields, linguistic toggles, proximity and
 *    corpus chips (defaults: shared/hebrewSearch.js ADVANCED_DEFAULTS);
 * plus a short recent-queries list shared by both.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { ADVANCED_DEFAULTS, type ProximityMode } from '../../shared/hebrewSearch';
import type { SearchScope } from '../../shared/search';

const MAX_RECENT = 8;

export interface AdvancedFields {
  /** מילות החיפוש / ביטוי (inline operators: a|b, -word, word*, "exact"). */
  query: string;
  /** אחת מהמילים · או */
  anyOf: string;
  /** ללא המילים · שלילה */
  exclude: string;
}

export interface LinguisticOptions {
  prefixesAndSuffixes: boolean;
  pleneDefective: boolean;
  acronyms: boolean;
  aramaicEquiv: boolean;
}

export interface ProximityOptions {
  mode: ProximityMode;
  distance: number;
  ordered: boolean;
}

/** 'all' | 'book' (the open book) | corpus ids (shared/search.js CORPORA), several allowed. */
export type CorpusSelection = string[];

export interface AdvancedState {
  fields: AdvancedFields;
  options: LinguisticOptions;
  proximity: ProximityOptions;
  corpora: CorpusSelection;
}

export const EMPTY_FIELDS: AdvancedFields = { query: '', anyOf: '', exclude: '' };

export function advancedDefaults(): AdvancedState {
  return {
    fields: { ...EMPTY_FIELDS },
    options: {
      prefixesAndSuffixes: ADVANCED_DEFAULTS.prefixesAndSuffixes,
      pleneDefective: ADVANCED_DEFAULTS.pleneDefective,
      acronyms: ADVANCED_DEFAULTS.acronyms,
      aramaicEquiv: ADVANCED_DEFAULTS.aramaicEquiv,
    },
    proximity: { ...ADVANCED_DEFAULTS.proximity },
    corpora: ['all'],
  };
}

interface SearchState {
  query: string;
  scope: SearchScope;
  recent: string[];
  advanced: AdvancedState;
  setQuery: (q: string) => void;
  setScope: (scope: SearchScope) => void;
  setAdvanced: (patch: Partial<AdvancedState>) => void;
  resetAdvanced: () => void;
  remember: (q: string) => void;
  clearRecent: () => void;
}

export const useSearch = create<SearchState>()(
  persist(
    (set) => ({
      query: '',
      scope: { kind: 'all' },
      recent: [],
      advanced: advancedDefaults(),
      setQuery: (query) => set({ query }),
      setScope: (scope) => set({ scope }),
      setAdvanced: (patch) => set((s) => ({ advanced: { ...s.advanced, ...patch } })),
      resetAdvanced: () => set({ advanced: advancedDefaults() }),
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
      version: 2,
      // v1 had a "חיפוש מורחב" toggle on the main screen: Simple Search is now always literal.
      migrate: (persisted) => {
        const p = (persisted || {}) as Partial<SearchState> & { smart?: boolean };
        return { query: p.query ?? '', scope: p.scope ?? { kind: 'all' }, recent: p.recent ?? [], advanced: advancedDefaults() } as unknown as SearchState;
      },
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<SearchState>;
        const d = advancedDefaults();
        const a = p.advanced;
        return {
          ...current,
          ...p,
          advanced: a
            ? { fields: { ...d.fields, ...a.fields }, options: { ...d.options, ...a.options }, proximity: { ...d.proximity, ...a.proximity }, corpora: Array.isArray(a.corpora) && a.corpora.length ? a.corpora : d.corpora }
            : d,
        };
      },
      partialize: ({ query, scope, recent, advanced }) => ({ query, scope, recent, advanced }),
    },
  ),
);

export function scopeLabel(scope: SearchScope): string {
  if (scope.kind === 'category' || scope.kind === 'corpus' || scope.kind === 'books') return scope.name;
  if (scope.kind === 'book') return scope.title;
  return 'כל הספרייה';
}
