#!/usr/bin/env node
/**
 * Audit of the parallel-works families and the canonical book roles against a library map
 * (default: otzaria_index_only.txt, one "./folder/.../title.txt" path per line).
 *
 *   node scripts/audit-parallels.js [--index=PATH | --db=core_library.db] [--json] [--list]
 *
 * --db audits a built library database (its categories.path + books.title), as the cloud library
 * workflow does right after indexing (.github/workflows/build-library.yml).
 * Prints the exact books matched per family / work (shared/parallelWorks.js) and verifies:
 *   - every member is classified as a standalone parallel work by the catalog (shared/bookRoles.js),
 *     never a commentary / targum, and no member is nested under another book;
 *   - no commentary leaks into a family ("X על Y" titles, books in a "מפרשים" folder);
 *   - the strict exclusions (קיצור שולחן ערוך, חיי אדם, חכמת אדם, בן איש חי, ערוך השולחן העתיד,
 *     ספר המצוות, סמ"ג ...) are in no family;
 *   - coverage (warning only): every Talmud tractate has its Mishnah tractate.
 * Exits 1 on any violation. Node built-ins only (runs on the CI runner without node_modules).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const parallelWorks = require('../shared/parallelWorks');
const libraryCatalog = require('../shared/libraryCatalog');
const { generateBookAliases, aliasKey } = require('../shared/hebrew');

function readPaths(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.txt'))
    .map((l) => l.replace(/^\.\//, '').replace(/\.txt$/, ''));
}

/** "folder/.../title" paths of every core book of a built library database (node:sqlite, read-only). */
function readDbPaths(file) {
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = origEmit;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare('SELECT b.title, c.path FROM books b LEFT JOIN categories c ON c.id = b.category_id WHERE b.id < 1000000000 ORDER BY b.id')
      .all()
      .map((r) => (r.path ? `${r.path}/${r.title}` : r.title));
  } finally {
    db.close();
  }
}

/** Catalog input (categories + books) from "dir/.../title" paths. */
function catalogInput(paths) {
  const categories = [];
  const cid = new Map();
  const cat = (p) => {
    if (cid.has(p)) return cid.get(p);
    const parts = p.split('/');
    const parent = parts.length > 1 ? cat(parts.slice(0, -1).join('/')) : null;
    categories.push({ id: categories.length + 1, parent_id: parent, name: parts[parts.length - 1], path: p });
    cid.set(p, categories.length);
    return categories.length;
  };
  const books = paths.map((p, i) => {
    const parts = p.split('/');
    const title = parts.pop();
    return { id: i + 1, category_id: parts.length ? cat(parts.join('/')) : null, title, aliases: generateBookAliases(parts, title).join('|') };
  });
  return { categories, books };
}

/** Runs the audit; returns { report, violations, stats }. */
function audit(paths) {
  const report = parallelWorks.auditPaths(paths);
  const catalog = libraryCatalog.buildLibraryCatalog(catalogInput(paths));
  const idOf = new Map(paths.map((p, i) => [p, i + 1]));
  const violations = [];
  const members = new Set();
  for (const [family, works] of Object.entries(report)) {
    for (const [work, list] of Object.entries(works)) {
      for (const p of list) {
        if (members.has(p)) violations.push(`${p}: in two families`);
        members.add(p);
        const id = idOf.get(p);
        const role = catalog.roleOf(id);
        if (role !== 'parallel') violations.push(`${family}/${work}: ${p} is classified "${role}", not a standalone parallel work`);
        if (catalog.baseOf(id) != null) violations.push(`${family}/${work}: ${p} is nested under ${paths[catalog.baseOf(id) - 1]}`);
        const dirs = p.split('/').slice(0, -1).map(aliasKey);
        if (dirs.includes(aliasKey('מפרשים'))) violations.push(`${family}/${work}: ${p} sits in a מפרשים folder (commentary leak)`);
        const title = p.split('/').pop();
        if (/ על /.test(title) && work !== 'rosh') violations.push(`${family}/${work}: ${p} is an "X על Y" commentary title`);
        // A parallel work never carries another member's commentaries as its own members.
        for (const cid of catalog.commentaryIds(id)) if (catalog.isParallel(cid)) violations.push(`${p}: parallel work ${paths[cid - 1]} nested as its commentary`);
      }
    }
  }
  const excluded = new Set(parallelWorks.EXCLUDED_TITLES.map(aliasKey));
  for (const p of paths) {
    const title = aliasKey(p.split('/').pop());
    if (excluded.has(title) && members.has(p)) violations.push(`${p}: excluded title joined a family`);
  }
  // Coverage (a warning: partial libraries lack whole corpora): a Talmud tractate without its Mishnah
  // tractate has no Mishnah parallel.
  const warnings = [];
  const tractatesOf = (list) => new Set(list.map((p) => parallelWorks.memberOf({ title: p.split('/').pop(), categoryPath: p.split('/').slice(0, -1).join('/') }).tractate));
  const shas = report.shas;
  const mishna = tractatesOf(shas.mishna);
  for (const work of ['bavli', 'yerushalmi', 'tosefta', 'rif', 'rosh']) {
    for (const t of tractatesOf(shas[work])) if (!mishna.has(t)) warnings.push(`shas/${work}: tractate ${parallelWorks.tractateName(t)} has no Mishnah member`);
  }
  const stats = {};
  for (const [family, works] of Object.entries(report)) stats[family] = Object.fromEntries(Object.entries(works).map(([w, l]) => [w, l.length]));
  return { report, violations, warnings, stats, catalog };
}

function main() {
  const arg = (name) => {
    const a = process.argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : null;
  };
  const dbFile = arg('db');
  const file = dbFile || arg('index') || path.join(ROOT, 'otzaria_index_only.txt');
  if (!fs.existsSync(file)) {
    console.error(`library map not found: ${file}`);
    process.exit(2);
  }
  const paths = dbFile ? readDbPaths(file) : readPaths(file);
  const { report, violations, warnings, stats } = audit(paths);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ books: paths.length, stats, report, violations, warnings }, null, 2));
  } else {
    const list = process.argv.includes('--list');
    console.log(`Parallel-works audit of ${path.basename(file)} (${paths.length} books)`);
    for (const [family, works] of Object.entries(report)) {
      const fam = parallelWorks.FAMILIES[family];
      console.log(`\n${fam.label} [${family}] - linked by ${fam.unit}`);
      for (const [work, members] of Object.entries(works)) {
        const label = parallelWorks.WORKS[work].label;
        console.log(`  ${label.padEnd(14)} ${String(members.length).padStart(3)}${members.length ? '' : '  (not in this library)'}`);
        if (list || members.length <= 6) for (const m of members) console.log(`      ${m}`);
      }
    }
    console.log(`\nExcluded (never linked): ${parallelWorks.EXCLUDED_TITLES.join(', ')}`);
    if (warnings.length) console.log(`\n! coverage (not an error):\n  ${warnings.join('\n  ')}`);
    console.log(violations.length ? `\n✗ ${violations.length} violation(s):\n  ${violations.join('\n  ')}` : '\n✓ zero false positives: every member is a standalone parallel work, no commentary leaks');
  }
  process.exit(violations.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { audit, readPaths, readDbPaths, catalogInput };
