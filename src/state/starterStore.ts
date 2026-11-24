/**
 * Cloud starter catalog (starter-catalog.json) and the per-book load state shown on the Library
 * screen. Not persisted here: the last good catalog is cached in AsyncStorage by
 * src/services/starterLibrary.ts, so the list also shows offline.
 */
import { create } from 'zustand';

import type { StarterCatalog } from '../../shared/starterPacks';

export type StarterPhase = 'download' | 'verify' | 'import';

interface StarterState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  catalog: StarterCatalog | null;
  /** The catalog on screen is the cached copy (the network was unreachable). */
  stale: boolean;
  error: string | null;
  /** Books being loaded right now (slug -> phase). */
  busy: Record<string, StarterPhase>;
  /** Last load error per book (slug -> message), shown on its row with a retry. */
  failed: Record<string, string>;
  set: (patch: Partial<Pick<StarterState, 'status' | 'catalog' | 'stale' | 'error'>>) => void;
  setBusy: (slug: string, phase: StarterPhase | null) => void;
  setFailed: (slug: string, message: string | null) => void;
}

export const useStarter = create<StarterState>()((set) => ({
  status: 'idle',
  catalog: null,
  stale: false,
  error: null,
  busy: {},
  failed: {},
  set: (patch) => set(patch),
  setBusy: (slug, phase) =>
    set((s) => {
      const busy = { ...s.busy };
      if (phase) busy[slug] = phase;
      else delete busy[slug];
      return { busy };
    }),
  setFailed: (slug, message) =>
    set((s) => {
      const failed = { ...s.failed };
      if (message) failed[slug] = message;
      else delete failed[slug];
      return { failed };
    }),
}));
