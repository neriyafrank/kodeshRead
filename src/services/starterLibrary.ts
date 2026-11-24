/**
 * Instant cloud starter: browse and open well-known base books straight from GitHub Releases.
 *
 *   starter-catalog.json   (release `starter-latest`, published by the "Build cloud library" workflow)
 *     -> the list on the Library screen; the last good copy is cached in AsyncStorage (offline / retry)
 *   starter-<slug>.json.gz tap a book -> download -> size + SHA-256 -> gunzip -> ONE SQLite
 *     transaction into starter_library.db (base book + Rashi / Onkelos / Tosafot + ref_links + FTS)
 *     -> the library is refreshed and the Reader opens (~1 s).
 *
 * The format, validation and the import are shared/starterPacks.js (self-tested in Node on the very
 * same code); this file is only the app wiring.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  decodePack,
  importStarterPack,
  loadedFilePaths,
  packUrl,
  validateStarterCatalog,
  verifyPackBytes,
  type StarterCatalog,
  type StarterCatalogEntry,
  type StarterImportResult,
} from '../../shared/starterPacks';
import { toAdapter, toWriter } from '../db/library';
import { useLibrary, useLibraryController } from '../db/LibraryContext';
import { useStarter } from '../state/starterStore';

const DEFAULT_REPO = 'neriyafrank/kodeshRead';
const CACHE_KEY = 'kodeshread.starterCatalog.v1';
const CATALOG_TIMEOUT_MS = 20000;
const PACK_TIMEOUT_MS = 90000;

export function starterCatalogUrl(): string {
  const extra = Constants.expoConfig?.extra as { starterCatalogUrl?: string } | undefined;
  return extra?.starterCatalogUrl || `https://github.com/${DEFAULT_REPO}/releases/download/starter-latest/starter-catalog.json`;
}

async function timedFetch(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { cache: 'no-store', signal: ctl.signal });
  } catch {
    throw new Error(ctl.signal.aborted ? 'הבקשה לענן ארכה יותר מדי' : 'אין חיבור לענן');
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(): Promise<StarterCatalog | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? validateStarterCatalog(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Fetches the catalog (cache first for instant paint, network to refresh); the store gets the result. */
export async function loadStarterCatalog(): Promise<void> {
  const store = useStarter.getState();
  if (store.status === 'loading') return;
  const cached = store.catalog ?? (await readCache());
  store.set({ status: 'loading', error: null, ...(cached ? { catalog: cached, stale: true } : {}) });
  try {
    const res = await timedFetch(starterCatalogUrl(), CATALOG_TIMEOUT_MS);
    if (!res.ok) throw new Error(res.status === 404 ? 'עדיין לא פורסמו ספרי התחלה בענן (404)' : `שגיאת רשת ${res.status}`);
    const catalog = validateStarterCatalog(await res.json());
    useStarter.getState().set({ status: 'ready', catalog, stale: false, error: null });
    AsyncStorage.setItem(CACHE_KEY, JSON.stringify(catalog)).catch(() => undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A cached catalog keeps the list usable offline; the banner offers a retry.
    useStarter.getState().set({ status: cached ? 'ready' : 'error', stale: !!cached, error: message });
  }
}

/** Downloads, verifies, decodes and imports one starter pack. `starter` is the starter DB connection. */
export async function fetchAndImportStarter(entry: StarterCatalogEntry, starter: SQLiteDatabase, catalogUrl = starterCatalogUrl()): Promise<StarterImportResult> {
  const store = useStarter.getState();
  store.setFailed(entry.slug, null);
  try {
    store.setBusy(entry.slug, 'download');
    const res = await timedFetch(packUrl(catalogUrl, entry), PACK_TIMEOUT_MS);
    if (!res.ok) throw new Error(`שגיאת רשת ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    store.setBusy(entry.slug, 'verify');
    await verifyPackBytes(bytes, entry);
    const pack = decodePack(bytes);
    store.setBusy(entry.slug, 'import');
    // Let the "loading" state paint before the synchronous part of the import work.
    await new Promise((r) => setTimeout(r, 0));
    return await importStarterPack(toWriter(starter), pack);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useStarter.getState().setFailed(entry.slug, message);
    throw e;
  } finally {
    useStarter.getState().setBusy(entry.slug, null);
  }
}

/** Catalog + which books are already in the starter database (available offline). */
export function useStarterCatalog(enabled: boolean) {
  const { status, catalog, stale, error } = useStarter();
  useEffect(() => {
    if (enabled && useStarter.getState().status === 'idle') void loadStarterCatalog();
  }, [enabled]);
  const retry = useCallback(() => void loadStarterCatalog(), []);
  return { status, catalog, stale, error, retry };
}

const EMPTY = new Set<string>();

/** file_path of the books of the starter database; refreshed on every library generation. */
export function useLoadedStarterPaths(): Set<string> {
  const { starter, generation } = useLibrary();
  const [state, setState] = useState<{ starter: SQLiteDatabase; generation: number; paths: Set<string> } | null>(null);
  useEffect(() => {
    if (!starter) return;
    let alive = true;
    loadedFilePaths(toAdapter(starter)).then(
      (paths) => alive && setState({ starter, generation, paths }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [starter, generation]);
  return starter && state && state.starter === starter ? state.paths : EMPTY;
}

/**
 * `open(entry)` -> { bookId, title } of the book in the starter library: reuses a book that is
 * already there (no download, no duplicate rows), otherwise loads it from the cloud first.
 * Concurrent taps on one book share one load.
 */
export function useOpenStarterBook() {
  const { starter } = useLibrary();
  const controller = useLibraryController();
  const inflight = useRef(new Map<string, Promise<{ bookId: number; title: string }>>());
  return useCallback(
    (entry: StarterCatalogEntry) => {
      const running = inflight.current.get(entry.slug);
      if (running) return running;
      const job = (async () => {
        if (!starter) throw new Error('הספרייה המלאה כבר הותקנה: פתחו את הספר מהספרייה');
        const rows = await starter.getAllAsync<{ id: number; title: string }>('SELECT id, title FROM books WHERE file_path = ? AND is_complete = 1', [entry.filePath]);
        if (rows.length) return { bookId: rows[0].id, title: rows[0].title };
        const res = await fetchAndImportStarter(entry, starter);
        await controller.refresh();
        return { bookId: res.bookId, title: res.title };
      })();
      inflight.current.set(entry.slug, job);
      const done = () => inflight.current.delete(entry.slug);
      job.then(done, done);
      return job;
    },
    [starter, controller],
  );
}

// Web preview in development only: lets the Playwright suite (scripts/e2e-library.js) re-fetch the
// catalog (offline -> cached copy) without a file system or a second app launch.
if (typeof __DEV__ !== 'undefined' && __DEV__ && typeof document !== 'undefined') {
  (globalThis as { __kodeshreadStarter?: { load: typeof loadStarterCatalog } }).__kodeshreadStarter = { load: loadStarterCatalog };
}
