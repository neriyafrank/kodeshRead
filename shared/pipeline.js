/**
 * Streaming, resumable import pipeline (schema v6), shared by the on-device indexer
 * (src/services/localIndexer.ts) and the self-tests. Built for the full Otzaria library
 * (7,674+ books, several GB) on a phone:
 *
 *   scan      breadth-first walk of the source folder, ONE folder per transaction: its
 *             sub-folders and book files are persisted in `import_queue` (never collected in a
 *             JS array); non-text files (.pdf, .docx, images, ...) are counted and skipped
 *             without being read.
 *   books     the queue's pending files in canonical (depth-first, sorted) order, ONE book per
 *             transaction: read -> parse -> paragraphs + TOC + book_units + FTS rows -> queue row
 *             done -> checkpoint, then the text is dropped and the event loop yields.
 *   links     commentary <-> base alignment from folder paths / titles + book_units
 *             (indexer.indexRefLinks), in small batches with a committed cursor.
 *   finalize  optional optimizations (bounded FTS5 merge steps, ANALYZE, PRAGMA optimize), each
 *             non-fatal (shared/coreFinalize.js); never VACUUM on the device.
 *
 * Every step commits its checkpoint (ingestion_state) together with the rows it describes, so a
 * pause, an OS kill or a crash at any statement resumes at the exact next folder / book / batch,
 * with no duplicates and no wasted work.
 *
 * Crash-loop protection: before a book (or a links batch) starts, its key is committed as
 * `inflight_key` with an attempt count. A unit that was still in flight when the app died is
 * retried once (alone, for links); if the app dies on it again it is skipped and logged, so one
 * file that crashes the app (out of memory, a native fault) can never trap every later resume.
 *
 * Books are streamed when the file adapter has `open(handle)` (text chunks; see
 * shared/bookStream.js): a book is parsed and written as it arrives, never held whole. There are no external link files: commentary links come
 * only from folder paths, file names and the books' own headings.
 *
 * File adapter (in addition to indexer's { list, readText }):
 *   uriOf(handle) -> string            persisted in import_queue
 *   fromUri(uri, isDir) -> handle      re-opens a queued folder / file
 *   open(handle) -> Promise<{ read() -> Promise<string|null>, close() }>   optional streamed reads
 * (both default to the identity, which suits node paths).
 */
'use strict';

const indexer = require('./indexer');
const coreFinalize = require('./coreFinalize');

const PAD = 5; // sort_key segment width: up to 99,999 entries per folder
const pad = (n) => String(n).padStart(PAD, '0');

/** Folders never walked: Otzaria's external link files are not used (pairing is path-based). */
const SKIPPED_ROOT_DIRS = new Set(['links']);
/** Metadata files read elsewhere (or not at all), not counted as skipped books. */
const METADATA_FILES = new Set(['order.json', 'aliases.json', 'manifest.json', 'files.json']);

const PHASES = ['scan', 'books', 'links', 'finalize'];

/** Otzaria is ~4-6 levels deep (אוצריא / category / sub-category / ... / book): deeper folders are never scanned. */
const MAX_SCAN_DEPTH = 12;
/** More folders than this scanned with no book file found = the wrong folder (or a runaway listing): stop. */
const NO_BOOKS_AFTER_DIRS = 500;
/** Folders never entered at any depth: hidden ("." prefix) and Android's own data / system folders. */
const isSkippedScanDir = (name) => {
  const n = String(name || '');
  return n.startsWith('.') || /^(android|\$recycle\.bin|lost\+found|system volume information)$/i.test(n);
};
const NO_BOOKS_MESSAGE = (dirs) => `לא נמצאו קבצי טקסט של אוצריא בתיקייה שנבחרה (נסרקו ${dirs} תיקיות ללא אף קובץ ‎.txt). בחרו ישירות את התיקייה ״אוצריא״ שמכילה את הספרים.`;

/** Thrown by the scan when it gives up on a folder that holds no book files. */
class NoBooksFoundError extends Error {
  constructor(dirs) {
    super(NO_BOOKS_MESSAGE(dirs));
    this.name = 'NoBooksFoundError';
    this.code = 'NO_BOOKS';
    this.dirs = dirs;
  }
}

/** A folder URI in one canonical spelling (decoded up to 3 times, no trailing slash): the "visited" key. */
function canonicalUri(uri) {
  let u = String(uri || '');
  for (let i = 0; i < 3 && /%[0-9A-F]{2}/i.test(u); i++) {
    try {
      const d = decodeURIComponent(u);
      if (d === u) break;
      u = d;
    } catch {
      break;
    }
  }
  return u.replace(/\/+$/, '');
}

/** Runs that may die on the same book / links job before it is skipped. */
const MAX_ATTEMPTS = 2;
const CRASH_MESSAGE = 'הייבוא נעצר באמצע קובץ זה פעמיים (קריסה או סגירת האפליקציה) — הקובץ דולג';

/** Attempts already made on `key` (0 when another unit, or nothing, was in flight). */
function attemptsOf(st, key) {
  return st && st.inflight_key === key ? Number(st.inflight_attempts) || 0 : 0;
}
const CLEAR_INFLIGHT = { inflight_key: null, inflight_attempts: 0 };

/** The checkpoint row; unlike indexer.readIngestionState, a failing read (dead database) throws. */
async function checkpoint(db) {
  const st = (await db.all('SELECT * FROM ingestion_state WHERE id = 1', []))[0];
  if (!st) throw new Error('ingestion checkpoint missing');
  return st;
}

const defaultYield = () => new Promise((r) => setTimeout(r, 0));

async function count(db, sql, params) {
  return Number((await db.all(sql, params || []))[0].n);
}

/** Queue totals (for progress and the checkpoint). */
async function queueCounts(db) {
  const rows = await db.all("SELECT kind, status, COUNT(*) AS n FROM import_queue GROUP BY kind, status", []);
  const out = { dirs: 0, dirsPending: 0, files: 0, filesPending: 0, filesDone: 0, filesFailed: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    if (r.kind === 'dir') {
      out.dirs += n;
      if (r.status === 'pending') out.dirsPending += n;
    } else {
      out.files += n;
      if (r.status === 'pending') out.filesPending += n;
      else if (r.status === 'done') out.filesDone += n;
      else if (r.status === 'failed') out.filesFailed += n;
    }
  }
  return out;
}

async function tx(db, fn) {
  await db.exec('BEGIN');
  try {
    const r = await fn();
    await db.exec('COMMIT');
    return r;
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

async function logError(db, relPath, e) {
  await db.run('INSERT INTO ingestion_errors (file_path, message, at) VALUES (?, ?, ?)', [relPath, indexer.errorMessage(e), indexer.nowIso()]);
}

/**
 * Starts a new run: clears the previous checkpoint / queue and seeds the queue with the source
 * (the root folder, or the picked files), in one transaction.
 */
async function seedRun(db, fsa, o) {
  const uriOf = fsa.uriOf || ((h) => String(h));
  const base = await indexer.maxId(db, 'books', o.idBase || 0);
  await tx(db, async () => {
    await db.run('DELETE FROM import_queue', []);
    await indexer.clearIngestionState(db);
    const src = o.source;
    if (src.kind === 'folder') {
      await db.run("INSERT INTO import_queue (kind, uri, rel, sort_key) VALUES ('dir', ?, '', '')", [uriOf(src.root)]);
    } else {
      const files = src.files || [];
      // Picked files: canonical order, as if they were one folder.
      const entries = indexer.sortEntries(files.map((f) => ({ name: f.name, isDir: false, handle: f.handle })));
      const books = entries.filter((e) => indexer.isBookFileName(e.name));
      await indexer.insertMany(db, 'INSERT OR IGNORE INTO import_queue (kind, uri, rel, sort_key)', 4, books, (e, i) => ['file', uriOf(e.handle), e.name, pad(i)]);
    }
    await indexer.writeIngestionState(db, {
      source_uri: String(o.sourceUri || ''),
      source_name: o.sourceName || null,
      source_kind: src.kind,
      target_db: o.targetDb || 'user',
      status: 'in_progress',
      phase: src.kind === 'folder' ? 'scan' : 'books',
      base_book_id: base,
      processed_count: 0,
      total_count: src.kind === 'folder' ? 0 : await count(db, "SELECT COUNT(*) AS n FROM import_queue WHERE kind = 'file'"),
      skipped_count: src.kind === 'folder' ? 0 : (src.files || []).filter((f) => !indexer.isBookFileName(f.name)).length,
      started_at: indexer.nowIso(),
    });
  });
}

/**
 * Scan phase: lists pending folders breadth-first, one folder per transaction.
 * @returns {Promise<StopReason|null>}
 */
async function scanPhase(db, fsa, o, report) {
  const uriOf = fsa.uriOf || ((h) => String(h));
  const fromUri = fsa.fromUri || ((u) => u);
  const skipRootDirs = o.skipRootDirs || SKIPPED_ROOT_DIRS;
  const maxDepth = o.maxScanDepth || MAX_SCAN_DEPTH;
  const noBooksAfter = o.noBooksAfterDirs || NO_BOOKS_AFTER_DIRS;
  // A folder is scanned once: every queued folder (also after a resume) is remembered by its canonical URI,
  // so a provider that lists a folder inside itself can never grow the queue without end.
  const visited = new Set((await db.all("SELECT uri FROM import_queue WHERE kind = 'dir'", [])).map((r) => canonicalUri(r.uri)));
  for (;;) {
    const stop = o.shouldStop ? o.shouldStop() : null;
    if (stop) return stop;
    const next = await db.all("SELECT id, uri, rel, sort_key FROM import_queue WHERE kind = 'dir' AND status = 'pending' ORDER BY id LIMIT 1", []);
    if (!next.length) return null;
    const dir = next[0];
    const parts = dir.rel ? dir.rel.split('/') : [];
    let entries = null;
    let listError = null;
    let order = null;
    try {
      entries = (await fsa.list(fromUri(dir.uri, true))).filter((e) => !indexer.isIgnoredEntry(e));
      const orderEntry = entries.find((e) => !e.isDir && e.name.toLowerCase() === 'order.json');
      if (orderEntry) {
        try {
          order = JSON.parse(String(await fsa.readText(orderEntry.handle)).replace(/^﻿/, ''));
        } catch {
          order = null;
        }
      }
    } catch (e) {
      listError = e;
    }
    let skipped = 0;
    let filesFound = 0;
    let progress = null;
    await tx(db, async () => {
      if (listError) {
        await db.run("UPDATE import_queue SET status = 'failed' WHERE id = ?", [dir.id]);
        await logError(db, (o.categoryPrefix || []).concat(parts).join('/') || '/', listError);
      } else {
        const rows = [];
        indexer.sortEntries(entries, order).forEach((e, i) => {
          const rel = parts.concat(e.name).join('/');
          const key = (dir.sort_key ? dir.sort_key + '.' : '') + pad(i);
          // A name with a file extension is a file whatever the platform called it (SAF).
          if (e.isDir && !indexer.looksLikeFileName(e.name)) {
            if (!parts.length && skipRootDirs.has(e.name.toLowerCase())) return;
            if (isSkippedScanDir(e.name)) return;
            if (parts.length + 1 > maxDepth) return; // too deep to be Otzaria: never entered
            const uri = uriOf(e.handle);
            const canon = canonicalUri(uri);
            if (visited.has(canon)) return; // already queued / scanned under another path
            visited.add(canon);
            rows.push(['dir', uri, rel, key]);
          } else if (indexer.isBookFileName(e.name)) {
            rows.push(['file', uriOf(e.handle), rel, key]);
            filesFound++;
          } else if (!METADATA_FILES.has(e.name.toLowerCase())) {
            skipped++; // .pdf / .docx / images / ...: never read
          }
        });
        await indexer.insertMany(db, 'INSERT OR IGNORE INTO import_queue (kind, uri, rel, sort_key)', 4, rows);
        await db.run("UPDATE import_queue SET status = 'done' WHERE id = ?", [dir.id]);
      }
      const st = await indexer.readIngestionState(db);
      progress = { dirs: Number(st.scanned_dirs || 0) + 1, files: Number(st.total_count || 0) + filesFound };
      await indexer.writeIngestionState(db, {
        phase: 'scan',
        status: 'in_progress',
        scanned_dirs: progress.dirs,
        skipped_count: Number(st.skipped_count || 0) + skipped,
        total_count: progress.files,
        error_count: await count(db, 'SELECT COUNT(*) AS n FROM ingestion_errors'),
      });
    });
    entries = null;
    // current = folders scanned, total = book files found so far.
    report('scan', progress.dirs, progress.files, parts.join('/'));
    if (progress.dirs > noBooksAfter && progress.files === 0) {
      // Nothing to resume: drop the queue and mark the run failed (not paused), then explain.
      const err = new NoBooksFoundError(progress.dirs);
      await tx(db, async () => {
        await db.run('DELETE FROM import_queue', []);
        await indexer.writeIngestionState(db, { status: 'failed', last_error: err.message });
      });
      throw err;
    }
    await o.yieldToUI();
  }
}

/** Creates every queued folder's category in canonical order (idempotent), paged. */
async function ensureCategories(db, writer, prefix) {
  await tx(db, async () => {
    if (prefix.length) await writer.ensureCategory(prefix);
    let after = '';
    for (;;) {
      const rows = await db.all("SELECT rel, sort_key FROM import_queue WHERE kind = 'dir' AND rel <> '' AND status <> 'failed' AND sort_key > ? ORDER BY sort_key LIMIT 500", [after]);
      if (!rows.length) break;
      for (const r of rows) await writer.ensureCategory(prefix.concat(r.rel.split('/')));
      after = rows[rows.length - 1].sort_key;
    }
  });
}

/**
 * Books phase: one queued book per transaction.
 * @returns {Promise<{ stopped: StopReason|null, books, paragraphs, failed, errors }>}
 */
async function booksPhase(db, fsa, o, report) {
  const fromUri = fsa.fromUri || ((u) => u);
  const prefix = o.categoryPrefix || [];
  const writer = await indexer.createBookWriter(db, { idBase: o.idBase, categoryPrefix: prefix, aliasOverrides: o.aliasOverrides, isolate: true });
  await ensureCategories(db, writer, prefix);
  const out = { stopped: null, books: 0, paragraphs: 0, failed: 0, errors: [] };
  const counts = await queueCounts(db);
  const total = counts.files;
  let done = counts.filesDone + counts.filesFailed;
  const every = Math.max(1, o.checkpointEvery || 150);
  for (;;) {
    const stop = o.shouldStop ? o.shouldStop() : null;
    if (stop) {
      out.stopped = stop;
      return out;
    }
    const next = await db.all("SELECT id, uri, rel FROM import_queue WHERE kind = 'file' AND status = 'pending' ORDER BY sort_key LIMIT 1", []);
    if (!next.length) return out;
    const row = next[0];
    const relParts = row.rel.split('/');
    const file = { name: relParts[relParts.length - 1], rel: relParts, dir: relParts.slice(0, -1) };
    const relPath = prefix.concat(relParts).join('/');
    const key = 'book:' + row.id;
    const attempts = attemptsOf(await checkpoint(db), key);
    let r;
    if (attempts >= MAX_ATTEMPTS) {
      // The app died on this book every time: skip it instead of crashing on every resume.
      r = { ok: false, error: new Error(CRASH_MESSAGE) };
      await tx(db, async () => {
        await db.run("UPDATE import_queue SET status = 'failed' WHERE id = ?", [row.id]);
        await logError(db, relPath, r.error);
        await indexer.writeIngestionState(db, Object.assign({
          phase: 'books',
          status: 'in_progress',
          processed_count: done + 1,
          total_count: total,
          last_book_path: relPath,
          error_count: await count(db, 'SELECT COUNT(*) AS n FROM ingestion_errors'),
        }, CLEAR_INFLIGHT));
      });
    } else {
      // Committed before the book starts: a kill while writing it is detected on resume.
      await tx(db, () => indexer.writeIngestionState(db, { inflight_key: key, inflight_attempts: attempts + 1 }));
      const handle = fromUri(row.uri, false);
      const source = fsa.open ? { open: () => fsa.open(handle) } : { read: () => fsa.readText(handle) };
      r = await tx(db, async () => {
        const old = await db.all('SELECT id FROM books WHERE file_path = ?', [relPath]);
        const res = await writer.write(Object.assign({ file, relPath, oldIds: old.map((x) => x.id) }, source));
        if (res.ok) await db.run("UPDATE import_queue SET status = 'done', book_id = ? WHERE id = ?", [res.id, row.id]);
        else {
          await db.run("UPDATE import_queue SET status = 'failed' WHERE id = ?", [row.id]);
          await logError(db, relPath, res.error);
        }
        await indexer.writeIngestionState(db, Object.assign({
          phase: 'books',
          status: 'in_progress',
          processed_count: done + 1,
          total_count: total,
          last_book_path: relPath,
          error_count: await count(db, 'SELECT COUNT(*) AS n FROM ingestion_errors'),
        }, CLEAR_INFLIGHT));
        return res;
      });
    }
    done++;
    if (r.ok) {
      out.books++;
      out.paragraphs += r.lines;
    } else {
      out.failed++;
      out.errors.push({ relPath, message: indexer.errorMessage(r.error) });
      if (o.onError) o.onError({ relPath, error: r.error });
    }
    report('books', done, total, r.ok ? r.title : file.name);
    // Keep the WAL bounded: fold it back into the database every `every` books.
    if (done % every === 0) await o.walCheckpoint('PASSIVE');
    await o.yieldToUI();
  }
}

/**
 * Links phase: aligns commentaries with their base books in batches of `linksPerTransaction`
 * jobs, the checkpoint cursor committed with each batch. The library is paired once per run,
 * cooperatively (yieldToUI between slices). A batch that was in flight when the app died is redone
 * one job at a time, and a single job the app died on twice is skipped and logged.
 * @returns {Promise<StopReason|null>}
 */
async function linksPhase(db, o, report, out) {
  if (!(await indexer.hasTable(db, 'ref_links'))) return null;
  const plan = await indexer.refLinkJobs(db, o.linkBookIds, o.yieldToUI);
  const total = plan.jobs.length;
  const byId = new Map(plan.books.map((b) => [b.id, b]));
  const perTx = Math.max(1, o.linksPerTransaction || 20);
  out.refLinks = { pairs: total, units: 0 };
  for (;;) {
    const stop = o.shouldStop ? o.shouldStop() : null;
    if (stop) return stop;
    const st = await checkpoint(db);
    const cursor = Math.min(total, Number(st.links_done) || 0);
    if (cursor >= total) {
      if (Number(st.links_total) !== total) await tx(db, () => indexer.writeIngestionState(db, { links_done: total, links_total: total }));
      return null;
    }
    const key = 'links:' + cursor;
    const attempts = attemptsOf(st, key);
    if (attempts >= MAX_ATTEMPTS) {
      const job = plan.jobs[cursor];
      const title = (byId.get(job.commId) || {}).title || String(job.commId);
      await tx(db, async () => {
        await logError(db, 'קישור פרשנים: ' + title, new Error(CRASH_MESSAGE));
        await indexer.writeIngestionState(db, Object.assign({ links_done: cursor + 1, links_total: total, phase: 'links' }, CLEAR_INFLIGHT));
      });
      continue;
    }
    // After a crash in this batch: redo it one job at a time, so the faulty job is isolated.
    const size = attempts ? 1 : perTx;
    await tx(db, () => indexer.writeIngestionState(db, { inflight_key: key, inflight_attempts: attempts + 1, links_total: total }));
    const r = await indexer.indexRefLinks(db, {
      plan,
      cursor,
      limit: size,
      booksPerTransaction: size,
      shouldStop: o.shouldStop,
      beforeCommit: (next, n) => indexer.writeIngestionState(db, Object.assign({ links_done: next, links_total: n, phase: 'links' }, CLEAR_INFLIGHT)),
      onBook: (b) => report('links', b.index, b.total, b.title),
    });
    out.refLinks.units += r.units;
    if (r.stopped) return r.stopped;
    await o.yieldToUI();
  }
}

/**
 * Runs (or resumes) a whole import into `db` (which already has the schema).
 *
 * @param {object} db   writer adapter { exec, run, all }
 * @param {object} fsa  file adapter { list, readText, uriOf?, fromUri? }
 * @param {object} o
 *   source           { kind: 'folder', root } | { kind: 'files', files: { name, handle }[] }
 *   sourceUri, sourceName, targetDb ('core' | 'user')
 *   idBase, categoryPrefix, aliasOverrides
 *   resume           continue the checkpoint of the same sourceUri instead of starting over
 *   shouldStop()     -> null | 'pause' | 'cancel'
 *   onProgress({ phase, current, total, detail })
 *   onError({ relPath, error })
 *   yieldToUI()      awaited after every folder / book / link batch (default: setTimeout 0)
 *   walCheckpoint(mode)  default: PRAGMA wal_checkpoint(mode); errors are always ignored
 *   checkpointEvery  books between PASSIVE WAL checkpoints (default 150)
 *   linksPerTransaction  commentary books per links transaction (default 20)
 *   finalize         false to skip the optimizations; or { analyze, analysisLimit, mergePages, maxSteps }
 *   onWarning({ step, message })  a non-fatal finalize sub-step failed (the import still completes)
 * @returns {Promise<{ stopped, phase, books, paragraphs, failed, skippedFiles, errors, refLinks: { pairs, units }, warnings }>}
 */
async function runImport(db, fsa, opts) {
  const o = Object.assign({}, opts);
  o.yieldToUI = o.yieldToUI || defaultYield;
  // A WAL checkpoint only bounds the WAL file: it is never allowed to fail an import (a busy
  // reader or a transient lock just leaves the frames for the next one).
  const checkpointWal = o.walCheckpoint || ((mode) => db.all(`PRAGMA wal_checkpoint(${mode})`, []));
  o.walCheckpoint = async (mode) => {
    try {
      await checkpointWal(mode);
    } catch {
      // not in WAL mode / busy reader: harmless
    }
  };
  const report = (phase, current, total, detail) => {
    if (o.onProgress) o.onProgress({ phase, current, total, detail });
  };

  const warnings = [];
  const warn = (w) => {
    warnings.push(w);
    if (o.onWarning) o.onWarning(w);
  };

  let st = await indexer.readIngestionState(db);
  if (o.resume && coreFinalize.isReadyToInstall(st)) {
    // A finished build waiting only for its install: nothing left to import (never re-seed it).
    return { stopped: null, phase: 'done', books: 0, paragraphs: 0, failed: Number(st.error_count) || 0, skippedFiles: Number(st.skipped_count) || 0, errors: (await indexer.readIngestionErrors(db, 1000)).map((e) => ({ relPath: e.file_path, message: e.message })), refLinks: { pairs: 0, units: 0 }, warnings };
  }
  const resume = !!o.resume && indexer.isResumableState(st) && (st.source_kind === o.source.kind);
  if (!resume) {
    await seedRun(db, fsa, o);
    st = await indexer.readIngestionState(db);
  } else {
    await tx(db, async () => {
      const newUri = String(o.sourceUri || st.source_uri);
      if (o.source.kind === 'folder' && st.source_uri && newUri !== st.source_uri) {
        // The same folder re-picked after a restart under another URI: re-base the queued URIs.
        await db.run('UPDATE import_queue SET uri = ? || substr(uri, ?) WHERE substr(uri, 1, ?) = ?', [newUri, st.source_uri.length + 1, st.source_uri.length, st.source_uri]);
      }
      await indexer.writeIngestionState(db, { status: 'in_progress', source_uri: newUri });
    });
  }
  const out = { stopped: null, phase: st.phase, books: 0, paragraphs: 0, failed: 0, skippedFiles: 0, errors: [], refLinks: { pairs: 0, units: 0 }, warnings };
  const pause = async (stop) => {
    out.stopped = stop;
    // A clean stop: nothing is in flight any more.
    await tx(db, () => indexer.writeIngestionState(db, Object.assign({ status: 'paused' }, CLEAR_INFLIGHT)));
    return out;
  };
  const setPhase = (phase, extra) => tx(db, () => indexer.writeIngestionState(db, Object.assign({ phase, status: 'in_progress' }, extra || {})));
  let phase = PHASES.includes(st.phase) ? st.phase : 'books';

  if (phase === 'scan') {
    const stop = await scanPhase(db, fsa, o, report);
    if (stop) return pause(stop);
    const c = await queueCounts(db);
    await setPhase('books', { total_count: c.files });
    phase = 'books';
  }
  if (phase === 'books') {
    const r = await booksPhase(db, fsa, o, report);
    Object.assign(out, { books: r.books, paragraphs: r.paragraphs, failed: r.failed, errors: r.errors });
    if (r.stopped) return pause(r.stopped);
    await o.walCheckpoint('TRUNCATE');
    await setPhase('links', { links_done: 0, links_total: 0 });
    phase = 'links';
  }
  if (phase === 'links') {
    const r = await linksPhase(db, o, report, out);
    if (r) return pause(r);
    await o.walCheckpoint('TRUNCATE');
    await setPhase('finalize');
    phase = 'finalize';
  }
  if (o.finalize !== false) {
    // Optional optimizations only: each sub-step is non-fatal (a busy / locked FTS merge or
    // ANALYZE logs a warning and the import still completes), and none of them is VACUUM.
    report('finalize', null, null, null);
    const f = typeof o.finalize === 'object' ? o.finalize : {};
    const stop = await coreFinalize.optimizeIndex(db, Object.assign({ incremental: true }, f, {
      shouldStop: o.shouldStop,
      warn,
      onStep: async (step) => {
        report('finalize', step, null, null);
        await o.walCheckpoint('PASSIVE');
        await o.yieldToUI();
      },
    }));
    if (stop) return pause(stop);
  }
  // Done: the queue has served its purpose; the checkpoint is completed by the caller
  // (together with its own meta rows) via completeImport().
  const fin = await indexer.readIngestionState(db);
  out.skippedFiles = Number(fin.skipped_count) || 0;
  out.errors = (await indexer.readIngestionErrors(db, 1000)).map((e) => ({ relPath: e.file_path, message: e.message }));
  out.failed = Number(fin.error_count) || out.failed;
  out.phase = 'done';
  await o.walCheckpoint('TRUNCATE');
  return out;
}

/** Marks a finished run completed and empties its queue (one transaction). */
async function completeImport(db) {
  await tx(db, async () => {
    await db.run('DELETE FROM import_queue', []);
    await indexer.writeIngestionState(db, { status: 'completed' });
  });
}

module.exports = { runImport, completeImport, queueCounts, PHASES, SKIPPED_ROOT_DIRS, MAX_ATTEMPTS, CRASH_MESSAGE, MAX_SCAN_DEPTH, NO_BOOKS_AFTER_DIRS, NoBooksFoundError, canonicalUri, isSkippedScanDir };
