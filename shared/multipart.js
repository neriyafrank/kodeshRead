/**
 * Multi-part cloud library (GitHub Release `library-latest`), shared by the app (src/services/cloudLibrary.ts),
 * scripts/cloud-release.js (the CI manifest writer) and scripts/selftest.js.
 *
 * Release layout (one file per asset, each strictly under GitHub's 2 GB limit):
 *   library-manifest.json
 *   core_library.db.zip.part-01, .part-02, ...   (byte slices of one standard Deflate .zip)
 *
 * This file: manifest validation, sizes / labels, and the staging pipeline
 *   download (shared/cloudDownload.js: resumable, SHA-256 verified, pause / resume, network-drop safe)
 *   -> streaming assembly of the parts into one zip (whole-zip SHA-256) -> streaming extraction of the DB.
 *
 * Everything is pure and storage-agnostic: file access goes through an `io` object (PartsIO), so the same
 * code runs on expo-file-system (phone), node:fs (CI / self-tests) and memory (browser e2e):
 *
 *   io.size(name)               -> number | null   (null: missing)
 *   io.remove(name)             -> void
 *   io.rename(from, to)         -> void (replaces `to`)
 *   io.sha256(name)             -> hex digest (native / streaming, never a whole-file buffer)
 *   io.openRead(name)           -> { read(n) -> Uint8Array (empty at EOF), close() }
 *   io.openWrite(name, append)  -> { write(bytes) -> Promise<void>, close() }
 *   io.readText(name)           -> string
 *   io.writeText(name, text)    -> void (atomic: temp file + rename)
 */
'use strict';

const releases = require('./libraryRelease');
const dl = require('./cloudDownload');

/** Release tag of the (single, complete) cloud library. */
const CLOUD_RELEASE_TAG = releases.LIBRARY_TAG;
const CLOUD_MANIFEST_NAME = 'library-manifest.json';
const CLOUD_ZIP_NAME = 'core_library.db.zip';
const CLOUD_DB_NAME = 'core_library.db';
/** The optional second stage (the expansion pack): its own zip / parts / database. */
const EXTENDED_ZIP_NAME = 'extended_library.db.zip';
const EXTENDED_DB_NAME = 'extended_library.db';
/** Slack required on top of (zip + extracted DB) before a download starts. */
const FREE_SPACE_MARGIN = 500 * 1024 * 1024;
/** GitHub Releases rejects assets of 2 GiB and more. */
const MAX_PART_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const COPY_CHUNK = 1 << 20;

const HEX64 = /^[0-9a-f]{64}$/;

/** Name of the n-th part (1-based) as `split -d -a 2` + a 1-based rename writes it. */
const partName = (n, kind = 'core') => `${kind === 'extended' ? EXTENDED_ZIP_NAME : CLOUD_ZIP_NAME}.part-${String(n).padStart(2, '0')}`;
const PART_NAME_RES = { core: /^core_library\.db\.zip\.part-(\d{2,})$/, extended: /^extended_library\.db\.zip\.part-(\d{2,})$/ };

/** URL of the manifest of the cloud library release (`library-latest`). */
function cloudManifestUrl(repo) {
  return releases.libraryManifestUrl(repo);
}

/** Asset URL of a part, next to the manifest. */
function partUrl(manifestUrl, part) {
  const base = String(manifestUrl).replace(/[?#].*$/, '');
  return base.slice(0, base.lastIndexOf('/') + 1) + encodeURIComponent(part.name);
}

/**
 * Validates a parsed library-manifest.json; throws a readable error for anything unusable.
 * @returns the manifest with numbers coerced and hashes lower-cased
 */
function validateCloudManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest is not a JSON object');
  if (!m.version || typeof m.version !== 'string') throw new Error('manifest has no "version"');
  const core = validatePackage(m, 'core', 'manifest');
  // `extended` (the expansion pack, schema of the two-stage library) is optional: older manifests describe one database.
  const extended = m.extended == null ? null : validatePackage(m.extended, 'extended', 'manifest.extended');
  // `edition` (written by builds that still had a classic tier) is dropped: there is one library.
  const { edition: _legacyEdition, extended: _ext, ...rest } = m;
  return {
    ...rest,
    version: m.version,
    sourceRepo: m.sourceRepo ? String(m.sourceRepo) : null,
    scope: m.scope ? String(m.scope) : null,
    builtAt: m.builtAt ? String(m.builtAt) : null,
    ...core,
    extended,
  };
}

/** One package (the core database, or the extended one): its numbers coerced, parts checked, hashes lower-cased. */
function validatePackage(m, kind, label) {
  const int = (k) => {
    const v = Number(m[k]);
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) throw new Error(`${label} "${k}" is not a non-negative integer`);
    return v;
  };
  if (!Array.isArray(m.parts) || !m.parts.length) throw new Error(`${label} has no "parts"`);
  const fullZipSha256 = String(m.fullZipSha256 || '').toLowerCase();
  if (!HEX64.test(fullZipSha256)) throw new Error(`${label} "fullZipSha256" is not a SHA-256 hex digest`);
  const parts = m.parts.map((p, i) => {
    const m2 = PART_NAME_RES[kind].exec(String((p && p.name) || ''));
    if (!m2) throw new Error(`part ${i + 1} has an unexpected name "${p && p.name}"`);
    if (Number(m2[1]) !== i + 1) throw new Error(`parts are out of order: expected part-${String(i + 1).padStart(2, '0')}, got "${p.name}"`);
    const sizeBytes = Number(p.sizeBytes);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Error(`part "${p.name}" has an invalid size`);
    if (sizeBytes > MAX_PART_BYTES) throw new Error(`part "${p.name}" exceeds the 2 GB release-asset limit`);
    const sha256 = String(p.sha256 || '').toLowerCase();
    if (!HEX64.test(sha256)) throw new Error(`part "${p.name}" has no valid SHA-256`);
    return { name: p.name, sizeBytes, sha256 };
  });
  const totalZipBytes = int('totalZipBytes');
  const sum = parts.reduce((a, p) => a + p.sizeBytes, 0);
  if (sum !== totalZipBytes) throw new Error(`part sizes add up to ${sum} bytes, but totalZipBytes is ${totalZipBytes}`);
  return {
    bookCount: int('bookCount'),
    paragraphCount: int('paragraphCount'),
    uncompressedDbBytes: int('uncompressedDbBytes'),
    totalZipBytes,
    fullZipSha256,
    parts,
  };
}

/**
 * One stage of a validated manifest as the download pipeline sees it ({ version, parts, totalZipBytes, uncompressedDbBytes,
 * fullZipSha256, bookCount, ... }), with the file names of that stage. The core view is the manifest itself.
 */
function packageOf(manifest, kind) {
  if (kind === 'extended') {
    if (!manifest.extended) throw new Error('this release has no extended library');
    return { ...manifest.extended, version: manifest.version, kind: 'extended', zipName: EXTENDED_ZIP_NAME, dbName: EXTENDED_DB_NAME };
  }
  return { ...manifest, kind: 'core', zipName: CLOUD_ZIP_NAME, dbName: CLOUD_DB_NAME };
}

/**
 * The staged download plan of the card (pure):
 *   core      ספריית יסוד only
 *   extended  the expansion pack only (core is already installed)
 *   full      core + extended in one flow (core first)
 * @returns {{ plan, packages: string[], totalZipBytes, uncompressedDbBytes, bookCount }}
 */
function planPackages(manifest, plan) {
  const kinds = plan === 'core' ? ['core'] : plan === 'extended' ? ['extended'] : ['core', 'extended'];
  const pk = kinds.map((k) => packageOf(manifest, k));
  return {
    plan,
    packages: kinds,
    totalZipBytes: pk.reduce((a, p) => a + p.totalZipBytes, 0),
    uncompressedDbBytes: pk.reduce((a, p) => a + p.uncompressedDbBytes, 0),
    bookCount: pk.reduce((a, p) => a + p.bookCount, 0),
  };
}

/** Free space the whole download + install needs. */
function requiredFreeBytes(m) {
  return m.totalZipBytes + m.uncompressedDbBytes + FREE_SPACE_MARGIN;
}

/** Free space a plan needs: its downloads + extracted databases + the margin (the zips go one at a time, so no double count). */
function requiredFreeBytesForPlan(manifest, plan) {
  const p = planPackages(manifest, plan);
  return p.totalZipBytes + p.uncompressedDbBytes + FREE_SPACE_MARGIN;
}

/** `{ ok, required, free }`; unknown free space (null) never blocks. */
function checkFreeSpace(m, freeBytes) {
  const required = requiredFreeBytes(m);
  return { ok: freeBytes == null || freeBytes >= required, required, free: freeBytes };
}

/** "1.4 GB" / "320 MB" / "48 KB" (binary units, one decimal for GB). */
function formatBytes(n) {
  const v = Number(n) || 0;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (v >= GB) return `${(v / GB).toFixed(1)} GB`;
  if (v >= MB || v === 0) return `${Math.round(v / MB)} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}

const cancelledError = () => new Error('cancelled');

/** "ממתין לחיבור לרשת…": the device is offline; the download continues by itself from the saved bytes. */
const WAITING_STAGE = 'ממתין לחיבור לרשת…';
/** "הרשת נותקה זמנית — מנסה להמשיך הורדה…": online, but the server / connection failed; retried with backoff. */
const NETWORK_RETRY_STAGE = 'הרשת נותקה זמנית — מנסה להמשיך הורדה…';
const VERIFY_STAGE = 'מאמת SHA-256…';
const DOWNLOAD_STAGE = 'מוריד…';
const PAUSED_STAGE = 'ההורדה הושהתה';

/**
 * "חלק 2 מתוך 3 · 1.4 GB / 3.2 GB · 44%" (overall bytes across all parts). In a two-stage flow `label` names the
 * stage ("ספריית יסוד · חלק 2 מתוך 3 · ..."), and the bytes / percentage are those of the WHOLE flow.
 */
function formatPartProgress({ partIndex, partCount, doneBytes, totalBytes, label }) {
  const pct = totalBytes > 0 ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : 0;
  return `${label ? label + ' · ' : ''}חלק ${partIndex} מתוך ${partCount} · ${formatBytes(doneBytes)} / ${formatBytes(totalBytes)} · ${pct}%`;
}

/**
 * Title / text / progress of the Android foreground-service notification of a cloud job:
 * "מוריד ספרייה מהענן… 42%". `current` / `total` are per-mille for the notification's progress bar.
 */
function formatCloudNotification(stage, fraction, detail) {
  const pct = fraction == null ? null : Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  let label = stage || '';
  if (label === DOWNLOAD_STAGE) label = 'מוריד ספרייה מהענן…';
  else if (label === 'מרכיב את החלקים…') label = 'מרכיב את הספרייה…';
  else if (label === 'מחלץ…') label = 'מחלץ את הספרייה…';
  const showPct = pct != null && label !== NETWORK_RETRY_STAGE && label !== WAITING_STAGE;
  return { title: showPct ? `${label} ${pct}%` : label, text: detail || '', current: pct == null ? 0 : Math.round(Math.max(0, Math.min(1, fraction)) * 1000), total: pct == null ? 0 : 1000 };
}

/** Bytes of a package already on disk (finished parts + partials), for the first progress report of a resumed run. */
function existingBytes(io, pkg) {
  return dl.bytesOnDisk(io, pkg.parts);
}

/**
 * Concatenates the parts into `zipName` by streaming appends (1 MB at a time: no multi-GB
 * buffers in memory) and deletes each part right after it was appended, so the peak disk use stays
 * at about one copy of the archive. Verifies the whole archive's SHA-256 against the manifest.
 */
async function assembleParts(io, manifest, zipName, opts) {
  const o = opts || {};
  const chunk = o.chunkSize || COPY_CHUNK;
  if ((await io.size(zipName)) != null) await io.remove(zipName);
  const out = await io.openWrite(zipName, false);
  let written = 0;
  try {
    for (const part of manifest.parts) {
      if (o.isCancelled && o.isCancelled()) throw cancelledError();
      const input = await io.openRead(part.name);
      try {
        let got = 0;
        for (;;) {
          const bytes = await input.read(chunk);
          if (!bytes.length) break;
          await out.write(bytes);
          got += bytes.length;
          written += bytes.length;
          if (o.onProgress) o.onProgress({ doneBytes: written, totalBytes: manifest.totalZipBytes });
        }
        if (got !== part.sizeBytes) throw new Error(`${part.name}: נקראו ${got} בתים במקום ${part.sizeBytes}`);
      } finally {
        await input.close();
      }
      await io.remove(part.name);
    }
  } catch (e) {
    await out.close();
    await io.remove(zipName);
    throw e;
  }
  await out.close();
  if (written !== manifest.totalZipBytes) {
    await io.remove(zipName);
    throw new Error(`הארכיון המורכב (${written} בתים) שונה מהצפוי (${manifest.totalZipBytes})`);
  }
  if ((await io.sha256(zipName)).toLowerCase() !== manifest.fullZipSha256) {
    await io.remove(zipName);
    throw new Error('בדיקת SHA-256 של הארכיון המלא נכשלה');
  }
}

/**
 * Streams the .db entry of the zip into `dbName` (fflate, chunked, shared/release.js) and
 * checks the extracted size against the manifest.
 */
async function extractZip(io, manifest, zipName, dbName, opts) {
  const o = opts || {};
  const { decompressStream } = require('./release'); // fflate: only the app / tests need it, not the CI manifest writer
  const total = (await io.size(zipName)) || 0;
  const input = await io.openRead(zipName);
  const output = await io.openWrite(dbName, false);
  let res;
  try {
    res = await decompressStream({
      format: 'zip',
      totalIn: total,
      read: (n) => input.read(n),
      write: (b) => output.write(b),
      isCancelled: o.isCancelled,
      onProgress: o.onProgress,
    });
  } catch (e) {
    await input.close();
    await output.close();
    await io.remove(dbName);
    throw e;
  }
  await input.close();
  await output.close();
  if (res.bytesOut !== manifest.uncompressedDbBytes) {
    await io.remove(dbName);
    throw new Error(`גודל מסד הנתונים שחולץ (${res.bytesOut}) שונה מהצפוי (${manifest.uncompressedDbBytes})`);
  }
  return res;
}

/** Job-card line of a download snapshot (overall bytes of the flow). */
function describeSnapshot(snap, ctx) {
  const done = ctx.overall(snap.doneBytes);
  const progress = formatPartProgress({ partIndex: snap.partIndex, partCount: snap.partCount, doneBytes: done, totalBytes: ctx.total, label: ctx.label });
  const fraction = ctx.total ? Math.min(1, done / ctx.total) : null;
  switch (snap.state) {
    case dl.STATES.WAITING: {
      const r = snap.retry || {};
      if (r.offline || !r.attempt) return { stage: WAITING_STAGE, fraction, detail: `ההורדה תמשיך מעצמה כשהרשת תחזור · ${progress}` };
      return { stage: NETWORK_RETRY_STAGE, fraction, detail: `ניסיון ${r.attempt} מתוך ${r.maxAttempts} · בעוד ${Math.max(1, Math.round((r.delayMs || 0) / 1000))} שנ׳ · ${progress}` };
    }
    case dl.STATES.VERIFYING:
      return { stage: VERIFY_STAGE, fraction, detail: `${ctx.label ? ctx.label + ' · ' : ''}חלק ${snap.partIndex} מתוך ${snap.partCount}` };
    case dl.STATES.PAUSED:
      return { stage: PAUSED_STAGE, fraction, detail: progress };
    case dl.STATES.ERROR:
      return { stage: 'ההורדה נכשלה', fraction, detail: snap.error ? snap.error.message : progress };
    default:
      return { stage: DOWNLOAD_STAGE, fraction, detail: progress };
  }
}

/**
 * The whole staging pipeline of ONE package: download (resumable, every part SHA-256 verified) -> append-assemble +
 * verify the zip -> extract the DB into `dbName` -> delete the zip. `report({ stage, fraction, detail, download })`
 * feeds the job card (`download` = the engine state: downloading / waiting_for_network / verifying / paused ...).
 * The caller validates the extracted DB and installs it.
 *
 * Pause (`isPauseRequested`) stops the transfer and throws DownloadPausedError: the bytes and the state stay on disk
 * and the next run continues from them. Cancel deletes the package's bytes. A fatal failure throws DownloadError
 * (with `.diagnostic`); the bytes are kept. The zip and a half-extracted DB are always removed.
 *
 * opts: { manifestUrl, engine? (default: createHttpEngine over io + fetch), request?, connectivity?, isCancelled,
 *         isPauseRequested, window: { offset, total, label }, report, keepAwake(fn), sleep, pollMs }
 */
async function stageCloudLibrary(io, manifest, opts) {
  const o = opts || {};
  const report = o.report || (() => undefined);
  const zipName = o.zipName || manifest.zipName || CLOUD_ZIP_NAME;
  const dbName = o.dbName || manifest.dbName || CLOUD_DB_NAME;
  // Two-stage flow: `window` = { offset, total, label } maps this package's download bytes onto ONE bar for the whole
  // flow (offset = bytes of the packages before it, total = the combined size of every package of the flow).
  const win = o.window || null;
  const ctx = { overall: (bytes) => (win ? win.offset + bytes : bytes), total: win ? win.total : manifest.totalZipBytes, label: win && win.label };
  const engine = o.engine || dl.createHttpEngine({ io, request: o.request, connectivity: o.connectivity, sleep: o.sleep, backoffBaseMs: o.backoffBaseMs, backoffCapMs: o.backoffCapMs });
  const keepAwake = o.keepAwake || ((fn) => fn());
  let lastFraction = 0;
  const r = await dl.downloadPackage(io, manifest, {
    engine,
    urlOf: (p) => partUrl(o.manifestUrl, p),
    isCancelled: o.isCancelled,
    isPauseRequested: o.isPauseRequested,
    window: win,
    sleep: o.sleep,
    pollMs: o.pollMs,
    verifyRetries: o.verifyRetries,
    onUpdate: (snap) => {
      const line = describeSnapshot(snap, ctx);
      // The bar never moves backwards (the controller's bytes are monotonic; this also holds across states).
      if (line.fraction != null) lastFraction = Math.max(lastFraction, line.fraction);
      report({ ...line, fraction: line.fraction == null ? null : lastFraction, download: snap.state });
    },
  });
  if (r.status === 'paused') throw new dl.DownloadPausedError({ doneBytes: ctx.overall(r.doneBytes), totalBytes: ctx.total });
  // Assembly + extraction are the heavy disk steps: the device must not sleep in the middle of them.
  await keepAwake(async () => {
    report({ stage: 'מרכיב את החלקים…', fraction: 0, detail: null, download: dl.STATES.COMPLETED });
    await assembleParts(io, manifest, zipName, {
      isCancelled: o.isCancelled,
      onProgress: (p) => report({ stage: 'מרכיב את החלקים…', fraction: p.totalBytes ? p.doneBytes / p.totalBytes : null, detail: `${formatBytes(p.doneBytes)} / ${formatBytes(p.totalBytes)}`, download: dl.STATES.COMPLETED }),
    });
    report({ stage: 'מחלץ…', fraction: 0, detail: null, download: dl.STATES.COMPLETED });
    try {
      await extractZip(io, manifest, zipName, dbName, {
        isCancelled: o.isCancelled,
        onProgress: ({ bytesIn, bytesOut, totalIn }) =>
          report({ stage: 'מחלץ…', fraction: totalIn ? bytesIn / totalIn : null, detail: `${formatBytes(bytesOut)} / ${formatBytes(manifest.uncompressedDbBytes)}`, download: dl.STATES.COMPLETED }),
      });
    } finally {
      if ((await io.size(zipName)) != null) await io.remove(zipName);
    }
  });
  // The package is staged: its download record is done (the parts were consumed by the assembly).
  await dl.patchDownloadState(io, { packages: { [manifest.kind || 'core']: null } });
}

/**
 * In-memory PartsIO (browser e2e preview, self-tests). Hashes with WebCrypto. Only meant for small fixtures: the phone
 * uses expo-file-system (src/services/cloudLibrary.ts).
 */
function createMemoryIO() {
  const files = new Map();
  const concat = (chunks) => {
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  return {
    files,
    size: (name) => (files.has(name) ? files.get(name).length : null),
    remove: (name) => void files.delete(name),
    rename: (from, to) => {
      if (!files.has(from)) throw new Error(`${from} does not exist`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    sha256: async (name) => {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', files.get(name));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    },
    readText: (name) => new TextDecoder().decode(files.get(name)),
    writeText: (name, text) => void files.set(name, new TextEncoder().encode(text)),
    openRead: (name) => {
      const data = files.get(name);
      if (!data) throw new Error(`${name} does not exist`);
      let at = 0;
      return {
        read: async (n) => {
          const out = data.subarray(at, at + n);
          at += out.length;
          return out;
        },
        close: () => undefined,
      };
    },
    // Every write is visible at once (like a real file): an interrupted transfer keeps exactly the bytes it wrote.
    openWrite: (name, append) => {
      const chunks = append && files.has(name) ? [files.get(name)] : [];
      files.set(name, concat(chunks));
      return {
        write: async (bytes) => {
          chunks.push(Uint8Array.from(bytes));
          files.set(name, concat(chunks));
        },
        close: () => undefined,
      };
    },
  };
}

module.exports = {
  CLOUD_RELEASE_TAG,
  CLOUD_MANIFEST_NAME,
  CLOUD_ZIP_NAME,
  CLOUD_DB_NAME,
  EXTENDED_ZIP_NAME,
  EXTENDED_DB_NAME,
  packageOf,
  planPackages,
  requiredFreeBytesForPlan,
  FREE_SPACE_MARGIN,
  MAX_PART_BYTES,
  partName,
  cloudManifestUrl,
  partUrl,
  validateCloudManifest,
  requiredFreeBytes,
  checkFreeSpace,
  formatBytes,
  formatPartProgress,
  formatCloudNotification,
  describeSnapshot,
  PARTIAL_SUFFIX: dl.PARTIAL_SUFFIX,
  partialName: dl.partialName,
  WAITING_STAGE,
  NETWORK_RETRY_STAGE,
  VERIFY_STAGE,
  PAUSED_STAGE,
  existingBytes,
  assembleParts,
  extractZip,
  stageCloudLibrary,
  createMemoryIO,
};
