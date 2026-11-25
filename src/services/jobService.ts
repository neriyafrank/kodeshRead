/**
 * The Android foreground service of a running library job (importForegroundService.ts), with the job's progress
 * mirrored into its notification ("מייבא ספרייה: 1,240 / 7,674", "מרכיב את הספרייה… 42%"). Used by libraryActions.runJob
 * for ingestion jobs and by the cloud download for the steps after the transfer (assembly, extraction, install):
 * the transfer itself runs in WorkManager's own foreground service (backgroundDownload.ts), so the app never shows
 * two progress notifications. Web / iOS: no-op.
 */
import { formatCloudNotification } from '../../shared/multipart';
import { useLibraryJobs, type JobProgress } from '../state/libraryJobs';
import * as importService from './importForegroundService';

/** Notification title / text / progress of the running job. */
export function notificationFor(job: JobProgress): [string, string, number, number] {
  if (job.kind === 'download') {
    // "מוריד ספרייה מהענן… 42%" with a per-mille progress bar
    const n = formatCloudNotification(job.stage, job.fraction, job.detail);
    return [n.title, n.text, n.current, n.total];
  }
  const count = importService.formatCount(job.current, job.total);
  const title = job.phase === 'books' && count ? `${job.stage}: ${count}` : count ? `${job.stage} ${count}` : job.stage;
  const name = job.detail && job.detail.includes(' · ') ? job.detail.slice(job.detail.lastIndexOf(' · ') + 3) : (job.detail ?? '');
  return [title, name, job.current ?? 0, job.total ?? 0];
}

/** Starts the service and mirrors the job's progress into it; returns the cleanup (a no-op where unavailable). */
export async function startJobService(stage: string): Promise<() => Promise<void>> {
  if (!importService.isAvailable()) return async () => undefined;
  // Android 13+: ask before a long job; a refusal only hides the notification.
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

/** Runs `fn` under the job's foreground service (reuses one that is already running). */
export async function withJobService<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  if (importService.isActive()) return fn();
  const stop = await startJobService(stage).catch((e) => {
    console.warn('job foreground service unavailable', e);
    return async () => undefined;
  });
  try {
    return await fn();
  } finally {
    await stop().catch(() => undefined);
  }
}
