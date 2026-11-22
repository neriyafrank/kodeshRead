#!/usr/bin/env node
/**
 * Makes sure assets/db/library.db matches the build profile before the native build
 * bundles it. Runs as the `eas-build-post-install` npm hook on EAS (cloud or --local)
 * and before local release builds (`npm run apk:sample` / `npm run apk:full`).
 *
 *   LIBRARY_SOURCE=sample  (eas.json "preview")       -> always rebuild from raw_library/sample
 *   LIBRARY_SOURCE=full    (eas.json "preview-full",  -> use the DB pre-built on your PC with
 *                           "production")                `npm run db:full` (raw_library/full is
 *                                                         never uploaded); fail if it is missing
 *                                                         or was built from another source
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'assets/db/library.db');
const VERSION = path.join(ROOT, 'assets/db/db-version.json');
const source = (process.argv.find((a) => a.startsWith('--source=')) || '').slice(9) || process.env.LIBRARY_SOURCE || 'sample';

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(VERSION, 'utf8'));
  } catch {
    return null;
  }
}

if (source === 'sample') {
  execFileSync(process.execPath, [path.join(__dirname, 'build-db.js'), '--source=sample'], { stdio: 'inherit' });
} else if (source === 'full') {
  const v = readVersion();
  if (!fs.existsSync(DB) || !v) {
    if (fs.existsSync(path.join(ROOT, 'raw_library/full')) && fs.readdirSync(path.join(ROOT, 'raw_library/full')).some((n) => !n.startsWith('.'))) {
      execFileSync(process.execPath, [path.join(__dirname, 'build-db.js'), '--source=full'], { stdio: 'inherit' });
    } else {
      console.error('[eas-build-db] LIBRARY_SOURCE=full but assets/db/library.db is missing.\n  Run `npm run db:full` on your PC first (see README, "Full library APK").');
      process.exit(1);
    }
  } else if (v.source !== 'full') {
    console.error(`[eas-build-db] LIBRARY_SOURCE=full but the bundled DB was built from "${v.source}". Run \`npm run db:full\` first.`);
    process.exit(1);
  }
} else {
  console.error(`[eas-build-db] unknown LIBRARY_SOURCE "${source}" (expected sample | full)`);
  process.exit(1);
}

const v = readVersion();
const mb = (fs.statSync(DB).size / 1024 / 1024).toFixed(1);
console.log(`[eas-build-db] bundling ${v.source} library: ${v.books} books, ${v.paragraphs} paragraphs, ${mb} MB, DB_VERSION=${v.version}`);
