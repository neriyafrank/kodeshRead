/**
 * App lifecycle around long library imports:
 *
 *  - <IngestionLifecycle/> (mounted once under the LibraryProvider) listens to AppState.
 *    When the app leaves the foreground ('background' / 'inactive') during a resumable
 *    import, it asks the job to pause: the import stops right after the current book
 *    commits and its checkpoint is saved as 'paused'. When the app is active again the
 *    import continues automatically (or, if it was still finishing its book, the pause is
 *    simply withdrawn). If the OS killed the app meanwhile, the checkpoint says
 *    'in_progress' and the resume card offers to continue on the next launch.
 *  - useInterruptedImports() lists the checkpoints of imports that did not finish, for the
 *    "המשך בנייה שנעצרה" card (Library screen + manager).
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useLibrary } from '../db/LibraryContext';
import { useLibraryJobs } from '../state/libraryJobs';
import { useLibraryActions } from './libraryActions';
import { findInterruptedImports, reopenSource, type InterruptedImport } from './localIndexer';

export function useInterruptedImports(): { items: InterruptedImport[]; reload: () => void } {
  const lib = useLibrary();
  const running = useLibraryJobs((x) => !!x.job);
  const generation = useLibraryJobs((x) => x.checkpointGeneration);
  const [items, setItems] = useState<InterruptedImport[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (running) return;
    let alive = true;
    findInterruptedImports(lib.user).then(
      (r) => alive && setItems(r),
      (e) => {
        console.warn('interrupted imports unreadable', e);
        if (alive) setItems([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [lib.user, lib.generation, running, generation, nonce]);

  return { items: running ? [] : items, reload: () => setNonce((n) => n + 1) };
}

export function IngestionLifecycle() {
  const lib = useLibrary();
  const actions = useLibraryActions();
  const [appState, setAppState] = useState<AppStateStatus>(() => (AppState.currentState ?? 'active') as AppStateStatus);
  const job = useLibraryJobs((x) => x.job);
  const autoPaused = useLibraryJobs((x) => x.autoPaused);
  const result = useLibraryJobs((x) => x.result);
  const resuming = useRef(false);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setAppState(next);
      const jobs = useLibraryJobs.getState();
      if (next === 'active') jobs.withdrawAutoPause();
      else if (jobs.job?.resumable && !jobs.stopRequested) jobs.requestPause(true);
    });
    return () => sub.remove();
  }, []);

  // Back in the foreground after an automatic pause: continue where it stopped.
  useEffect(() => {
    if (appState !== 'active' || job || !autoPaused || resuming.current) return;
    useLibraryJobs.getState().setAutoPaused(false);
    // Only the job that was just paused by the lifecycle resumes on its own.
    if (!result?.paused) return;
    const target = result.kind === 'buildCore' ? 'core' : 'user';
    resuming.current = true;
    (async () => {
      try {
        const item = (await findInterruptedImports(lib.user)).find((i) => i.target === target);
        // Only an import whose source is still open in this session resumes on its own;
        // anything else waits for a tap on the resume card.
        if (item && reopenSource(item.state)) {
          useLibraryJobs.getState().clearResult();
          await actions.resumeImport(item);
        }
      } catch (e) {
        console.warn('auto-resume failed', e);
      } finally {
        resuming.current = false;
      }
    })();
  }, [appState, job, autoPaused, result, lib.user, actions]);

  return null;
}
