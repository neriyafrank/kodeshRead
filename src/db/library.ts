/**
 * The two on-device library databases (FileSystem document directory + 'SQLite/'):
 *
 *   core_library.db  main library: downloaded from a GitHub Release (src/services/coreLibrary.ts)
 *                    or built on the device from an Otzaria folder (src/services/localIndexer.ts).
 *                    Read-only at runtime; replaced atomically by renaming a verified staging
 *                    file of the same directory (installStagedCore).
 *   user_library.db  personal books imported on the device; created on first launch.
 *                    Ids >= USER_ID_BASE, so rows of both DBs never collide.
 *
 * Nothing is bundled in the APK any more. Queries go through the router from
 * shared/sources.js (per-book routing + cross-DB merging), see LibraryContext.
 *
 * Web preview only: there is no file system, so the sample library is imported from a
 * bundled asset (src/db/webSeed.web.ts) as the core DB, and imports are disabled.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { deleteDatabaseAsync, importDatabaseFromAssetAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { describeError, installFile } from '../../shared/coreFinalize';
import { ensureSchema, readMeta, SCHEMA_VERSION, type WriterDb } from '../../shared/indexer';
import type { QueryAdapter } from '../../shared/quickJump';
import { closeQuietly } from './dbUtils';
import { webSeed } from './webSeed';

export const CORE_DB = 'core_library.db';
export const USER_DB = 'user_library.db';
/** Staging name for a downloaded core DB before the atomic swap. */
export const CORE_TMP_DB = 'core_library.db.tmp';
/**
 * Working file of an on-device core build. Unlike CORE_TMP_DB it survives restarts: it holds
 * the build's checkpoint (ingestion_state), so an interrupted build resumes where it stopped.
 * Renamed to CORE_TMP_DB once complete, then installed like a download.
 */
export const CORE_BUILD_DB = 'core_library.build.db';
/** Pre-Milestone-5 builds copied the bundled library here. */
const LEGACY_DB = 'library.db';
const WEB_SEED_VERSION_KEY = 'kodeshread.webSeedVersion';

export const isWeb = Platform.OS === 'web';

/** `FileSystem.documentDirectory + 'SQLite/'` (expo-sqlite's default database directory). */
export function sqliteDir(): Directory {
  return new Directory(Paths.document, 'SQLite');
}

export function dbFile(name: string): File {
  return new File(sqliteDir(), name);
}

/** Deletes a database file and its journal / WAL side files. */
export function removeDbFiles(name: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const f = dbFile(name + suffix);
    if (f.exists) f.delete();
  }
}

export interface CoreInfo {
  version: string;
  builtAt: string | null;
  source: string | null;
  books: number;
  paragraphs: number;
  links: number;
  /** Size of core_library.db in bytes (null on web). */
  size: number | null;
  scriptVersion: number;
}

/** Meta row values as a CoreInfo, or null when this is not a valid core library. */
export function coreInfoFromMeta(meta: Record<string, string> | null, size: number | null): CoreInfo | null {
  if (!meta || !meta.db_version) return null;
  return {
    version: meta.db_version,
    builtAt: meta.built_at ?? null,
    source: meta.source ?? null,
    books: Number(meta.books ?? 0),
    paragraphs: Number(meta.paragraphs ?? 0),
    links: Number(meta.links ?? 0),
    size,
    scriptVersion: Number(meta.script_version ?? 0),
  };
}

/** Read adapter used by the shared (platform-independent) query modules. */
export function toAdapter(db: SQLiteDatabase): QueryAdapter {
  return {
    all: <T,>(sql: string, params: (string | number | null)[]) => db.getAllAsync<T>(sql, params),
  };
}

/** Writer adapter for shared/indexer.js. */
export function toWriter(db: SQLiteDatabase): WriterDb {
  return {
    exec: (sql) => db.execAsync(sql),
    run: (sql, params) => db.runAsync(sql, params),
    all: <T,>(sql: string, params: (string | number | null)[]) => db.getAllAsync<T>(sql, params),
  };
}

// --- core --------------------------------------------------------------------

/** Adopts the library copied by pre-Milestone-5 builds instead of deleting it. */
async function migrateLegacyDb(): Promise<void> {
  const legacy = dbFile(LEGACY_DB);
  if (!legacy.exists) return;
  const core = dbFile(CORE_DB);
  if (core.exists) removeDbFiles(LEGACY_DB);
  // File.move() is asynchronous: it must be awaited before anything touches either name.
  else await legacy.move(core);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const f = dbFile(LEGACY_DB + suffix);
    if (f.exists) f.delete();
  }
}

async function openReadOnly(name: string): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(name);
  await db.execAsync('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY;');
  return db;
}

/**
 * Older app versions moved a finished on-device build to CORE_TMP_DB with an un-awaited
 * File.move() and could fail before installing it; the staging file was then deleted on the next
 * launch, throwing away hours of indexing. A staged file that is a complete LOCAL build
 * (meta.source "local:…") is now moved back to CORE_BUILD_DB, where the resume card offers to
 * install it. Anything else (an interrupted download) is deleted as before.
 */
async function salvageOrRemoveStaging(): Promise<void> {
  const tmp = dbFile(CORE_TMP_DB);
  if (tmp.exists && !dbFile(CORE_BUILD_DB).exists) {
    let local = false;
    let db: SQLiteDatabase | null = null;
    try {
      db = await openDatabaseAsync(CORE_TMP_DB, { useNewConnection: true });
      const rows = await db.getAllAsync<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('source', 'db_version')", []);
      const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      local = !!meta.db_version && String(meta.source ?? '').startsWith('local:');
    } catch {
      local = false;
    } finally {
      await closeQuietly(db);
    }
    if (local) {
      try {
        // The WAL (if any) travels with its database file, before anything opens the new name.
        for (const suffix of ['-wal', '-shm', '']) {
          const f = dbFile(CORE_TMP_DB + suffix);
          if (f.exists) await f.move(dbFile(CORE_BUILD_DB + suffix), { overwrite: true });
        }
        return;
      } catch (e) {
        console.warn('finished build could not be recovered from the staging file', e);
        return; // kept: never delete a complete library because a rename failed
      }
    }
  }
  removeDbFiles(CORE_TMP_DB);
}

/** The file is damaged or not SQLite at all (as opposed to busy / locked / out of memory). */
const isCorruption = (e: unknown) => /not a database|malformed|SQLITE_NOTADB|SQLITE_CORRUPT|file is encrypted/i.test(describeError(e));

/**
 * Opens core_library.db if it exists and is a valid library (meta.db_version present,
 * compatible schema). Returns null on first launch.
 *
 * Only a file that is provably not a library (no meta.db_version, or SQLite reports it corrupt)
 * is deleted. A transient failure (busy, locked, out of memory right after a swap) never deletes a
 * 1GB library: it returns null (`strict`: throws), and the next open tries again.
 */
export async function openCoreDatabase(opts: { strict?: boolean } = {}): Promise<{ db: SQLiteDatabase; info: CoreInfo } | null> {
  if (isWeb) return openWebSeed();
  const dir = sqliteDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  await migrateLegacyDb();
  // A staging file left over from an interrupted download is never trusted. (An on-device build
  // waits in CORE_BUILD_DB with its checkpoint, see localIndexer.ts.)
  await salvageOrRemoveStaging();
  const file = dbFile(CORE_DB);
  if (!file.exists) return null;
  let db: SQLiteDatabase | null = null;
  try {
    db = await openReadOnly(CORE_DB);
    // Unlike readMeta(), a failing query throws here: "locked" must not read as "not a library".
    const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM meta', []);
    const meta: Record<string, string> = {};
    for (const r of rows) meta[r.key] = r.value;
    const info = coreInfoFromMeta(meta, file.size);
    if (!info) {
      await closeQuietly(db);
      db = null;
      console.warn('core_library.db is not a library database, removing it');
      removeDbFiles(CORE_DB);
      return null;
    }
    if (info.scriptVersion > SCHEMA_VERSION) throw new Error(`library schema ${info.scriptVersion} is newer than this app (${SCHEMA_VERSION})`);
    return { db, info };
  } catch (e) {
    await closeQuietly(db);
    if (/no such table: meta/i.test(describeError(e)) || isCorruption(e)) {
      console.warn('core_library.db is unusable, removing it:', e);
      removeDbFiles(CORE_DB);
      return null;
    }
    if (opts.strict) throw e;
    console.warn('core_library.db could not be opened now (kept for the next attempt):', e);
    return null;
  }
}

async function openWebSeed(): Promise<{ db: SQLiteDatabase; info: CoreInfo } | null> {
  if (!webSeed) return null;
  const stored = await AsyncStorage.getItem(WEB_SEED_VERSION_KEY).catch(() => null);
  if (stored !== webSeed.version) {
    await importDatabaseFromAssetAsync(CORE_DB, { assetId: webSeed.asset, forceOverwrite: true });
    await AsyncStorage.setItem(WEB_SEED_VERSION_KEY, webSeed.version).catch(() => undefined);
  }
  const db = await openReadOnly(CORE_DB);
  const info = coreInfoFromMeta(await readMeta(toAdapter(db)), null);
  if (!info) {
    await db.closeAsync();
    return null;
  }
  return { db, info };
}

/**
 * Atomically replaces core_library.db with a verified staging file in the same SQLite directory:
 * CORE_TMP_DB (a download) or CORE_BUILD_DB (an on-device build, already sealed by
 * localIndexer.ts). Every sub-step is named (shared/coreFinalize.js):
 *   finalize:check_staged     the staged file exists
 *   finalize:close_db         `closeCore()` closes every connection to core_library.db (and drains
 *                             its readers), then a short pause lets the native handles go
 *   finalize:remove_sidecars  the OLD library's -wal / -shm / -journal are deleted
 *   finalize:swap_file        an awaited same-directory rename (never a copy of a 1GB+ file)
 *   finalize:reopen_db        `reopenCore()` opens and validates the new library
 * A rename inside one directory is atomic, so a crash leaves either the old or the new library.
 * If anything fails before the rename, the staged file is untouched (a build stays resumable).
 */
export async function installStagedCore<T>(o: { from?: string; closeCore: () => Promise<void>; reopenCore: () => Promise<T>; warn?: (w: { step: string; message: string }) => void }): Promise<T> {
  return installFile(
    {
      exists: (name) => dbFile(name).exists,
      remove: (name) => dbFile(name).delete(),
      move: (from, to) => dbFile(from).move(dbFile(to), { overwrite: true }),
      closeCore: o.closeCore,
      reopenCore: o.reopenCore,
    },
    { from: o.from ?? CORE_TMP_DB, to: CORE_DB, warn: o.warn },
  );
}

/** Removes the core library (the personal library is untouched). */
export async function deleteCoreDatabase(): Promise<void> {
  if (isWeb) {
    await deleteDatabaseAsync(CORE_DB).catch(() => undefined);
    await AsyncStorage.removeItem(WEB_SEED_VERSION_KEY).catch(() => undefined);
    return;
  }
  removeDbFiles(CORE_DB);
}

// --- user ----------------------------------------------------------------------

/** Opens (creating on first launch) the personal library database. */
export async function openUserDatabase(): Promise<SQLiteDatabase> {
  if (!isWeb) {
    const dir = sqliteDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  }
  const db = await openDatabaseAsync(USER_DB);
  // WAL: the reader keeps querying while an import writes.
  if (!isWeb) await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = OFF;');
  await ensureSchema(toWriter(db), { kind: 'user' });
  return db;
}
