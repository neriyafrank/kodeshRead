/**
 * Download / update of the pre-built core library from a GitHub Release.
 *
 *   1. manifest.json (version, counts, size, SHA-256) from the configured URL
 *      (default: app.json extra.libraryManifestUrl = .../releases/latest/download/manifest.json).
 *      A URL ending in .gz / .zip / .db is downloaded directly, without a manifest.
 *   2. the compressed DB is downloaded with live progress into the document directory
 *   3. integrity: byte size + native SHA-256 against the manifest
 *   4. streaming decompression (.gz / .zip, 1 MB chunks) into SQLite/core_library.db.tmp
 *   5. the staged DB is opened and checked (meta.db_version = manifest version, schema)
 *   6. LibraryController.installCore() renames it over core_library.db (atomic) and reopens;
 *      user_library.db is never touched.
 */
import Constants from 'expo-constants';
import { File, FileMode, Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';

import { readMeta, SCHEMA_VERSION } from '../../shared/indexer';
import { compressionOf, decompressStream, isDirectAssetUrl, resolveAssetUrl, validateManifest, type Compression, type ReleaseManifest } from '../../shared/release';
import { closeQuietly } from '../db/dbUtils';
import { coreInfoFromMeta, CORE_TMP_DB, dbFile, isWeb, removeDbFiles, toAdapter } from '../db/library';
import { CancelledError, formatMB, useLibraryJobs } from '../state/libraryJobs';

const FALLBACK_MANIFEST_URL = 'https://github.com/neriyafrank/kodeshRead/releases/latest/download/manifest.json';
const DOWNLOAD_NAME = 'core_library.download';

export function defaultManifestUrl(): string {
  const extra = Constants.expoConfig?.extra as { libraryManifestUrl?: string } | undefined;
  return extra?.libraryManifestUrl || FALLBACK_MANIFEST_URL;
}

export interface ReleaseInfo {
  /** null when the URL points straight at a library file. */
  manifest: ReleaseManifest | null;
  assetUrl: string;
  compression: Compression;
  /** Compressed size if known. */
  size: number | null;
}

/** Reads the release manifest (or describes a direct asset URL). */
export async function fetchReleaseInfo(url: string): Promise<ReleaseInfo> {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('כתובת לא תקינה (נדרש http/https)');
  if (isDirectAssetUrl(u)) return { manifest: null, assetUrl: u, compression: compressionOf(u), size: null };
  const res = await fetch(u, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'לא נמצא קובץ manifest.json בכתובת (404). האם פורסמה גרסה?' : `שגיאת רשת ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('קובץ ה-manifest אינו JSON תקין');
  }
  const manifest = validateManifest(json, SCHEMA_VERSION);
  return { manifest, assetUrl: resolveAssetUrl(u, manifest), compression: manifest.compression, size: manifest.size };
}

function progress(stage: string, fraction: number | null, detail: string | null = null) {
  useLibraryJobs.getState().update({ stage, fraction, detail });
}

const cancelled = () => useLibraryJobs.getState().cancelRequested;

/**
 * Downloads, verifies and decompresses a release into SQLite/core_library.db.tmp.
 * Returns the staged library's version. The caller installs it with installCore().
 */
export async function downloadAndStageCore(release: ReleaseInfo): Promise<string> {
  if (isWeb) throw new Error('הורדת ספרייה אינה נתמכת בתצוגה המקדימה בדפדפן');
  const m = release.manifest;
  const needed = (release.size ?? 0) + (m?.dbSize ?? (release.size ?? 0) * 4);
  const free = Paths.availableDiskSpace;
  if (needed && free && free < needed * 1.05) {
    throw new Error(`אין מספיק מקום פנוי: נדרשים כ-${formatMB(needed)} MB, פנויים ${formatMB(free)} MB`);
  }

  const download = new File(Paths.document, DOWNLOAD_NAME);
  if (download.exists) download.delete();
  removeDbFiles(CORE_TMP_DB);
  try {
    // --- 1. download ---------------------------------------------------------
    progress('מוריד…', 0);
    const task = File.createDownloadTask(release.assetUrl, download, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (cancelled()) task.cancel();
        const total = totalBytes > 0 ? totalBytes : release.size;
        progress('מוריד…', total ? bytesWritten / total : null, `${formatMB(bytesWritten)} / ${formatMB(total)} MB`);
      },
    });
    let got: File | null;
    try {
      got = await task.downloadAsync();
    } catch (e) {
      if (cancelled()) throw new CancelledError();
      throw new Error(`ההורדה נכשלה: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (cancelled()) throw new CancelledError();
    if (!got || !download.exists) throw new Error('ההורדה נכשלה');

    // --- 2. integrity --------------------------------------------------------
    progress('מאמת שלמות…', null, `${formatMB(download.size)} MB`);
    if (m?.size != null && download.size !== m.size) throw new Error(`גודל הקובץ שהורד (${download.size}) שונה מהצפוי (${m.size})`);
    if (m?.sha256) {
      const digest = (await download.digest('SHA-256')).toLowerCase();
      if (digest !== m.sha256) throw new Error('בדיקת SHA-256 נכשלה: הקובץ פגום או שונה מהגרסה שפורסמה');
    }
    if (cancelled()) throw new CancelledError();

    // --- 3. decompress (streaming) --------------------------------------------
    const out = dbFile(CORE_TMP_DB);
    out.create({ overwrite: true });
    const input = download.open(FileMode.ReadOnly);
    const output = out.open(FileMode.WriteOnly);
    const totalIn = download.size;
    try {
      await decompressStream({
        format: release.compression === 'none' ? undefined : release.compression,
        totalIn,
        read: async (n) => {
          const left = totalIn - (input.offset ?? 0);
          return left > 0 ? input.readBytes(Math.min(n, left)) : new Uint8Array(0);
        },
        write: (bytes) => output.writeBytes(bytes),
        isCancelled: cancelled,
        onProgress: ({ bytesIn, bytesOut }) =>
          progress('מחלץ…', totalIn ? bytesIn / totalIn : null, `${formatMB(bytesOut)}${m?.dbSize ? ' / ' + formatMB(m.dbSize) : ''} MB`),
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') throw new CancelledError();
      throw e;
    } finally {
      input.close();
      output.close();
    }
    download.delete();
    if (m?.dbSize != null && out.size !== m.dbSize) throw new Error(`גודל מסד הנתונים שחולץ (${out.size}) שונה מהצפוי (${m.dbSize})`);

    // --- 4. validate the staged database ------------------------------------
    progress('בודק את מסד הנתונים…', null);
    return await validateStagedCore(m?.version ?? null);
  } catch (e) {
    if (download.exists) download.delete();
    removeDbFiles(CORE_TMP_DB);
    throw e;
  }
}

/** Opens the staged DB read-only and checks it is a compatible library (returns its version). */
export async function validateStagedCore(expectedVersion: string | null): Promise<string> {
  const db = await openDatabaseAsync(CORE_TMP_DB);
  try {
    await db.execAsync('PRAGMA query_only = ON;');
    const info = coreInfoFromMeta(await readMeta(toAdapter(db)), null);
    if (!info) throw new Error('הקובץ אינו ספריית kodeshRead (חסרה טבלת meta)');
    if (info.scriptVersion > SCHEMA_VERSION) throw new Error('הספרייה דורשת גרסה חדשה יותר של האפליקציה');
    if (expectedVersion && info.version !== expectedVersion) throw new Error(`גרסת הספרייה (${info.version}) אינה תואמת ל-manifest (${expectedVersion})`);
    const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('books', 'paragraphs', 'toc_nodes', 'paragraphs_fts', 'links')");
    if (!row || row.n < 5) throw new Error('מבנה מסד הנתונים חסר');
    return info.version;
  } finally {
    await closeQuietly(db);
  }
}

/** Leftovers of an interrupted download (called when the manager opens). */
export function cleanupDownloads(): void {
  if (isWeb) return;
  const f = new File(Paths.document, DOWNLOAD_NAME);
  if (f.exists && !useLibraryJobs.getState().job) f.delete();
}
