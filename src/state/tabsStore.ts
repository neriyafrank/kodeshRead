/**
 * Multi-tab reading workspace. Each tab remembers its book and exact reading
 * position ({ tabId, bookId, bookTitle, currentLineIndex, tocPath } plus the pixel
 * offset into that line), persisted to AsyncStorage.
 *
 * Jump requests (Quick Jump, TOC taps, re-opening a book) are transient and not
 * persisted: the active BookReader consumes them.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface ReaderTab {
  tabId: string;
  bookId: number;
  bookTitle: string;
  currentLineIndex: number;
  tocPath: string | null;
  /** Pixels the top visible paragraph is scrolled past the viewport top (exact restore). */
  lineOffset: number;
  /** Last time the tab was opened or activated (ms), for "recent first" ordering. */
  lastUsed?: number;
}

export interface JumpRequest {
  tabId: string;
  line: number;
  highlight: boolean;
  /** Normalized search terms to flash inside the target paragraph (search results). */
  terms?: string[];
  /** Highlight every line up to this one (a commentary block / verse unit). */
  highlightEnd?: number;
  nonce: number;
}

/** Studying with many sources open is normal: the oldest inactive tab is dropped beyond this. */
export const MAX_TABS = 40;

interface TabsState {
  tabs: ReaderTab[];
  activeTabId: string | null;
  pendingJump: JumpRequest | null;
  /** Opens (or re-uses) a tab for the book and jumps to `line`. Returns the tab id. */
  openBook: (book: { bookId: number; bookTitle: string }, opts?: { line?: number; highlight?: boolean; highlightEnd?: number; terms?: string[]; newTab?: boolean }) => string;
  activate: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  /** Keeps only `tabId` (and activates it). */
  closeOthers: (tabId: string) => void;
  /** Closes the tabs visually to the LEFT of `tabId` in the RTL strip (the ones after it). */
  closeToLeft: (tabId: string) => void;
  closeAll: () => void;
  /** Closes every tab for which `keep` returns false (e.g. its book no longer exists). */
  pruneTabs: (keep: (tab: ReaderTab) => boolean) => void;
  requestJump: (tabId: string, line: number, highlight?: boolean) => void;
  consumeJump: (nonce: number) => void;
  updatePosition: (tabId: string, pos: { currentLineIndex: number; tocPath: string | null; lineOffset: number }) => void;
}

let nonce = 0;
const newTabId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      pendingJump: null,

      openBook: ({ bookId, bookTitle }, opts = {}) => {
        const { tabs } = get();
        const line = Math.max(1, opts.line ?? 1);
        const existing = opts.newTab ? undefined : tabs.find((t) => t.bookId === bookId);
        // Opening a book from the tree without a target restores where you left off.
        const keepPosition = existing && opts.line == null;
        const tabId = existing?.tabId ?? newTabId();
        const now = Date.now();
        let next = existing ? tabs.map((t) => (t.tabId === tabId ? { ...t, lastUsed: now } : t)) : tabs;
        if (!existing) {
          next = [...tabs, { tabId, bookId, bookTitle, currentLineIndex: line, tocPath: null, lineOffset: 0, lastUsed: now }];
          if (next.length > MAX_TABS) {
            // Drop the least recently used inactive tab.
            const active = get().activeTabId;
            const candidates = next.filter((t) => t.tabId !== active && t.tabId !== tabId);
            const drop = candidates.reduce<ReaderTab | undefined>((a, t) => (!a || (t.lastUsed ?? 0) < (a.lastUsed ?? 0) ? t : a), undefined);
            next = next.filter((t) => t !== drop);
          }
        }
        set({
          tabs: next,
          activeTabId: tabId,
          pendingJump: keepPosition
            ? null
            : { tabId, line, highlight: !!opts.highlight, highlightEnd: opts.highlightEnd, terms: opts.terms?.length ? opts.terms : undefined, nonce: ++nonce },
        });
        return tabId;
      },

      activate: (tabId) => set((s) => ({ activeTabId: tabId, tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, lastUsed: Date.now() } : t)) })),

      closeOthers: (tabId) =>
        set((s) => {
          const keep = s.tabs.filter((t) => t.tabId === tabId);
          if (!keep.length) return s;
          return { tabs: keep, activeTabId: tabId, pendingJump: s.pendingJump?.tabId === tabId ? s.pendingJump : null };
        }),

      closeToLeft: (tabId) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.tabId === tabId);
          if (idx < 0) return s;
          const tabs = s.tabs.slice(0, idx + 1);
          const activeTabId = tabs.some((t) => t.tabId === s.activeTabId) ? s.activeTabId : tabId;
          return { tabs, activeTabId, pendingJump: s.pendingJump && tabs.some((t) => t.tabId === s.pendingJump?.tabId) ? s.pendingJump : null };
        }),

      closeTab: (tabId) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.tabId === tabId);
          if (idx < 0) return s;
          const tabs = s.tabs.filter((t) => t.tabId !== tabId);
          let activeTabId = s.activeTabId;
          if (activeTabId === tabId) activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? null)?.tabId ?? null;
          return { tabs, activeTabId, pendingJump: s.pendingJump?.tabId === tabId ? null : s.pendingJump };
        }),

      closeAll: () => set({ tabs: [], activeTabId: null, pendingJump: null }),

      pruneTabs: (keep) =>
        set((s) => {
          const tabs = s.tabs.filter(keep);
          if (tabs.length === s.tabs.length) return s;
          const activeTabId = tabs.some((t) => t.tabId === s.activeTabId) ? s.activeTabId : (tabs[0]?.tabId ?? null);
          const pendingJump = s.pendingJump && tabs.some((t) => t.tabId === s.pendingJump?.tabId) ? s.pendingJump : null;
          return { tabs, activeTabId, pendingJump };
        }),

      requestJump: (tabId, line, highlight = true) => set({ pendingJump: { tabId, line, highlight, nonce: ++nonce } }),

      consumeJump: (n) => set((s) => (s.pendingJump?.nonce === n ? { pendingJump: null } : s)),

      updatePosition: (tabId, pos) =>
        set((s) => {
          const t = s.tabs.find((x) => x.tabId === tabId);
          if (!t || (t.currentLineIndex === pos.currentLineIndex && t.tocPath === pos.tocPath && t.lineOffset === pos.lineOffset)) return s;
          return { tabs: s.tabs.map((x) => (x.tabId === tabId ? { ...x, ...pos } : x)) };
        }),
    }),
    {
      name: 'kodeshread.tabs',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: ({ tabs, activeTabId }) => ({ tabs, activeTabId }),
    },
  ),
);

export const selectActiveTab = (s: TabsState) => s.tabs.find((t) => t.tabId === s.activeTabId) ?? null;
