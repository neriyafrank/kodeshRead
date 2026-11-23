/**
 * The canonical library catalog (shared/libraryCatalog.js) for the current library generation,
 * built once and shared by the Library screen and the Search Scope Picker. Pairing the whole
 * library takes ~1s of pure JS, so it yields to the UI thread every few hundred books.
 */
import { useEffect, useState } from 'react';

import { buildLibraryCatalogAsync, type LibraryCatalog } from '../../shared/libraryCatalog';
import { loadCatalog } from '../../shared/sources';
import { useLibrary } from './LibraryContext';

let last: { generation: number; adapter: unknown; promise: Promise<LibraryCatalog> } | null = null;

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function loadLibraryCatalog(adapter: Parameters<typeof loadCatalog>[0], generation: number): Promise<LibraryCatalog> {
  if (last && last.generation === generation && last.adapter === adapter) return last.promise;
  const promise = loadCatalog(adapter).then((data) => buildLibraryCatalogAsync(data, pause));
  last = { generation, adapter, promise };
  // A failed build must not stick: the next caller retries.
  promise.catch(() => {
    if (last?.promise === promise) last = null;
  });
  return promise;
}

export function useLibraryCatalog(enabled = true): LibraryCatalog | null {
  const { adapter, generation } = useLibrary();
  const [state, setState] = useState<{ generation: number; catalog: LibraryCatalog } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadLibraryCatalog(adapter, generation).then(
      (catalog) => alive && setState({ generation, catalog }),
      (e) => console.warn('library catalog failed', e),
    );
    return () => {
      alive = false;
    };
  }, [adapter, generation, enabled]);
  return state && state.generation === generation ? state.catalog : null;
}
