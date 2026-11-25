/**
 * The canonical library catalog (shared/libraryCatalog.js) for the current library generation, shared by the Library
 * screen and the Search Scope Picker.
 *
 * Cold start: the catalog is restored from its persisted snapshot (shared/catalogCache.js; key = installed stages +
 * cheap per-source statistics), which takes a few milliseconds. Only a changed library (first launch, a new core, an
 * expansion install, an import) pays for pairing the whole library and building the trees (seconds of pure JS on
 * Hermes; it yields to the UI thread every few hundred books), and the result is stored for the next launch AFTER
 * the first paint, so storing never competes with the first render.
 */
import { useEffect, useState } from 'react';

import { loadCatalogCached } from '../../shared/catalogCache';
import type { LibraryCatalog } from '../../shared/libraryCatalog';
import { openTimings, perfLog, runAfterRender, sinceStart } from '../lib/perf';
import { catalogStore } from '../services/catalogCache';
import { useLibrary, type Library } from './LibraryContext';

let last: { generation: number; adapter: unknown; promise: Promise<LibraryCatalog> } | null = null;

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Installed library versions: part of the cache key (a core -> core + extended install is a different catalog). */
export const stagesOf = (lib: Pick<Library, 'core' | 'extended' | 'starter'>): string => `core=${lib.core?.info.version ?? (lib.starter ? 'starter' : '-')}|extended=${lib.extended?.info.version ?? '-'}`;

export function loadLibraryCatalog(adapter: Parameters<typeof loadCatalogCached>[0], generation: number, stages = ''): Promise<LibraryCatalog> {
  if (last && last.generation === generation && last.adapter === adapter) return last.promise;
  const promise = loadCatalogCached(adapter, {
    stages,
    store: catalogStore,
    pause,
    schedule: runAfterRender,
    onTiming: (t) =>
      perfLog('library-load', {
        dbOpen: openTimings.dbOpen,
        bookIndex: openTimings.bookIndex,
        key: t.keyMs,
        cacheRead: t.readMs,
        query: t.queryMs,
        buildTree: t.buildMs,
        total: t.totalMs,
        cache: t.cache,
        sinceStart: sinceStart(),
      }),
  });
  last = { generation, adapter, promise };
  // A failed build must not stick: the next caller retries.
  promise.catch(() => {
    if (last?.promise === promise) last = null;
  });
  return promise;
}

export function useLibraryCatalog(enabled = true): LibraryCatalog | null {
  const lib = useLibrary();
  const { adapter, generation } = lib;
  const stages = stagesOf(lib);
  const [state, setState] = useState<{ generation: number; catalog: LibraryCatalog } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadLibraryCatalog(adapter, generation, stages).then(
      (catalog) => alive && setState({ generation, catalog }),
      (e) => console.warn('library catalog failed', e),
    );
    return () => {
      alive = false;
    };
  }, [adapter, generation, enabled, stages]);
  return state && state.generation === generation ? state.catalog : null;
}
