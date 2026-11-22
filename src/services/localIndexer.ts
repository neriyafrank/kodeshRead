/**
 * On-device ingestion: the same engine as scripts/build-db.js (shared/indexer.js), fed by
 * expo-file-system and written with expo-sqlite.
 *
 *  - importUserFiles / importUserFolder: personal books into user_library.db under the
 *    "הספרים שלי" folder (sub-folders preserved as categories; link files in the folder
 *    are matched against all personal books). Re-importing the same path replaces the book.
 *  - buildCoreFromFolder: rebuilds core_library.db from an Otzaria folder (the folder that
 *    contains "אוצריא" + "links", or a books folder) into a staging file, then the caller
 *    swaps it in atomically.
 *
 * Every book is its own transaction (paragraphs + FTS rows in batched multi-row INSERTs),
 * with a yield to the UI between books, so the app stays responsive and the progress
 * (file count + current book) updates live.
 */
import { Directory, File } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import * as indexer from '../../shared/indexer';
import type { FsAdapter, LinkStats, ScannedBook, ScannedLinkFile } from '../../shared/indexer';
import { closeQuietly, nextFrame } from '../db/dbUtils';
import { CORE_TMP_DB, isWeb, removeDbFiles, toWriter } from '../db/library';
import { throwIfCancelled, useLibraryJobs } from '../state/libraryJobs';

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
    progress(stage, b.total ? b.index / b.total : null, `${b.index} / ${b.total} · ${b.title}`);
    throwIfCancelled();
  };
}

export interface ImportSummary {
  books: number;
  paragraphs: number;
  links: LinkStats | null;
}

function ensureNative() {
  if (isWeb) throw new Error('ייבוא ספרים אינו נתמך בתצוגה המקדימה בדפדפן');
}

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

async function indexLinksWithProgress(db: SQLiteDatabase, files: ScannedLinkFile<Entry>[]): Promise<LinkStats | null> {
  if (!files.length) return null;
  return indexer.indexLinks(toWriter(db), deviceFs, files, {
    onFile: (f) => {
      progress('מקשר פרשנים…', f.index / f.total, `${f.index} / ${f.total} · ${f.name}`);
      throwIfCancelled();
    },
    onError: (f, e) => console.warn('link file skipped', f.name, e),
  });
}

async function finishUserImport(user: SQLiteDatabase, books: number, paragraphs: number, links: LinkStats | null): Promise<ImportSummary> {
  progress('ממטב את האינדקס…', null);
  await indexer.finalizeIndex(toWriter(user));
  return { books, paragraphs, links };
}

/** Imports picked .txt files into the root of "הספרים שלי". */
export async function importUserFiles(user: SQLiteDatabase, picked: File[]): Promise<ImportSummary> {
  ensureNative();
  const files: ScannedBook<Entry>[] = picked
    .map((f) => ({ handle: f as Entry, name: entryName(f), rel: [entryName(f)], dir: [] as string[] }))
    .filter((f) => /\.txt$/i.test(f.name));
  if (!files.length) throw new Error('לא נבחרו קובצי ‎.txt');
  const r = await indexer.indexBooks(toWriter(user), deviceFs, {
    files,
    idBase: indexer.USER_ID_BASE,
    categoryPrefix: [indexer.USER_ROOT_NAME],
    onBook: bookProgress('מייבא ספרים…'),
    yieldEvery: nextFrame,
  });
  return finishUserImport(user, r.books, r.paragraphs, null);
}

/** Imports a folder tree (sub-folders become categories) into "הספרים שלי/<folder>". */
export async function importUserFolder(user: SQLiteDatabase, root: Directory): Promise<ImportSummary> {
  ensureNative();
  progress('סורק את התיקייה…', null);
  const layout = await resolveLayout(root);
  const tree = await indexer.scanBooks(deviceFs, layout.books as Entry);
  if (!tree.files.length) throw new Error('לא נמצאו קובצי ‎.txt בתיקייה');
  const linkFiles = await indexer.scanLinkFiles(deviceFs, (layout.links ?? layout.books) as Entry);
  const r = await indexer.indexBooks(toWriter(user), deviceFs, {
    files: tree.files,
    dirs: tree.dirs,
    idBase: indexer.USER_ID_BASE,
    categoryPrefix: [indexer.USER_ROOT_NAME, entryName(root)],
    aliasOverrides: await readAliases(layout.books),
    onBook: bookProgress('מייבא ספרים…'),
    yieldEvery: nextFrame,
  });
  const links = await indexLinksWithProgress(user, linkFiles);
  return finishUserImport(user, r.books, r.paragraphs, links);
}

/**
 * Builds a complete core library from an Otzaria folder into SQLite/core_library.db.tmp.
 * Returns the new version; install it with LibraryController.installCore().
 */
export async function buildCoreFromFolder(root: Directory): Promise<{ version: string; summary: ImportSummary }> {
  ensureNative();
  removeDbFiles(CORE_TMP_DB);
  progress('סורק את התיקייה…', null);
  const layout = await resolveLayout(root);
  const tree = await indexer.scanBooks(deviceFs, layout.books as Entry);
  if (!tree.files.length) throw new Error('לא נמצאו קובצי ‎.txt בתיקייה');
  const linkFiles = layout.links ? await indexer.scanLinkFiles(deviceFs, layout.links as Entry) : [];

  const db = await openDatabaseAsync(CORE_TMP_DB);
  try {
    // A staging file: durability is irrelevant until the atomic rename.
    await db.execAsync('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;');
    const w = toWriter(db);
    await indexer.ensureSchema(w, { kind: 'core' });
    const r = await indexer.indexBooks(w, deviceFs, {
      files: tree.files,
      dirs: tree.dirs,
      idBase: 0,
      aliasOverrides: await readAliases(layout.books),
      booksPerTransaction: 10,
      onBook: bookProgress('בונה ספרייה…'),
      yieldEvery: nextFrame,
    });
    const links = await indexLinksWithProgress(db, linkFiles);
    progress('ממטב את האינדקס…', null);
    await indexer.finalizeIndex(w, { analyze: true });
    const counts = await indexer.libraryCounts(w);
    const version = `local-${Date.now().toString(36)}`;
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
    await closeQuietly(db);
    return { version, summary: { books: r.books, paragraphs: r.paragraphs, links } };
  } catch (e) {
    await closeQuietly(db);
    removeDbFiles(CORE_TMP_DB);
    throw e;
  }
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
