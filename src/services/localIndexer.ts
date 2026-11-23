/**
 * On-device ingestion: the streaming pipeline of shared/pipeline.js (same parsing / alignment
 * engine as scripts/build-db.js), fed by expo-file-system and written with expo-sqlite.
 *
 *  - importUserFiles / importUserFolder: personal books into user_library.db under the
 *    "הספרים שלי" folder (sub-folders preserved as categories). Re-importing the same path
 *    replaces the book.
 *  - buildCoreFromFolder: builds core_library.db from an Otzaria folder (the folder that
 *    contains "אוצריא", or a books folder) into CORE_BUILD_DB and seals it for the caller's
 *    atomic same-directory swap (installCore(CORE_BUILD_DB)); finalizeCoreBuild retries only
 *    the end of a build (shared/coreFinalize.js) when its finalize / install step failed.
 *
 * Built for the full Otzaria library (7,674+ books) on a phone:
 *  - phases scan -> books -> links -> finalize, each incremental and checkpointed in the target
 *    DB (ingestion_state + import_queue), committed together with the rows they describe;
 *  - scan: breadth-first, one folder per transaction into the SQLite import_queue (no array of
 *    thousands of SAF URIs in JS); .pdf / .docx / images are counted and skipped unread;
 *  - books: one book per transaction, text dropped right after, a short yield between books;
 *    a malformed book is rolled back alone, logged to ingestion_errors and skipped;
 *  - links: commentary <-> base pairing from folder paths / titles and the persisted heading
 *    units (book_units), 20 commentaries per transaction with a committed cursor. There are no
 *    external link files: a "links" folder next to the books is never read;
 *  - finalize: optional optimizations (bounded FTS5 merges, ANALYZE), each non-fatal, no VACUUM;
 *    the build file is consumed only by the final rename, so a failed finish retries in seconds;
 *  - WAL + synchronous=NORMAL, 16MB page cache, PASSIVE WAL checkpoints every 150 books and
 *    TRUNCATE between phases, so memory and the WAL stay bounded;
 *  - an Android foreground service (src/services/importForegroundService.ts) keeps the process
 *    alive in the background; a pause / kill resumes at the exact next folder / book / batch.
 *
 * Never blocks or crashes the app:
 *  - books are STREAMED: 64KB byte chunks through an expo-file-system FileHandle (also on SAF
 *    content:// URIs), decoded and parsed line by line and written 150 paragraphs at a time, so
 *    memory per book is one chunk whatever the file size, and the JS thread only ever runs a few
 *    milliseconds between native round trips;
 *  - commentary pairing of the whole library yields to the UI every few hundred books;
 *  - personal imports write through their OWN SQLite connection (WAL), so the reader keeps reading
 *    committed data instead of queueing behind import statements or running inside their
 *    transactions;
 *  - a file the app dies on twice is skipped on the next resume (shared/pipeline.js crash guard);
 *  - names of listed files come from their URIs where possible (no SAF query per file);
 *  - progress reaches React at most every PROGRESS_MS.
 */
import { Directory, File, FileMode } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { cleanName, nameFromUri, openTextReader } from '../../shared/bookStream';
import * as coreFinalize from '../../shared/coreFinalize';
import type { CheckpointRow } from '../../shared/coreFinalize';
import * as indexer from '../../shared/indexer';
import type { IngestionError, IngestionState, StopReason, TargetDb, WriterDb } from '../../shared/indexer';
import * as pipeline from '../../shared/pipeline';
import type { FinalizeWarning, PipelineFs, PipelinePhase, PipelineProgress } from '../../shared/pipeline';
import { closeQuietly, yieldToUI } from '../db/dbUtils';
import { CORE_BUILD_DB, dbFile, isWeb, removeDbFiles, sqliteDir, toWriter, USER_DB } from '../db/library';
import { stopRequest, useLibraryJobs } from '../state/libraryJobs';

type Entry = File | Directory;

/** SAF (content://) names can arrive URL-encoded on some devices. */
function entryName(e: Entry): string {
  // From the URI when it carries the name: reading `e.name` on a SAF entry is a synchronous
  // content-provider query per file (seconds for a big folder).
  return nameFromUri(e.uri) ?? cleanName(e.name || '');
}

/** Bytes of a file through a FileHandle (works for file:// and SAF content:// URIs). */
function byteSource(file: File) {
  const handle = file.open(FileMode.ReadOnly);
  return {
    read: (n: number) => handle.readBytes(n),
    close: () => handle.close(),
  };
}

const deviceFs: PipelineFs<Entry> = {
  list: async (dir) => (dir as Directory).list().map((e) => ({ name: entryName(e), isDir: e instanceof Directory, handle: e })),
  readText: (file) => (file as File).text(),
  // Streamed reads: the book is never one string in memory.
  open: (file) => openTextReader(() => byteSource(file as File)),
  uriOf: (e) => e.uri,
  fromUri: (uri, isDir) => (isDir ? new Directory(uri) : new File(uri)),
};

/** Hebrew label of each phase (job stage + notification title). */
export const PHASE_LABELS: Record<PipelinePhase, string> = {
  scan: 'סורק תיקיות…',
  books: 'מייבא ספרייה',
  links: 'מקשר פרשנים לפי כותרות…',
  finalize: 'ממטב את האינדקס…',
};

const fmt = (n: number) => n.toLocaleString('en-US');

/** Minimum interval between progress updates reaching React / the notification. */
const PROGRESS_MS = 250;
let lastProgress = { at: 0, phase: '' };

function onProgress(p: PipelineProgress) {
  const now = Date.now();
  // Phase changes and the last item of a phase always show; anything else at most every PROGRESS_MS.
  const last = p.total != null && p.current != null && p.current >= p.total;
  if (p.phase === lastProgress.phase && !last && now - lastProgress.at < PROGRESS_MS) return;
  lastProgress = { at: now, phase: p.phase };
  let detail: string | null = null;
  let fraction: number | null = null;
  if (p.phase === 'scan') detail = `${fmt(p.current ?? 0)} תיקיות · ${fmt(p.total ?? 0)} ספרים נמצאו${p.detail ? ` · ${p.detail}` : ''}`;
  else if (p.phase === 'finalize') detail = p.current ? `שלב ${p.current}` : null;
  else if (p.total) {
    fraction = (p.current ?? 0) / p.total;
    detail = `${fmt(p.current ?? 0)} / ${fmt(p.total)}${p.detail ? ` · ${p.detail}` : ''}`;
  }
  useLibraryJobs.getState().update({
    stage: PHASE_LABELS[p.phase],
    fraction,
    detail,
    phase: p.phase,
    current: p.phase === 'scan' || p.phase === 'finalize' ? null : p.current,
    total: p.phase === 'scan' || p.phase === 'finalize' ? null : p.total,
  });
}

export interface ImportSummary {
  books: number;
  paragraphs: number;
  /** Heading-aligned commentary pairs / units written by the links phase. */
  refLinks: { pairs: number; units: number } | null;
  /** Non-text files (.pdf, .docx, images, ...) skipped without being read. */
  skippedFiles: number;
  /** Kept for the summary text: books completed by an interrupted run before this one resumed. */
  skipped: number;
  /** Books / folders that failed and were skipped. */
  errors: { path: string; message: string }[];
  /** Set when the run stopped early: 'pause' = resumable checkpoint kept, 'cancel' = discarded. */
  stopped: StopReason | null;
}

export interface RunOptions {
  /** Continue the interrupted checkpoint of the same source instead of starting over. */
  resume?: boolean;
}

function ensureNative() {
  if (isWeb) throw new Error('ייבוא ספרים אינו נתמך בתצוגה המקדימה בדפדפן');
}

// --- sources (kept in memory for auto-resume, re-opened from their URI after a restart) ------

type Source = { kind: 'folder'; dir: Directory } | { kind: 'files'; files: File[] };
const liveSources = new Map<string, Source>();

const folderUri = (dir: Directory) => dir.uri;
const filesUri = (files: File[]) => JSON.stringify(files.map((f) => f.uri));

/**
 * The source of an interrupted import, or null when it can no longer be read (the
 * folder permission was not kept across restarts): the user then picks it again.
 */
export function reopenSource(state: IngestionState): Source | null {
  const live = liveSources.get(state.source_uri);
  if (live) return live;
  try {
    if (state.source_kind === 'files') {
      const files = (JSON.parse(state.source_uri) as string[]).map((u) => new File(u));
      return files.length && files.every((f) => f.exists) ? { kind: 'files', files } : null;
    }
    const dir = new Directory(state.source_uri);
    if (!dir.exists) return null;
    dir.list(); // throws without a (persisted) read permission
    return { kind: 'folder', dir };
  } catch {
    return null;
  }
}

// --- helpers --------------------------------------------------------------------------

/** The books folder of an Otzaria download ("אוצריא"), otherwise the picked folder itself. */
async function resolveBooksRoot(root: Directory): Promise<Directory> {
  const entries = await deviceFs.list(root);
  const books = entries.find((e) => e.isDir && (e.name === 'אוצריא' || e.name.toLowerCase() === 'otzaria'));
  return (books?.handle as Directory | undefined) ?? root;
}

async function readAliases(dir: Directory): Promise<Record<string, string[]>> {
  const f = (await deviceFs.list(dir)).find((e) => !e.isDir && e.name.toLowerCase() === 'aliases.json');
  if (!f) return {};
  try {
    return indexer.mergeAliasOverrides([JSON.parse((await deviceFs.readText(f.handle)).replace(/^﻿/, ''))]);
  } catch {
    return {};
  }
}

/** Low-RAM bulk-write tuning for a connection an import writes through. */
async function tuneForImport(db: SQLiteDatabase): Promise<void> {
  // WAL + NORMAL: every commit is durable enough to resume from after a crash / OS kill without
  // fsync-ing every page; a 16MB page cache keeps memory flat (temp B-trees stay in memory:
  // Android has no reliably writable SQLite temp directory); journal_size_limit caps the WAL file
  // after each checkpoint; busy_timeout waits for a reader's checkpoint instead of failing.
  await db.execAsync(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16000; PRAGMA temp_store = MEMORY; PRAGMA journal_size_limit = 67108864; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = OFF;',
  );
}

/**
 * A dedicated connection to the personal library for one import. The app's own connection keeps
 * serving the reader: in WAL mode it reads the last committed state while this one writes.
 */
async function openUserWriter(): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(USER_DB, { useNewConnection: true });
  try {
    await tuneForImport(db);
    await indexer.ensureSchema(toWriter(db), { kind: 'user' });
    return db;
  } catch (e) {
    await closeQuietly(db);
    throw e;
  }
}

/** Runs `fn` with a personal-library write connection that is always closed afterwards. */
async function withUserWriter<T>(fn: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
  const db = await openUserWriter();
  try {
    return await fn(db);
  } finally {
    await db.execAsync('PRAGMA wal_checkpoint(PASSIVE);').catch(() => undefined);
    await closeQuietly(db);
  }
}

function walCheckpointer(db: SQLiteDatabase) {
  return async (mode: 'PASSIVE' | 'TRUNCATE') => {
    try {
      await db.execAsync(`PRAGMA wal_checkpoint(${mode});`);
    } catch (e) {
      console.warn('wal checkpoint skipped', e);
    }
  };
}

/** in_progress -> paused (never revives a completed / cleared checkpoint). */
async function markPaused(w: WriterDb) {
  try {
    const st = await indexer.readIngestionState(w);
    if (st?.status === 'in_progress') await indexer.writeIngestionState(w, { status: 'paused' });
  } catch (e) {
    console.warn('checkpoint not saved', e);
  }
}

/** Runs / resumes the streaming pipeline for either target. */
async function runPipeline(
  db: SQLiteDatabase,
  target: TargetDb,
  p: {
    source: { kind: 'folder'; root: Entry } | { kind: 'files'; files: { name: string; handle: Entry }[] };
    sourceUri: string;
    sourceName: string;
    idBase: number;
    categoryPrefix?: string[];
    aliasOverrides?: Record<string, string[]>;
    resume: boolean;
  },
): Promise<ImportSummary> {
  const w = toWriter(db);
  const before = p.resume ? await indexer.readIngestionState(w) : null;
  lastProgress = { at: 0, phase: '' };
  try {
    const r = await pipeline.runImport(w, deviceFs, {
      source: p.source,
      sourceUri: p.sourceUri,
      sourceName: p.sourceName,
      targetDb: target,
      idBase: p.idBase,
      categoryPrefix: p.categoryPrefix,
      aliasOverrides: p.aliasOverrides,
      resume: p.resume,
      shouldStop: stopRequest,
      onProgress,
      onError: ({ relPath, error }) => console.warn('book skipped', relPath, error),
      onWarning: (w) => console.warn(`import: ${w.step} failed (ignored, the import completes)`, w.message),
      yieldToUI: () => yieldToUI(15),
      walCheckpoint: walCheckpointer(db),
      checkpointEvery: 150,
      linksPerTransaction: 20,
      finalize: { analyze: target === 'core', analysisLimit: 1000 },
    });
    const errors = r.stopped ? (await indexer.readIngestionErrors(w, 50)).map((e) => ({ path: e.file_path, message: e.message })) : r.errors.map((e) => ({ path: e.relPath, message: e.message }));
    return {
      books: r.books,
      paragraphs: r.paragraphs,
      refLinks: r.phase === 'done' ? r.refLinks : null,
      skippedFiles: r.skippedFiles,
      skipped: before && indexer.isResumableState(before) ? Number(before.processed_count) || 0 : 0,
      errors,
      stopped: r.stopped,
    };
  } catch (e) {
    // Disk full, revoked permission, …: keep the checkpoint so the run can be resumed.
    await markPaused(w);
    throw e;
  }
}

// --- personal library --------------------------------------------------------------

async function finishUser(user: SQLiteDatabase, out: ImportSummary): Promise<ImportSummary> {
  if (out.stopped === 'cancel') await discardUserRun(user);
  else if (!out.stopped) await pipeline.completeImport(toWriter(user));
  useLibraryJobs.getState().bumpCheckpoint();
  return out;
}

/**
 * Imports picked .txt files into the root of "הספרים שלי". `_reader` is the app's own connection
 * (kept for the call shape); the import writes through a dedicated connection.
 */
export async function importUserFiles(_reader: SQLiteDatabase, picked: File[], opts: RunOptions = {}): Promise<ImportSummary> {
  ensureNative();
  const files = picked.map((f) => ({ name: entryName(f), handle: f as Entry }));
  const books = files.filter((f) => indexer.isBookFileName(f.name));
  if (!books.length) throw new Error('לא נבחרו קובצי ‎.txt');
  const uri = filesUri(picked);
  liveSources.set(uri, { kind: 'files', files: picked });
  return withUserWriter(async (user) => {
    const out = await runPipeline(user, 'user', {
      source: { kind: 'files', files },
      sourceUri: uri,
      sourceName: books.length === 1 ? books[0].name : `${books.length} קבצים`,
      idBase: indexer.USER_ID_BASE,
      categoryPrefix: [indexer.USER_ROOT_NAME],
      resume: !!opts.resume,
    });
    return finishUser(user, out);
  });
}

/** Imports a folder tree (sub-folders become categories) into "הספרים שלי/<folder>". */
export async function importUserFolder(_reader: SQLiteDatabase, root: Directory, opts: RunOptions = {}): Promise<ImportSummary> {
  ensureNative();
  useLibraryJobs.getState().update({ stage: PHASE_LABELS.scan, fraction: null, detail: null, phase: 'scan' });
  const books = await resolveBooksRoot(root);
  const uri = folderUri(root);
  liveSources.set(uri, { kind: 'folder', dir: root });
  const aliasOverrides = await readAliases(books);
  return withUserWriter(async (user) => {
    const out = await runPipeline(user, 'user', {
      source: { kind: 'folder', root: books },
      sourceUri: uri,
      sourceName: entryName(root),
      idBase: indexer.USER_ID_BASE,
      categoryPrefix: [indexer.USER_ROOT_NAME, entryName(root)],
      aliasOverrides,
      resume: !!opts.resume,
    });
    if (!out.stopped && out.books === 0 && out.skipped === 0 && !out.errors.length) {
      await finishUser(user, out);
      throw new Error('לא נמצאו קובצי ‎.txt בתיקייה');
    }
    return finishUser(user, out);
  });
}

/** "Discard & reset" of an interrupted personal import: deletes the books it added. */
export async function discardUserRun(user: SQLiteDatabase): Promise<void> {
  const w = toWriter(user);
  const st = await indexer.readIngestionState(w);
  await user.withTransactionAsync(async () => {
    if (st && st.status !== 'completed') {
      const base = Math.max(Number(st.base_book_id) || 0, indexer.USER_ID_BASE - 1);
      const rows = await user.getAllAsync<{ id: number }>('SELECT id FROM books WHERE id > ?', [base]);
      for (const r of rows) await indexer.deleteBook(w, r.id);
      await indexer.pruneEmptyCategories(w);
    }
    await w.run('DELETE FROM import_queue', []);
    await indexer.clearIngestionState(w);
  });
}

// --- core library --------------------------------------------------------------------

/**
 * The build's own connection (never shared through expo-sqlite's connection cache, so closing it
 * really releases the file before the rename).
 */
async function openBuildDb(): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(CORE_BUILD_DB, { useNewConnection: true });
  try {
    await tuneForImport(db);
    return db;
  } catch (e) {
    await closeQuietly(db);
    throw e;
  }
}

const coreWarn = (w: FinalizeWarning) => console.warn(`core build: ${w.step} failed (ignored, the import completes)`, w.message);

export interface CoreBuildResult {
  /** The built library's version, or null when the build paused / was cancelled. */
  version: string | null;
  summary: ImportSummary;
  /** Totals of the finished library (from its meta). */
  counts: { books: number; paragraphs: number } | null;
}

/**
 * Seals the finished build file so it can be renamed into place: verified WAL TRUNCATE
 * checkpoint, journal mode DELETE (soft), close, empty -wal / -shm removed (soft).
 */
async function sealBuildDb(db: SQLiteDatabase): Promise<void> {
  await coreFinalize.sealBuild(
    {
      checkpoint: () => db.getFirstAsync<CheckpointRow>('PRAGMA wal_checkpoint(TRUNCATE)'),
      setJournalDelete: () => db.execAsync('PRAGMA journal_mode = DELETE;'),
      close: () => db.closeAsync(),
      // Only the WAL pair: a -journal could be a hot rollback journal and is never deleted here.
      removeSideFiles: () => {
        for (const suffix of ['-wal', '-shm']) {
          const f = dbFile(CORE_BUILD_DB + suffix);
          if (f.exists) f.delete();
        }
      },
    },
    { warn: coreWarn },
  );
}

/**
 * Best-effort: stores "step · message" of a failed build / install in the build checkpoint, so
 * the resume card still shows it after a restart. Never throws.
 */
export async function recordCoreBuildError(e: unknown, open?: SQLiteDatabase | null): Promise<void> {
  if (isWeb) return;
  let db: SQLiteDatabase | null = open ?? null;
  try {
    if (!db) {
      if (!dbFile(CORE_BUILD_DB).exists) return;
      db = await openDatabaseAsync(CORE_BUILD_DB, { useNewConnection: true });
    }
    const w = toWriter(db);
    if (await indexer.readIngestionState(w)) await indexer.writeIngestionState(w, { last_error: coreFinalize.diagnosticOf(e) });
  } catch (err) {
    console.warn('core build error not recorded', err);
  } finally {
    if (!open) await closeQuietly(db);
    useLibraryJobs.getState().bumpCheckpoint();
  }
}

/**
 * Runs (or resumes) the pipeline into core_library.build.db and, when it finishes, writes the
 * library meta and seals the file for installCore(CORE_BUILD_DB). `src` null = finalize only:
 * the checkpoint is at the finalize phase (or the build is complete and waits for its install),
 * so the source folder is not needed and no book is read again.
 */
async function runCoreBuild(src: { root: Directory; books: Directory } | null, resume: boolean): Promise<CoreBuildResult> {
  ensureNative();
  if (!resume) removeDbFiles(CORE_BUILD_DB);
  else if (!dbFile(CORE_BUILD_DB).exists) throw new Error('קובץ הבנייה לא נמצא — יש לבנות את הספרייה מחדש');
  let db: SQLiteDatabase | null = await openBuildDb();
  try {
    const w = toWriter(db);
    await indexer.ensureSchema(w, { kind: 'core' });
    const st = await coreFinalize.adoptCompletedBuild(w);
    if (!src && !coreFinalize.needsFinalizeOnly(st)) throw new Error('הבנייה שנעצרה לא הגיעה לשלב הסיום: בחרו שוב את התיקייה כדי להמשיך');
    if (src || !coreFinalize.isReadyToInstall(st)) useLibraryJobs.getState().update({ stage: PHASE_LABELS[src ? 'scan' : 'finalize'], fraction: null, detail: null, phase: src ? 'scan' : 'finalize' });
    const uri = src ? folderUri(src.root) : (st?.source_uri ?? '');
    const summary = await runPipeline(db, 'core', {
      // Finalize only: the pipeline resumes at the finalize phase and never touches the source.
      source: src ? { kind: 'folder', root: src.books } : st?.source_kind === 'files' ? { kind: 'files', files: [] } : { kind: 'folder', root: sqliteDir() },
      sourceUri: uri,
      sourceName: src ? entryName(src.root) : (st?.source_name ?? ''),
      idBase: 0,
      aliasOverrides: src ? await readAliases(src.books) : undefined,
      resume,
    });
    if (summary.stopped) {
      await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => undefined);
      await closeQuietly(db);
      db = null;
      if (summary.stopped === 'cancel') removeDbFiles(CORE_BUILD_DB);
      useLibraryJobs.getState().bumpCheckpoint();
      return { version: null, summary, counts: null };
    }

    useLibraryJobs.getState().update({ stage: 'מסיים את הבנייה…', fraction: null, detail: null, phase: 'finalize' });
    const sourceName = src ? entryName(src.root) : (st?.source_name ?? '');
    const meta = await coreFinalize.writeBuildMeta(w, { source: `local:${sourceName}`, warn: coreWarn });
    const sealing = db;
    db = null; // from here on the connection is closed by sealBuild (or left to it on failure)
    try {
      await sealBuildDb(sealing);
    } catch (e) {
      await closeQuietly(sealing);
      throw e;
    }
    useLibraryJobs.getState().bumpCheckpoint();
    return { version: meta.version, summary, counts: { books: meta.counts.books, paragraphs: meta.counts.paragraphs } };
  } catch (e) {
    // The build file and its checkpoint are kept: the next attempt resumes from here (a build
    // that reached the finalize phase retries only that).
    if (db) {
      await markPaused(toWriter(db));
      await recordCoreBuildError(e, db);
      await closeQuietly(db);
    } else {
      await recordCoreBuildError(e);
    }
    useLibraryJobs.getState().bumpCheckpoint();
    throw e;
  }
}

/**
 * Builds (or, with `resume`, continues) a complete core library from an Otzaria folder in
 * SQLite/core_library.build.db. When finished the file is sealed (self-contained, closed) and
 * the new version is returned; install it with LibraryController.installCore(CORE_BUILD_DB).
 * When paused, `version` is null and the build file (with its checkpoint) is kept.
 */
export async function buildCoreFromFolder(root: Directory, opts: RunOptions = {}): Promise<CoreBuildResult> {
  ensureNative();
  useLibraryJobs.getState().update({ stage: PHASE_LABELS.scan, fraction: null, detail: null, phase: 'scan' });
  const books = await resolveBooksRoot(root);
  liveSources.set(folderUri(root), { kind: 'folder', dir: root });
  return runCoreBuild({ root, books }, !!opts.resume);
}

/**
 * Retries only the end of an interrupted core build (finalize optimizations, meta, sealing):
 * for a checkpoint at the finalize phase or a complete build whose install failed. Reads no
 * book and needs no folder permission. Install the result with installCore(CORE_BUILD_DB).
 */
export function finalizeCoreBuild(): Promise<CoreBuildResult> {
  return runCoreBuild(null, true);
}

/** Deletes an interrupted on-device core build (the installed library is untouched). */
export function discardCoreBuild(): void {
  if (!isWeb) removeDbFiles(CORE_BUILD_DB);
}

// --- interrupted imports ---------------------------------------------------------------

export interface InterruptedImport {
  target: TargetDb;
  state: IngestionState;
  errors: IngestionError[];
  /** Core build: only the finalize step (or just the install) is left; no folder is needed. */
  finalizeOnly?: boolean;
  /** Core build: complete, only the install into core_library.db is left. */
  readyToInstall?: boolean;
}

/** Checkpoints of imports that did not finish (paused, or killed mid-run), newest first. */
export async function findInterruptedImports(user: SQLiteDatabase): Promise<InterruptedImport[]> {
  if (isWeb) return [];
  const out: InterruptedImport[] = [];
  const u = toWriter(user);
  const us = await indexer.readIngestionState(u);
  const importing = ['importFiles', 'importFolder'].includes(useLibraryJobs.getState().job?.kind ?? '');
  if (!importing && indexer.isResumableState(us)) out.push({ target: 'user', state: us, errors: await indexer.readIngestionErrors(u, 20) });
  // Never open the build file while a build is writing it.
  const building = useLibraryJobs.getState().job?.kind === 'buildCore';
  if (!building && dbFile(CORE_BUILD_DB).exists) {
    let db: SQLiteDatabase | null = null;
    try {
      db = await openDatabaseAsync(CORE_BUILD_DB, { useNewConnection: true });
      const w = toWriter(db);
      const cs = await coreFinalize.adoptCompletedBuild(w);
      if (indexer.isResumableState(cs) || coreFinalize.isReadyToInstall(cs)) {
        out.push({
          target: 'core',
          state: cs as IngestionState,
          errors: await indexer.readIngestionErrors(w, 20),
          finalizeOnly: coreFinalize.needsFinalizeOnly(cs),
          readyToInstall: coreFinalize.isReadyToInstall(cs),
        });
      } else if (!cs) {
        await closeQuietly(db);
        db = null;
        removeDbFiles(CORE_BUILD_DB); // a build file without a checkpoint cannot be resumed
      }
    } catch (e) {
      console.warn('core build checkpoint unreadable', e);
    } finally {
      await closeQuietly(db);
    }
  }
  return out.sort((a, b) => (a.state.updated_at < b.state.updated_at ? 1 : -1));
}

// --- personal library maintenance ----------------------------------------------

export interface UserBookRow {
  id: number;
  title: string;
  total_lines: number;
}

/** One personal folder (a leaf category that holds books) with its totals. */
export interface UserFolderRow {
  category_id: number | null;
  category_path: string | null;
  book_count: number;
  total_lines: number;
}

/**
 * Personal folders with book counts — one row per folder, never one per book. The manager
 * screen renders this summary and loads a folder's books only when it is opened: a personal
 * library imported from a whole Otzaria folder holds thousands of books, and rendering them
 * all at once froze the screen and crashed the app.
 */
export function listUserFolders(user: SQLiteDatabase): Promise<UserFolderRow[]> {
  return user.getAllAsync<UserFolderRow>(
    `SELECT b.category_id AS category_id, c.path AS category_path,
            COUNT(*) AS book_count, COALESCE(SUM(b.total_lines), 0) AS total_lines
     FROM books b LEFT JOIN categories c ON c.id = b.category_id
     GROUP BY b.category_id ORDER BY c.path`,
  );
}

/** One page of the books in a personal folder (ordered by file path). */
export function listUserBooksInFolder(user: SQLiteDatabase, categoryId: number | null, limit: number, offset = 0): Promise<UserBookRow[]> {
  return user.getAllAsync<UserBookRow>(
    `SELECT id, title, total_lines FROM books WHERE category_id IS ? ORDER BY file_path LIMIT ? OFFSET ?`,
    [categoryId, limit, offset],
  );
}

/** Every book id in a personal folder (for "delete folder"). */
export async function listUserBookIdsInFolder(user: SQLiteDatabase, categoryId: number | null): Promise<number[]> {
  const rows = await user.getAllAsync<{ id: number }>(`SELECT id FROM books WHERE category_id IS ?`, [categoryId]);
  return rows.map((r) => r.id);
}

/** Deletes personal books (text, TOC, FTS rows, links) and folders left empty. */
export async function deleteUserBooks(user: SQLiteDatabase, bookIds: number[]): Promise<void> {
  const w = toWriter(user);
  await user.withTransactionAsync(async () => {
    for (const id of bookIds) {
      if (id < indexer.USER_ID_BASE) throw new Error('only personal books can be deleted');
      await indexer.deleteBook(w, id);
    }
    await indexer.pruneEmptyCategories(w);
  });
}
