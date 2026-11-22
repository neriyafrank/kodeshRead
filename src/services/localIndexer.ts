/**
 * On-device ingestion: the same engine as scripts/build-db.js (shared/indexer.js), fed by
 * expo-file-system and written with expo-sqlite.
 *
 *  - importUserFiles / importUserFolder: personal books into user_library.db under the
 *    "הספרים שלי" folder (sub-folders preserved as categories; link files in the folder
 *    are matched against all personal books). Re-importing the same path replaces the book.
 *  - buildCoreFromFolder: builds core_library.db from an Otzaria folder (the folder that
 *    contains "אוצריא" + "links", or a books folder) into CORE_BUILD_DB, then stages it as
 *    CORE_TMP_DB for the caller's atomic swap.
 *
 * Resumable and crash-proof (large 4GB+ libraries, backgrounding, screen-off):
 *  - every run keeps a checkpoint (ingestion_state) in the target DB, committed together
 *    with the books it describes; books commit in small batches (or alone when big);
 *  - phases: books -> links -> finalize. A pause (button, or the app leaving the
 *    foreground) stops after the current book commits; an interrupted run — paused, or
 *    killed by the OS — is resumed by re-running it with `resume: true`: completed books
 *    are skipped without being read, the rest continue;
 *  - a malformed book is rolled back alone, logged to ingestion_errors and skipped;
 *  - the FTS index is filled per book and merged incrementally at the end with WAL
 *    checkpoints in between, so the WAL / memory stay bounded.
 */
import { Directory, File } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import * as indexer from '../../shared/indexer';
import type { FsAdapter, IngestionError, IngestionState, LinkStats, ScannedBook, ScannedLinkFile, StopReason, TargetDb, WriterDb } from '../../shared/indexer';
import { closeQuietly, nextFrame } from '../db/dbUtils';
import { CORE_BUILD_DB, CORE_TMP_DB, dbFile, isWeb, removeDbFiles, toWriter } from '../db/library';
import { stopRequest, useLibraryJobs } from '../state/libraryJobs';

type Entry = File | Directory;

/** SAF (content://) names can arrive URL-encoded on some devices. */
function entryName(e: Entry): string {
  let n = e.name || '';
  if (/%[0-9A-F]{2}/i.test(n)) {
    try {
      n = decodeURIComponent(n);
    } catch {
      // keep as is
    }
  }
  const slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf(':'));
  return slash >= 0 ? n.slice(slash + 1) : n;
}

const deviceFs: FsAdapter<Entry> = {
  list: async (dir) =>
    (dir as Directory).list().map((e) => ({ name: entryName(e), isDir: e instanceof Directory, handle: e })),
  readText: (file) => (file as File).text(),
};

function progress(stage: string, fraction: number | null, detail: string | null = null) {
  useLibraryJobs.getState().update({ stage, fraction, detail });
}

function bookProgress(stage: string) {
  return (b: indexer.BookProgress) => {
    progress(b.skipped ? 'מדלג על ספרים שכבר הושלמו…' : stage, b.total ? b.index / b.total : null, `${b.index} / ${b.total} · ${b.title}`);
  };
}

export interface ImportSummary {
  books: number;
  paragraphs: number;
  links: LinkStats | null;
  /** Books completed by the interrupted run (resume). */
  skipped: number;
  /** Books that failed and were skipped. */
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

/** Finds "אוצריא" / "links" inside an Otzaria download folder; otherwise the folder itself. */
async function resolveLayout(root: Directory): Promise<{ books: Directory; links: Directory | null }> {
  const entries = await deviceFs.list(root);
  const dirs = entries.filter((e) => e.isDir);
  const books = dirs.find((e) => e.name === 'אוצריא' || e.name.toLowerCase() === 'otzaria')?.handle as Directory | undefined;
  const links = dirs.find((e) => e.name.toLowerCase() === 'links')?.handle as Directory | undefined;
  return { books: books ?? root, links: links ?? null };
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

/** Keeps the WAL file small during long runs (it otherwise grows until the next checkpoint). */
function walCheckpointer(db: SQLiteDatabase, every: number) {
  let n = 0;
  return async () => {
    if (++n % every !== 0) return;
    try {
      await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (e) {
      console.warn('wal checkpoint skipped', e);
    }
  };
}

async function setPhase(w: WriterDb, phase: 'links' | 'finalize') {
  await w.exec('BEGIN');
  await indexer.writeIngestionState(w, { phase, status: 'in_progress' });
  await w.exec('COMMIT');
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

/** Link phase: throws IngestionStopped between files when a pause / cancel is requested. */
async function indexLinksWithProgress(db: SQLiteDatabase, files: ScannedLinkFile<Entry>[]): Promise<LinkStats | null> {
  if (!files.length) return null;
  return indexer.indexLinks(toWriter(db), deviceFs, files, {
    onFile: (f) => {
      progress('מקשר פרשנים…', f.index / f.total, `${f.index} / ${f.total} · ${f.name}`);
      const stop = stopRequest();
      if (stop) throw new indexer.IngestionStopped(stop);
    },
    onError: (f, e) => console.warn('link file skipped', f.name, e),
  });
}

const summaryErrors = (r: { errors: { relPath: string; message: string }[] }) => r.errors.map((e) => ({ path: e.relPath, message: e.message }));

/**
 * Shared run loop for both targets: books (resumable) -> links -> finalize.
 * Returns the summary; `stopped` set when the user paused / cancelled.
 */
async function runPhases(...args: Parameters<typeof runPhasesInner>): Promise<ImportSummary> {
  try {
    return await runPhasesInner(...args);
  } catch (e) {
    // Disk full, revoked permission, …: keep the checkpoint so the run can be resumed.
    await markPaused(toWriter(args[0]));
    throw e;
  }
}

async function runPhasesInner(
  db: SQLiteDatabase,
  target: TargetDb,
  p: {
    sourceUri: string;
    sourceName: string;
    sourceKind: 'folder' | 'files';
    files: ScannedBook<Entry>[];
    dirs?: string[][];
    idBase: number;
    categoryPrefix?: string[];
    aliasOverrides?: Record<string, string[]>;
    linkFiles: ScannedLinkFile<Entry>[];
    stage: string;
    resume: boolean;
    booksPerTransaction: number;
  },
): Promise<ImportSummary> {
  const w = toWriter(db);
  const prev = p.resume ? await indexer.readIngestionState(w) : null;
  const resume = p.resume && indexer.isResumableState(prev);
  const phase = resume ? prev!.phase : 'books';
  const onCommit = walCheckpointer(db, target === 'core' ? 5 : 20);
  const out: ImportSummary = { books: 0, paragraphs: 0, links: null, skipped: 0, errors: [], stopped: null };

  if (phase === 'books' || !resume) {
    const r = await indexer.indexBooks(w, deviceFs, {
      files: p.files,
      dirs: p.dirs,
      idBase: p.idBase,
      categoryPrefix: p.categoryPrefix,
      aliasOverrides: p.aliasOverrides,
      booksPerTransaction: p.booksPerTransaction,
      maxLinesPerTransaction: 20000,
      ingestion: { sourceUri: p.sourceUri, sourceName: p.sourceName, sourceKind: p.sourceKind, targetDb: target, resume },
      shouldStop: stopRequest,
      onError: ({ relPath, error }) => console.warn('book skipped', relPath, error),
      onBook: bookProgress(p.stage),
      onCommit,
      yieldEvery: nextFrame,
    });
    Object.assign(out, { books: r.books, paragraphs: r.paragraphs, skipped: r.skipped, errors: summaryErrors(r), stopped: r.stopped });
    if (r.stopped) return out;
    await setPhase(w, 'links');
  } else {
    const errs = await indexer.readIngestionErrors(w);
    out.errors = errs.map((e) => ({ path: e.file_path, message: e.message }));
  }

  if (phase !== 'finalize') {
    try {
      out.links = await indexLinksWithProgress(db, p.linkFiles);
    } catch (e) {
      if (e instanceof indexer.IngestionStopped) {
        await markPaused(w);
        out.stopped = e.reason;
        return out;
      }
      throw e;
    }
    await setPhase(w, 'finalize');
  }

  progress('ממטב את האינדקס…', null);
  await indexer.finalizeIndex(w, {
    analyze: target === 'core',
    incremental: true,
    shouldStop: stopRequest,
    onStep: async (step) => {
      progress('ממטב את האינדקס…', null, `שלב ${step}`);
      await onCommit();
      await nextFrame();
    },
  });
  const stop = stopRequest();
  if (stop) {
    await markPaused(w);
    out.stopped = stop;
    return out;
  }
  return out;
}

// --- personal library --------------------------------------------------------------

async function finishUser(user: SQLiteDatabase, out: ImportSummary): Promise<ImportSummary> {
  const w = toWriter(user);
  if (out.stopped === 'cancel') {
    await discardUserRun(user);
  } else if (!out.stopped) {
    await indexer.writeIngestionState(w, { status: 'completed' });
  }
  useLibraryJobs.getState().bumpCheckpoint();
  return out;
}

/** Imports picked .txt files into the root of "הספרים שלי". */
export async function importUserFiles(user: SQLiteDatabase, picked: File[], opts: RunOptions = {}): Promise<ImportSummary> {
  ensureNative();
  const files: ScannedBook<Entry>[] = picked
    .map((f) => ({ handle: f as Entry, name: entryName(f), rel: [entryName(f)], dir: [] as string[] }))
    .filter((f) => indexer.isBookFileName(f.name));
  if (!files.length) throw new Error('לא נבחרו קובצי ‎.txt');
  const uri = filesUri(picked);
  liveSources.set(uri, { kind: 'files', files: picked });
  const out = await runPhases(user, 'user', {
    sourceUri: uri,
    sourceName: files.length === 1 ? files[0].name : `${files.length} קבצים`,
    sourceKind: 'files',
    files,
    idBase: indexer.USER_ID_BASE,
    categoryPrefix: [indexer.USER_ROOT_NAME],
    linkFiles: [],
    stage: 'מייבא ספרים…',
    resume: !!opts.resume,
    booksPerTransaction: 1,
  });
  return finishUser(user, out);
}

/** Imports a folder tree (sub-folders become categories) into "הספרים שלי/<folder>". */
export async function importUserFolder(user: SQLiteDatabase, root: Directory, opts: RunOptions = {}): Promise<ImportSummary> {
  ensureNative();
  progress('סורק את התיקייה…', null);
  const layout = await resolveLayout(root);
  const tree = await indexer.scanBooks(deviceFs, layout.books as Entry);
  if (!tree.files.length) throw new Error('לא נמצאו קובצי ‎.txt בתיקייה');
  const linkFiles = await indexer.scanLinkFiles(deviceFs, (layout.links ?? layout.books) as Entry);
  const uri = folderUri(root);
  liveSources.set(uri, { kind: 'folder', dir: root });
  const out = await runPhases(user, 'user', {
    sourceUri: uri,
    sourceName: entryName(root),
    sourceKind: 'folder',
    files: tree.files,
    dirs: tree.dirs,
    idBase: indexer.USER_ID_BASE,
    categoryPrefix: [indexer.USER_ROOT_NAME, entryName(root)],
    aliasOverrides: await readAliases(layout.books),
    linkFiles,
    stage: 'מייבא ספרים…',
    resume: !!opts.resume,
    booksPerTransaction: 1,
  });
  return finishUser(user, out);
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
    await indexer.clearIngestionState(w);
  });
}

// --- core library --------------------------------------------------------------------

async function openBuildDb(): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(CORE_BUILD_DB);
  // WAL + NORMAL: every commit is durable enough to resume from after a crash / OS kill,
  // without fsync-ing every page. A bounded page cache and on-disk temp tables keep memory
  // flat on multi-GB libraries (links staging can hold millions of rows).
  await db.execAsync(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = FILE; PRAGMA cache_size = -16000; PRAGMA journal_size_limit = 67108864; PRAGMA foreign_keys = OFF;',
  );
  return db;
}

/**
 * Builds (or, with `resume`, continues) a complete core library from an Otzaria folder in
 * SQLite/core_library.build.db. When finished it is moved to core_library.db.tmp and the
 * new version is returned; install it with LibraryController.installCore(). When paused,
 * `version` is null and the build file (with its checkpoint) is kept for a later resume.
 */
export async function buildCoreFromFolder(root: Directory, opts: RunOptions = {}): Promise<{ version: string | null; summary: ImportSummary }> {
  ensureNative();
  if (!opts.resume) removeDbFiles(CORE_BUILD_DB);
  progress('סורק את התיקייה…', null);
  const layout = await resolveLayout(root);
  const tree = await indexer.scanBooks(deviceFs, layout.books as Entry);
  if (!tree.files.length) throw new Error('לא נמצאו קובצי ‎.txt בתיקייה');
  const linkFiles = layout.links ? await indexer.scanLinkFiles(deviceFs, layout.links as Entry) : [];
  const uri = folderUri(root);
  liveSources.set(uri, { kind: 'folder', dir: root });

  let db: SQLiteDatabase | null = await openBuildDb();
  try {
    const w = toWriter(db);
    await indexer.ensureSchema(w, { kind: 'core' });
    const summary = await runPhases(db, 'core', {
      sourceUri: uri,
      sourceName: entryName(root),
      sourceKind: 'folder',
      files: tree.files,
      dirs: tree.dirs,
      idBase: 0,
      aliasOverrides: await readAliases(layout.books),
      linkFiles,
      stage: 'בונה ספרייה…',
      resume: !!opts.resume,
      booksPerTransaction: 10,
    });
    if (summary.stopped) {
      await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => undefined);
      await closeQuietly(db);
      db = null;
      if (summary.stopped === 'cancel') removeDbFiles(CORE_BUILD_DB);
      useLibraryJobs.getState().bumpCheckpoint();
      return { version: null, summary };
    }

    const counts = await indexer.libraryCounts(w);
    const version = `local-${Date.now().toString(36)}`;
    await w.exec('BEGIN');
    await indexer.writeMeta(w, {
      kind: 'core',
      db_version: version,
      built_at: new Date().toISOString(),
      source: `local:${entryName(root)}`,
      script_version: indexer.SCHEMA_VERSION,
      books: counts.books,
      categories: counts.categories,
      paragraphs: counts.paragraphs,
      links: counts.links,
      toc_nodes: counts.tocNodes,
    });
    await indexer.writeIngestionState(w, { status: 'completed' });
    await w.exec('COMMIT');
    // Fold the WAL into the main file so the staged library is one self-contained file.
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    await closeQuietly(db);
    db = null;
    removeDbFiles(CORE_TMP_DB);
    dbFile(CORE_BUILD_DB).move(dbFile(CORE_TMP_DB));
    removeDbFiles(CORE_BUILD_DB);
    useLibraryJobs.getState().bumpCheckpoint();
    return { version, summary };
  } catch (e) {
    // The build file and its checkpoint are kept: the next attempt resumes from here.
    if (db) {
      await markPaused(toWriter(db));
      await closeQuietly(db);
    }
    useLibraryJobs.getState().bumpCheckpoint();
    throw e;
  }
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
      db = await openDatabaseAsync(CORE_BUILD_DB);
      const w = toWriter(db);
      const cs = await indexer.readIngestionState(w);
      if (indexer.isResumableState(cs)) out.push({ target: 'core', state: cs, errors: await indexer.readIngestionErrors(w, 20) });
      else if (!cs) {
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
  file_path: string;
  total_lines: number;
  category_path: string | null;
}

export function listUserBooks(user: SQLiteDatabase): Promise<UserBookRow[]> {
  return user.getAllAsync<UserBookRow>(
    `SELECT b.id, b.title, b.file_path, b.total_lines, c.path AS category_path
     FROM books b LEFT JOIN categories c ON c.id = b.category_id ORDER BY b.file_path`,
  );
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
