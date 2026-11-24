import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { normalizeInstalledCloud } from '../../shared/libraryRelease';

interface LibraryUiState {
  /** Expanded category ids in the library tree. */
  expanded: Record<number, true>;
  /** Selected folder in each column of the columns browser, root first (category ids). */
  columnPath: number[];
  setColumnPath: (path: number[]) => void;
  /** Library browser: base books | commentaries per base book (shared/libraryCatalog.js). */
  catalogMode: 'base' | 'comm';
  /** Selected node ids (sections, then a book) in each column of the canonical catalog browser. */
  catalogPath: string[];
  setCatalogMode: (mode: 'base' | 'comm') => void;
  setCatalogPath: (path: string[]) => void;
  /** Mode and path in one update (e.g. "מפרשים (N)" jumping to a book's commentaries). */
  showCatalog: (mode: 'base' | 'comm', path: string[]) => void;
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
      catalogMode: 'base',
      catalogPath: [],
      setCatalogMode: (catalogMode) => set({ catalogMode, catalogPath: [] }),
      setCatalogPath: (catalogPath) => set({ catalogPath }),
      showCatalog: (catalogMode, catalogPath) => set({ catalogMode, catalogPath }),
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
  /** Library screen: the ספרי התחלה section is expanded (persisted; collapsed = just its header). */
  starterOpen: boolean;
  setStarterOpen: (open: boolean) => void;
  /** Cloud version + stage the app last installed (older builds also stored an `edition`: ignored). */
  installedCloud: { version: string; stage?: 'core' | 'full' } | null;
  setInstalledCloud: (version: string, stage?: 'core' | 'full') => void;
  setManifestUrl: (url: string | null) => void;
  dismissOnboarding: (dismissed?: boolean) => void;
}

/** Library & Updates Manager preferences (persisted). */
export const useLibrarySettings = create<LibrarySettingsState>()(
  persist(
    (set) => ({
      manifestUrl: null,
      onboardingDismissed: false,
      starterOpen: true,
      setStarterOpen: (starterOpen) => set({ starterOpen }),
      installedCloud: null,
      setInstalledCloud: (version, stage) => set({ installedCloud: stage ? { version, stage } : { version } }),
      setManifestUrl: (url) => set({ manifestUrl: url && url.trim() ? url.trim() : null }),
      dismissOnboarding: (dismissed = true) => set({ onboardingDismissed: dismissed }),
    }),
    {
      name: 'kodeshread.librarySettings',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      // v1 stored `installedCloud: { edition: 'classic' | 'full', version }`: there is one library now.
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        return { ...p, installedCloud: normalizeInstalledCloud(p.installedCloud) } as unknown as LibrarySettingsState;
      },
    },
  ),
);
