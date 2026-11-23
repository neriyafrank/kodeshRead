/**
 * Commentary drawer preferences.
 *  - pinned: favorite commentators (⭐), by normalized commentator key (shared/commentaryRank.js
 *    commentatorKey; canonical for core commentators, so a ⭐ on רש"י holds in every book).
 *    Persisted; pin order = display order at the top of the drawer.
 *  - expanded: commentators the user opened / closed by hand this session. They override the
 *    smart default (favorites + top 3 primary) as the drawer moves between verses. Not persisted.
 *  - view: the drawer's view chip (all / core / pinned). Not persisted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { CommentaryView } from '../../shared/commentaryRank';

interface CommentaryPrefsState {
  pinned: string[];
  expanded: Record<string, boolean>;
  view: CommentaryView;
  togglePinned: (key: string) => void;
  setExpanded: (patch: Record<string, boolean>) => void;
  setView: (view: CommentaryView) => void;
}

export const useCommentaryPrefs = create<CommentaryPrefsState>()(
  persist(
    (set) => ({
      pinned: [],
      expanded: {},
      view: 'all',
      togglePinned: (key) =>
        set((s) => ({ pinned: s.pinned.includes(key) ? s.pinned.filter((k) => k !== key) : [...s.pinned, key] })),
      setExpanded: (patch) => set((s) => ({ expanded: { ...s.expanded, ...patch } })),
      setView: (view) => set({ view }),
    }),
    {
      name: 'kodeshread.commentary',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: ({ pinned }) => ({ pinned }),
    },
  ),
);
