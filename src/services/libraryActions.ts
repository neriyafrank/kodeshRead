/**
 * User-facing library operations (download / build / import / delete) wired to the job
 * progress store, the pickers and the LibraryController. Used by the Library & Updates
 * Manager and the first-launch onboarding card.
 */
import { Directory, File } from 'expo-file-system';
import { useMemo } from 'react';

import { useLibrary, useLibraryController } from '../db/LibraryContext';
import { CancelledError, useLibraryJobs, type JobKind } from '../state/libraryJobs';
import { useLibrarySettings } from '../state/libraryStore';
import { defaultManifestUrl, downloadAndStageCore, fetchReleaseInfo, type ReleaseInfo } from './coreLibrary';
import { buildCoreFromFolder, deleteUserBooks, importUserFiles, importUserFolder, type ImportSummary } from './localIndexer';

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

/** Runs one job at a time; returns false when another job is running. */
async function runJob(kind: JobKind, stage: string, fn: () => Promise<string>, after?: () => Promise<void>): Promise<boolean> {
  const jobs = useLibraryJobs.getState();
  if (!jobs.start(kind, stage)) return false;
  try {
    const message = await fn();
    useLibraryJobs.getState().finish({ ok: true, message });
  } catch (e) {
    console.warn(`library job ${kind} failed`, e);
    const message = e instanceof CancelledError ? 'הפעולה בוטלה' : e instanceof Error ? e.message : String(e);
    useLibraryJobs.getState().finish({ ok: false, message });
  } finally {
    if (after) await after().catch((e) => console.warn('library refresh failed', e));
  }
  return true;
}

function describeImport(s: ImportSummary): string {
  let msg = `יובאו ${s.books} ספרים (${s.paragraphs.toLocaleString('he-IL')} שורות)`;
  if (s.links) msg += `, ${s.links.kept} קישורי פרשנים`;
  if (s.links?.unmatched.size) msg += ` (${s.links.unmatched.size} שמות ספרים לא זוהו)`;
  return msg;
}

export function useManifestUrl(): string {
  const custom = useLibrarySettings((s) => s.manifestUrl);
  return custom ?? defaultManifestUrl();
}

export function useLibraryActions() {
  const lib = useLibrary();
  const ctl = useLibraryController();
  const manifestUrl = useManifestUrl();

  return useMemo(
    () => ({
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

      /** Rebuilds core_library.db on the device from a picked Otzaria folder. */
      buildCoreFromDevice: async () => {
        const dir = await pickDirectory();
        if (!dir) return false;
        return runJob('buildCore', 'סורק את התיקייה…', async () => {
          const { version, summary } = await buildCoreFromFolder(dir);
          useLibraryJobs.getState().update({ stage: 'מתקין…', fraction: null, detail: null });
          await ctl.installCore();
          return `ספריית הליבה נבנתה מהמכשיר (${version}): ${describeImport(summary).replace('יובאו', '')}`;
        });
      },

      importFiles: async () => {
        const files = await pickTextFiles();
        if (!files?.length) return false;
        return runJob('importFiles', 'מייבא ספרים…', async () => describeImport(await importUserFiles(lib.user, files)), ctl.refresh);
      },

      importFolder: async () => {
        const dir = await pickDirectory();
        if (!dir) return false;
        return runJob('importFolder', 'סורק את התיקייה…', async () => describeImport(await importUserFolder(lib.user, dir)), ctl.refresh);
      },

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
    }),
    [ctl, lib.user, manifestUrl],
  );
}
