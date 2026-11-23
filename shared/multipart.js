/**
 * Multi-part cloud library (GitHub Release `library-latest`), shared by the app's downloader
 * (src/services/cloudLibrary.ts), scripts/cloud-release.js (the CI manifest writer) and
 * scripts/selftest.js.
 *
 * Release layout (one file per asset, each strictly under GitHub's 2 GB limit):
 *   library-manifest.json
 *   core_library.db.zip.part-01, .part-02, ...   (byte slices of one standard Deflate .zip)
 *
 * Everything here is pure and storage-agnostic: file access goes through an `io` object, so the
 * same code runs on expo-file-system (phone), node:fs (CI / self-tests) and memory (browser e2e).
 *
 *   io.size(name)                    -> number | null   (null: missing)
 *   io.remove(name)                  -> void
 *   io.sha256(name)                  -> hex digest (native / streaming, never a whole-file buffer)
 *   io.download(url, name, onProgress(bytesWritten, totalBytes), isCancelled)  -> Promise<void>
 *   io.openRead(name)                -> { read(n) -> Uint8Array (empty at EOF), close() }
 *   io.openWrite(name, append)       -> { write(bytes) -> Promise<void>, close() }
 */
'use strict';

const CLOUD_RELEASE_TAG = 'library-latest';
const CLOUD_MANIFEST_NAME = 'library-manifest.json';
const CLOUD_ZIP_NAME = 'core_library.db.zip';
const CLOUD_DB_NAME = 'core_library.db';
/** Slack required on top of (zip + extracted DB) before a download starts. */
const FREE_SPACE_MARGIN = 500 * 1024 * 1024;
/** GitHub Releases rejects assets of 2 GiB and more. */
const MAX_PART_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const COPY_CHUNK = 1 << 20;

const HEX64 = /^[0-9a-f]{64}$/;

/** Name of the n-th part (1-based) as `split -d -a 2` + a 1-based rename writes it. */
const partName = (n) => `${CLOUD_ZIP_NAME}.part-${String(n).padStart(2, '0')}`;
const PART_NAME_RE = /^core_library\.db\.zip\.part-(\d{2,})$/;

/** URL of the manifest of the repository's `library-latest` release. */
function cloudManifestUrl(repo) {
  return `https://github.com/${repo}/releases/download/${CLOUD_RELEASE_TAG}/${CLOUD_MANIFEST_NAME}`;
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
  const int = (k) => {
    const v = Number(m[k]);
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) throw new Error(`manifest "${k}" is not a non-negative integer`);
    return v;
  };
  if (!m.version || typeof m.version !== 'string') throw new Error('manifest has no "version"');
  if (!Array.isArray(m.parts) || !m.parts.length) throw new Error('manifest has no "parts"');
  const fullZipSha256 = String(m.fullZipSha256 || '').toLowerCase();
  if (!HEX64.test(fullZipSha256)) throw new Error('manifest "fullZipSha256" is not a SHA-256 hex digest');
  const parts = m.parts.map((p, i) => {
    const m2 = PART_NAME_RE.exec(String((p && p.name) || ''));
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
    ...m,
    version: m.version,
    sourceRepo: m.sourceRepo ? String(m.sourceRepo) : null,
    scope: m.scope ? String(m.scope) : null,
    builtAt: m.builtAt ? String(m.builtAt) : null,
    bookCount: int('bookCount'),
    paragraphCount: int('paragraphCount'),
    uncompressedDbBytes: int('uncompressedDbBytes'),
    totalZipBytes,
    fullZipSha256,
    parts,
  };
}

/** Free space the whole download + install needs. */
function requiredFreeBytes(m) {
  return m.totalZipBytes + m.uncompressedDbBytes + FREE_SPACE_MARGIN;
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

/** "חלק 2 מתוך 3 · 1.4 GB / 3.2 GB · 44%" (overall bytes across all parts). */
function formatPartProgress({ partIndex, partCount, doneBytes, totalBytes }) {
  const pct = totalBytes > 0 ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : 0;
  return `חלק ${partIndex} מתוך ${partCount} · ${formatBytes(doneBytes)} / ${formatBytes(totalBytes)} · ${pct}%`;
}

const cancelledError = () => {
  const e = new Error('cancelled');
  return e;
};

/**
 * True when `name` is on disk with the manifest's size and SHA-256. A part that fails either
 * check is deleted (it is re-downloaded). Sizes are compared first: no hashing of a partial file.
 */
async function isValidPart(io, part) {
  const size = await io.size(part.name);
  if (size == null) return false;
  if (size !== part.sizeBytes) {
    await io.remove(part.name);
    return false;
  }
  if ((await io.sha256(part.name)).toLowerCase() !== part.sha256) {
    await io.remove(part.name);
    return false;
  }
  return true;
}

/**
 * Downloads every part sequentially, skipping parts that are already on disk and valid (resume
 * after a dropped connection / app restart). A downloaded part is verified; one corrupt part is
 * retried `retries` times before the run fails.
 *
 * @param {object} opts { manifestUrl, retries = 2, onProgress({ partIndex, partCount, doneBytes, totalBytes, skipped }), isCancelled }
 * @returns {{ downloaded: number, skipped: number }}
 */
async function downloadParts(io, manifest, opts) {
  const o = opts || {};
  const retries = o.retries == null ? 2 : o.retries;
  const total = manifest.totalZipBytes;
  const count = manifest.parts.length;
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  const report = (partIndex, within, wasSkipped) => o.onProgress && o.onProgress({ partIndex, partCount: count, doneBytes: done + within, totalBytes: total, skipped: !!wasSkipped });
  for (let i = 0; i < count; i++) {
    const part = manifest.parts[i];
    const idx = i + 1;
    if (o.isCancelled && o.isCancelled()) throw cancelledError();
    if (await isValidPart(io, part)) {
      skipped++;
      done += part.sizeBytes;
      report(idx, 0, true);
      continue;
    }
    let attempt = 0;
    for (;;) {
      report(idx, 0, false);
      try {
        await io.download(partUrl(o.manifestUrl, part), part.name, (written) => report(idx, Math.min(written, part.sizeBytes), false), o.isCancelled);
      } catch (e) {
        if (o.isCancelled && o.isCancelled()) throw cancelledError();
        if (attempt++ >= retries) throw new Error(`הורדת ${part.name} נכשלה: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (o.isCancelled && o.isCancelled()) throw cancelledError();
      if (await isValidPart(io, part)) break;
      if (attempt++ >= retries) throw new Error(`${part.name} פגום (גודל או SHA-256 לא תואמים) גם אחרי ${retries + 1} ניסיונות`);
    }
    downloaded++;
    done += part.sizeBytes;
    report(idx, 0, false);
  }
  return { downloaded, skipped };
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

/**
 * The whole staging pipeline: download (resuming valid parts) -> append-assemble + verify the zip
 * -> extract the DB into `dbName` -> delete the zip. `report({ stage, fraction, detail })` feeds the
 * job card. The caller validates the extracted DB and installs it.
 *
 * Parts are deliberately kept when anything fails, so the next run resumes; the zip and the
 * half-extracted DB are removed.
 */
async function stageCloudLibrary(io, manifest, opts) {
  const o = opts || {};
  const report = o.report || (() => undefined);
  const zipName = o.zipName || CLOUD_ZIP_NAME;
  const dbName = o.dbName || CLOUD_DB_NAME;
  await downloadParts(io, manifest, {
    manifestUrl: o.manifestUrl,
    isCancelled: o.isCancelled,
    retries: o.retries,
    onProgress: (p) =>
      report({
        stage: p.skipped ? 'ממשיך — חלק קיים' : 'מוריד…',
        fraction: p.totalBytes ? p.doneBytes / p.totalBytes : null,
        detail: formatPartProgress(p),
      }),
  });
  report({ stage: 'מרכיב את החלקים…', fraction: 0, detail: null });
  await assembleParts(io, manifest, zipName, {
    isCancelled: o.isCancelled,
    onProgress: (p) => report({ stage: 'מרכיב את החלקים…', fraction: p.totalBytes ? p.doneBytes / p.totalBytes : null, detail: `${formatBytes(p.doneBytes)} / ${formatBytes(p.totalBytes)}` }),
  });
  report({ stage: 'מחלץ…', fraction: 0, detail: null });
  try {
    await extractZip(io, manifest, zipName, dbName, {
      isCancelled: o.isCancelled,
      onProgress: ({ bytesIn, bytesOut, totalIn }) =>
        report({ stage: 'מחלץ…', fraction: totalIn ? bytesIn / totalIn : null, detail: `${formatBytes(bytesOut)} / ${formatBytes(manifest.uncompressedDbBytes)}` }),
    });
  } finally {
    if ((await io.size(zipName)) != null) await io.remove(zipName);
  }
}

/**
 * In-memory PartsIO (browser e2e preview, self-tests). Parts are fetched with `fetch`, hashed with
 * WebCrypto. Only meant for small fixtures: the phone uses expo-file-system (src/services/cloudLibrary.ts).
 */
function createMemoryIO(opts) {
  const files = new Map();
  const o = opts || {};
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const concat = (chunks) => {
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  const io = {
    files,
    size: (name) => (files.has(name) ? files.get(name).length : null),
    remove: (name) => void files.delete(name),
    sha256: async (name) => {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', files.get(name));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    },
    download: async (url, name, onProgress, isCancelled) => {
      const res = await doFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = [];
      let got = 0;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          if (isCancelled && isCancelled()) throw cancelledError();
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          onProgress(got, total);
        }
      } else {
        chunks.push(new Uint8Array(await res.arrayBuffer()));
        got = chunks[0].length;
        onProgress(got, total);
      }
      files.set(name, concat(chunks));
    },
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
    openWrite: (name, append) => {
      const chunks = append && files.has(name) ? [files.get(name)] : [];
      return {
        write: async (bytes) => void chunks.push(Uint8Array.from(bytes)),
        close: () => void files.set(name, concat(chunks)),
      };
    },
  };
  return io;
}

module.exports = {
  CLOUD_RELEASE_TAG,
  CLOUD_MANIFEST_NAME,
  CLOUD_ZIP_NAME,
  CLOUD_DB_NAME,
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
  isValidPart,
  downloadParts,
  assembleParts,
  extractZip,
  stageCloudLibrary,
  createMemoryIO,
};
