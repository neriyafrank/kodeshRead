/**
 * Core-library releases (GitHub Releases), shared by the app's downloader
 * (src/services/coreLibrary.ts) and scripts/selftest.js.
 *
 *  - manifest.json validation and asset URL resolution
 *  - streaming decompression of .gz / .zip (fflate) or a plain .db, chunk by chunk, so a
 *    multi-GB library never has to fit in memory
 */
'use strict';

const { Gunzip, Unzip, UnzipInflate, UnzipPassThrough } = require('fflate');

const MANIFEST_FORMAT = 1;

/** True when the configured URL points at a library file rather than a manifest. */
function isDirectAssetUrl(url) {
  return /\.(db|gz|zip)(\?.*)?$/i.test(String(url || '').trim());
}

/** Resolves manifest.url / manifest.file against the manifest's own URL. */
function resolveAssetUrl(manifestUrl, manifest) {
  if (manifest.url && /^https?:\/\//i.test(manifest.url)) return manifest.url;
  const file = String(manifest.file || '');
  if (/^https?:\/\//i.test(file)) return file;
  const base = String(manifestUrl).replace(/[?#].*$/, '');
  return base.slice(0, base.lastIndexOf('/') + 1) + encodeURIComponent(file).replace(/%2F/gi, '/');
}

function compressionOf(nameOrUrl) {
  const n = String(nameOrUrl || '').toLowerCase().replace(/[?#].*$/, '');
  if (n.endsWith('.gz')) return 'gzip';
  if (n.endsWith('.zip')) return 'zip';
  return 'none';
}

/**
 * Validates a parsed manifest.json; throws a readable error for anything unusable.
 * @returns normalized { version, size, sha256, dbSize, compression, file, ... }
 */
function validateManifest(m, appSchemaVersion) {
  if (!m || typeof m !== 'object') throw new Error('manifest is not a JSON object');
  if (m.format != null && Number(m.format) > MANIFEST_FORMAT) throw new Error(`manifest format ${m.format} is newer than this app supports`);
  if (!m.version || typeof m.version !== 'string') throw new Error('manifest has no "version"');
  if (!m.file && !m.url) throw new Error('manifest has no "file" or "url"');
  if (m.schemaVersion != null && appSchemaVersion != null && Number(m.schemaVersion) > appSchemaVersion) {
    throw new Error(`this library needs a newer app (schema ${m.schemaVersion} > ${appSchemaVersion})`);
  }
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const out = {
    ...m,
    size: num(m.size),
    dbSize: num(m.dbSize),
    sha256: m.sha256 ? String(m.sha256).toLowerCase() : null,
    compression: m.compression || compressionOf(m.file || m.url),
  };
  if (out.sha256 && !/^[0-9a-f]{64}$/.test(out.sha256)) throw new Error('manifest "sha256" is not a SHA-256 hex digest');
  if (!['gzip', 'zip', 'none'].includes(out.compression)) throw new Error(`unsupported compression "${out.compression}"`);
  return out;
}

/** Sniffs the format from the first bytes (gzip 1f8b, zip PK\3\4, SQLite header). */
function detectFormat(head) {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  const sig = 'SQLite format 3';
  if (head.length >= sig.length && String.fromCharCode(...head.slice(0, sig.length)) === sig) return 'none';
  return null;
}

const OUT_FLUSH = 1 << 20; // coalesce decoder output into ~1 MB writes

/**
 * Streams `read()` -> decoder -> `write()`.
 *
 * @param {object} io
 *   read(n)   -> Promise<Uint8Array>   next chunk of the compressed input (empty at EOF)
 *   write(b)  -> Promise<void>         append decompressed bytes
 *   totalIn   compressed size (for progress), optional
 *   onProgress({ bytesIn, bytesOut, totalIn })
 *   isCancelled() -> boolean
 *   chunkSize (default 1 MB)
 *   format    'gzip' | 'zip' | 'none' | undefined (sniffed from the first chunk)
 * @returns {Promise<{ bytesIn: number, bytesOut: number, format: string, entry: string | null }>}
 */
async function decompressStream(io) {
  const chunkSize = io.chunkSize || 1 << 20;
  let bytesIn = 0;
  let bytesOut = 0;
  let pending = [];
  let pendingLen = 0;
  let error = null;
  let entry = null;
  const emit = (data) => {
    if (!data || !data.length) return;
    pending.push(data);
    pendingLen += data.length;
  };
  const flush = async (force) => {
    if (!pendingLen || (!force && pendingLen < OUT_FLUSH)) return;
    let buf;
    if (pending.length === 1) buf = pending[0];
    else {
      buf = new Uint8Array(pendingLen);
      let o = 0;
      for (const p of pending) {
        buf.set(p, o);
        o += p.length;
      }
    }
    pending = [];
    pendingLen = 0;
    await io.write(buf);
    bytesOut += buf.length;
  };

  let first = await io.read(chunkSize);
  bytesIn += first.length;
  const format = io.format || detectFormat(first);
  if (!format) throw new Error('downloaded file is not a .gz, .zip or SQLite database');

  let push;
  if (format === 'gzip') {
    const gz = new Gunzip((data) => emit(data));
    push = (chunk, final) => gz.push(chunk, final);
  } else if (format === 'zip') {
    const uz = new Unzip((file) => {
      // The first *.db / *.sqlite entry is the library.
      if (entry !== null || (/\/$/.test(file.name))) return;
      if (!/\.db$/i.test(file.name) && !/\.sqlite3?$/i.test(file.name)) return;
      entry = file.name;
      file.ondata = (err, data) => {
        if (err) error = err;
        else emit(data);
      };
      file.start();
    });
    uz.register(UnzipInflate);
    uz.register(UnzipPassThrough);
    push = (chunk, final) => uz.push(chunk, final);
  } else {
    push = (chunk) => emit(chunk);
  }

  let chunk = first;
  first = null;
  for (;;) {
    if (io.isCancelled && io.isCancelled()) throw new Error('cancelled');
    const next = chunk.length ? await io.read(chunkSize) : new Uint8Array(0);
    bytesIn += next.length;
    const final = next.length === 0;
    push(chunk, final);
    if (error) throw error;
    await flush(final);
    if (io.onProgress) io.onProgress({ bytesIn, bytesOut: bytesOut + pendingLen, totalIn: io.totalIn || null });
    if (final) break;
    chunk = next;
  }
  await flush(true);
  if (format === 'zip' && entry === null) throw new Error('the .zip contains no .db file');
  return { bytesIn, bytesOut, format, entry };
}

module.exports = { MANIFEST_FORMAT, isDirectAssetUrl, resolveAssetUrl, compressionOf, validateManifest, detectFormat, decompressStream };
