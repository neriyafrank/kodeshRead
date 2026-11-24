#!/usr/bin/env node
/**
 * Exports the cloud starter packs from a freshly built core_library.db
 * (.github/workflows/build-library.yml, before the database is deleted; scripts/selftest.js).
 *
 *   node scripts/export-starter-packs.js --db=core_library.db --out=dist/starter
 *
 * For every curated book (shared/starterPacks.js STARTER_BOOKS) that is actually in the database
 * (missing ones are skipped with a note) it writes `starter-<slug>.json.gz`: the base book, its
 * primary commentaries (רש"י / אונקלוס / תוספות where present), their TOC and paragraphs and the
 * exact ref_links between them (Bavli `שורה N` paragraph links included). Then
 * `starter-catalog.json` lists the packs in canonical catalog order with size and SHA-256.
 * Every pack is read back (gunzip + validate) before the catalog is written.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const sp = require('../shared/starterPacks');

/** Node built-ins only (CI has no node_modules). Level 9 + zlib's gzip header (mtime 0) = deterministic. */
const codec = {
  gzipSync: (u8) => zlib.gzipSync(u8, { level: 9 }),
  gunzipSync: (u8) => zlib.gunzipSync(u8),
};
const { openDb, writerAdapter } = require('./build-db');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

/**
 * @returns {Promise<{ catalog, packs: { slug, file, bytes, sha256, counts }[], skipped: string[] }>}
 */
async function exportStarterPacks({ dbFile, outDir, log = () => undefined }) {
  if (!fs.existsSync(dbFile)) throw new Error(`database not found: ${dbFile}`);
  const raw = openDb(dbFile);
  try {
    const db = writerAdapter(raw);
    const metaRows = await db.all('SELECT key, value FROM meta', []);
    const m = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
    const meta = { dbVersion: m.db_version || null, builtAt: m.built_at || new Date().toISOString() };
    const data = {
      categories: await db.all('SELECT id, parent_id, name, path FROM categories ORDER BY id', []),
      books: await db.all('SELECT id, category_id, title, aliases, total_lines FROM books ORDER BY id', []),
    };
    const selection = sp.selectStarterBooks(data);
    const found = new Set(selection.map((s) => s.spec.slug));
    const skipped = sp.STARTER_BOOKS.filter((b) => !found.has(b.slug)).map((b) => b.slug);
    for (const s of skipped) log(`skipped (not in this library): ${s}`);

    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (/^starter-.*\.json\.gz$/.test(f) || f === sp.STARTER_CATALOG_NAME) fs.rmSync(path.join(outDir, f));

    const items = [];
    for (const sel of selection) {
      const pack = await sp.buildStarterPack(db, sel, meta);
      const bytes = sp.packToBytes(pack, codec);
      // Read it back exactly like the app will: gunzip + validate + same counts.
      const back = sp.decodePack(bytes, codec);
      if (back.counts.paragraphs !== pack.counts.paragraphs || back.paragraphs.length !== pack.paragraphs.length) throw new Error(`${sel.spec.slug}: pack does not read back`);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const file = path.join(outDir, sp.packFileName(sel.spec.slug));
      fs.writeFileSync(file, bytes);
      items.push({ sel, pack, bytes, sha256, file });
      log(`${sp.packFileName(sel.spec.slug)}: ${(bytes.length / 1024).toFixed(0)} KB, ${pack.counts.books} book(s) [${sel.commentaries.map((c) => c.name).join(', ') || 'no commentary'}], ${pack.counts.paragraphs} paragraphs, ${pack.counts.refLinks} ref_links`);
    }
    const catalog = sp.buildStarterCatalog(items, meta);
    fs.writeFileSync(path.join(outDir, sp.STARTER_CATALOG_NAME), JSON.stringify(catalog, null, 2) + '\n');
    return { catalog, packs: items.map((i) => ({ slug: i.sel.spec.slug, file: i.file, bytes: i.bytes, sha256: i.sha256, counts: i.pack.counts })), skipped };
  } finally {
    raw.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.out) {
    console.error('usage: export-starter-packs.js --db=<core_library.db> --out=<dir> [--min=<n>]');
    process.exit(2);
  }
  const min = Number(args.min || 1);
  const res = await exportStarterPacks({ dbFile: path.resolve(args.db), outDir: path.resolve(args.out), log: (m) => console.log(`[starter] ${m}`) });
  if (res.packs.length < min) throw new Error(`only ${res.packs.length} starter pack(s) found (expected at least ${min})`);
  const total = res.packs.reduce((a, p) => a + p.bytes.length, 0);
  console.log(`[starter] ${res.packs.length} pack(s), ${(total / 1024 / 1024).toFixed(2)} MB, catalog version ${res.catalog.version}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[starter] FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { exportStarterPacks };
