#!/usr/bin/env node
/**
 * Cloud-release helpers of .github/workflows/build-library.yml (and scripts/selftest.js).
 *
 *   node scripts/cloud-release.js validate --db=core_library.db --stats=stats.json
 *       PRAGMA integrity_check; books, paragraphs, paragraphs_fts (shadow rows + a real MATCH) and
 *       ref_links must all be non-empty. Writes { version, builtAt, bookCount, paragraphCount,
 *       refLinkCount, uncompressedDbBytes } to --stats.
 *
 *   node scripts/cloud-release.js manifest --stats=stats.json --parts-dir=dist \
 *       --source-repo=Sivan22/otzaria-library --scope=all --out=dist/library-manifest.json
 *       Hashes every core_library.db.zip.part-NN (and, streaming over them in order, the whole zip)
 *       and writes library-manifest.json:
 *       { sourceRepo, scope, releaseTag, version, builtAt, bookCount, paragraphCount, uncompressedDbBytes,
 *         totalZipBytes, fullZipSha256, parts: [{ name, sizeBytes, sha256 }],
 *         extended: { bookCount, paragraphCount, uncompressedDbBytes, totalZipBytes, fullZipSha256, parts } }
 *       (top level = the core package, `extended` = the optional expansion pack; --extended-stats / --extended-parts-dir)
 *
 * The zip itself is never needed here (and is already deleted by then): its hash is the hash of the
 * concatenated parts.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateCloudManifest, MAX_PART_BYTES, CLOUD_MANIFEST_NAME } = require('../shared/multipart');
const { openDb } = require('./build-db');
const releases = require('../shared/libraryRelease');


/** Integrity + non-emptiness checks of a finished core library. Returns the stats; throws on failure. */
function validateDb(file) {
  if (!fs.existsSync(file)) throw new Error(`database not found: ${file}`);
  const db = openDb(file);
  try {
    const one = (sql) => db.prepare(sql).get();
    const check = db.prepare('PRAGMA integrity_check').all();
    const verdict = check.map((r) => Object.values(r)[0]);
    if (verdict.length !== 1 || verdict[0] !== 'ok') throw new Error(`integrity_check failed: ${verdict.slice(0, 5).join('; ')}`);

    const count = (table) => Number(Object.values(one(`SELECT COUNT(*) AS n FROM ${table}`))[0]);
    const books = count('books');
    const paragraphs = count('paragraphs');
    const refLinks = count('ref_links');
    if (!books) throw new Error('books is empty');
    if (!paragraphs) throw new Error('paragraphs is empty');
    if (!refLinks) throw new Error('ref_links is empty (no commentary was aligned)');
    // paragraphs_fts is external-content: its own rows live in the shadow tables. Check them, then a
    // real MATCH on a word taken from the first paragraph.
    const ftsRows = count('paragraphs_fts_docsize');
    if (!ftsRows) throw new Error('paragraphs_fts is empty (no indexed rows)');
    const firstLine = one("SELECT clean_text FROM paragraphs WHERE length(clean_text) > 3 ORDER BY id LIMIT 1");
    const word = firstLine && String(firstLine.clean_text).split(/\s+/).find((w) => /^[\p{L}\d]+$/u.test(w));
    if (!word) throw new Error('could not pick a probe word for the FTS check');
    const hit = db.prepare('SELECT rowid FROM paragraphs_fts WHERE paragraphs_fts MATCH ? LIMIT 1').get(`"${word}"`);
    if (!hit) throw new Error(`paragraphs_fts MATCH "${word}" found nothing`);

    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    if (!meta.db_version) throw new Error('meta.db_version is missing');
    return {
      version: meta.db_version,
      builtAt: meta.built_at || new Date().toISOString(),
      bookCount: books,
      paragraphCount: paragraphs,
      refLinkCount: refLinks,
      uncompressedDbBytes: fs.statSync(file).size,
    };
  } finally {
    db.close();
  }
}

/** SHA-256 of one or more files, streamed in order (one digest over their concatenation). */
async function sha256Files(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    await new Promise((resolve, reject) => {
      fs.createReadStream(f).on('data', (c) => h.update(c)).on('error', reject).on('end', resolve);
    });
  }
  return h.digest('hex');
}

const PART_RES = { core: /^core_library\.db\.zip\.part-(\d{2,})$/, extended: /^extended_library\.db\.zip\.part-(\d{2,})$/ };

/** The numbers of one package (core or extended): its parts with SHA-256 + the hash of the whole zip. */
async function buildPackage(kind, stats, partsDir) {
  const names = fs
    .readdirSync(partsDir)
    .filter((n) => PART_RES[kind].test(n))
    .sort();
  if (!names.length) throw new Error(`no ${kind}_library.db.zip.part-NN files in ${partsDir}`);
  const parts = [];
  for (const name of names) {
    const file = path.join(partsDir, name);
    const sizeBytes = fs.statSync(file).size;
    if (sizeBytes >= MAX_PART_BYTES) throw new Error(`${name} is ${sizeBytes} bytes: GitHub Releases rejects files of 2 GB and more`);
    parts.push({ name, sizeBytes, sha256: await sha256Files([file]) });
  }
  return {
    bookCount: stats.bookCount,
    paragraphCount: stats.paragraphCount,
    uncompressedDbBytes: stats.uncompressedDbBytes,
    totalZipBytes: parts.reduce((a, p) => a + p.sizeBytes, 0),
    fullZipSha256: await sha256Files(names.map((n) => path.join(partsDir, n))),
    parts,
  };
}

/**
 * library-manifest.json content. The top-level numbers / parts describe the core package (so an app that knows only one
 * database still reads a valid manifest); `extended` describes the expansion pack with its own parts and SHA-256s.
 */
async function buildManifest({ stats, partsDir, extended, sourceRepo, scope }) {
  if (scope && scope !== releases.LIBRARY_SCOPE) throw new Error(`the cloud library is built with scope ${releases.LIBRARY_SCOPE}, not ${scope}`);
  if (extended && extended.stats.version !== stats.version) throw new Error(`core (${stats.version}) and extended (${extended.stats.version}) come from different builds`);
  const manifest = {
    sourceRepo,
    scope: scope || releases.LIBRARY_SCOPE,
    releaseTag: releases.LIBRARY_TAG,
    version: stats.version,
    builtAt: stats.builtAt,
    ...(await buildPackage('core', stats, partsDir)),
    ...(extended ? { extended: await buildPackage('extended', extended.stats, extended.partsDir) } : {}),
  };
  validateCloudManifest(manifest); // numbering, sizes add up, hashes well-formed
  return manifest;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  if (cmd === 'validate') {
    const stats = validateDb(path.resolve(args.db));
    if (args.stats) fs.writeFileSync(path.resolve(args.stats), JSON.stringify(stats, null, 2) + '\n');
    console.log(`[cloud-release] OK: ${stats.bookCount} books, ${stats.paragraphCount} paragraphs, ${stats.refLinkCount} ref links, ${(stats.uncompressedDbBytes / 1024 / 1024).toFixed(0)} MB`);
  } else if (cmd === 'manifest') {
    const stats = JSON.parse(fs.readFileSync(path.resolve(args.stats), 'utf8'));
    const extended = args['extended-stats'] ? { stats: JSON.parse(fs.readFileSync(path.resolve(args['extended-stats']), 'utf8')), partsDir: path.resolve(args['extended-parts-dir']) } : null;
    const manifest = await buildManifest({ stats, partsDir: path.resolve(args['parts-dir']), extended, sourceRepo: args['source-repo'], scope: args.scope });
    const out = path.resolve(args.out || path.join(args['parts-dir'], CLOUD_MANIFEST_NAME));
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`[cloud-release] ${path.basename(out)}: core ${manifest.parts.length} part(s) ${(manifest.totalZipBytes / 1024 / 1024).toFixed(0)} MB${manifest.extended ? `, extended ${manifest.extended.parts.length} part(s) ${(manifest.extended.totalZipBytes / 1024 / 1024).toFixed(0)} MB` : ''}, version ${manifest.version}`);
  } else {
    console.error('usage: cloud-release.js validate --db=<file> --stats=<json> | manifest --stats=<json> --parts-dir=<dir> [--extended-stats=<json> --extended-parts-dir=<dir>] --source-repo=<o/r> [--scope=all] [--out=<file>]');
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[cloud-release] FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { validateDb, buildManifest, sha256Files };
