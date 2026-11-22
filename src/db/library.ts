/**
 * The two on-device library databases (FileSystem document directory + 'SQLite/'):
 *
 *   core_library.db  main library: downloaded from a GitHub Release (src/services/coreLibrary.ts)
 *                    or built on the device from an Otzaria folder (src/services/localIndexer.ts).
 *                    Read-only at runtime; replaced atomically by renaming a verified temp file.
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

import { ensureSchema, readMeta, SCHEMA_VERSION, type WriterDb } from '../../shared/indexer';
import type { QueryAdapter } from '../../shared/quickJump';
import { webSeed } from './webSeed';

export const CORE_DB = 'core_library.db';
export const USER_DB = 'user_library.db';
/** Staging name for a downloaded / locally built core DB before the atomic swap. */
export const CORE_TMP_DB = 'core_library.db.tmp';
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
function migrateLegacyDb(): void {
  const legacy = dbFile(LEGACY_DB);
  if (!legacy.exists) return;
  const core = dbFile(CORE_DB);
  if (core.exists) removeDbFiles(LEGACY_DB);
  else legacy.move(core);
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
 * Opens core_library.db if it exists and is a valid library (meta.db_version present,
 * compatible schema). Returns null on first launch; a broken file is deleted.
 */
export async function openCoreDatabase(): Promise<{ db: SQLiteDatabase; info: CoreInfo } | null> {
  if (isWeb) return openWebSeed();
  const dir = sqliteDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  migrateLegacyDb();
  // A staging file left over from an interrupted download/build is never trusted.
  removeDbFiles(CORE_TMP_DB);
  const file = dbFile(CORE_DB);
  if (!file.exists) return null;
  let db: SQLiteDatabase | null = null;
  try {
    db = await openReadOnly(CORE_DB);
    const info = coreInfoFromMeta(await readMeta(toAdapter(db)), file.size);
    if (!info || info.scriptVersion > SCHEMA_VERSION) throw new Error(info ? `library schema ${info.scriptVersion} is newer than this app (${SCHEMA_VERSION})` : 'not a library database');
    return { db, info };
  } catch (e) {
    console.warn('core_library.db is unusable, removing it:', e);
    await db?.closeAsync().catch(() => undefined);
    removeDbFiles(CORE_DB);
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
 * Atomically replaces core_library.db with the verified staging file CORE_TMP_DB.
 * The caller must have closed its core connection. A rename inside one directory is
 * atomic, so a crash leaves either the old or the new library, never a mix.
 */
export async function installStagedCore(): Promise<void> {
  const tmp = dbFile(CORE_TMP_DB);
  if (!tmp.exists) throw new Error('staged library file is missing');
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const f = dbFile(CORE_DB + suffix);
    if (f.exists) f.delete();
  }
  tmp.move(dbFile(CORE_DB), { overwrite: true });
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
