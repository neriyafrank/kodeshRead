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
import { runStagedFlow, STAGE_TITLES, type InstalledState, type Plan } from '../../shared/libraryRelease';
import { checkFreeSpace, cloudManifestUrl, createMemoryIO, downloadRangeChunks, formatBytes, packageOf, planPackages, requiredFreeBytesForPlan, stageCloudLibrary, validateCloudManifest, type CloudManifest, type CloudPackageView, type PartsIO } from '../../shared/multipart';
import { closeQuietly } from '../db/dbUtils';
import { coreInfoFromMeta, CORE_TMP_DB, dbFile, EXTENDED_TMP_DB, isWeb, removeDbFiles, toAdapter } from '../db/library';
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

/** "free < zips + dbs + 500 MB" of one plan -> a Hebrew warning; ok otherwise. */
export function storageVerdict(m: CloudManifest, plan: Plan = 'core', free: number | null = freeDiskBytes()): StorageVerdict {
  const p = planPackages(m, plan);
  const v = checkFreeSpace({ ...m, totalZipBytes: p.totalZipBytes, uncompressedDbBytes: p.uncompressedDbBytes }, free);
  return {
    ...v,
    message: v.ok ? null : `אין מספיק מקום פנוי: נדרשים ${formatBytes(v.required)} (הורדה ${formatBytes(p.totalZipBytes)} + חילוץ ${formatBytes(p.uncompressedDbBytes)} + 500 MB רזרבה), פנויים ${formatBytes(v.free ?? 0)}.`,
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
  const file = (name: string) => (name === CORE_TMP_DB || name === EXTENDED_TMP_DB ? dbFile(name) : new File(dir, name));
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

/** Parts of a plan already on disk with the exact size of the manifest (the card's "ההורדה תמשיך" hint). */
export function countPartsOnDisk(m: CloudManifest, plan: Plan = 'full'): { onDisk: number; total: number } {
  const pkgs = planPackages(m, plan).packages.map((k) => packageOf(m, k));
  const total = pkgs.reduce((a, p) => a + p.parts.length, 0);
  if (isWeb) return { onDisk: 0, total };
  try {
    const dir = new Directory(Paths.document, PARTS_DIR);
    if (!dir.exists) return { onDisk: 0, total };
    let onDisk = 0;
    for (const pkg of pkgs) {
      for (const p of pkg.parts) {
        const f = new File(dir, p.name);
        if (f.exists && f.size === p.sizeBytes) onDisk++;
      }
    }
    return { onDisk, total };
  } catch {
    return { onDisk: 0, total };
  }
}

/** Removes the downloaded parts (and their partial / id / chunk side files) of finished packages. */
export function clearCloudParts(pkgs?: CloudPackageView[]): void {
  if (isWeb) return;
  try {
    const dir = new Directory(Paths.document, PARTS_DIR);
    if (!dir.exists) return;
    if (!pkgs) return dir.delete();
    for (const pkg of pkgs) {
      for (const p of pkg.parts) {
        for (const suffix of ['', '.partial', '.partial.id', '.chunk']) {
          const f = new File(dir, p.name + suffix);
          if (f.exists) f.delete();
        }
      }
    }
  } catch (e) {
    console.warn('could not remove cloud library parts', e);
  }
}

function report(p: { stage: string; fraction: number | null; detail: string | null }) {
  useLibraryJobs.getState().update(p);
}

const tmpDbOf = (kind: 'core' | 'extended') => (kind === 'extended' ? EXTENDED_TMP_DB : CORE_TMP_DB);

/**
 * Downloads, assembles, extracts and validates ONE package (core or extended) into its staging database
 * (SQLite/core_library.db.tmp | extended_library.db.tmp). `win` maps its download bytes onto the unified bar of the
 * whole flow. Resumes from the parts on disk (chunked Range, SHA-256 per part and for the whole zip).
 */
async function stagePackage(pkg: CloudPackageView, manifest: CloudManifest, manifestUrl: string, win: { offset: number; total: number; label: string }): Promise<void> {
  const cancelled = () => useLibraryJobs.getState().cancelRequested;
  const io = nativePartsIO(cancelled);
  const tmp = tmpDbOf(pkg.kind);
  removeDbFiles(tmp);
  try {
    try {
      await stageCloudLibrary(io, pkg, {
        manifestUrl,
        dbName: tmp,
        window: win,
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
    report({ stage: 'בודק את מסד הנתונים…', fraction: null, detail: win.label });
    // A release with an extended pack stamps its core database `part = core`; an older one-database release has no part.
    await validateStagedCloud(manifest.version, tmp, pkg.kind === 'extended' ? 'extended' : manifest.extended ? 'core' : null);
  } catch (e) {
    removeDbFiles(tmp); // the parts stay: the next attempt resumes
    throw e;
  }
}

/** quick_check + meta + schema of a staged DB (returns its version). `part` = the expected `meta.part` (null: none). */
export async function validateStagedCloud(expectedVersion: string, dbName: string = CORE_TMP_DB, part: 'core' | 'extended' | null = null): Promise<string> {
  const db = await openDatabaseAsync(dbName);
  try {
    await db.execAsync('PRAGMA query_only = ON;');
    const check = await db.getAllAsync<Record<string, string>>('PRAGMA quick_check');
    const verdict = check.map((r) => Object.values(r)[0]);
    if (verdict.length !== 1 || verdict[0] !== 'ok') throw new Error(`בדיקת שלמות SQLite נכשלה: ${verdict.slice(0, 3).join('; ')}`);
    const info = coreInfoFromMeta(await readMeta(toAdapter(db)), null);
    if (!info) throw new Error('הקובץ אינו ספריית kodeshRead (חסרה טבלת meta)');
    if (info.scriptVersion > SCHEMA_VERSION) throw new Error('הספרייה דורשת גרסה חדשה יותר של האפליקציה');
    if (info.version !== expectedVersion) throw new Error(`גרסת הספרייה (${info.version}) אינה תואמת ל-manifest (${expectedVersion})`);
    if (part && info.part !== part) throw new Error(`סוג הספרייה (${info.part ?? 'ללא'}) אינו תואם למצופה (${part})`);
    const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('books', 'paragraphs', 'toc_nodes', 'paragraphs_fts', 'links', 'ref_links')");
    if (!row || row.n < 6) throw new Error('מבנה מסד הנתונים חסר');
    return info.version;
  } finally {
    await closeQuietly(db);
  }
}

/** True when the browser preview runs the download flow against in-memory storage (e2e only). */
export const isPreviewCloudDownload = () => isWeb && !!(globalThis as { __KODESHREAD_E2E_CLOUD__?: boolean }).__KODESHREAD_E2E_CLOUD__;

/** Browser e2e: the same pipeline over in-memory storage for ONE package; resolves once the bytes are a SQLite database. */
async function stagePackageForPreview(pkg: CloudPackageView, manifestUrl: string, win: { offset: number; total: number; label: string }): Promise<void> {
  const io = createMemoryIO();
  const cancelled = () => useLibraryJobs.getState().cancelRequested;
  try {
    await stageCloudLibrary(io, pkg, { manifestUrl, dbName: tmpDbOf(pkg.kind), window: win, isCancelled: cancelled, report });
  } catch (e) {
    if (cancelled()) throw new CancelledError();
    throw e;
  }
  const head = io.files.get(tmpDbOf(pkg.kind))?.subarray(0, 15);
  if (!head || String.fromCharCode(...head) !== 'SQLite format 3') throw new Error('הקובץ שחולץ אינו מסד SQLite');
}

export interface CloudFlowHooks {
  installCore: () => Promise<void>;
  installExtended: () => Promise<void>;
  /** Called after a stage is installed (the browser preview records it instead of installing). */
  onInstalled: (kind: 'core' | 'extended', version: string) => void;
}

/**
 * The staged cloud download of one plan (see shared/libraryRelease.js flowOf):
 *   core      ספריית יסוד only
 *   extended  only the expansion pack (core.db is never downloaded again)
 *   full      core -> extended in ONE flow with ONE progress bar (total = the combined bytes of the packages left);
 *             a fresh install installs core as soon as it is staged, so a cancellation keeps it usable and the next run
 *             only finishes the extended pack; an UPDATE stages both first and swaps them back to back.
 * Every package is resumable (parts on disk, Range chunks) and SHA-256 verified. Returns the installed book count.
 */
export async function runCloudFlow(manifest: CloudManifest, manifestUrl: string, plan: Plan, state: InstalledState, hooks: CloudFlowHooks): Promise<{ books: number; kinds: ('core' | 'extended')[] }> {
  const preview = isPreviewCloudDownload();
  if (isWeb && !preview) throw new Error('הורדת ספרייה אינה נתמכת בתצוגה המקדימה בדפדפן');
  const free = freeDiskBytes();
  if (!preview && free != null && free < requiredFreeBytesForPlan(manifest, plan) * 0.5) {
    // The card already warned; this only stops a run that cannot possibly fit.
    throw new Error(storageVerdict(manifest, plan, free).message ?? 'אין מספיק מקום פנוי');
  }
  const r = await runStagedFlow({
    state,
    manifest,
    plan,
    stage: (p: CloudPackageView, win) => (preview ? stagePackageForPreview(p, manifestUrl, win) : stagePackage(p, manifest, manifestUrl, win)),
    install: async (p: CloudPackageView) => {
      useLibraryJobs.getState().update({ stage: 'מתקין…', fraction: null, detail: STAGE_TITLES[p.kind] });
      if (!preview) {
        // The DB swap (drain readers, close, rename) must not be cut short by the device sleeping.
        await withKeepAwake(CLOUD_KEEP_AWAKE_TAG, () => (p.kind === 'core' ? hooks.installCore() : hooks.installExtended()));
        clearCloudParts([p]);
      }
      hooks.onInstalled(p.kind, manifest.version);
    },
  });
  return { books: r.books, kinds: r.kinds };
}
