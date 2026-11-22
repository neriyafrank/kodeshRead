/**
 * User-facing library operations (download / build / import / resume / delete) wired to the
 * job progress store, the pickers and the LibraryController. Used by the Library & Updates
 * Manager, the first-launch onboarding card and the "resume interrupted import" card.
 *
 * Every job keeps the device awake (expo-keep-awake) while it runs, so a long build does not
 * stall when the screen would dim. Ingestion jobs are resumable: see IngestionLifecycle for
 * the background / foreground handling and localIndexer.ts for the checkpoints.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Directory, File } from 'expo-file-system';
import { useMemo } from 'react';
import { Alert, Platform } from 'react-native';

import type { IngestionState } from '../../shared/indexer';
import { useLibrary, useLibraryController } from '../db/LibraryContext';
import { CancelledError, useLibraryJobs, type JobKind, type JobResult } from '../state/libraryJobs';
import { useLibrarySettings } from '../state/libraryStore';
import { defaultManifestUrl, downloadAndStageCore, fetchReleaseInfo, type ReleaseInfo } from './coreLibrary';
import {
  buildCoreFromFolder,
  deleteUserBooks,
  discardCoreBuild,
  discardUserRun,
  findInterruptedImports,
  importUserFiles,
  importUserFolder,
  reopenSource,
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

/** Runs one job at a time (device kept awake); returns false when another job is running. */
async function runJob(kind: JobKind, stage: string, fn: () => Promise<JobOutcome>, after?: () => Promise<void>, resumable = false): Promise<boolean> {
  const jobs = useLibraryJobs.getState();
  if (!jobs.start(kind, stage, { resumable })) return false;
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch((e) => console.warn('keep-awake unavailable', e));
  try {
    const out = await fn();
    useLibraryJobs.getState().finish(typeof out === 'string' ? { ok: true, message: out } : { ok: true, ...out });
  } catch (e) {
    console.warn(`library job ${kind} failed`, e);
    const message = e instanceof CancelledError ? 'הפעולה בוטלה' : e instanceof Error ? e.message : String(e);
    useLibraryJobs.getState().finish({ ok: false, message });
  } finally {
    await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    if (after) await after().catch((e) => console.warn('library refresh failed', e));
  }
  return true;
}

function describeImport(s: ImportSummary): string {
  let msg = `יובאו ${s.books} ספרים (${s.paragraphs.toLocaleString('he-IL')} שורות)`;
  if (s.skipped) msg += `, ${s.skipped} ספרים הושלמו כבר קודם`;
  if (s.links) msg += `, ${s.links.kept} קישורי פרשנים`;
  if (s.links?.unmatched.size) msg += ` (${s.links.unmatched.size} שמות ספרים לא זוהו)`;
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

    const runBuildCore = (dir: Directory, resume: boolean) =>
      runJob(
        'buildCore',
        resume ? 'ממשיך בנייה…' : 'סורק את התיקייה…',
        async () => {
          const { version, summary } = await buildCoreFromFolder(dir, { resume });
          if (!version) return ingestionOutcome(summary, describeImport);
          useLibraryJobs.getState().update({ stage: 'מתקין…', fraction: null, detail: null });
          await ctl.installCore();
          return ingestionOutcome(summary, (s) => `ספריית הליבה נבנתה מהמכשיר (${version}): ${describeImport(s).replace('יובאו', '')}`);
        },
        undefined,
        true,
      );

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
        return runBuildCore(dir, sameFolder(await interrupted('core'), dir));
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
