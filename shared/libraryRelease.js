/**
 * The single cloud library release (pure JS, shared by the app, the CI scripts and scripts/selftest.js;
 * Node built-ins only). There is ONE complete library: scope `all` (every Otzaria folder), published to the
 * release `library-latest` as `library-manifest.json` + `core_library.db.zip.part-NN`. The instant starter
 * books live in their own `starter-latest` release.
 *
 * Backward compatibility: installs made while a smaller "classic" build existed (DB `meta.scope` =
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
 * Persisted `installedCloud` (older builds stored `{ edition, version }`) -> `{ version }` | null.
 * Anything unreadable is dropped.
 */
function normalizeInstalledCloud(recorded) {
  if (!recorded || typeof recorded !== 'object' || typeof recorded.version !== 'string' || !recorded.version) return null;
  return { version: recorded.version };
}

/** True when the installed DB is a partial (older "classic") build: it has a scope and that scope is not `all`. */
function isPartialScope(scope) {
  return !!scope && scope !== LIBRARY_SCOPE;
}

/**
 * What the card offers, given what is installed:
 *   install   nothing (or a library of unknown origin, e.g. built on the device) is installed
 *   current   the complete library at this version is installed
 *   update    the complete library is installed and the cloud has another version ("קיים עדכון בענן"),
 *             or a partial (older classic) build is installed: update to the complete library
 * @param {{ installedScope?: string|null, installedVersion: string|null, manifest: { version: string } }} a
 */
function libraryAction({ installedScope, installedVersion, manifest }) {
  if (!installedVersion) return 'install';
  if (isPartialScope(installedScope)) return 'update';
  if (manifest.version === installedVersion) return 'current';
  return installedScope === LIBRARY_SCOPE ? 'update' : 'install';
}

module.exports = {
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
