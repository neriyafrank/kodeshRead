/**
 * Library scopes of the cloud build (scripts/build-db.js --scope=..., .github/workflows/build-library.yml).
 *
 *   all             every folder of the source
 *   classical_full  the classical Torah corpora (Tanach, Mishnah, Bavli, Yerushalmi, Midrash, Rishonim,
 *                   Rambam, Tur, Shulchan Aruch and the classic commentaries): every folder EXCEPT the
 *                   contemporary authors' folders `מחברי זמננו` / `אחרוני זמננו` (smaller DB, clean public-domain
 *                   footing). This is the "classic" edition of shared/editions.js; `all` is the "full" edition.
 *
 * In both scopes the `links/` folder of an Otzaria download is never read (commentaries are linked
 * from folder paths + headings), so it is skipped too. The filter is applied while the folder tree
 * is walked: excluded folders are never listed, read or indexed.
 */
'use strict';

const { aliasKey } = require('./hebrew');

const SCOPES = ['classical_full', 'all'];

/** Folder names (aliasKey-normalized) dropped by every scope. */
const ALWAYS_SKIPPED = new Set(['links'].map(aliasKey));
/** Folder names dropped by classical_full only. */
const MODERN_AUTHORS = new Set(['מחברי זמננו', 'מחברי זמנינו', 'אחרוני זמננו', 'אחרוני זמנינו'].map(aliasKey));

/** True for a contemporary-authors folder name (excluded by classical_full). */
function isModernAuthorsDir(name) {
  return MODERN_AUTHORS.has(aliasKey(String(name)));
}

/** Throws on an unknown scope; returns the name. */
function assertScope(scope) {
  if (!SCOPES.includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join(' / ')} (got "${scope}")`);
  return scope;
}

/** True when a folder called `name` is left out of `scope`. */
function isExcludedDir(scope, name) {
  const k = aliasKey(String(name));
  if (ALWAYS_SKIPPED.has(k)) return true;
  return scope === 'classical_full' && MODERN_AUTHORS.has(k);
}

/**
 * Wraps a shared/indexer.js file adapter so excluded folders never show up in `list()`.
 * `stats.excluded` counts the dropped folders (for the build log).
 */
function scopedFs(fsa, scope) {
  assertScope(scope);
  const stats = { excluded: 0, excludedNames: new Set() };
  return {
    stats,
    list: async (dir) => {
      const out = [];
      for (const e of await fsa.list(dir)) {
        if (e.isDir && isExcludedDir(scope, e.name)) {
          stats.excluded++;
          stats.excludedNames.add(e.name);
        } else out.push(e);
      }
      return out;
    },
    readText: (h) => fsa.readText(h),
  };
}

/**
 * The folder that holds the books of an Otzaria checkout: `אוצריא` (searched up to `maxDepth`
 * levels down, breadth-first), otherwise the folder itself.
 * @param fsa node `fs`-like { readdirSync, statSync } and `path`
 */
function findBooksRoot(fs, path, dir, maxDepth) {
  const limit = maxDepth == null ? 3 : maxDepth;
  let level = [dir];
  for (let d = 0; d <= limit && level.length; d++) {
    const next = [];
    for (const cur of level) {
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'אוצריא') return path.join(cur, e.name);
        next.push(path.join(cur, e.name));
      }
    }
    level = next;
  }
  return dir;
}

module.exports = { SCOPES, assertScope, isExcludedDir, isModernAuthorsDir, scopedFs, findBooksRoot };
