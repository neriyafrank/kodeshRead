/**
 * User-facing library operations (download / build / import / resume / delete) wired to the
 * job progress store, the pickers and the LibraryController. Used by the Library & Updates
 * Manager, the first-launch onboarding card and the "resume interrupted import" card.
 *
 * Every job keeps the device awake (expo-keep-awake) while it runs, so a long build does not
 * stall when the screen would dim. Ingestion jobs additionally run under an Android foreground
 * service (ongoing progress notification + partial WakeLock, src/services/importForegroundService.ts)
 * so they keep going with the app in the background or the screen off. They are resumable too:
 * see IngestionLifecycle for the fallback when the service is unavailable, and localIndexer.ts
 * for the checkpoints.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Directory, File } from 'expo-file-system';
import { useMemo } from 'react';
import { Alert, Platform } from 'react-native';

import { describeError, StepError } from '../../shared/coreFinalize';
import type { IngestionState } from '../../shared/indexer';
import { useLibrary, useLibraryController } from '../db/LibraryContext';
import { CORE_BUILD_DB } from '../db/library';
import { CancelledError, useLibraryJobs, type JobKind, type JobProgress, type JobResult } from '../state/libraryJobs';
import { useLibrarySettings } from '../state/libraryStore';
import { defaultManifestUrl, downloadAndStageCore, fetchReleaseInfo, type ReleaseInfo } from './coreLibrary';
import * as importService from './importForegroundService';
import {
  buildCoreFromFolder,
  deleteUserBooks,
  discardCoreBuild,
  discardUserRun,
  finalizeCoreBuild,
  findInterruptedImports,
  importUserFiles,
  importUserFolder,
  recordCoreBuildError,
  reopenSource,
  type CoreBuildResult,
  type ImportSummary,
  type InterruptedImport,
} from './localIndexer';

const KEEP_AWAKE_TAG = 'kodeshread-library-job';

const isPickerCancel = (e: unknown) => /cancel/i.test(e instanceof Error ? e.message : String(e));

async function pickDirectory(): Promise<Directory | null> {
  try {
    return await Directory.pickDirectoryAsync();
  } catch (e) {
    if (isPickerCancel(e)) return null;
    throw e;
  }
}

async function pickTextFiles(): Promise<File[] | null> {
  try {
    const r = await File.pickFileAsync({ multipleFiles: true, mimeTypes: ['text/plain', 'application/octet-stream'] });
    return r.canceled ? null : r.result;
  } catch (e) {
    if (isPickerCancel(e)) return null;
    throw e;
  }
}

/** Shows a one-button notice and waits for it (web: window.alert). */
function notice(title: string, message: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${title}\n\n${message}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => Alert.alert(title, message, [{ text: 'בחר', onPress: () => resolve() }], { cancelable: false }));
}

type JobOutcome = string | Omit<JobResult, 'kind' | 'ok'>;

/** Notification title / text of the running ingestion job ("מייבא ספרייה: 1,240 / 7,674"). */
function notificationFor(job: JobProgress): [string, string, number, number] {
  const count = importService.formatCount(job.current, job.total);
  const title = job.phase === 'books' && count ? `${job.stage}: ${count}` : count ? `${job.stage} ${count}` : job.stage;
  const name = job.detail && job.detail.includes(' · ') ? job.detail.slice(job.detail.lastIndexOf(' · ') + 3) : (job.detail ?? '');
  return [title, name, job.current ?? 0, job.total ?? 0];
}

/**
 * Starts the Android foreground service for an ingestion job and mirrors the job's progress into
 * its notification. Returns the cleanup. Web / iOS: no-op (the lifecycle pauses on background).
 */
async function startImportService(stage: string): Promise<() => Promise<void>> {
  if (!importService.isAvailable()) return async () => undefined;
  // Android 13+: ask before the bulk import; a refusal only hides the notification.
  await importService.ensureNotificationPermission();
  if (!(await importService.start(stage, '', 0, 0))) return async () => undefined;
  const unsubscribe = useLibraryJobs.subscribe((s, prev) => {
    if (s.job && s.job !== prev.job) importService.update(...notificationFor(s.job));
  });
  return async () => {
    unsubscribe();
    await importService.stop();
  };
}

/** Runs one job at a time (device kept awake); returns false when another job is running. */
async function runJob(kind: JobKind, stage: string, fn: () => Promise<JobOutcome>, after?: () => Promise<void>, resumable = false): Promise<boolean> {
  const jobs = useLibraryJobs.getState();
  if (!jobs.start(kind, stage, { resumable })) return false;
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch((e) => console.warn('keep-awake unavailable', e));
  const stopService = resumable ? await startImportService(stage).catch((e) => (console.warn('import service failed', e), async () => undefined)) : null;
  try {
    const out = await fn();
    useLibraryJobs.getState().finish(typeof out === 'string' ? { ok: true, message: out } : { ok: true, ...out });
  } catch (e) {
    console.warn(`library job ${kind} failed`, e);
    useLibraryJobs.getState().finish(failureResult(kind, e));
  } finally {
    if (stopService) await stopService().catch(() => undefined);
    await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    if (after) await after().catch((e) => console.warn('library refresh failed', e));
  }
  return true;
}

/**
 * Failure card of a job: a readable message plus the one-line diagnostic (exact sub-step +
 * native error / code) that the "העתק פרטי שגיאה" button copies.
 */
function failureResult(kind: JobKind, e: unknown): Omit<JobResult, 'kind'> {
  if (e instanceof CancelledError) return { ok: false, message: 'הפעולה בוטלה' };
  const phase = useLibraryJobs.getState().job?.phase;
  if (e instanceof StepError) {
    const finishing = e.step.startsWith('finalize:');
    const keep = kind === 'buildCore' && finishing && e.retryable;
    return {
      ok: false,
      message: keep
        ? 'הספרייה נבנתה במלואה, אבל שלב הסיום וההתקנה נכשל. שום ספר לא אבד: לחצו ״המשך״ כדי לנסות שוב רק את שלב הסיום (כמה שניות).'
        : kind === 'download' && finishing
          ? 'ההתקנה של הספרייה שהורדה נכשלה. הספרייה הקודמת נשמרה.'
          : e.detail,
      diagnostic: e.diagnostic,
      retryable: keep,
    };
  }
  const detail = describeError(e);
  return { ok: false, message: e instanceof Error ? e.message : String(e), diagnostic: `${phase ?? kind} · ${detail}` };
}

function describeImport(s: ImportSummary): string {
  let msg = `יובאו ${s.books.toLocaleString('he-IL')} ספרים (${s.paragraphs.toLocaleString('he-IL')} שורות)`;
  if (s.skipped) msg += `, ${s.skipped.toLocaleString('he-IL')} ספרים הושלמו כבר קודם`;
  if (s.refLinks) msg += `, ${s.refLinks.pairs.toLocaleString('he-IL')} פרשנים קושרו (${s.refLinks.units.toLocaleString('he-IL')} יחידות)`;
  if (s.skippedFiles) msg += `. ${s.skippedFiles.toLocaleString('he-IL')} קבצים שאינם טקסט דולגו`;
  if (s.errors.length) msg += `. ${s.errors.length} קבצים פגומים דולגו`;
  return msg;
}

/** Job result of an ingestion run (finished / paused / cancelled). */
function ingestionOutcome(s: ImportSummary, done: (s: ImportSummary) => string): JobOutcome {
  const errors = s.errors.slice(0, 20);
  if (s.stopped === 'cancel') return { message: 'הפעולה בוטלה וההתקדמות נמחקה', errors };
  if (s.stopped === 'pause') return { message: 'הפעולה הושהתה — ההתקדמות נשמרה. אפשר להמשיך מאותה נקודה.', paused: true, errors };
  return { message: done(s), errors };
}

/** Same folder as an interrupted checkpoint (by URI, or by name after a re-pick). */
function sameFolder(st: IngestionState | undefined, dir: Directory): boolean {
  if (!st || st.source_kind !== 'folder') return false;
  if (st.source_uri === dir.uri) return true;
  const name = (dir.name || '').replace(/^.*[/:]/, '');
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // keep
  }
  return !!st.source_name && (st.source_name === name || st.source_name === decoded);
}

export function useManifestUrl(): string {
  const custom = useLibrarySettings((s) => s.manifestUrl);
  return custom ?? defaultManifestUrl();
}

export function useLibraryActions() {
  const lib = useLibrary();
  const ctl = useLibraryController();
  const manifestUrl = useManifestUrl();

  return useMemo(() => {
    const interrupted = async (target: 'core' | 'user') => (await findInterruptedImports(lib.user)).find((i) => i.target === target)?.state;

    /** Installs a finished, sealed build (CORE_BUILD_DB) and describes the result. */
    const installBuilt = async ({ version, summary, counts }: CoreBuildResult, finalizeOnly: boolean): Promise<JobOutcome> => {
      if (!version) return ingestionOutcome(summary, describeImport);
      useLibraryJobs.getState().update({ stage: 'מתקין את הספרייה…', fraction: null, detail: null, phase: 'finalize' });
      try {
        await ctl.installCore(CORE_BUILD_DB);
      } catch (e) {
        // The sealed build is still in place (unless the rename itself happened): keep the
        // diagnostic on its checkpoint for the resume card.
        await recordCoreBuildError(e);
        throw e;
      }
      if (finalizeOnly) {
        const books = (counts?.books ?? 0).toLocaleString('he-IL');
        const lines = (counts?.paragraphs ?? 0).toLocaleString('he-IL');
        return ingestionOutcome(summary, () => `ספריית הליבה הותקנה (${version}): ${books} ספרים (${lines} שורות)`);
      }
      return ingestionOutcome(summary, (s) => `ספריית הליבה נבנתה מהמכשיר (${version}): ${describeImport(s).replace('יובאו', '')}`);
    };

    const runBuildCore = (dir: Directory, resume: boolean) =>
      runJob(
        'buildCore',
        resume ? 'ממשיך בנייה…' : 'סורק את התיקייה…',
        async () => installBuilt(await buildCoreFromFolder(dir, { resume }), false),
        undefined,
        true,
      );

    /** Retries only the end of a core build (finalize + install); no folder, no book re-read. */
    const runFinalizeCore = () =>
      runJob('buildCore', 'מסיים את הבנייה…', async () => installBuilt(await finalizeCoreBuild(), true), undefined, true);

    const runImportFolder = (dir: Directory, resume: boolean) =>
      runJob(
        'importFolder',
        resume ? 'ממשיך ייבוא…' : 'סורק את התיקייה…',
        async () => ingestionOutcome(await importUserFolder(lib.user, dir, { resume }), describeImport),
        ctl.refresh,
        true,
      );

    const runImportFiles = (files: File[], resume: boolean) =>
      runJob('importFiles', 'מייבא ספרים…', async () => ingestionOutcome(await importUserFiles(lib.user, files, { resume }), describeImport), ctl.refresh, true);

    return {
      checkForUpdate: (url = manifestUrl): Promise<ReleaseInfo> => fetchReleaseInfo(url),

      /** Downloads (manifest -> .gz/.zip -> verify -> extract) and installs the core library. */
      downloadCore: (release?: ReleaseInfo) =>
        runJob('download', 'בודק גרסה…', async () => {
          const r = release ?? (await fetchReleaseInfo(manifestUrl));
          const version = await downloadAndStageCore(r);
          useLibraryJobs.getState().update({ stage: 'מתקין…', fraction: null, detail: null });
          await ctl.installCore();
          return `ספריית הליבה הותקנה (גרסה ${version})`;
        }),

      /** Builds core_library.db on the device from a picked Otzaria folder (resumes the same folder). */
      buildCoreFromDevice: async () => {
        const dir = await pickDirectory();
        if (!dir) return false;
        const pending = (await findInterruptedImports(lib.user)).find((i) => i.target === 'core');
        // Re-picking the folder of a build that only has its finish left: just finish it.
        if (pending?.finalizeOnly && sameFolder(pending.state, dir)) return runFinalizeCore();
        return runBuildCore(dir, sameFolder(pending?.state, dir));
      },

      importFiles: async () => {
        const files = await pickTextFiles();
        if (!files?.length) return false;
        return runImportFiles(files, false);
      },

      importFolder: async () => {
        const dir = await pickDirectory();
        if (!dir) return false;
        return runImportFolder(dir, sameFolder(await interrupted('user'), dir));
      },

      /**
       * Continues an interrupted import from its checkpoint. When the source can no longer be
       * read (the folder permission did not survive a restart), asks to pick it again.
       */
      resumeImport: async (item: InterruptedImport): Promise<boolean> => {
        const st = item.state;
        // A core build that reached its finalize step needs neither the folder nor any book.
        if (item.target === 'core' && item.finalizeOnly) return runFinalizeCore();
        let src = reopenSource(st);
        if (!src) {
          if (st.source_kind === 'files') {
            await notice('המשך ייבוא', 'בחרו שוב את קובצי הספרים שייבאתם. ספרים שכבר הושלמו ידולגו.');
            const files = await pickTextFiles();
            if (!files?.length) return false;
            src = { kind: 'files', files };
          } else {
            await notice('המשך מהנקודה שנעצרה', `בחרו שוב את התיקייה ״${st.source_name ?? ''}״. ספרים שכבר הושלמו ידולגו.`);
            const dir = await pickDirectory();
            if (!dir) return false;
            src = { kind: 'folder', dir };
          }
        }
        if (item.target === 'core') return src.kind === 'folder' ? runBuildCore(src.dir, true) : false;
        return src.kind === 'folder' ? runImportFolder(src.dir, true) : runImportFiles(src.files, true);
      },

      /** "Discard & reset": drops the partial core build, or the books of the partial personal import. */
      discardImport: (item: InterruptedImport) =>
        runJob(
          'delete',
          'מוחק את ההתקדמות…',
          async () => {
            if (item.target === 'core') discardCoreBuild();
            else await discardUserRun(lib.user);
            useLibraryJobs.getState().bumpCheckpoint();
            return item.target === 'core' ? 'הבנייה שנעצרה נמחקה' : 'הייבוא שנעצר בוטל והספרים החלקיים נמחקו';
          },
          ctl.refresh,
        ),

      deleteUserBooks: (ids: number[]) =>
        runJob(
          'delete',
          'מוחק…',
          async () => {
            await deleteUserBooks(lib.user, ids);
            return ids.length === 1 ? 'הספר נמחק' : `${ids.length} ספרים נמחקו`;
          },
          ctl.refresh,
        ),

      removeCore: () =>
        runJob('delete', 'מוחק את ספריית הליבה…', async () => {
          await ctl.removeCore();
          return 'ספריית הליבה הוסרה (הספרים האישיים נשמרו)';
        }),
    };
  }, [ctl, lib.user, manifestUrl]);
}
