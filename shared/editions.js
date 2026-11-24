/**
 * The two full-library editions of the cloud release (pure JS, shared by the app, the CI scripts and
 * scripts/selftest.js; Node built-ins only).
 *
 *   classic  ספרייה בסיסית (קלאסית): scope `classical_full` = every folder EXCEPT the contemporary
 *            authors' folder (מחברי זמננו / אחרוני זמננו) -> release `library-classic-latest`
 *   full     ספרייה מלאה (כולל אחרוני זמננו): scope `all`      -> release `library-latest`
 *            (the original tag, so existing installs and manifests keep working)
 *
 * Both releases carry `library-manifest.json` + `core_library.db.zip.part-NN`; they never share a tag, so
 * publishing one edition can never overwrite (or prune the parts of) the other. The instant starter books
 * live in their own `starter-latest` release.
 */
'use strict';

const EDITIONS = {
  classic: {
    id: 'classic',
    scope: 'classical_full',
    tag: 'library-classic-latest',
    title: 'ספרייה בסיסית (קלאסית)',
    includes: 'תנ"ך, ש"ס, ראשונים, שו"ע ונושאי כלים (ללא אחרוני זמננו)',
  },
  full: {
    id: 'full',
    scope: 'all',
    tag: 'library-latest',
    title: 'ספרייה מלאה (כולל אחרוני זמננו)',
    includes: 'כל מאגר אוצריא המלא',
  },
};

/** Display / selection order. */
const EDITION_IDS = ['classic', 'full'];
const MANIFEST_NAME = 'library-manifest.json';

const isEdition = (e) => e === 'classic' || e === 'full';
const assertEdition = (e) => {
  if (!isEdition(e)) throw new Error(`edition must be classic or full (got "${e}")`);
  return e;
};

/** Release tag of an edition. */
const editionTag = (edition) => EDITIONS[assertEdition(edition)].tag;
/** build-db.js --scope of an edition. */
const editionScope = (edition) => EDITIONS[assertEdition(edition)].scope;

/** Edition built with a scope (`classical_full` -> classic, `all` -> full); null for anything else. */
function editionOfScope(scope) {
  if (scope === 'classical_full') return 'classic';
  if (scope === 'all') return 'full';
  return null;
}

/** Edition a (validated) library-manifest.json belongs to: its `edition`, else its `scope`; null when unknown. */
function editionOfManifest(m) {
  if (!m) return null;
  if (isEdition(m.edition)) return m.edition;
  return editionOfScope(m.scope);
}

/** Manifest URL of an edition's release in `repo` ("owner/name"). */
function editionManifestUrl(repo, edition) {
  return `https://github.com/${repo}/releases/download/${editionTag(edition)}/${MANIFEST_NAME}`;
}

/** Release tag a manifest URL points at ("library-classic-latest" / "library-latest"), or null. */
function tagOfManifestUrl(url) {
  const m = /\/releases\/download\/([^/]+)\//.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Edition a manifest URL points at (by its release tag), or null for a custom URL. */
function editionOfUrl(url) {
  const tag = tagOfManifestUrl(url);
  return EDITION_IDS.find((e) => EDITIONS[e].tag === tag) || null;
}

/**
 * The installed edition: the DB's own `meta.scope` wins (it is written by build-db.js), then the edition
 * recorded when the app installed the cloud library - trusted only while it still describes the installed
 * version. null = unknown (a library built before editions, or on the device).
 * @param {{ scope?: string|null, version?: string|null }|null} info CoreInfo of the installed core
 * @param {{ edition?: string, version?: string }|null} recorded persisted `installedCloud`
 */
function installedEdition(info, recorded) {
  if (!info) return null;
  const fromMeta = editionOfScope(info.scope || null);
  if (fromMeta) return fromMeta;
  if (recorded && isEdition(recorded.edition) && recorded.version === info.version) return recorded.edition;
  return null;
}

/**
 * What the card offers for the edition of `manifest`, given what is installed:
 *   install     nothing (or an edition-less build) installed
 *   current     this edition at this version is installed
 *   update      this edition is installed and the cloud has another version ("קיים עדכון בענן")
 *   switch      the other edition is installed: downloading replaces it (tabs / settings / personal books stay)
 */
function editionAction({ installedEdition: ed, installedVersion, manifest }) {
  const target = editionOfManifest(manifest);
  if (!installedVersion) return 'install';
  if (!ed || !target) return manifest.version === installedVersion ? 'current' : 'install';
  if (ed !== target) return 'switch';
  return manifest.version === installedVersion ? 'current' : 'update';
}

module.exports = {
  EDITIONS,
  EDITION_IDS,
  MANIFEST_NAME,
  isEdition,
  assertEdition,
  editionTag,
  editionScope,
  editionOfScope,
  editionOfManifest,
  editionManifestUrl,
  tagOfManifestUrl,
  editionOfUrl,
  installedEdition,
  editionAction,
};
