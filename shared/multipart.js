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

const editions = require('./editions');

/** Release tag of the full edition (the original, backwards-compatible tag). The classic edition: shared/editions.js. */
const CLOUD_RELEASE_TAG = editions.EDITIONS.full.tag;
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

/** URL of the manifest of an edition's release (`library-latest` = full, the default; `library-classic-latest` = classic). */
function cloudManifestUrl(repo, edition = 'full') {
  return editions.editionManifestUrl(repo, edition);
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
    edition: editions.editionOfManifest(m),
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

/**
 * Title / text / progress of the Android foreground-service notification of a cloud job:
 * "מוריד ספרייה מהענן… 42%". `current` / `total` are per-mille for the notification's progress bar.
 */
function formatCloudNotification(stage, fraction, detail) {
  const pct = fraction == null ? null : Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  let label = stage || '';
  if (/^מוריד…?$|^ממשיך — חלק קיים$/.test(label)) label = 'מוריד ספרייה מהענן…';
  else if (label === 'מרכיב את החלקים…') label = 'מרכיב את הספרייה…';
  else if (label === 'מחלץ…') label = 'מחלץ את הספרייה…';
  const showPct = pct != null && label !== NETWORK_RETRY_STAGE;
  return { title: showPct ? `${label} ${pct}%` : label, text: detail || '', current: pct == null ? 0 : Math.round(Math.max(0, Math.min(1, fraction)) * 1000), total: pct == null ? 0 : 1000 };
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

/** Suffix of an in-progress part: kept on disk across interruptions and resumed with an HTTP Range request. */
const PARTIAL_SUFFIX = '.partial';
const partialName = (name) => name + PARTIAL_SUFFIX;
/** Sidecar of a partial: holds the part's manifest SHA-256, so a partial of another release is never continued. */
const partialIdName = (name) => name + PARTIAL_SUFFIX + '.id';

async function readPartialId(io, part) {
  const idName = partialIdName(part.name);
  if ((await io.size(idName)) == null) return null;
  const r = await io.openRead(idName);
  try {
    return new TextDecoder().decode(await r.read(128)).trim();
  } finally {
    await r.close();
  }
}

async function writePartialId(io, part) {
  const w = await io.openWrite(partialIdName(part.name), false);
  try {
    await w.write(new TextEncoder().encode(part.sha256));
  } finally {
    await w.close();
  }
}

/**
 * Bytes of the library already on disk (complete parts + the partial of each part, sizes only), for the
 * first progress report of a retry: the UI shows the saved percentage at once instead of 0%.
 */
async function existingBytes(io, manifest) {
  let sum = 0;
  for (const part of manifest.parts) {
    const full = await io.size(part.name);
    if (full === part.sizeBytes) {
      sum += full;
      continue;
    }
    const partial = (await io.size(partialName(part.name))) || 0;
    sum += Math.min(partial, part.sizeBytes);
  }
  return sum;
}

const TRANSIENT_RE =
  /unable to resolve host|no address associated|unknownhost|enotfound|eai_again|econnreset|econnaborted|econnrefused|etimedout|ehostunreach|enetunreach|enetdown|epipe|time[d ]?-?out|connection (?:dropped|reset|closed|aborted|lost|refused)|connect(?:ion)? failed|failed to connect|software caused connection abort|unexpected end of stream|stream was reset|socket|network|offline|internet|ssl|handshake|premature|broken pipe|http (?:408|429|5\d\d)\b/i;

/**
 * True for an error worth retrying: DNS / connectivity loss (Android revokes background network access
 * -> "Unable to resolve host"), resets, timeouts, 5xx / 429. HTTP 404 / 403, a full disk or a
 * cancellation are not transient and fail at once.
 */
function isTransientNetworkError(e) {
  const msg = e instanceof Error ? e.message : String(e == null ? '' : e);
  if (!msg || /^cancelled$/i.test(msg)) return false;
  return TRANSIENT_RE.test(msg);
}

/** Exponential backoff: base * 2^attempt (attempt 0-based), capped. 2 s, 4 s, 8 s, 16 s, ... 30 s. */
function backoffDelayMs(attempt, baseMs = 2000, capMs = 30000) {
  return Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sleeps `ms` in slices of <= 500 ms so a cancel request ends the wait quickly. */
async function sleepCancellable(sleep, ms, isCancelled) {
  let left = ms;
  while (left > 0) {
    if (isCancelled && isCancelled()) throw cancelledError();
    const step = Math.min(500, left);
    await sleep(step);
    left -= step;
  }
  if (isCancelled && isCancelled()) throw cancelledError();
}

/** "הרשת נותקה זמנית — מנסה להמשיך הורדה…" */
const NETWORK_RETRY_STAGE = 'הרשת נותקה זמנית — מנסה להמשיך הורדה…';

/**
 * Downloads every part sequentially, skipping parts that are already on disk and valid (resume
 * after a dropped connection / app restart).
 *
 * A part is written to `<part>.partial` and renamed once it has the manifest size. The partial file is
 * never deleted on an interruption: the next attempt (automatic retry, or a later run) continues with
 * `io.download(url, partial, onProgress, isCancelled, { resumeFrom, expectedBytes })`, i.e. an HTTP
 * Range request, instead of starting from 0%.
 *
 * Transient network errors (isTransientNetworkError) are retried `networkRetries` times with exponential
 * backoff; the budget is refilled whenever an attempt made progress, so a long download over a flaky link
 * is not abandoned. A failure while the app is in the background (the OS revoked network access) is not
 * counted: the loop waits for `whenForeground()` and resumes. One corrupt part is retried `retries` times.
 *
 * @param {object} opts { manifestUrl, retries = 2, networkRetries = 4, backoffBaseMs, backoffCapMs, sleep,
 *   isBackgrounded(), whenForeground(), onRetry({ partIndex, attempt, maxAttempts, delayMs, error, background }),
 *   onProgress({ partIndex, partCount, doneBytes, totalBytes, skipped }), isCancelled }
 * @returns {{ downloaded: number, skipped: number }}
 */
async function downloadParts(io, manifest, opts) {
  const o = opts || {};
  const retries = o.retries == null ? 2 : o.retries;
  const maxNet = o.networkRetries == null ? 4 : o.networkRetries;
  const sleep = o.sleep || defaultSleep;
  const total = manifest.totalZipBytes;
  const count = manifest.parts.length;
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  const cancelled = () => !!(o.isCancelled && o.isCancelled());
  const report = (partIndex, within, wasSkipped) => o.onProgress && o.onProgress({ partIndex, partCount: count, doneBytes: done + within, totalBytes: total, skipped: !!wasSkipped });
  for (let i = 0; i < count; i++) {
    const part = manifest.parts[i];
    const idx = i + 1;
    const partial = partialName(part.name);
    if (cancelled()) throw cancelledError();
    if (await isValidPart(io, part)) {
      await io.remove(partial); // a stale partial of an already complete part
      await io.remove(partialIdName(part.name));
      skipped++;
      done += part.sizeBytes;
      report(idx, 0, true);
      continue;
    }
    let attempt = 0; // corrupt-part attempts
    let netAttempt = 0; // consecutive transient failures without progress
    for (;;) {
      let have = (await io.size(partial)) || 0;
      if (have > 0) {
        // A partial left by another release (different SHA-256 in its sidecar) can never be continued.
        const id = await readPartialId(io, part).catch(() => null);
        if (id && id !== part.sha256) {
          await io.remove(partial);
          have = 0;
        }
      }
      if (have > part.sizeBytes) {
        await io.remove(partial); // cannot be a prefix of this part
        have = 0;
      }
      report(idx, have, false);
      if (have < part.sizeBytes) {
        try {
          await writePartialId(io, part);
          await io.download(partUrl(o.manifestUrl, part), partial, (written) => report(idx, Math.min(written, part.sizeBytes), false), o.isCancelled, { resumeFrom: have, expectedBytes: part.sizeBytes });
        } catch (e) {
          if (cancelled()) throw cancelledError();
          const after = (await io.size(partial)) || 0;
          const background = !!(o.isBackgrounded && o.isBackgrounded());
          if (!isTransientNetworkError(e) && !background) throw new Error(`הורדת ${part.name} נכשלה: ${e instanceof Error ? e.message : String(e)}`);
          if (after > have) netAttempt = 0; // progress was made: refill the retry budget
          if (background && o.whenForeground) {
            // Android cut the network while the app was not in the foreground: not the network's fault.
            if (o.onRetry) o.onRetry({ partIndex: idx, attempt: netAttempt, maxAttempts: maxNet, delayMs: 0, error: e, background: true });
            await o.whenForeground();
            if (cancelled()) throw cancelledError();
            await sleepCancellable(sleep, 1000, o.isCancelled);
            continue;
          }
          if (netAttempt >= maxNet) throw new Error(`הורדת ${part.name} נכשלה אחרי ${maxNet + 1} ניסיונות (ההורדה תמשיך מאותה נקודה): ${e instanceof Error ? e.message : String(e)}`);
          const delayMs = backoffDelayMs(netAttempt, o.backoffBaseMs, o.backoffCapMs);
          netAttempt++;
          if (o.onRetry) o.onRetry({ partIndex: idx, attempt: netAttempt, maxAttempts: maxNet, delayMs, error: e, background: false });
          await sleepCancellable(sleep, delayMs, o.isCancelled);
          continue;
        }
      }
      if (cancelled()) throw cancelledError();
      const got = (await io.size(partial)) || 0;
      if (got !== part.sizeBytes) {
        // The transfer ended "successfully" but short (a proxy cut it): keep it and continue from there.
        if (netAttempt++ >= maxNet) throw new Error(`הורדת ${part.name} הסתיימה קצרה (${got} מתוך ${part.sizeBytes} בתים)`);
        continue;
      }
      await io.rename(partial, part.name);
      await io.remove(partialIdName(part.name));
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
  // Seeded with what is already on disk: a retry's first report is the saved percentage, never 0%.
  let lastFraction = manifest.totalZipBytes ? Math.min(1, (await existingBytes(io, manifest)) / manifest.totalZipBytes) : 0;
  const keepAwake = o.keepAwake || ((fn) => fn());
  await downloadParts(io, manifest, {
    manifestUrl: o.manifestUrl,
    isCancelled: o.isCancelled,
    retries: o.retries,
    networkRetries: o.networkRetries,
    backoffBaseMs: o.backoffBaseMs,
    backoffCapMs: o.backoffCapMs,
    sleep: o.sleep,
    isBackgrounded: o.isBackgrounded,
    whenForeground: o.whenForeground,
    onRetry: (r) =>
      report({
        stage: NETWORK_RETRY_STAGE,
        fraction: lastFraction,
        detail: r.background ? 'ההורדה תמשיך כשתחזרו לאפליקציה' : `ניסיון ${r.attempt} מתוך ${r.maxAttempts} · בעוד ${Math.max(1, Math.round(r.delayMs / 1000))} שנ׳`,
      }),
    onProgress: (p) => {
      // Strictly monotonic: a transient drop / retry never moves the bar backwards.
      lastFraction = Math.max(lastFraction, p.totalBytes ? p.doneBytes / p.totalBytes : 0);
      report({
        stage: p.skipped ? 'ממשיך — חלק קיים' : 'מוריד…',
        fraction: p.totalBytes ? lastFraction : null,
        detail: formatPartProgress(p),
      });
    },
  });
  // Assembly + extraction are the heavy disk steps: the device must not sleep in the middle of them.
  await keepAwake(async () => {
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
  });
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
    rename: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    sha256: async (name) => {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', files.get(name));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    },
    download: async (url, name, onProgress, isCancelled, resume) => {
      const from = (resume && resume.resumeFrom) || 0;
      const res = await (from > 0 ? doFetch(url, { headers: { Range: `bytes=${from}-` } }) : doFetch(url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 206 -> the server continues after `from`; 200 -> it ignored Range and sent the whole file.
      const resumed = from > 0 && res.status === 206 && files.has(name);
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = resumed ? [files.get(name)] : [];
      let got = resumed ? from : 0;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          if (isCancelled && isCancelled()) throw cancelledError();
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          files.set(name, concat(chunks)); // kept even if the stream breaks later: the next try resumes
          got += value.length;
          onProgress(got, total);
        }
      } else {
        chunks.push(new Uint8Array(await res.arrayBuffer()));
        got += chunks[resumed ? 1 : 0].length;
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
  PARTIAL_SUFFIX,
  NETWORK_RETRY_STAGE,
  partialName,
  partialIdName,
  existingBytes,
  isTransientNetworkError,
  backoffDelayMs,
  formatCloudNotification,
  downloadParts,
  assembleParts,
  extractZip,
  stageCloudLibrary,
  createMemoryIO,
};
