#!/usr/bin/env node
/**
 * Build-time ingestion: Otzaria folders -> core library DB (SQLite + FTS5), plus an
 * optional compressed release artifact for GitHub Releases.
 *
 *   node scripts/build-db.js --source=sample        # raw_library/sample (tracked in git)
 *   node scripts/build-db.js --source=full          # raw_library/full   (git-ignored)
 *   node scripts/build-db.js --source=sample --if-missing   # no-op when the DB already exists
 *   node scripts/build-db.js --source=full --release        # + dist/core_library.db.gz + dist/manifest.json
 *
 * Options:
 *   --out=<path>        output DB (default assets/db/library.db; used by the web preview and
 *                       the self-tests. The APK does NOT bundle it any more: the app downloads
 *                       the release artifact, or indexes books on the device.)
 *   --links=<dir>       LEGACY explicit link files (CSV / Otzaria JSON). The real library has
 *                       none: commentaries are linked from folder paths, file names and
 *                       headings (book_units -> ref_links). Default: raw_links/sample for
 *                       --source=sample only (a regression fixture for the `links` table);
 *                       none for full / custom folders, so no link I/O happens at all.
 *   --release[=<dir>]   also write <dir>/core_library.db.gz and <dir>/manifest.json
 *                       (default dir: dist/). Upload both files to a GitHub Release.
 *   --release-url=<url> absolute download URL of the .gz to put in the manifest (optional;
 *                       by default the app resolves "file" relative to the manifest URL)
 *   --scope=<name>      classical_full | all. Walks the books of an Otzaria checkout (the `אוצריא`
 *                       folder is found below --source) and drops the `links/` folder; classical_full
 *                       also drops every `מחברי זמננו` (contemporary authors) folder. Used by the
 *                       cloud build (.github/workflows/build-library.yml).
 *   --lean              strip the ingestion-only tables (book_units, import_queue) before VACUUM, as
 *                       --release does, but without writing the .gz (the cloud build zips and splits
 *                       the DB itself: scripts/cloud-release.js).
 *
 * The parsing / indexing logic lives in shared/indexer.js and is the same code the app
 * runs on the device (src/services/localIndexer.ts).
 *
 * Requires Node >= 22.13 (built-in `node:sqlite`, which ships with FTS5). If
 * `better-sqlite3` is installed it is used as a fallback on older Node versions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const indexer = require('../shared/indexer');
const { aliasKey } = require('../shared/hebrew');
const libraryScope = require('../shared/libraryScope');

const { SCHEMA_VERSION } = indexer;
const ROOT = path.resolve(__dirname, '..');
const RELEASE_DB_NAME = 'core_library.db';
const MANIFEST_FORMAT = 1;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { source: 'sample', out: path.join(ROOT, 'assets/db/library.db'), links: undefined, ifMissing: false, release: null, releaseUrl: null, scope: null, lean: false };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'source') args.source = v;
    else if (k === 'out') args.out = path.resolve(v);
    else if (k === 'links') args.links = path.resolve(v);
    else if (k === 'if-missing') args.ifMissing = true;
    else if (k === 'release') args.release = path.resolve(v || path.join(ROOT, 'dist'));
    else if (k === 'release-url') args.releaseUrl = v;
    else if (k === 'scope') args.scope = libraryScope.assertScope(v);
    else if (k === 'lean') args.lean = true;
    else if (k === 'help') args.help = true;
    else throw new Error(`Unknown option --${k}`);
  }
  if (!['sample', 'full'].includes(args.source) && !fs.existsSync(path.resolve(args.source))) {
    throw new Error(`--source must be "sample", "full" or a folder path (got "${args.source}")`);
  }
  const named = ['sample', 'full'].includes(args.source);
  args.sourceDir = named ? path.join(ROOT, 'raw_library', args.source) : path.resolve(args.source);
  // Explicit link files are a legacy input kept only for the sample fixture.
  if (args.links === undefined) args.links = args.source === 'sample' ? path.join(ROOT, 'raw_links', 'sample') : null;
  return args;
}

// ---------------------------------------------------------------------------
// SQLite driver (node:sqlite, or better-sqlite3 as fallback) + async adapters
// ---------------------------------------------------------------------------
function openDb(file) {
  try {
    // Silence the one-line ExperimentalWarning printed by some Node 22 builds.
    const origEmit = process.emitWarning;
    process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...rest));
    const { DatabaseSync } = require('node:sqlite');
    process.emitWarning = origEmit;
    return new DatabaseSync(file);
  } catch (e) {
    try {
      const Better = require('better-sqlite3');
      return new Better(file);
    } catch {
      throw new Error('No SQLite driver: use Node >= 22.13 (node:sqlite) or `npm i -D better-sqlite3`.\n' + e.message);
    }
  }
}

/** shared/indexer.js writer adapter over a synchronous node:sqlite connection. */
function writerAdapter(db) {
  const stmts = new Map();
  const prep = (sql) => {
    let st = stmts.get(sql);
    if (!st) {
      st = db.prepare(sql);
      if (stmts.size > 64) stmts.clear();
      stmts.set(sql, st);
    }
    return st;
  };
  return {
    exec: async (sql) => db.exec(sql),
    run: async (sql, params) => prep(sql).run(...params),
    all: async (sql, params) => prep(sql).all(...params),
  };
}

/** shared/indexer.js file adapter over node fs (handles are absolute paths). */
const nodeFs = {
  list: async (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isFile())
      .map((e) => ({ name: e.name, isDir: e.isDirectory(), handle: path.join(dir, e.name) })),
  readText: async (file) => fs.readFileSync(file, 'utf8'),
};

function loadAliasOverrides(sourceDir) {
  const objs = [];
  for (const f of [path.join(ROOT, 'raw_library', 'aliases.json'), path.join(sourceDir, 'aliases.json')]) {
    if (fs.existsSync(f)) objs.push(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')));
  }
  return indexer.mergeAliasOverrides(objs);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const MAX_LISTED_UNMATCHED = 40;

function reportLinks(stats, linksDir) {
  if (!linksDir) console.log('[build-db] links: path + heading alignment only (no link files)');
  else if (!fs.existsSync(linksDir)) console.log(`[build-db] links: ${path.relative(ROOT, linksDir) || linksDir} not found, building without commentaries`);
  else {
    console.log(`[build-db] links: ${stats.files} file(s), ${stats.parsed} parsed, ${stats.kept} stored (${stats.duplicates} duplicate/reverse, ${stats.outOfRange} pointing at missing lines, ${stats.invalid} malformed)`);
  }
  if (stats.outOfRange) console.warn(`[build-db] WARNING: ${stats.outOfRange} link(s) point at a line that is not a paragraph of its book (dropped).`);
  const { unmatched } = stats;
  if (unmatched.size) {
    const total = [...unmatched.values()].reduce((x, y) => x + y, 0);
    console.warn(`[build-db] WARNING: ${unmatched.size} unmatched book name(s) in links (${total} link(s) skipped):`);
    const sorted = [...unmatched].sort((x, y) => y[1] - x[1]);
    for (const [n, c] of sorted.slice(0, MAX_LISTED_UNMATCHED)) console.warn(`   - "${n}" (${c} link${c > 1 ? 's' : ''})`);
    if (sorted.length > MAX_LISTED_UNMATCHED) console.warn(`   ... and ${sorted.length - MAX_LISTED_UNMATCHED} more`);
  }
}

function reportAmbiguousAliases(db) {
  const rows = db.prepare('SELECT title, aliases FROM books').all();
  const owners = new Map();
  for (const r of rows) for (const a of String(r.aliases).split('|').filter(Boolean)) owners.set(a, (owners.get(a) || []).concat(r.title));
  const ambiguous = [...owners].filter(([, v]) => v.length > 1);
  if (ambiguous.length) {
    console.log(`[build-db] note: ${ambiguous.length} alias(es) shared by several books (Quick Jump shows all matches), e.g.:`);
    for (const [a, v] of ambiguous.slice(0, 8)) console.log(`   - "${a}": ${v.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Release artifact (GitHub Releases)
// ---------------------------------------------------------------------------
async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/**
 * dist/core_library.db.gz + dist/manifest.json. The app (src/services/coreLibrary.ts)
 * downloads the manifest, then the .gz; it checks size + SHA-256 of the download, the
 * decompressed size, and meta.db_version of the result before swapping it in.
 */
async function writeRelease(args, dbFile, meta) {
  fs.mkdirSync(args.release, { recursive: true });
  const gzName = RELEASE_DB_NAME + '.gz';
  const gzPath = path.join(args.release, gzName);
  const tmp = gzPath + '.tmp';
  await pipeline(fs.createReadStream(dbFile), zlib.createGzip({ level: 9 }), fs.createWriteStream(tmp));
  fs.renameSync(tmp, gzPath);
  const manifest = {
    format: MANIFEST_FORMAT,
    name: 'kodeshRead core library',
    version: meta.version,
    schemaVersion: SCHEMA_VERSION,
    builtAt: meta.builtAt,
    source: meta.source,
    books: meta.books,
    categories: meta.categories,
    paragraphs: meta.paragraphs,
    links: meta.links,
    tocNodes: meta.tocNodes,
    file: gzName,
    ...(args.releaseUrl ? { url: args.releaseUrl } : {}),
    compression: 'gzip',
    size: fs.statSync(gzPath).size,
    sha256: await sha256File(gzPath),
    dbSize: fs.statSync(dbFile).size,
    dbSha256: await sha256File(dbFile),
  };
  fs.writeFileSync(path.join(args.release, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(`[build-db] release: ${path.relative(ROOT, gzPath)} (${mb(manifest.size)} MB, from ${mb(manifest.dbSize)} MB), sha256=${manifest.sha256.slice(0, 16)}…`);
  console.log(`[build-db] release: ${path.relative(ROOT, path.join(args.release, 'manifest.json'))} (version ${manifest.version})`);
  return manifest;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  const versionFile = path.join(path.dirname(args.out), 'db-version.json');
  if (args.ifMissing && fs.existsSync(args.out) && fs.existsSync(versionFile)) {
    console.log(`[build-db] ${path.relative(ROOT, args.out)} exists, skipping (--if-missing).`);
    return;
  }
  if (!fs.existsSync(args.sourceDir)) throw new Error(`Source folder not found: ${args.sourceDir}`);

  const t0 = Date.now();
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const tmp = args.out + '.tmp';
  for (const f of [tmp, tmp + '-journal', tmp + '-wal', tmp + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

  const raw = openDb(tmp);
  raw.exec('PRAGMA page_size = 4096; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;');
  const db = writerAdapter(raw);
  await indexer.ensureSchema(db, { kind: 'core' });

  const overrides = loadAliasOverrides(args.sourceDir);
  const hash = crypto.createHash('sha1').update(`v${SCHEMA_VERSION}|${args.source}|${args.scope || ''}|`);
  for (const f of ['shared/hebrew.js', 'shared/indexer.js', 'shared/refAlign.js', 'shared/pairing.js']) hash.update(fs.readFileSync(path.join(ROOT, f)));
  hash.update(fs.readFileSync(__filename));
  hash.update(JSON.stringify(overrides));

  // Cloud builds: walk only the books folder, minus the folders the scope leaves out.
  let fsa = nodeFs;
  let booksDir = args.sourceDir;
  if (args.scope) {
    booksDir = libraryScope.findBooksRoot(fs, path, args.sourceDir);
    fsa = libraryScope.scopedFs(nodeFs, args.scope);
    console.log(`[build-db] scope ${args.scope}: books folder ${path.relative(args.sourceDir, booksDir) || '.'}`);
  }
  const tree = await indexer.scanBooks(fsa, booksDir);
  if (args.scope) console.log(`[build-db] scope ${args.scope}: ${fsa.stats.excluded} folder(s) left out (${[...fsa.stats.excludedNames].slice(0, 8).join(', ') || 'none'}), ${tree.files.length} book file(s) kept`);
  const bookStats = await indexer.indexBooks(db, fsa, {
    files: tree.files,
    dirs: tree.dirs,
    idBase: 0,
    aliasOverrides: overrides,
    booksPerTransaction: Number.MAX_SAFE_INTEGER, // one transaction: fastest on the PC
    onFileRead: (rel, text) => hash.update(rel).update(text),
    onBook: (b) => console.log(`[build-db] ${b.relPath}: ${b.lines} lines, ${b.tocNodes} TOC nodes`),
  });

  // Legacy explicit links: staged, de-duplicated and validated against real paragraph lines.
  const linkFiles = args.links && fs.existsSync(args.links) ? await indexer.scanLinkFiles(nodeFs, args.links) : [];
  const linkStats = await indexer.indexLinks(db, nodeFs, linkFiles, {
    onFileRead: (f, text) => hash.update(f.rel.join('/')).update(text),
    onError: (f, e) => console.warn(`[build-db] WARNING: could not parse ${f.rel.join('/')}: ${e.message}`),
  });
  reportLinks(linkStats, args.links);
  // Otzaria reference alignment: commentary units <-> base units by canonical heading path.
  const refStats = await indexer.indexRefLinks(db, { booksPerTransaction: Number.MAX_SAFE_INTEGER });
  console.log(`[build-db] ref links: ${refStats.pairs} commentary/base pair(s), ${refStats.units} aligned unit(s)`);
  reportAmbiguousAliases(raw);

  await indexer.finalizeIndex(db, { analyze: true });
  const counts = await indexer.libraryCounts(db);

  const version = hash.digest('hex').slice(0, 12);
  const builtAt = new Date().toISOString();
  await indexer.writeMeta(db, {
    kind: 'core',
    db_version: version,
    built_at: builtAt,
    source: args.source === 'sample' || args.source === 'full' ? args.source : path.basename(args.sourceDir),
    script_version: SCHEMA_VERSION,
    books: counts.books,
    categories: counts.categories,
    paragraphs: counts.paragraphs,
    links: counts.links,
    toc_nodes: counts.tocNodes,
  });
  // book_units / import_queue only serve ingestion: the downloadable release ships without them.
  if (args.release || args.lean) raw.exec('DELETE FROM book_units; DELETE FROM import_queue;');
  raw.exec('PRAGMA optimize; VACUUM;');
  raw.close();

  for (const f of [args.out, args.out + '-journal', args.out + '-wal', args.out + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
  fs.renameSync(tmp, args.out);
  const meta = { version, builtAt, source: args.source, ...counts };
  fs.writeFileSync(versionFile, JSON.stringify({ version, builtAt, source: args.source, books: counts.books, paragraphs: counts.paragraphs }, null, 2) + '\n');

  const size = (fs.statSync(args.out).size / 1024 / 1024).toFixed(2);
  console.log(`[build-db] done: ${counts.books} books, ${counts.categories} categories, ${counts.paragraphs} paragraphs, ${counts.links} links, ${counts.tocNodes} TOC nodes`);
  console.log(`[build-db] ${path.relative(ROOT, args.out)} (${size} MB), DB_VERSION=${version}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (bookStats.books !== counts.books) console.warn(`[build-db] WARNING: indexed ${bookStats.books} files but the DB holds ${counts.books} books (duplicate file paths?)`);

  if (args.release) await writeRelease(args, args.out, meta);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[build-db] FAILED:', e.message);
    process.exit(1);
  });
}

// Re-exported for scripts/selftest.js and older imports.
module.exports = {
  parseBook: indexer.parseBook,
  sanitizeDisplay: indexer.sanitizeDisplay,
  makeBookMatcher: indexer.makeBookMatcher,
  linkBookKey: indexer.linkBookKey,
  aliasKey,
  writerAdapter,
  nodeFs,
  openDb,
  RELEASE_DB_NAME,
};
