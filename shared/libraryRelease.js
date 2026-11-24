/**
 * The cloud library release (pure JS, shared by the app, the CI scripts and scripts/selftest.js; Node built-ins
 * only): scope `all` (every Otzaria folder), published to the release `library-latest` as ONE manifest
 * (`library-manifest.json`) describing two disjoint packages (shared/coreLibrary.js): `core_library.db.zip.part-NN`
 * (ספריית יסוד, the manifest's top-level fields) and `extended_library.db.zip.part-NN` (`manifest.extended`, the
 * expansion pack). The instant starter books live in their own `starter-latest` release.
 *
 * Backward compatibility: an older monolithic core_library.db (no `part` meta) counts as the complete library; installs made while a smaller "classic" build existed (DB `meta.scope` =
 * `classical_full`, or a persisted `installedCloud` of `{ edition: 'classic', version }`) are treated as an
 * incomplete library that can always be updated to the complete one, with no error and nothing to choose.
 */
'use strict';

const LIBRARY_SCOPE = 'all';
const LIBRARY_TAG = 'library-latest';
const MANIFEST_NAME = 'library-manifest.json';
const LIBRARY_TITLE = 'הספרייה המלאה';
const LIBRARY_INCLUDES = 'כל מאגר אוצריא המלא';

/** Manifest URL of the library release in `repo` ("owner/name"). */
function libraryManifestUrl(repo) {
  return `https://github.com/${repo}/releases/download/${LIBRARY_TAG}/${MANIFEST_NAME}`;
}

/** Release tag a manifest URL points at, or null. */
function tagOfManifestUrl(url) {
  const m = /\/releases\/download\/([^/]+)\//.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Persisted `installedCloud` (older builds stored `{ edition, version }`) -> `{ version, stage? }` | null.
 * Anything unreadable is dropped.
 */
function normalizeInstalledCloud(recorded) {
  if (!recorded || typeof recorded !== 'object' || typeof recorded.version !== 'string' || !recorded.version) return null;
  return recorded.stage === 'core' || recorded.stage === 'full' ? { version: recorded.version, stage: recorded.stage } : { version: recorded.version };
}

/** True when the installed DB is a partial (older "classic") build: it has a scope and that scope is not `all`. */
function isPartialScope(scope) {
  return !!scope && scope !== LIBRARY_SCOPE;
}

/** Hebrew names of the stages (the card and the job texts). */
const STAGE_TITLES = { core: 'ספריית יסוד', extended: 'הרחבה לספרייה מלאה', full: 'ספרייה מלאה' };

/**
 * What is installed (pure):
 *   none      no library database
 *   core      ספריית יסוד only (core_library.db with meta.part = core): the expansion can be added any time
 *   full      core + extended of the same build, or a monolithic core_library.db of an older build / on-device build
 *             (it already holds every book: the "backward compatible" install)
 *   partial   a smaller library of an older build (`classical_full`): always offered the complete one
 * `extendedInfo` of another version than the core is stale (never mixed): the state is then `core`.
 * `recorded` ({ version, stage }) only serves databases that carry no `part` (the browser preview's sample library).
 * @param {{ coreInfo: { version: string, scope?: string|null, part?: string|null }|null, extendedInfo?: { version: string }|null, recorded?: { version: string, stage?: string }|null }} a
 * @returns {{ stage: 'none'|'core'|'full'|'partial', version: string|null, legacy: boolean, extendedStale: boolean }}
 */
function libraryState({ coreInfo, extendedInfo, recorded }) {
  if (!coreInfo) return { stage: 'none', version: null, legacy: false, extendedStale: false };
  const version = coreInfo.version;
  if (coreInfo.part === 'core') {
    const ok = !!extendedInfo && extendedInfo.version === version;
    return { stage: ok ? 'full' : 'core', version, legacy: false, extendedStale: !!extendedInfo && !ok };
  }
  if (isPartialScope(coreInfo.scope)) return { stage: 'partial', version, legacy: true, extendedStale: false };
  if (!coreInfo.part && recorded && recorded.version === version && recorded.stage === 'core') return { stage: 'core', version, legacy: false, extendedStale: false };
  return { stage: 'full', version, legacy: true, extendedStale: false };
}

/**
 * What the card offers for a manifest, given the installed state (pure):
 *   choose    nothing installed: ספריית יסוד (plan core) or ספרייה מלאה (plan full: core -> extended in one flow)
 *   expand    core is current: "הרחב לספרייה מלאה" downloads ONLY the extended pack (plan extended)
 *   update    a newer cloud version (or an older smaller build): plans offered per what is installed
 *   current   the installed stage is the cloud version
 * A release without an extended pack (one database) only ever offers a single download (plan core).
 * @returns {{ mode: 'choose'|'expand'|'update'|'current', plans: ('core'|'extended'|'full')[] }}
 */
function libraryAction({ state, manifest }) {
  const hasExt = !!manifest.extended;
  const same = state.version === manifest.version;
  if (state.stage === 'none') return { mode: 'choose', plans: hasExt ? ['core', 'full'] : ['core'] };
  if (state.stage === 'core') {
    if (same) return hasExt ? { mode: 'expand', plans: ['extended'] } : { mode: 'current', plans: [] };
    return { mode: 'update', plans: hasExt ? ['core', 'full'] : ['core'] };
  }
  if (state.stage === 'partial') return { mode: 'update', plans: [hasExt ? 'full' : 'core'] };
  // full (two databases, or a monolith)
  if (same) return { mode: 'current', plans: [] };
  return { mode: 'update', plans: [hasExt ? 'full' : 'core'] };
}

/**
 * The staged flow of one plan (pure): which packages to download, and whether each is installed as soon as it is
 * staged (`installAsYouGo`: a fresh install keeps a finished core usable if the expansion is cancelled) or all are
 * staged first and swapped back to back (an UPDATE of an installed library never mixes builds).
 * 'full' with a current core downloads the expansion only: core.db is never downloaded twice.
 * @returns {{ packages: ('core'|'extended')[], installAsYouGo: boolean }}
 */
function flowOf({ state, manifest, plan }) {
  const coreCurrent = state.stage !== 'none' && state.stage !== 'partial' && state.version === manifest.version && !state.legacy && (state.stage === 'core' || state.stage === 'full');
  if (plan === 'core') return { packages: ['core'], installAsYouGo: true };
  if (plan === 'extended') return { packages: ['extended'], installAsYouGo: true };
  const packages = coreCurrent ? ['extended'] : ['core', 'extended'];
  return { packages, installAsYouGo: state.stage === 'none' || coreCurrent };
}

/**
 * Runs the staged flow of a plan (pure orchestration; the app and scripts/selftest.js pass the callbacks):
 *   stage(pkg, window)  downloads + verifies + extracts one package; `window` ({ offset, total, label }) maps its bytes onto
 *                       the ONE progress bar of the whole flow (total = the combined zip bytes of the packages in the flow)
 *   install(pkg)        swaps a staged package in
 * A fresh install installs core as soon as it is staged: a cancellation (the next `stage` throws) keeps it installed and
 * usable, and running the same plan again downloads only what is missing. An update stages every package first.
 * @returns {Promise<{ kinds: string[], installed: string[], total: number, books: number }>}
 */
async function runStagedFlow({ state, manifest, plan, stage, install }) {
  const { packageOf } = require('./multipart');
  const flow = flowOf({ state, manifest, plan });
  const pkgs = flow.packages.map((k) => packageOf(manifest, k));
  const total = pkgs.reduce((a, p) => a + p.totalZipBytes, 0);
  const installed = [];
  const staged = [];
  let offset = 0;
  for (const p of pkgs) {
    await stage(p, { offset, total, label: STAGE_TITLES[p.kind] });
    offset += p.totalZipBytes;
    if (flow.installAsYouGo) {
      await install(p);
      installed.push(p.kind);
    } else staged.push(p);
  }
  for (const p of staged) {
    await install(p);
    installed.push(p.kind);
  }
  return { kinds: flow.packages, installed, total, books: pkgs.reduce((a, p) => a + p.bookCount, 0) };
}

module.exports = {
  STAGE_TITLES,
  runStagedFlow,
  libraryState,
  flowOf,
  LIBRARY_SCOPE,
  LIBRARY_TAG,
  MANIFEST_NAME,
  LIBRARY_TITLE,
  LIBRARY_INCLUDES,
  libraryManifestUrl,
  tagOfManifestUrl,
  normalizeInstalledCloud,
  isPartialScope,
  libraryAction,
};
