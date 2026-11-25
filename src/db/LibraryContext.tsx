/**
 * Library state shared by every screen: the core + personal databases, the router that
 * queries across them (shared/sources.js), the in-memory Quick Jump book index, and a
 * controller to refresh after imports or swap the core library atomically.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { loadBookIndex, type BookIndex, type QueryAdapter } from '../../shared/quickJump';
import { booksScope, hasFts5 } from '../../shared/search';
import { createRouter, EXTENDED_ID_BASE, USER_ID_BASE, USER_ROOT_NAME, type LibraryRouter, type LibrarySource } from '../../shared/sources';
import { openTimings, perfLog, runAfterRender } from '../lib/perf';
import { useSearch } from '../state/searchStore';
import { useTabs } from '../state/tabsStore';
import { closeQuietly } from './dbUtils';
import { readMeta } from '../../shared/indexer';
import { deleteExtendedDatabase, deleteStarterDatabase, installStagedCore, installStagedExtended, isWeb, openCoreDatabase, openExtendedDatabase, openStarterDatabase, openUserDatabase, deleteCoreDatabase, starterDbExists, toAdapter, type CoreInfo } from './library';

export interface Library {
  /** Routes per-book queries to the owning DB and merges library-wide ones. */
  adapter: LibraryRouter;
  /** In-memory title/alias index for Quick Jump (both libraries). */
  bookIndex: BookIndex;
  /** SQLite build has FTS5 (always on Android; the web preview falls back to LIKE). */
  fts: boolean;
  /** core_library.db, or null until one is downloaded / built. */
  core: { db: SQLiteDatabase; info: CoreInfo } | null;
  /**
   * extended_library.db (הרחבה לספרייה מלאה): the optional second stage, queried as one more router source (ids >=
   * EXTENDED_ID_BASE; nothing is merged on the device). null until it is downloaded; never open without a core.
   */
  extended: { db: SQLiteDatabase; info: CoreInfo } | null;
  /** user_library.db (always open, read-write for the local indexer). */
  user: SQLiteDatabase;
  /**
   * starter_library.db: cloud starter books loaded on demand. Open (and queried as a source, ids as in
   * the core library) only while there is no core library; null once the full library is installed.
   */
  starter: SQLiteDatabase | null;
  coreBookCount: number;
  userBookCount: number;
  /** Bumped on every refresh, so screens re-fetch the tree etc. */
  generation: number;
}

export interface LibraryController {
  /** Re-reads both DBs (after importing or deleting personal books). */
  refresh: () => Promise<void>;
  /**
   * Swaps in a verified staging file of the SQLite directory (default core_library.db.tmp; an
   * on-device build passes core_library.build.db): drains the core readers, closes the current
   * core connection, removes its -wal / -shm, renames the file over core_library.db, reopens.
   * user_library.db is untouched. Throws a coreFinalize.StepError naming the failed sub-step.
   */
  installCore: (from?: string) => Promise<void>;
  /**
   * Swaps in the verified staging file extended_library.db.tmp over extended_library.db and attaches it to the router.
   * The core library is untouched and stays usable throughout.
   */
  installExtended: () => Promise<void>;
  /** Removes the core library AND the expansion pack (the expansion only works next to its core). */
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

/**
 * Reader gate of one core connection: counts the queries in flight so a swap can wait for them
 * (instead of closing the connection under a running statement), then refuses new ones until
 * the new library is published (screens re-query on the generation bump).
 */
interface CoreGate {
  adapter: QueryAdapter;
  /** Stops new queries and waits (at most `timeoutMs`) for the running ones to finish. */
  drain: (timeoutMs: number) => Promise<void>;
}

const coreGates = new WeakMap<SQLiteDatabase, CoreGate>();

function coreGate(db: SQLiteDatabase): CoreGate {
  const existing = coreGates.get(db);
  if (existing) return existing;
  let inflight = 0;
  let closed = false;
  let idle: (() => void)[] = [];
  const settle = () => {
    if (inflight) return;
    const waiting = idle;
    idle = [];
    waiting.forEach((f) => f());
  };
  const gate: CoreGate = {
    adapter: {
      all: async <T,>(sql: string, params: (string | number | null)[]) => {
        if (closed) throw new Error('ספריית הליבה מתעדכנת כעת — נסו שוב בעוד רגע');
        inflight++;
        try {
          return await db.getAllAsync<T>(sql, params);
        } finally {
          inflight--;
          settle();
        }
      },
    },
    drain: async (timeoutMs) => {
      closed = true;
      if (!inflight) return;
      await Promise.race([new Promise<void>((r) => idle.push(r)), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    },
  };
  coreGates.set(db, gate);
  return gate;
}

async function buildLibrary(core: Library['core'], user: SQLiteDatabase, starter: SQLiteDatabase | null, generation: number, extended: Library['extended'] = null): Promise<Library> {
  const sources: LibrarySource[] = [];
  if (core) sources.push({ name: 'core', adapter: coreGate(core.db).adapter, idBase: 0 });
  if (core && extended) sources.push({ name: 'extended', adapter: coreGate(extended.db).adapter, idBase: EXTENDED_ID_BASE });
  // Starter mode: the books opened from the cloud stand in for the core library (same ids as in it).
  else if (starter) sources.push({ name: 'starter', adapter: toAdapter(starter), idBase: 0 });
  // Web preview only: after a page reload expo-sqlite's web storage can hand back the seeded
  // core database under the user database's name; querying it as "user" would list every
  // core book twice. A personal library always says kind = user.
  const userKind = isWeb ? (await readMeta(toAdapter(user)).catch(() => null))?.kind : 'user';
  if (userKind === 'user' || userKind === undefined) sources.push({ name: 'user', adapter: toAdapter(user), idBase: USER_ID_BASE, categoryRoot: USER_ROOT_NAME });
  else console.warn(`user library storage returned a "${userKind}" database (web preview); personal books unavailable`);
  const adapter = createRouter(sources);
  // Cold start: only the cheap columns (id, title, folder, lines) before the first render; the alias index for Quick Jump
  // is built after the first paint (publish) or on its first use. The FTS5 probe runs beside it.
  const timed = async <T,>(p: Promise<T>): Promise<[T, number]> => {
    const t = Date.now();
    return [await p, Date.now() - t];
  };
  const [[bookIndex, bookIndexMs], [fts, ftsMs]] = await Promise.all([timed(loadBookIndex(adapter, { lazyAliases: true })), timed(hasFts5(adapter))]);
  openTimings.bookIndex = bookIndexMs;
  openTimings.fts = ftsMs;
  if (!fts) console.warn('SQLite build has no FTS5 (web preview): full-text search uses a slow LIKE fallback');
  let coreBookCount = 0;
  let userBookCount = 0;
  for (const id of bookIndex.books.keys()) {
    if (id >= USER_ID_BASE) userBookCount++;
    else coreBookCount++;
  }
  return { adapter, bookIndex, fts, core, extended: core ? extended : null, user, starter: core ? null : starter, coreBookCount, userBookCount, generation };
}

/**
 * After the full library replaced the cloud starter books: a tab keeps working when the book has a
 * different id in the new library (another release) but the same title in the same folder.
 */
function remapTabs(prev: BookIndex, next: BookIndex) {
  const byKey = new Map<string, number | null>();
  for (const b of next.books.values()) {
    const key = `${b.title}\u0000${b.categoryPath}`;
    byKey.set(key, byKey.has(key) ? null : b.id);
  }
  useTabs.setState((s) => ({
    tabs: s.tabs.map((t) => {
      if (next.books.get(t.bookId)?.title === t.bookTitle) return t;
      const old = prev.books.get(t.bookId);
      const id = old ? byKey.get(`${old.title}\u0000${old.categoryPath}`) : null;
      return id != null ? { ...t, bookId: id } : t;
    }),
  }));
}

/** Drops tabs / search scopes whose book disappeared or changed (core swapped, book deleted). */
function pruneStaleReferences(index: BookIndex) {
  const valid = (bookId: number, title: string) => index.books.get(bookId)?.title === title;
  useTabs.getState().pruneTabs((t) => valid(t.bookId, t.bookTitle));
  const scope = useSearch.getState().scope;
  if (scope.kind === 'book' && !valid(scope.bookId, scope.title)) useSearch.getState().setScope({ kind: 'all' });
  if (scope.kind === 'books') {
    const picks = (scope.picks ?? []).filter((p) => valid(p.id, p.title));
    if (picks.length !== (scope.picks ?? []).length) useSearch.getState().setScope(booksScope(picks));
  }
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
    // Non-critical, after the first render: the Quick Jump alias index (cooperative, a few hundred books per slice).
    runAfterRender(() => {
      const t = Date.now();
      lib.bookIndex.ensureAliases(() => new Promise<void>((r) => setTimeout(r, 0))).then(
        () => perfLog('quickjump-aliases', { build: Date.now() - t }),
        (e) => console.warn('quick jump aliases failed (built on first use)', e),
      );
    });
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
        const tOpen = Date.now();
        // Everything that opens a file starts at once; the expansion is dropped below when there is no (matching) core.
        const [core, user, extended0] = await Promise.all([openCoreDatabase(), openUserDatabase(), openExtendedDatabase().catch(() => null)]);
        // The expansion pack only works next to a core library of the same build; a stale one is ignored (replaced on update).
        let extended = extended0;
        if (!core && extended) {
          await closeQuietly(extended.db);
          extended = null;
        }
        if (extended && extended.info.version !== core?.info.version) {
          await closeQuietly(extended.db);
          extended = null;
        }
        // No full library yet: the cloud starter database is the instant first-launch library.
        // (A starter DB left behind next to an installed core library is stale: removed.)
        let starter: SQLiteDatabase | null = null;
        if (!core) starter = await openStarterDatabase().catch((e) => (console.warn('starter library unavailable', e), null));
        else if (starterDbExists()) await deleteStarterDatabase().catch(() => undefined);
        openTimings.dbOpen = Date.now() - tOpen;
        const lib = await buildLibrary(core, user, starter, ++generation.current, extended);
        openTimings.total = Date.now() - tOpen;
        perfLog('library-open', { dbOpen: openTimings.dbOpen, bookIndex: openTimings.bookIndex, fts: openTimings.fts, total: openTimings.total, books: String(lib.bookIndex.books.size) });
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
          publish(await buildLibrary(lib.core, lib.user, lib.starter, ++generation.current, lib.extended));
        }),
      installCore: (from?: string) =>
        serial(async () => {
          const lib = current.current;
          if (!lib) return;
          let closed = false;
          try {
            await installStagedCore({
              from,
              closeCore: async () => {
                if (!lib.core) return;
                // No query may run on (or start against) the old file while it is replaced.
                await coreGate(lib.core.db).drain(2000);
                if (lib.extended) {
                  await coreGate(lib.extended.db).drain(2000);
                  await lib.extended.db.closeAsync();
                }
                await lib.core.db.closeAsync();
                closed = true;
              },
              reopenCore: async () => {
                const core = await openCoreDatabase({ strict: true });
                if (!core) throw new Error('core_library.db is not a valid library after the swap');
                // The expansion of the OLD core is of another build: it is dropped and downloaded again (only that delta).
                if (lib.extended) deleteExtendedDatabase();
                const next = await buildLibrary(core, lib.user, null, ++generation.current);
                // Starter books (or an older, smaller library) -> the complete library: open tabs
                // follow their books (same title + folder).
                if (lib.starter || lib.core) remapTabs(lib.bookIndex, next.bookIndex);
                publish(next);
              },
              warn: (w) => console.warn(`library install: ${w.step} failed (ignored)`, w.message),
            });
            // The full library replaced the cloud starter books: drop that database. Nothing else
            // lives in it (tabs / settings are in AsyncStorage, personal books in user_library.db).
            if (lib.starter) {
              await closeQuietly(lib.starter);
              await deleteStarterDatabase().catch((err) => console.warn('starter library could not be removed', err));
            }
          } catch (e) {
            // Republish whatever is installed now (the old library if the swap did not happen).
            // A failed close left the old connection open: keep serving it through a new gate.
            let core: Library['core'] = null;
            let extended: Library['extended'] = null;
            if (closed || !lib.core) {
              core = await openCoreDatabase().catch(() => null);
              extended = core ? await openExtendedDatabase().catch(() => null) : null;
            } else {
              coreGates.delete(lib.core.db);
              core = lib.core;
              extended = lib.extended;
              if (extended) coreGates.delete(extended.db);
            }
            try {
              publish(await buildLibrary(core, lib.user, lib.starter, ++generation.current, extended));
            } catch (again) {
              console.warn('library could not be republished after a failed install', again);
            }
            throw e;
          }
        }),
      installExtended: () =>
        serial(async () => {
          const lib = current.current;
          if (!lib?.core) throw new Error('הרחבת הספרייה דורשת ספריית יסוד מותקנת');
          let closed = false;
          try {
            await installStagedExtended({
              closeExtended: async () => {
                if (!lib.extended) return;
                await coreGate(lib.extended.db).drain(2000);
                await lib.extended.db.closeAsync();
                closed = true;
              },
              reopenExtended: async () => {
                const extended = await openExtendedDatabase();
                if (!extended) throw new Error('extended_library.db is not a valid expansion library after the swap');
                if (extended.info.version !== lib.core?.info.version) throw new Error(`הרחבה (${extended.info.version}) אינה מתאימה לספריית היסוד (${lib.core?.info.version})`);
                // The core connection stays open: only the extended source is (re)attached to the router.
                publish(await buildLibrary(lib.core, lib.user, null, ++generation.current, extended));
              },
              warn: (w) => console.warn(`expansion install: ${w.step} failed (ignored)`, w.message),
            });
          } catch (e) {
            let extended: Library['extended'] = lib.extended;
            if (closed) extended = await openExtendedDatabase().catch(() => null);
            else if (extended) coreGates.delete(extended.db);
            try {
              publish(await buildLibrary(lib.core, lib.user, null, ++generation.current, extended));
            } catch (again) {
              console.warn('library could not be republished after a failed expansion install', again);
            }
            throw e;
          }
        }),
      removeCore: () =>
        serial(async () => {
          const lib = current.current;
          if (!lib) return;
          if (lib.extended) {
            await coreGate(lib.extended.db).drain(2000);
            await closeQuietly(lib.extended.db);
          }
          deleteExtendedDatabase();
          if (lib.core) {
            await coreGate(lib.core.db).drain(2000);
            await closeQuietly(lib.core.db);
          }
          await deleteCoreDatabase();
          // Back to the instant cloud starter (a fresh, empty starter database).
          const starter = lib.starter ?? (await openStarterDatabase().catch(() => null));
          publish(await buildLibrary(null, lib.user, starter, ++generation.current));
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
