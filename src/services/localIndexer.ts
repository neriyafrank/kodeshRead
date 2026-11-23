/**
 * On-device ingestion: the streaming pipeline of shared/pipeline.js (same parsing / alignment
 * engine as scripts/build-db.js), fed by expo-file-system and written with expo-sqlite.
 *
 *  - importUserFiles / importUserFolder: personal books into user_library.db under the
 *    "הספרים שלי" folder (sub-folders preserved as categories). Re-importing the same path
 *    replaces the book.
 *  - buildCoreFromFolder: builds core_library.db from an Otzaria folder (the folder that
 *    contains "אוצריא", or a books folder) into CORE_BUILD_DB, then stages it as CORE_TMP_DB
 *    for the caller's atomic swap.
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
 *  - finalize: bounded FTS5 merge steps;
 *  - WAL + synchronous=NORMAL, 16MB page cache, PASSIVE WAL checkpoints every 150 books and
 *    TRUNCATE between phases, so memory and the WAL stay bounded;
 *  - an Android foreground service (src/services/importForegroundService.ts) keeps the process
 *    alive in the background; a pause / kill resumes at the exact next folder / book / batch.
 */
import { Directory, File } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import * as indexer from '../../shared/indexer';
import type { IngestionError, IngestionState, StopReason, TargetDb, WriterDb } from '../../shared/indexer';
import * as pipeline from '../../shared/pipeline';
import type { PipelineFs, PipelinePhase, PipelineProgress } from '../../shared/pipeline';
import { closeQuietly, yieldToUI } from '../db/dbUtils';
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

const deviceFs: PipelineFs<Entry> = {
  list: async (dir) => (dir as Directory).list().map((e) => ({ name: entryName(e), isDir: e instanceof Directory, handle: e })),
  readText: (file) => (file as File).text(),
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

function onProgress(p: PipelineProgress) {
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

/** Low-RAM bulk-write tuning for a database an import writes to. */
async function tuneForImport(db: SQLiteDatabase): Promise<void> {
  // WAL + NORMAL: every commit is durable enough to resume from after a crash / OS kill without
  // fsync-ing every page; a 16MB page cache and in-memory temp B-trees keep memory flat and
  // predictable; journal_size_limit caps the WAL file after each checkpoint.
  await db.execAsync(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16000; PRAGMA temp_store = MEMORY; PRAGMA journal_size_limit = 67108864; PRAGMA foreign_keys = OFF;',
  );
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
      yieldToUI: () => yieldToUI(15),
      walCheckpoint: walCheckpointer(db),
      checkpointEvery: 150,
      linksPerTransaction: 20,
      finalize: { analyze: target === 'core' },
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

/** Imports picked .txt files into the root of "הספרים שלי". */
export async function importUserFiles(user: SQLiteDatabase, picked: File[], opts: RunOptions = {}): Promise<ImportSummary> {
  ensureNative();
  const files = picked.map((f) => ({ name: entryName(f), handle: f as Entry }));
  const books = files.filter((f) => indexer.isBookFileName(f.name));
  if (!books.length) throw new Error('לא נבחרו קובצי ‎.txt');
  const uri = filesUri(picked);
  liveSources.set(uri, { kind: 'files', files: picked });
  await tuneForImport(user);
  const out = await runPipeline(user, 'user', {
    source: { kind: 'files', files },
    sourceUri: uri,
    sourceName: books.length === 1 ? books[0].name : `${books.length} קבצים`,
    idBase: indexer.USER_ID_BASE,
    categoryPrefix: [indexer.USER_ROOT_NAME],
    resume: !!opts.resume,
  });
  return finishUser(user, out);
}

/** Imports a folder tree (sub-folders become categories) into "הספרים שלי/<folder>". */
export async function importUserFolder(user: SQLiteDatabase, root: Directory, opts: RunOptions = {}): Promise<ImportSummary> {
  ensureNative();
  useLibraryJobs.getState().update({ stage: PHASE_LABELS.scan, fraction: null, detail: null, phase: 'scan' });
  const books = await resolveBooksRoot(root);
  const uri = folderUri(root);
  liveSources.set(uri, { kind: 'folder', dir: root });
  await tuneForImport(user);
  const out = await runPipeline(user, 'user', {
    source: { kind: 'folder', root: books },
    sourceUri: uri,
    sourceName: entryName(root),
    idBase: indexer.USER_ID_BASE,
    categoryPrefix: [indexer.USER_ROOT_NAME, entryName(root)],
    aliasOverrides: await readAliases(books),
    resume: !!opts.resume,
  });
  if (!out.stopped && out.books === 0 && out.skipped === 0 && !out.errors.length) {
    await finishUser(user, out);
    throw new Error('לא נמצאו קובצי ‎.txt בתיקייה');
  }
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
    await w.run('DELETE FROM import_queue', []);
    await indexer.clearIngestionState(w);
  });
}

// --- core library --------------------------------------------------------------------

async function openBuildDb(): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(CORE_BUILD_DB);
  await tuneForImport(db);
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
  useLibraryJobs.getState().update({ stage: PHASE_LABELS.scan, fraction: null, detail: null, phase: 'scan' });
  const books = await resolveBooksRoot(root);
  const uri = folderUri(root);
  liveSources.set(uri, { kind: 'folder', dir: root });

  let db: SQLiteDatabase | null = await openBuildDb();
  try {
    const w = toWriter(db);
    await indexer.ensureSchema(w, { kind: 'core' });
    const summary = await runPipeline(db, 'core', {
      source: { kind: 'folder', root: books },
      sourceUri: uri,
      sourceName: entryName(root),
      idBase: 0,
      aliasOverrides: await readAliases(books),
      resume: !!opts.resume,
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
    if (!counts.books) throw new Error('לא נמצאו קובצי ‎.txt בתיקייה');
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
    await w.exec('COMMIT');
    await pipeline.completeImport(w);
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
