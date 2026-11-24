/**
 * End of an on-device core build: finalization of the build database and the swap into
 * core_library.db. Platform-independent (the device passes expo-file-system / expo-sqlite
 * operations, the self-tests pass node fs / node:sqlite), and every sub-step is named, so a
 * failure on a real phone says exactly where it happened ("finalize:swap_file · ...").
 *
 * Why this exists: on the full Otzaria library (7,674 books, >1GB) the whole import survived and
 * then failed in its last seconds. The rules this module enforces:
 *
 *  - Optional work never aborts a completed import. FTS merge steps, ANALYZE, PRAGMA optimize,
 *    switching the journal mode, dropping the import_queue rows: each one is a "soft" step that
 *    logs a warning and carries on. There is no VACUUM on the device (it needs 2x the disk and
 *    minutes on a 1GB+ file).
 *  - The build is retryable without losing work. The build file records `finalize_step` in its
 *    checkpoint ('index' once the optional optimizations ran, 'meta' once the library meta is
 *    written and the file is ready to install). It is only consumed by the final rename, so if
 *    anything fails before or during the swap the completed build stays on disk and "המשך" runs
 *    only these few seconds again.
 *  - The swap is a same-directory rename of a self-contained file: the build's WAL is folded in
 *    with a verified PRAGMA wal_checkpoint(TRUNCATE) and the connection closed before the move;
 *    the installed library's connection is closed (and its readers drained) and its stale
 *    -wal / -shm / -journal files deleted before the new file takes its name. Never a copy.
 */
'use strict';

const indexer = require('./indexer');

/** Sub-step names surfaced in the UI and the self-tests. */
const STEPS = {
  ftsOptimize: 'finalize:fts_optimize',
  analyze: 'finalize:analyze',
  pragmaOptimize: 'finalize:pragma_optimize',
  indexState: 'finalize:index_state',
  counts: 'finalize:counts',
  writeMeta: 'finalize:write_meta',
  dropQueue: 'finalize:drop_queue',
  checkpoint: 'finalize:checkpoint',
  journalMode: 'finalize:journal_mode',
  closeBuild: 'finalize:close_build_db',
  cleanStaging: 'finalize:clean_staging',
  checkStaged: 'finalize:check_staged',
  closeDb: 'finalize:close_db',
  removeSidecars: 'finalize:remove_sidecars',
  swapFile: 'finalize:swap_file',
  reopenDb: 'finalize:reopen_db',
};

/** finalize_step values of the build checkpoint. */
const FINALIZE_INDEX_DONE = 'index';
const FINALIZE_READY = 'meta';

/** SQLite side files of a database (deleted / moved together with it). */
const SIDE_SUFFIXES = ['-wal', '-shm', '-journal'];

/** "message [code]" of any thrown value (native errors carry a code), bounded. */
function describeError(e) {
  if (e == null) return 'unknown error';
  if (e instanceof StepError) return e.detail;
  const msg = String((e && e.message) || e).trim() || String(e);
  const code = e && (e.code || (e.name && e.name !== 'Error' && e.name !== 'TypeError' ? e.name : null));
  const out = code && !msg.includes(String(code)) ? `${msg} [${code}]` : msg;
  return out.slice(0, 600);
}

/** A failure of one named sub-step; `diagnostic` is the one-line UI text. */
class StepError extends Error {
  constructor(step, cause) {
    const detail = describeError(cause);
    super(`${step}: ${detail}`);
    this.name = 'StepError';
    this.step = step;
    this.detail = detail;
    this.cause = cause;
    this.code = (cause && cause.code) || null;
    /** False when retrying cannot help (e.g. a folder without books). */
    this.retryable = !(cause && cause.retryable === false);
  }
  get diagnostic() {
    return `${this.step} · ${this.detail}`;
  }
}

/** The one-line diagnostic of any error ("step · message [code]"). */
function diagnosticOf(e) {
  if (e instanceof StepError) return e.diagnostic;
  if (e && typeof e.step === 'string' && typeof e.detail === 'string') return `${e.step} · ${e.detail}`;
  return describeError(e);
}

/** Runs a required sub-step: any failure becomes a StepError naming it. */
async function step(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StepError) throw e;
    throw new StepError(name, e);
  }
}

/**
 * Runs an optional sub-step: a failure is reported to `warn({ step, message })` and swallowed.
 * Returns true when it succeeded.
 */
async function softStep(name, fn, warn) {
  try {
    await fn();
    return true;
  } catch (e) {
    const w = { step: name, message: describeError(e) };
    if (warn) {
      try {
        warn(w);
      } catch {
        // a broken logger never breaks the import
      }
    }
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. build database: index optimizations (pipeline finalize phase) -------------------------

/**
 * The optional index optimizations of the finalize phase, each one soft: bounded FTS5 merge
 * steps, then (opts.analyze) a bounded ANALYZE and PRAGMA optimize. Records
 * finalize_step = 'index' when it ran to the end, so a retry skips it. Returns the stop reason
 * when `shouldStop()` ended the merge early (the index is valid, merely less compact).
 */
async function optimizeIndex(db, opts) {
  const o = opts || {};
  const st = await indexer.readIngestionState(db);
  if (st && (st.finalize_step === FINALIZE_INDEX_DONE || st.finalize_step === FINALIZE_READY)) return null;
  await softStep(
    STEPS.ftsOptimize,
    () =>
      indexer.finalizeIndex(db, {
        incremental: o.incremental !== false,
        mergePages: o.mergePages,
        maxSteps: o.maxSteps,
        shouldStop: o.shouldStop,
        onStep: o.onStep,
        analyze: false,
        optimize: false,
      }),
    o.warn,
  );
  const stop = o.shouldStop ? o.shouldStop() : null;
  if (stop) return stop;
  if (o.analyze) {
    const limit = Number(o.analysisLimit) | 0;
    await softStep(STEPS.analyze, () => db.exec(limit ? `PRAGMA analysis_limit = ${limit}; ANALYZE` : 'ANALYZE'), o.warn);
  }
  await softStep(STEPS.pragmaOptimize, () => db.exec('PRAGMA optimize'), o.warn);
  await step(STEPS.indexState, async () => {
    await db.exec('BEGIN');
    try {
      await indexer.writeIngestionState(db, { finalize_step: FINALIZE_INDEX_DONE });
      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
  return null;
}

// --- 2. build database: library meta (ready to install) ---------------------------------------

/**
 * Writes the core library meta (version + counts) and marks the build ready to install, in one
 * transaction: checkpoint status 'completed', phase 'finalize', finalize_step 'meta'. Idempotent:
 * a build already marked ready keeps its version. Then drops the import_queue rows (soft).
 *
 * @param db writer adapter of the build database
 * @param o  { version, source, warn }
 * @returns {Promise<{ version: string, counts: object, reused: boolean }>}
 */
async function writeBuildMeta(db, o) {
  const opts = o || {};
  const st = await indexer.readIngestionState(db);
  const meta = (await indexer.readMeta(db)) || {};
  if (st && st.finalize_step === FINALIZE_READY && meta.db_version) {
    const counts = { books: Number(meta.books) || 0, paragraphs: Number(meta.paragraphs) || 0, links: Number(meta.links) || 0, categories: Number(meta.categories) || 0, tocNodes: Number(meta.toc_nodes) || 0 };
    await softStep(STEPS.dropQueue, () => db.run('DELETE FROM import_queue', []), opts.warn);
    return { version: meta.db_version, counts, reused: true };
  }
  const counts = await step(STEPS.counts, () => indexer.libraryCounts(db));
  if (!counts.books) {
    throw new StepError(STEPS.counts, Object.assign(new Error('לא נמצאו קובצי ‎.txt בתיקייה'), { retryable: false }));
  }
  const version = opts.version || `local-${Date.now().toString(36)}`;
  await step(STEPS.writeMeta, async () => {
    await db.exec('BEGIN');
    try {
      await indexer.writeMeta(db, {
        kind: 'core',
        db_version: version,
        built_at: new Date().toISOString(),
        source: opts.source || 'local',
        script_version: indexer.SCHEMA_VERSION,
        books: counts.books,
        categories: counts.categories,
        paragraphs: counts.paragraphs,
        links: counts.links,
        toc_nodes: counts.tocNodes,
      });
      await indexer.writeIngestionState(db, { status: 'completed', phase: 'finalize', finalize_step: FINALIZE_READY, last_error: null, inflight_key: null, inflight_attempts: 0 });
      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
  await softStep(STEPS.dropQueue, () => db.run('DELETE FROM import_queue', []), opts.warn);
  return { version, counts, reused: false };
}

/**
 * A build completed by an older app version (status 'completed', meta.db_version written, no
 * finalize_step) is adopted as ready to install instead of being rebuilt. Returns the
 * (possibly updated) checkpoint.
 */
async function adoptCompletedBuild(db) {
  const st = await indexer.readIngestionState(db);
  if (!st || st.status !== 'completed' || st.finalize_step) return st;
  const meta = (await indexer.readMeta(db)) || {};
  if (!meta.db_version) return st;
  await db.exec('BEGIN');
  try {
    await indexer.writeIngestionState(db, { phase: 'finalize', finalize_step: FINALIZE_READY });
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return indexer.readIngestionState(db);
}

/** A build file whose checkpoint says "complete, only the install is left". */
function isReadyToInstall(st) {
  return !!st && st.status === 'completed' && st.finalize_step === FINALIZE_READY;
}

/** A build checkpoint that only needs the finalize phase (no source folder required). */
function needsFinalizeOnly(st) {
  return isReadyToInstall(st) || (indexer.isResumableState(st) && st.phase === 'finalize');
}

// --- 3. build database: self-contained file ----------------------------------------------------

/**
 * Folds the WAL into the main file and verifies it (busy = 0 and every frame checkpointed),
 * retrying while another connection briefly holds it. Throws when the WAL could not be emptied:
 * moving the main file without its WAL would lose committed pages.
 *
 * @param checkpoint async () => { busy, log, checkpointed } (one PRAGMA wal_checkpoint(TRUNCATE) row)
 */
async function verifiedCheckpoint(checkpoint, opts) {
  const o = opts || {};
  const attempts = o.attempts || 5;
  let last = null;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await checkpoint();
      lastErr = null;
      // Not in WAL mode: nothing to fold in (SQLite returns busy 0, log -1).
      if (!last || (Number(last.busy) === 0 && (Number(last.log) <= 0 || Number(last.log) === Number(last.checkpointed)))) return last;
    } catch (e) {
      lastErr = e;
    }
    await (o.sleep || sleep)(o.delayMs == null ? 200 : o.delayMs);
  }
  if (lastErr) throw lastErr;
  throw Object.assign(new Error(`WAL checkpoint incomplete (busy ${last && last.busy}, log ${last && last.log}, checkpointed ${last && last.checkpointed})`), { code: 'SQLITE_BUSY' });
}

/**
 * Closes the build database cleanly so it can be renamed: verified TRUNCATE checkpoint, journal
 * mode DELETE (soft), close, then the now-empty -wal / -shm files are removed (soft).
 *
 * @param env {
 *   checkpoint(): Promise<{busy,log,checkpointed}>, setJournalDelete(): Promise<void>,
 *   close(): Promise<void>, removeSideFiles(): void | Promise<void>, sleep?(ms) }
 */
async function sealBuild(env, opts) {
  const o = opts || {};
  await step(STEPS.checkpoint, () => verifiedCheckpoint(env.checkpoint, { sleep: env.sleep, attempts: o.attempts, delayMs: o.delayMs }));
  await softStep(STEPS.journalMode, () => env.setJournalDelete(), o.warn);
  await step(STEPS.closeBuild, () => env.close());
  // The checkpoint above emptied the WAL, so these side files hold nothing.
  await softStep(STEPS.cleanStaging, () => env.removeSideFiles(), o.warn);
}

// --- 4. swap into core_library.db ----------------------------------------------------------

/**
 * Installs the staged / built file `from` as `to` (both in the same SQLite directory).
 *
 * @param env {
 *   exists(name): boolean | Promise<boolean>
 *   remove(name): void | Promise<void>
 *   move(from, to): Promise<void>        an awaited, overwriting same-directory rename
 *   closeCore(): Promise<void>           closes (and drains) every connection to `to`
 *   reopenCore(): Promise<unknown>       opens and validates the installed library
 *   sleep?(ms)
 * }
 * @param o { from, to, settleMs = 150, warn }
 */
async function installFile(env, o) {
  const from = o.from;
  const to = o.to;
  const wait = env.sleep || sleep;
  await step(STEPS.checkStaged, async () => {
    if (!(await env.exists(from))) throw Object.assign(new Error(`staged library file ${from} is missing`), { code: 'ENOENT' });
  });
  await step(STEPS.closeDb, async () => {
    await env.closeCore();
    // Let the native layer release its file handles before the rename.
    await wait(o.settleMs == null ? 150 : o.settleMs);
  });
  await step(STEPS.removeSidecars, async () => {
    // The old library's WAL / shm describe the OLD file: next to the new one they would corrupt it.
    for (const s of SIDE_SUFFIXES) if (await env.exists(to + s)) await env.remove(to + s);
  });
  await step(STEPS.swapFile, async () => {
    await env.move(from, to);
    if (!(await env.exists(to))) throw new Error(`${to} missing after the move`);
    if (await env.exists(from)) throw new Error(`${from} still present after the move`);
  });
  // Side files of the staged name have no main file any more.
  await softStep(
    STEPS.cleanStaging,
    async () => {
      for (const s of SIDE_SUFFIXES) if (await env.exists(from + s)) await env.remove(from + s);
    },
    o.warn,
  );
  return step(STEPS.reopenDb, () => env.reopenCore());
}

/**
 * What a core build does when it starts, from what exists on disk (pure; src/services/localIndexer.ts):
 *   fresh     start from the source (a new build, or a "resume" whose build file never got created / was removed:
 *             a pause or cancel during the scan, before the file existed, must never be an error)
 *   resume    the build file exists: continue its checkpoint
 *   finalize  only the end is left (no source): needs the file
 *   nothing   finalize-only without a build file: nothing to do, reset quietly (no crash message)
 */
function coreBuildStart({ resume, hasSource, buildFileExists }) {
  if (!resume) return 'fresh';
  if (buildFileExists) return hasSource ? 'resume' : 'finalize';
  return hasSource ? 'fresh' : 'nothing';
}

module.exports = {
  coreBuildStart,
  STEPS,
  FINALIZE_INDEX_DONE,
  FINALIZE_READY,
  SIDE_SUFFIXES,
  StepError,
  describeError,
  diagnosticOf,
  step,
  softStep,
  optimizeIndex,
  writeBuildMeta,
  adoptCompletedBuild,
  isReadyToInstall,
  needsFinalizeOnly,
  verifiedCheckpoint,
  sealBuild,
  installFile,
};
