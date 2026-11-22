/**
 * Library state shared by every screen: the core + personal databases, the router that
 * queries across them (shared/sources.js), the in-memory Quick Jump book index, and a
 * controller to refresh after imports or swap the core library atomically.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { loadBookIndex, type BookIndex } from '../../shared/quickJump';
import { hasFts5 } from '../../shared/search';
import { createRouter, USER_ID_BASE, USER_ROOT_NAME, type LibraryRouter, type LibrarySource } from '../../shared/sources';
import { useSearch } from '../state/searchStore';
import { useTabs } from '../state/tabsStore';
import { closeQuietly } from './dbUtils';
import { installStagedCore, openCoreDatabase, openUserDatabase, deleteCoreDatabase, toAdapter, type CoreInfo } from './library';

export interface Library {
  /** Routes per-book queries to the owning DB and merges library-wide ones. */
  adapter: LibraryRouter;
  /** In-memory title/alias index for Quick Jump (both libraries). */
  bookIndex: BookIndex;
  /** SQLite build has FTS5 (always on Android; the web preview falls back to LIKE). */
  fts: boolean;
  /** core_library.db, or null until one is downloaded / built. */
  core: { db: SQLiteDatabase; info: CoreInfo } | null;
  /** user_library.db (always open, read-write for the local indexer). */
  user: SQLiteDatabase;
  coreBookCount: number;
  userBookCount: number;
  /** Bumped on every refresh, so screens re-fetch the tree etc. */
  generation: number;
}

export interface LibraryController {
  /** Re-reads both DBs (after importing or deleting personal books). */
  refresh: () => Promise<void>;
  /**
   * Swaps in the verified staging file (core_library.db.tmp): closes the current core
   * connection, renames the file over core_library.db, reopens. user_library.db is untouched.
   */
  installCore: () => Promise<void>;
  removeCore: () => Promise<void>;
}

type State = { status: 'loading' } | { status: 'ready'; library: Library } | { status: 'error'; message: string };

const LibraryContext = createContext<Library | null>(null);
const ControllerContext = createContext<LibraryController | null>(null);

export function useLibrary(): Library {
  const lib = useContext(LibraryContext);
  if (!lib) throw new Error('useLibrary() must be used inside <LibraryProvider>');
  return lib;
}

export function useLibraryController(): LibraryController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error('useLibraryController() must be used inside <LibraryProvider>');
  return c;
}

async function buildLibrary(core: Library['core'], user: SQLiteDatabase, generation: number): Promise<Library> {
  const sources: LibrarySource[] = [];
  if (core) sources.push({ name: 'core', adapter: toAdapter(core.db), idBase: 0 });
  sources.push({ name: 'user', adapter: toAdapter(user), idBase: USER_ID_BASE, categoryRoot: USER_ROOT_NAME });
  const adapter = createRouter(sources);
  const [bookIndex, fts] = await Promise.all([loadBookIndex(adapter), hasFts5(adapter)]);
  if (!fts) console.warn('SQLite build has no FTS5 (web preview): full-text search uses a slow LIKE fallback');
  let coreBookCount = 0;
  let userBookCount = 0;
  for (const id of bookIndex.books.keys()) {
    if (id >= USER_ID_BASE) userBookCount++;
    else coreBookCount++;
  }
  return { adapter, bookIndex, fts, core, user, coreBookCount, userBookCount, generation };
}

/** Drops tabs / search scopes whose book disappeared or changed (core swapped, book deleted). */
function pruneStaleReferences(index: BookIndex) {
  const valid = (bookId: number, title: string) => index.books.get(bookId)?.title === title;
  useTabs.getState().pruneTabs((t) => valid(t.bookId, t.bookTitle));
  const scope = useSearch.getState().scope;
  if (scope.kind === 'book' && !valid(scope.bookId, scope.title)) useSearch.getState().setScope({ kind: 'all' });
}

interface ProviderProps {
  /** Rendered until the databases are open (gets the error message on failure). */
  fallback: (error: string | null) => ReactNode;
  children: ReactNode;
}

export function LibraryProvider({ fallback, children }: ProviderProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const current = useRef<Library | null>(null);
  const generation = useRef(0);
  const busy = useRef<Promise<void>>(Promise.resolve());

  const publish = useCallback((lib: Library) => {
    current.current = lib;
    pruneStaleReferences(lib.bookIndex);
    setState({ status: 'ready', library: lib });
  }, []);

  /** Serializes controller operations (no refresh while a core swap is half done). */
  const serial = useCallback((fn: () => Promise<void>) => {
    const next = busy.current.then(fn, fn);
    busy.current = next.catch(() => undefined);
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [core, user] = await Promise.all([openCoreDatabase(), openUserDatabase()]);
        const lib = await buildLibrary(core, user, ++generation.current);
        if (alive) publish(lib);
      } catch (e) {
        console.error(e);
        if (alive) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [publish]);

  const controller = useMemo<LibraryController>(
    () => ({
      refresh: () =>
        serial(async () => {
          const lib = current.current;
          if (!lib) return;
          publish(await buildLibrary(lib.core, lib.user, ++generation.current));
        }),
      installCore: () =>
        serial(async () => {
          const lib = current.current;
          if (!lib) return;
          if (lib.core) await closeQuietly(lib.core.db);
          try {
            await installStagedCore();
          } finally {
            // Reopen whatever is there now (the new library, or the old one if the move failed).
            const core = await openCoreDatabase();
            publish(await buildLibrary(core, lib.user, ++generation.current));
          }
        }),
      removeCore: () =>
        serial(async () => {
          const lib = current.current;
          if (!lib) return;
          if (lib.core) await closeQuietly(lib.core.db);
          await deleteCoreDatabase();
          publish(await buildLibrary(null, lib.user, ++generation.current));
        }),
    }),
    [publish, serial],
  );

  if (state.status !== 'ready') return <>{fallback(state.status === 'error' ? state.message : null)}</>;
  return (
    <ControllerContext.Provider value={controller}>
      <LibraryContext.Provider value={state.library}>{children}</LibraryContext.Provider>
    </ControllerContext.Provider>
  );
}
