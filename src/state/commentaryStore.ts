/**
 * Commentary drawer preferences.
 *  - pinned: favorite commentators (⭐), by normalized commentator key (shared/commentaryRank.js
 *    commentatorKey; canonical for core commentators, so a ⭐ on רש"י holds in every book).
 *    Persisted; pin order = display order at the top of the drawer.
 *  - expanded: commentators the user opened / closed by hand this session. They override the
 *    smart default (favorites + top 3 primary) as the drawer moves between verses. Not persisted.
 *  - selection: commentator keys picked in the chip bar (empty = הכל). Sticky while moving between
 *    verses; shared/commentaryRank.js nextSelection(). Not persisted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { nextSelection } from '../../shared/commentaryRank';

interface CommentaryPrefsState {
  pinned: string[];
  expanded: Record<string, boolean>;
  selection: string[];
  togglePinned: (key: string) => void;
  setExpanded: (patch: Record<string, boolean>) => void;
  /** Chip gesture on commentator `key` (see nextSelection). */
  selectChip: (key: string, gesture: 'tap' | 'longpress') => void;
  /** הכל: back to every commentator. */
  clearSelection: () => void;
}

export const useCommentaryPrefs = create<CommentaryPrefsState>()(
  persist(
    (set) => ({
      pinned: [],
      expanded: {},
      selection: [],
      togglePinned: (key) =>
        set((s) => ({ pinned: s.pinned.includes(key) ? s.pinned.filter((k) => k !== key) : [...s.pinned, key] })),
      setExpanded: (patch) => set((s) => ({ expanded: { ...s.expanded, ...patch } })),
      selectChip: (key, gesture) => set((s) => ({ selection: nextSelection(s.selection, key, gesture) })),
      clearSelection: () => set({ selection: [] }),
    }),
    {
      name: 'kodeshread.commentary',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: ({ pinned }) => ({ pinned }),
    },
  ),
);
