/**
 * Device transfer engines of the cloud library download (the engine contract of shared/cloudDownload.js):
 *
 *   Android  WorkManager (modules/cloud-download, plugins/withCloudDownload.js): an OS-managed, persisted, network-
 *            constrained long-running worker in a dataSync foreground service. The transfer runs natively, straight into
 *            `<part>.partial`, and keeps going with the screen off, the app in the background or its process killed;
 *            WorkManager restarts it after a reboot or when the network returns. JS only polls its status.
 *   iOS      expo-file-system DownloadTask on a background NSURLSession (the OS continues it while the app is
 *            suspended); a pause persists the session's resume data next to the part. Also the Android fallback when
 *            the native module is not in the build (Expo Go / an old dev client): OkHttp Range resume from the bytes
 *            on disk.
 *   web      none here: the browser preview uses shared/cloudDownload.js createHttpEngine over memory.
 *
 * Retries / waiting for the network: the WorkManager worker does both natively. The DownloadTask engine below applies
 * the same policy in JS (exponential backoff, a budget refilled by any progress, offline = waiting, never deleting
 * bytes on a network error). SHA-256 verification and the UI state machine are the controller's (downloadPackage).
 */
import { requireOptionalNativeModule } from 'expo';
import { Directory, DownloadTask, File, type DownloadPauseState } from 'expo-file-system';
import { Platform } from 'react-native';

import { backoffDelayMs, DownloadError, hostOf, isTransientNetworkError, MAX_ATTEMPTS, phaseFromWorkStatus, type DownloadEngine, type EngineFile, type EngineStatus, type EngineTask } from '../../shared/cloudDownload';

interface NativeCloudDownload {
  enqueue(taskJson: string): Promise<'enqueued' | 'attached'>;
  stop(): Promise<boolean>;
  status(): Promise<string>;
  isNetworkAvailable(): boolean;
}

const native: NativeCloudDownload | null = Platform.OS === 'android' ? requireOptionalNativeModule<NativeCloudDownload>('CloudDownload') : null;

/** True when downloads run as OS-managed WorkManager work (Android build with modules/cloud-download). */
export function hasNativeBackgroundDownloads(): boolean {
  return !!native;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Android: the WorkManager worker does the transfer; this adapter enqueues it, stops it and reads its status. */
function createWorkManagerEngine(n: NativeCloudDownload, dir: Directory, title: string): DownloadEngine {
  let taskId: string | null = null;
  const uri = (name: string) => new File(dir, name).uri;
  return {
    kind: 'workmanager',
    async start(task: EngineTask) {
      taskId = task.id;
      await n.enqueue(
        JSON.stringify({
          id: task.id,
          title,
          files: task.files.map((f) => ({ name: f.name, url: f.url, partial: uri(f.partial), target: uri(f.name), size: f.sizeBytes })),
        }),
      );
    },
    async stop() {
      await n.stop();
    },
    async poll(): Promise<EngineStatus> {
      let raw: unknown = null;
      try {
        raw = JSON.parse(await n.status());
      } catch (e) {
        console.warn('cloud download status unreadable', e);
      }
      return phaseFromWorkStatus(raw, taskId);
    },
  };
}

/** "HTTP 404" in an expo-file-system error message -> 404. */
const httpStatusOf = (msg: string) => {
  const m = /\bHTTP (\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : 0;
};

interface TaskRun {
  id: string;
  stopped: boolean;
  task: DownloadTask | null;
  status: EngineStatus;
  promise: Promise<void> | null;
}

/**
 * iOS (and the Android fallback): one expo-file-system DownloadTask per part. Android resumes from the bytes on disk
 * (`resumeData` = the partial's size -> Range); iOS resumes from the NSURLSession resume data saved on pause.
 */
function createDownloadTaskEngine(dir: Directory): DownloadEngine {
  let run: TaskRun | null = null;
  const fileOf = (name: string) => new File(dir, name);
  const resumeFileOf = (f: EngineFile) => fileOf(`${f.partial}.resume.json`);
  const ios = Platform.OS === 'ios';

  const saveResume = async (r: TaskRun, f: EngineFile) => {
    if (!ios || !r.task) return;
    try {
      const state = r.task.savable();
      const out = resumeFileOf(f);
      if (!out.exists) out.create({ overwrite: true });
      await out.write(JSON.stringify(state));
    } catch (e) {
      console.warn('could not save the download resume data', e);
    }
  };

  const loadResume = (f: EngineFile): DownloadPauseState | null => {
    const file = resumeFileOf(f);
    if (!ios || !file.exists) return null;
    try {
      const state = JSON.parse(file.textSync()) as DownloadPauseState;
      return state && state.url === f.url ? state : null;
    } catch {
      return null;
    }
  };

  async function transferFile(r: TaskRun, f: EngineFile) {
    let failures = 0;
    for (;;) {
      if (r.stopped) return;
      const target = fileOf(f.name);
      if (target.exists && target.size === f.sizeBytes) return;
      if (target.exists) target.delete();
      let partial = fileOf(f.partial);
      let have = partial.exists ? partial.size : 0;
      if (have > f.sizeBytes) {
        partial.delete();
        have = 0;
      }
      if (have === f.sizeBytes) {
        await partial.move(fileOf(f.name)); // move() is async: always awaited
        return;
      }
      r.status = { ...r.status, phase: 'running', fileName: f.name, fileBytes: have };
      const onProgress = ({ bytesWritten }: { bytesWritten: number }) => {
        if (bytesWritten > r.status.fileBytes) r.status.fileBytes = Math.min(bytesWritten, f.sizeBytes);
      };
      const saved = loadResume(f);
      let task: DownloadTask;
      if (saved) task = DownloadTask.fromSavable(saved, { onProgress, sessionType: 'background' });
      else if (!ios && have > 0) task = DownloadTask.fromSavable({ url: f.url, fileUri: partial.uri, isDirectory: false, resumeData: String(have) }, { onProgress });
      else task = File.createDownloadTask(f.url, fileOf(f.partial), { onProgress, sessionType: 'background' });
      r.task = task;
      let error: unknown = null;
      try {
        const out = saved || (!ios && have > 0) ? await task.resumeAsync() : await task.downloadAsync();
        if (out == null) {
          await saveResume(r, f); // paused: iOS keeps the session's resume data
          return;
        }
        const rf = resumeFileOf(f);
        if (rf.exists) rf.delete();
      } catch (e) {
        if (r.stopped) return;
        error = e;
      } finally {
        r.task = null;
      }
      partial = fileOf(f.partial);
      const after = partial.exists ? partial.size : 0;
      if (after > have) failures = 0;
      if (!error && after === f.sizeBytes) continue; // renamed at the top of the loop
      if (!error && after > f.sizeBytes) {
        partial.delete();
        throw new DownloadError('size', { file: f.name, serverBytes: after, expected: f.sizeBytes, host: hostOf(f.url) });
      }
      const reason = error ? (error instanceof Error ? error.message : String(error)) : `short body (${after} of ${f.sizeBytes} bytes)`;
      if (error && !isTransientNetworkError(error)) {
        const status = httpStatusOf(reason);
        throw new DownloadError(status ? 'http' : /enospc|no space/i.test(reason) ? 'disk' : 'engine', { file: f.name, httpStatus: status, bytes: after, expected: f.sizeBytes, host: hostOf(f.url), reason });
      }
      if (failures >= MAX_ATTEMPTS) throw new DownloadError('network', { file: f.name, bytes: after, expected: f.sizeBytes, attempts: failures + 1, host: hostOf(f.url), reason });
      const delayMs = backoffDelayMs(failures);
      failures++;
      // DNS / "offline" failures read as waiting for the network; others as a retry with backoff.
      const offline = /resolve host|no address|offline|internet|network is unreachable|enetunreach/i.test(reason);
      r.status = { ...r.status, phase: offline ? 'waiting_for_network' : 'retrying', retry: { attempt: failures, maxAttempts: MAX_ATTEMPTS, delayMs, reason, offline } };
      for (let left = delayMs; left > 0 && !r.stopped; left -= 250) await sleep(Math.min(250, left));
    }
  }

  async function runTask(r: TaskRun, task: EngineTask) {
    try {
      for (const f of task.files) {
        if (r.stopped) break;
        await transferFile(r, f);
        r.status.retry = null;
      }
      r.status.phase = r.stopped ? 'stopped' : 'completed';
    } catch (e) {
      r.status.phase = r.stopped ? 'stopped' : 'failed';
      if (!r.stopped) r.status.error = e instanceof DownloadError ? e : new DownloadError('engine', { file: r.status.fileName, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    kind: 'download-task',
    start(task: EngineTask) {
      if (run && run.id === task.id && !run.stopped && ['running', 'retrying', 'waiting_for_network', 'idle'].includes(run.status.phase)) return;
      const r: TaskRun = { id: task.id, stopped: false, task: null, promise: null, status: { phase: 'running', taskId: task.id, fileName: null, fileBytes: 0, retry: null, error: null } };
      run = r;
      r.promise = runTask(r, task);
    },
    async stop() {
      const r = run;
      if (!r) return;
      r.stopped = true;
      const t = r.task;
      if (t) {
        try {
          if (ios) await t.pauseAsync();
          else t.pause();
        } catch {
          // already finished
        }
      }
      await r.promise;
    },
    poll(): EngineStatus {
      if (!run) return { phase: 'idle', taskId: null, fileName: null, fileBytes: 0, retry: null, error: null };
      return { ...run.status, retry: run.status.retry ? { ...run.status.retry } : null };
    },
  };
}

/** The transfer engine of this device for the parts in `dir`. */
export function deviceDownloadEngine(dir: Directory, title = 'מוריד ספרייה מהענן…'): DownloadEngine {
  return native ? createWorkManagerEngine(native, dir, title) : createDownloadTaskEngine(dir);
}

/** Stops a native download that runs without a JS controller (discarded from the card while the app was closed). */
export async function stopNativeDownload(): Promise<void> {
  if (!native) return;
  try {
    await native.stop();
  } catch (e) {
    console.warn('could not stop the background download', e);
  }
}

/** True when the native transfer was stopped outside the app (the notification's "השהה") while no JS controller ran. */
export async function nativeTransferWasStopped(): Promise<boolean> {
  if (!native) return false;
  try {
    return phaseFromWorkStatus(JSON.parse(await native.status()), null).phase === 'stopped';
  } catch {
    return false;
  }
}
