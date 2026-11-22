import { useCallback, useSyncExternalStore } from 'react';

export interface PersistApi {
  persist: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void };
}

/** True once every given zustand `persist` store has rehydrated. Pass a stable (module-level) array. */
export function useHydrated(stores: readonly PersistApi[]): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const unsubs = stores.map((s) => s.persist.onFinishHydration(notify));
      return () => unsubs.forEach((u) => u());
    },
    [stores],
  );
  const get = useCallback(() => stores.every((s) => s.persist.hasHydrated()), [stores]);
  return useSyncExternalStore(subscribe, get, get);
}
