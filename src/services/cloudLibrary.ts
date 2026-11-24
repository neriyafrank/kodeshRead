/**
 * Multi-part cloud library: the pre-indexed core_library.db built by the "Build cloud library"
 * GitHub Action and published as `library-latest`: library-manifest.json + core_library.db.zip.part-NN (shared/libraryRelease.js).
 *
 *   1. library-manifest.json (book count, sizes, SHA-256 of every part and of the whole zip)
 *   2. free-space check: zip + extracted DB + 500 MB
 *   3. parts are downloaded one after the other into Documents/core_library_parts/ (as `<part>.partial`,
 *      continued with an HTTP Range request after any interruption; transient network errors retry with
 *      exponential backoff, and the run resumes when the app returns to the foreground). A part that is
 *      already there with the right size + SHA-256 is skipped, so an interrupted download resumes.
 *      The whole job runs under the Android foreground service (libraryActions.runJob) so Android keeps
 *      the network alive in the background / with the screen off
 *   4. parts are appended into one zip in 1 MB chunks (each part deleted once appended), the zip is
 *      verified against fullZipSha256, then streamed (fflate) into SQLite/core_library.db.tmp
 *   5. the staged DB is checked (PRAGMA quick_check + meta) and installed by LibraryController.installCore()
 *      (awaited same-directory File.move), exactly like the single-file download in coreLibrary.ts
 *
 * The orchestration is shared/multipart.js (pure, self-tested in Node); this file only supplies the
 * expo-file-system storage backend and the app wiring.
 */
import Constants from 'expo-constants';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';
import { AppState } from 'react-native';

import { readMeta, SCHEMA_VERSION } from '../../shared/indexer';
import { checkFreeSpace, cloudManifestUrl, createMemoryIO, downloadRangeChunks, existingBytes, formatBytes, partName, requiredFreeBytes, stageCloudLibrary, validateCloudManifest, type CloudManifest, type PartsIO } from '../../shared/multipart';
import { closeQuietly } from '../db/dbUtils';
import { coreInfoFromMeta, CORE_TMP_DB, dbFile, isWeb, removeDbFiles, toAdapter } from '../db/library';
import { CancelledError, useLibraryJobs } from '../state/libraryJobs';
import * as importService from './importForegroundService';
import { withKeepAwake } from './keepAwake';

const DEFAULT_REPO = 'neriyafrank/kodeshRead';
const PARTS_DIR = 'core_library_parts';
/** Wake lock held through assembly + extraction (+ the DB swap in libraryActions). */
export const CLOUD_KEEP_AWAKE_TAG = 'kodeshread-cloud-extract';

/** Manifest URL of the complete library release (`library-latest`). */
export function defaultCloudManifestUrl(): string {
  const extra = Constants.expoConfig?.extra as { cloudManifestUrl?: string } | undefined;
  return extra?.cloudManifestUrl || cloudManifestUrl(DEFAULT_REPO);
}

/** Fetches + validates library-manifest.json. */
export async function fetchCloudManifest(url: string = defaultCloudManifestUrl()): Promise<CloudManifest> {
  if (!/^https?:\/\//i.test(url)) throw new Error('כתובת לא תקינה (נדרש http/https)');
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'עדיין לא פורסמה ספרייה בענן (404). הריצו את ה-Workflow ״Build cloud library״ ב-GitHub.' : `שגיאת רשת ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('קובץ library-manifest.json אינו JSON תקין');
  }
  return validateCloudManifest(json);
}

/** Free internal storage in bytes (null when unknown, e.g. the browser preview). */
export function freeDiskBytes(): number | null {
  const override = (globalThis as { __KODESHREAD_FREE_BYTES__?: number }).__KODESHREAD_FREE_BYTES__;
  if (typeof override === 'number') return override;
  if (isWeb) return null;
  try {
    const free = Paths.availableDiskSpace;
    return free > 0 ? free : null;
  } catch {
    return null;
  }
}

export interface StorageVerdict {
  ok: boolean;
  required: number;
  free: number | null;
  message: string | null;
}

/** "free < zip + db + 500 MB" -> a Hebrew warning; ok otherwise. */
export function storageVerdict(m: CloudManifest, free: number | null = freeDiskBytes()): StorageVerdict {
  const v = checkFreeSpace(m, free);
  return {
    ...v,
    message: v.ok ? null : `אין מספיק מקום פנוי: נדרשים ${formatBytes(v.required)} (הורדה ${formatBytes(m.totalZipBytes)} + חילוץ ${formatBytes(m.uncompressedDbBytes)} + 500 MB רזרבה), פנויים ${formatBytes(v.free ?? 0)}.`,
  };
}

function partsDir(): Directory {
  const dir = new Directory(Paths.document, PARTS_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Appends `chunk` to `target` (1 MB at a time), or moves it there when the target is empty / missing; deletes it. */
async function absorbChunk(chunk: File, target: File): Promise<void> {
  if (!chunk.exists) return;
  const size = chunk.size;
  if (size > 0 && !target.exists) await chunk.move(target, { overwrite: true });
  else if (size > 0) {
    const start = target.size;
    const input = chunk.open(FileMode.ReadOnly);
    const output = target.open(FileMode.WriteOnly);
    try {
      output.offset = start;
      for (let left = size; left > 0; ) {
        const bytes = await input.readBytes(Math.min(1 << 20, left));
        if (!bytes.length) break;
        await output.writeBytes(bytes);
        left -= bytes.length;
      }
    } finally {
      input.close();
      output.close();
    }
  }
  if (chunk.exists) chunk.delete();
}

/** The OS may have revoked the network: only when no foreground service keeps the app alive. */
const isBackgrounded = () => AppState.currentState !== 'active' && !importService.isActive();

/** Resolves once the app is in the foreground again (or the job was cancelled). */
function whenForeground(isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (AppState.currentState === 'active') return resolve();
    const done = () => {
      sub.remove();
      clearInterval(poll);
      resolve();
    };
    const sub = AppState.addEventListener('change', (s) => s === 'active' && done());
    const poll = setInterval(() => isCancelled() && done(), 1000);
  });
}

/** expo-file-system backend of shared/multipart.js. Parts live in Documents/core_library_parts. */
export function nativePartsIO(isCancelled: () => boolean): PartsIO {
  const dir = partsDir();
  const file = (name: string) => (name === CORE_TMP_DB ? dbFile(name) : new File(dir, name));
  return {
    size: (name) => {
      const f = file(name);
      return f.exists ? f.size : null;
    },
    remove: (name) => {
      const f = file(name);
      if (f.exists) f.delete();
    },
    sha256: async (name) => (await file(name).digest('SHA-256')).toLowerCase(),
    rename: async (from, to) => {
      const dst = file(to);
      if (dst.exists) dst.delete();
      await file(from).move(dst, { overwrite: true }); // File.move() is async: always awaited
    },
    download: async (url, name, onProgress, _isCancelled, resume) => {
      // Chunked Range download: each <= 4 MB chunk goes to its own temp file and is appended to the .partial only
      // when complete, so a hard network drop on Android loses at most one chunk. downloadAsync never targets
      // the .partial itself.
      const target = file(name);
      const chunk = new File(dir, `${name}.chunk`);
      const expected = resume?.expectedBytes ?? 0;
      if (!expected) throw new Error('גודל החלק לא ידוע');
      await absorbChunk(chunk, target); // legacy chunk from an older build / process death: a valid prefix
      await downloadRangeChunks(
        {
          partialSize: () => (target.exists ? target.size : 0),
          // Resolve the final CDN URL ourselves (fetch follows the 302 keeping Range): the native downloader
          // then talks to the CDN directly and cannot lose the header on the redirect.
          resolve: async (start: number, end: number) => {
            const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
            try {
              void res.body?.cancel?.();
            } catch {
              // body already consumed / unsupported
            }
            return { url: res.url || url, status: res.status };
          },
          fetchChunk: async (finalUrl: string, range: string | null, onBytes: (n: number) => void) => {
            const task = File.createDownloadTask(finalUrl, chunk, {
              headers: range ? { Range: range } : undefined,
              onProgress: ({ bytesWritten }) => {
                if (isCancelled()) task.cancel();
                onBytes(bytesWritten);
              },
            });
            const got = await task.downloadAsync();
            if (!got) throw new Error('ההורדה נכשלה');
          },
          chunkSize: () => (chunk.exists ? chunk.size : null),
          discardChunk: () => {
            if (chunk.exists) chunk.delete();
          },
          appendChunk: () => absorbChunk(chunk, target),
          adoptChunk: async () => {
            if (target.exists) target.delete();
            await chunk.move(target, { overwrite: true });
          },
          resetPartial: () => {
            if (target.exists) target.delete();
          },
        },
        { expectedBytes: expected, isCancelled, onProgress },
      );
    },
    openRead: (name) => {
      const f = file(name);
      const total = f.size;
      const h = f.open(FileMode.ReadOnly);
      return {
        read: async (n) => {
          const left = total - (h.offset ?? 0);
          return left > 0 ? h.readBytes(Math.min(n, left)) : new Uint8Array(0);
        },
        close: () => h.close(),
      };
    },
    openWrite: (name, append) => {
      const f = file(name);
      if (!f.exists) f.create({ overwrite: true });
      else if (!append) {
        f.delete();
        f.create();
      }
      const h = f.open(FileMode.WriteOnly);
      if (append) h.offset = f.size;
      return { write: (bytes) => h.writeBytes(bytes), close: () => h.close() };
    },
  };
}

/** Parts already on disk with the exact size of the manifest (the card's "ההורדה תמשיך" hint). */
export function countPartsOnDisk(m: CloudManifest): number {
  if (isWeb) return 0;
  try {
    const dir = new Directory(Paths.document, PARTS_DIR);
    if (!dir.exists) return 0;
    return m.parts.filter((p) => {
      const f = new File(dir, partName(Number(/part-(\d+)$/.exec(p.name)?.[1])));
      return f.exists && f.size === p.sizeBytes;
    }).length;
  } catch {
    return 0;
  }
}

/** Removes downloaded parts / a half-assembled zip (after a successful install). */
export function clearCloudParts(): void {
  if (isWeb) return;
  try {
    const dir = new Directory(Paths.document, PARTS_DIR);
    if (dir.exists) dir.delete();
  } catch (e) {
    console.warn('could not remove cloud library parts', e);
  }
}

function report(p: { stage: string; fraction: number | null; detail: string | null }) {
  useLibraryJobs.getState().update(p);
}

/**
 * Downloads, assembles, extracts and validates the cloud library into SQLite/core_library.db.tmp.
 * Returns its version; the caller installs it with installCore().
 */
export async function downloadAndStageCloud(manifest: CloudManifest, manifestUrl: string): Promise<string> {
  if (isWeb) throw new Error('הורדת ספרייה אינה נתמכת בתצוגה המקדימה בדפדפן');
  const free = freeDiskBytes();
  if (free != null && free < requiredFreeBytes(manifest) * 0.5) {
    // The card already warned; this only stops a run that cannot possibly fit.
    throw new Error(storageVerdict(manifest, free).message ?? 'אין מספיק מקום פנוי');
  }
  const cancelled = () => useLibraryJobs.getState().cancelRequested;
  const io = nativePartsIO(cancelled);
  removeDbFiles(CORE_TMP_DB);
  try {
    // A retry shows the saved percentage at once (bytes already on disk), never a flash of 0%.
    const saved = manifest.totalZipBytes ? Math.min(1, (await existingBytes(io, manifest)) / manifest.totalZipBytes) : 0;
    report({ stage: 'מוריד…', fraction: saved, detail: null });
    try {
      await stageCloudLibrary(io, manifest, {
        manifestUrl,
        dbName: CORE_TMP_DB,
        isCancelled: cancelled,
        report,
        isBackgrounded,
        whenForeground: () => whenForeground(cancelled),
        keepAwake: (fn) => withKeepAwake(CLOUD_KEEP_AWAKE_TAG, fn),
      });
    } catch (e) {
      if (cancelled()) throw new CancelledError();
      throw e;
    }
    report({ stage: 'בודק את מסד הנתונים…', fraction: null, detail: null });
    return await validateStagedCloud(manifest.version);
  } catch (e) {
    removeDbFiles(CORE_TMP_DB); // the parts stay: the next attempt resumes
    throw e;
  }
}

/** quick_check + meta + schema of the staged DB (returns its version). */
export async function validateStagedCloud(expectedVersion: string): Promise<string> {
  const db = await openDatabaseAsync(CORE_TMP_DB);
  try {
    await db.execAsync('PRAGMA query_only = ON;');
    const check = await db.getAllAsync<Record<string, string>>('PRAGMA quick_check');
    const verdict = check.map((r) => Object.values(r)[0]);
    if (verdict.length !== 1 || verdict[0] !== 'ok') throw new Error(`בדיקת שלמות SQLite נכשלה: ${verdict.slice(0, 3).join('; ')}`);
    const info = coreInfoFromMeta(await readMeta(toAdapter(db)), null);
    if (!info) throw new Error('הקובץ אינו ספריית kodeshRead (חסרה טבלת meta)');
    if (info.scriptVersion > SCHEMA_VERSION) throw new Error('הספרייה דורשת גרסה חדשה יותר של האפליקציה');
    if (info.version !== expectedVersion) throw new Error(`גרסת הספרייה (${info.version}) אינה תואמת ל-manifest (${expectedVersion})`);
    const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('books', 'paragraphs', 'toc_nodes', 'paragraphs_fts', 'links', 'ref_links')");
    if (!row || row.n < 6) throw new Error('מבנה מסד הנתונים חסר');
    return info.version;
  } finally {
    await closeQuietly(db);
  }
}

/** True when the browser preview runs the download flow against in-memory storage (e2e only). */
export const isPreviewCloudDownload = () => isWeb && !!(globalThis as { __KODESHREAD_E2E_CLOUD__?: boolean }).__KODESHREAD_E2E_CLOUD__;

/**
 * Browser e2e: the same pipeline (download parts, assemble, extract) over in-memory storage.
 * Resolves with the manifest version once the extracted bytes are a SQLite database; nothing is
 * installed (the preview has no file system).
 */
export async function stageCloudForPreview(manifest: CloudManifest, manifestUrl: string): Promise<string> {
  const io = createMemoryIO();
  const cancelled = () => useLibraryJobs.getState().cancelRequested;
  try {
    await stageCloudLibrary(io, manifest, { manifestUrl, dbName: CORE_TMP_DB, isCancelled: cancelled, report });
  } catch (e) {
    if (cancelled()) throw new CancelledError();
    throw e;
  }
  const head = io.files.get(CORE_TMP_DB)?.subarray(0, 15);
  if (!head || String.fromCharCode(...head) !== 'SQLite format 3') throw new Error('הקובץ שחולץ אינו מסד SQLite');
  return manifest.version;
}
