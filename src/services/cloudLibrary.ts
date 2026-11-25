/**
 * Multi-part cloud library: the pre-indexed core_library.db (+ the optional extended_library.db) built by the "Build
 * cloud library" GitHub Action and published as `library-latest`: library-manifest.json + <db>.zip.part-NN
 * (shared/libraryRelease.js).
 *
 *   1. library-manifest.json (book count, sizes, SHA-256 of every part and of the whole zip)
 *   2. free-space check: zip + extracted DB + 500 MB
 *   3. the parts are downloaded into Documents/core_library_parts/ by the device's transfer engine
 *      (backgroundDownload.ts: Android WorkManager = OS-managed, continues in the background / screen off / after the
 *      app was killed or the phone rebooted; iOS background NSURLSession). Each part goes to `<part>.partial`, is
 *      continued with an HTTP Range request after any interruption and renamed once complete; the controller
 *      (shared/cloudDownload.js) verifies its SHA-256, persists the state in cloud-download.json (pause / resume across
 *      restarts) and reports monotonic progress plus the states downloading / waiting_for_network / verifying / paused
 *   4. parts are appended into one zip in 1 MB chunks (each part deleted once appended), the zip is
 *      verified against fullZipSha256, then streamed (fflate) into SQLite/core_library.db.tmp
 *   5. the staged DB is checked (PRAGMA quick_check + meta) and installed by LibraryController.installCore()
 *      (awaited same-directory File.move), exactly like the single-file download in coreLibrary.ts
 *
 * The orchestration is shared (pure, self-tested in Node); this file supplies the expo-file-system storage
 * backend, the engine and the app wiring.
 */
import Constants from 'expo-constants';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';

import { readMeta, SCHEMA_VERSION } from '../../shared/indexer';
import { runStagedFlow, STAGE_TITLES, type InstalledState, type Plan } from '../../shared/libraryRelease';
import { clearDownloadState, createHttpEngine, patchDownloadState, readDownloadState, type Connectivity, type DownloadState, type PersistedDownload } from '../../shared/cloudDownload';
import { checkFreeSpace, cloudManifestUrl, createMemoryIO, formatBytes, packageOf, planPackages, requiredFreeBytesForPlan, stageCloudLibrary, validateCloudManifest, type CloudManifest, type CloudPackageView, type PartsIO } from '../../shared/multipart';
import { closeQuietly } from '../db/dbUtils';
import { coreInfoFromMeta, CORE_TMP_DB, dbFile, EXTENDED_TMP_DB, isWeb, removeDbFiles, toAdapter } from '../db/library';
import { CancelledError, useLibraryJobs } from '../state/libraryJobs';
import { deviceDownloadEngine, hasNativeBackgroundDownloads, nativeTransferWasStopped, stopNativeDownload } from './backgroundDownload';
import { withJobService } from './jobService';
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

/** expo-file-system storage of shared/multipart.js. Parts live in Documents/core_library_parts; staged DBs in SQLite/. */
export function nativePartsIO(): PartsIO {
  const dir = partsDir();
  // Fresh File objects on every use: File.move() re-points the object it is called on.
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
      await file(from).move(file(to), { overwrite: true }); // File.move() is async: always awaited
    },
    readText: (name) => file(name).text(),
    writeText: async (name, text) => {
      // Atomic: a crash mid-write never leaves a truncated state file (the partials would look stale).
      const tmp = file(`${name}.tmp`);
      if (tmp.exists) tmp.delete();
      tmp.create();
      await tmp.write(text);
      await tmp.move(file(name), { overwrite: true });
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

/** True when the browser preview runs the download flow against in-memory storage (e2e only). */
export const isPreviewCloudDownload = () => isWeb && !!(globalThis as { __KODESHREAD_E2E_CLOUD__?: boolean }).__KODESHREAD_E2E_CLOUD__;

/** Browser preview: ONE in-memory store for the session, so a paused download resumes from its bytes. */
let previewIO: (PartsIO & { files: Map<string, Uint8Array> }) | null = null;
const previewStore = () => (previewIO ??= createMemoryIO());

/** The storage of the cloud download on this platform (null: none, e.g. the plain browser preview). */
function cloudIO(): PartsIO | null {
  if (isPreviewCloudDownload()) return previewStore();
  if (isWeb) return null;
  return nativePartsIO();
}

/** Browser connectivity (Playwright `setOffline` flips it): offline -> "ממתין לחיבור לרשת…". */
const browserConnectivity: Connectivity = { isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false };

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

/** Removes the downloaded parts (and their partial / resume side files) of finished packages; no argument: everything. */
export function clearCloudParts(pkgs?: CloudPackageView[]): void {
  if (isWeb) {
    if (!pkgs) previewIO = null;
    return;
  }
  try {
    const dir = new Directory(Paths.document, PARTS_DIR);
    if (!dir.exists) return;
    if (!pkgs) return dir.delete();
    for (const pkg of pkgs) {
      for (const p of pkg.parts) {
        for (const suffix of ['', '.partial', '.partial.resume.json']) {
          const f = new File(dir, p.name + suffix);
          if (f.exists) f.delete();
        }
      }
    }
  } catch (e) {
    console.warn('could not remove cloud library parts', e);
  }
}

function report(p: { stage: string; fraction: number | null; detail: string | null; download?: DownloadState }) {
  useLibraryJobs.getState().update(p);
}

const tmpDbOf = (kind: 'core' | 'extended') => (kind === 'extended' ? EXTENDED_TMP_DB : CORE_TMP_DB);
const cancelled = () => useLibraryJobs.getState().cancelRequested;
const pauseRequested = () => useLibraryJobs.getState().stopRequested === 'pause';

/**
 * Downloads, assembles, extracts and validates ONE package (core or extended) into its staging database
 * (SQLite/core_library.db.tmp | extended_library.db.tmp). `win` maps its download bytes onto the unified bar of the
 * whole flow. Throws DownloadPausedError on a pause (the bytes stay for the next run), DownloadError on a fatal failure.
 */
async function stagePackage(pkg: CloudPackageView, manifest: CloudManifest, manifestUrl: string, win: { offset: number; total: number; label: string }): Promise<void> {
  const io = nativePartsIO();
  const tmp = tmpDbOf(pkg.kind);
  removeDbFiles(tmp);
  // WorkManager runs the transfer in its own foreground service; the JS steps after it (assembly, extraction) run under
  // the job's. Without the native module (Expo Go) the whole stage needs the job's service.
  const native = hasNativeBackgroundDownloads();
  await adoptLegacyPartials(io, pkg);
  const run = async () => {
    try {
      await stageCloudLibrary(io, pkg, {
        manifestUrl,
        engine: deviceDownloadEngine(partsDir()),
        dbName: tmp,
        window: win,
        isCancelled: cancelled,
        isPauseRequested: pauseRequested,
        report,
        pollMs: 500,
        keepAwake: (fn) => withKeepAwake(CLOUD_KEEP_AWAKE_TAG, () => (native ? withJobService('מרכיב את הספרייה…', fn) : fn())),
      });
    } catch (e) {
      if (cancelled()) throw new CancelledError();
      throw e;
    }
    report({ stage: 'בודק את מסד הנתונים…', fraction: null, detail: win.label });
    // A release with an extended pack stamps its core database `part = core`; an older one-database release has no part.
    await validateStagedCloud(manifest.version, tmp, pkg.kind === 'extended' ? 'extended' : manifest.extended ? 'core' : null);
  };
  try {
    await (native ? run() : withJobService('מוריד ספרייה מהענן…', run));
  } catch (e) {
    removeDbFiles(tmp); // the parts stay: the next attempt resumes
    throw e;
  }
}

/**
 * Builds before the WorkManager engine kept `<part>.partial` + a `.partial.id` sidecar (the part's SHA-256) and 4 MB
 * `.chunk` temp files. A partial whose sidecar matches this release is adopted (continued; SHA-256 still verified at
 * the end), the side files are removed.
 */
async function adoptLegacyPartials(io: PartsIO, pkg: CloudPackageView): Promise<void> {
  const saved = await readDownloadState(io);
  const known = (saved?.packages as Record<string, { release?: string } | null> | undefined)?.[pkg.kind];
  let adopt = false;
  for (const p of pkg.parts) {
    const id = `${p.name}.partial.id`;
    if ((await io.size(id)) != null) {
      const sha = String(await io.readText(id)).trim();
      if (sha === p.sha256 && !known) adopt = true;
      await io.remove(id);
    }
    await io.remove(`${p.name}.chunk`);
  }
  if (adopt) await patchDownloadState(io, { packages: { [pkg.kind]: { release: pkg.fullZipSha256, verified: {}, corrupt: {} } } });
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

/** Browser e2e: the same pipeline over the session's in-memory storage for ONE package; resolves once the bytes are a SQLite database. */
async function stagePackageForPreview(pkg: CloudPackageView, manifestUrl: string, win: { offset: number; total: number; label: string }): Promise<void> {
  const io = previewStore();
  const delay = (globalThis as { __KODESHREAD_E2E_POLL_MS__?: number }).__KODESHREAD_E2E_POLL_MS__;
  try {
    await stageCloudLibrary(io, pkg, {
      manifestUrl,
      engine: createHttpEngine({ io, connectivity: browserConnectivity, backoffBaseMs: 300, backoffCapMs: 1200, onlinePollMs: 200 }),
      dbName: tmpDbOf(pkg.kind),
      window: win,
      isCancelled: cancelled,
      isPauseRequested: pauseRequested,
      report,
      pollMs: typeof delay === 'number' ? delay : 50,
    });
  } catch (e) {
    if (cancelled()) throw new CancelledError();
    throw e;
  }
  const db = io.files.get(tmpDbOf(pkg.kind));
  const head = db?.subarray(0, 15);
  if (!head || String.fromCharCode(...head) !== 'SQLite format 3') throw new Error('הקובץ שחולץ אינו מסד SQLite');
  io.remove(tmpDbOf(pkg.kind)); // "installed" (the preview records it instead)
}

export interface CloudFlowHooks {
  installCore: () => Promise<void>;
  installExtended: () => Promise<void>;
  /** Called after a stage is installed (the browser preview records it instead of installing). */
  onInstalled: (kind: 'core' | 'extended', version: string) => void;
}

/** A cloud download that did not finish (paused, failed, or interrupted by a kill): the card's "המשך הורדה". */
export interface PendingCloudDownload {
  status: DownloadState;
  plan: Plan;
  manifest: CloudManifest;
  manifestUrl: string;
  progress: { done: number; total: number } | null;
  error: { code: string; message: string; diagnostic: string } | null;
  updatedAt: string | null;
}

/** The saved, unfinished cloud download (null when there is none). */
export async function pendingCloudDownload(): Promise<PendingCloudDownload | null> {
  const io = cloudIO();
  if (!io) return null;
  const s: PersistedDownload | null = await readDownloadState(io);
  if (!s || !s.manifest || !s.plan || !s.manifestUrl) return null;
  const status = (s.status ?? 'paused') as DownloadState;
  if (status === 'idle' || status === 'completed') return null;
  let manifest: CloudManifest;
  try {
    manifest = validateCloudManifest(s.manifest);
  } catch {
    return null;
  }
  return { status, plan: s.plan as Plan, manifest, manifestUrl: String(s.manifestUrl), progress: s.progress ?? null, error: s.error ?? null, updatedAt: s.updatedAt ?? null };
}

/**
 * On launch: should the saved download continue by itself? Only one that was running when the app went away, and not
 * paused from the notification meanwhile (then it is recorded as paused and waits for "המשך הורדה").
 */
export async function shouldAutoResumeCloudDownload(p: PendingCloudDownload): Promise<boolean> {
  if (p.status !== 'downloading' && p.status !== 'waiting_for_network' && p.status !== 'verifying') return false;
  if (await nativeTransferWasStopped()) {
    const io = cloudIO();
    if (io) await patchDownloadState(io, { status: 'paused' });
    return false;
  }
  return true;
}

/** Stops a background transfer and deletes every downloaded byte + the saved state ("בטל הורדה"). */
export async function discardCloudDownload(): Promise<void> {
  await stopNativeDownload();
  const io = cloudIO();
  if (io) await clearDownloadState(io);
  clearCloudParts();
}

/**
 * The staged cloud download of one plan (see shared/libraryRelease.js flowOf):
 *   core      ספריית יסוד only
 *   extended  only the expansion pack (core.db is never downloaded again)
 *   full      core -> extended in ONE flow with ONE progress bar (total = the combined bytes of the packages left);
 *             a fresh install installs core as soon as it is staged, so a cancellation keeps it usable and the next run
 *             only finishes the extended pack; an UPDATE stages both first and swaps them back to back.
 * Every package is resumable (parts on disk, Range), pausable and SHA-256 verified; the flow is recorded in
 * cloud-download.json so a pause, a kill or a reboot continues it. Returns the installed book count.
 */
export async function runCloudFlow(manifest: CloudManifest, manifestUrl: string, plan: Plan, state: InstalledState, hooks: CloudFlowHooks): Promise<{ books: number; kinds: ('core' | 'extended')[] }> {
  const preview = isPreviewCloudDownload();
  const io = cloudIO();
  if (!io) throw new Error('הורדת ספרייה אינה נתמכת בתצוגה המקדימה בדפדפן');
  const free = freeDiskBytes();
  if (!preview && free != null && free < requiredFreeBytesForPlan(manifest, plan) * 0.5) {
    // The card already warned; this only stops a run that cannot possibly fit.
    throw new Error(storageVerdict(manifest, plan, free).message ?? 'אין מספיק מקום פנוי');
  }
  // (A saved download of another release is never continued: the controller drops partials of another fullZipSha256.)
  await patchDownloadState(io, { manifest, manifestUrl, plan, status: 'downloading', error: null });
  try {
    const r = await runStagedFlow({
      state,
      manifest,
      plan,
      stage: (p: CloudPackageView, win) => (preview ? stagePackageForPreview(p, manifestUrl, win) : stagePackage(p, manifest, manifestUrl, win)),
      install: async (p: CloudPackageView) => {
        useLibraryJobs.getState().update({ stage: 'מתקין…', fraction: null, detail: STAGE_TITLES[p.kind], download: 'completed' });
        if (!preview) {
          // The DB swap (drain readers, close, rename) must not be cut short by the device sleeping or the OS.
          await withKeepAwake(CLOUD_KEEP_AWAKE_TAG, () => withJobService('מתקין את הספרייה…', () => (p.kind === 'core' ? hooks.installCore() : hooks.installExtended())));
          clearCloudParts([p]);
        }
        hooks.onInstalled(p.kind, manifest.version);
      },
    });
    await clearDownloadState(io);
    return { books: r.books, kinds: r.kinds };
  } catch (e) {
    if (e instanceof CancelledError || cancelled()) await clearDownloadState(io);
    else if (!(e as { paused?: boolean })?.paused) {
      const cur = await readDownloadState(io);
      // A DownloadError was recorded by the controller with its diagnostic; any later failure is recorded here.
      if (cur && cur.status !== 'error') await patchDownloadState(io, { status: 'error', error: { code: 'stage', message: e instanceof Error ? e.message : String(e), diagnostic: e instanceof Error ? e.message : String(e) } });
    }
    throw e;
  }
}
