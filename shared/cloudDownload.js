/**
 * Cloud library download engine: one resumable, verifiable download of a package's parts
 * (shared/multipart.js stages core_library.db.zip.part-NN / extended_library.db.zip.part-NN).
 *
 * Two layers, both pure and storage-agnostic (self-tested in Node, run in the browser e2e):
 *
 *   1. A TRANSFER ENGINE moves bytes. It downloads a queue of files, each into `<name>.partial`
 *      (continued with `Range: bytes=<on-disk size>-`, the redirect chain followed by hand so the
 *      Range header is re-sent to the final CDN URL), and renames a file once it has its exact
 *      size. It retries transient failures with exponential backoff, waits while the device is
 *      offline, and never deletes bytes on a network error. Engines:
 *        - createHttpEngine (here): fetch / node:http. The browser preview and the self-tests.
 *        - the Android WorkManager worker (modules/cloud-download, src/services/backgroundDownload.ts):
 *          OS-managed, keeps running with the screen off, the app in the background or killed.
 *        - the expo-file-system DownloadTask engine (iOS background NSURLSession, and Android builds
 *          without the native module).
 *      Contract (every method may return a promise):
 *        start(task)  task = { id, files: [{ name, url, partial, sizeBytes }] }. Idempotent: starting
 *                     the task that already runs (same id) attaches to it.
 *        stop()       stops the transfer; bytes already written stay in the partial file.
 *        poll()       -> { phase, taskId, fileName, fileBytes, retry, error }
 *                     phase: idle | running | retrying | waiting_for_network | completed | failed | stopped
 *
 *   2. The CONTROLLER (downloadPackage) owns the state machine the UI sees:
 *        idle -> downloading <-> waiting_for_network -> verifying -> completed
 *                     |  \-> paused (persisted; survives kill / reboot)      \-> error (diagnostic)
 *      It persists the state in `cloud-download.json` next to the parts, verifies every finished
 *      part's SHA-256 before it counts as done (a corrupt part is deleted and fetched again, at most
 *      `verifyRetries` times), and reports strictly monotonic, cumulative byte progress.
 *
 * Storage goes through `io` (shared/multipart.js PartsIO): size, remove, rename, sha256, openWrite,
 * readText, writeText.
 */
'use strict';

const STATES = Object.freeze({
  IDLE: 'idle',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  WAITING: 'waiting_for_network',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  ERROR: 'error',
});

/** The one persisted record of the running / paused cloud download (flow + per-package state). */
const STATE_FILE = 'cloud-download.json';
const STATE_VERSION = 1;
const PARTIAL_SUFFIX = '.partial';
const partialName = (name) => name + PARTIAL_SUFFIX;

/** Consecutive failed attempts WITHOUT a single new byte before the engine gives up with a diagnostic. */
const MAX_ATTEMPTS = 8;
const MAX_REDIRECTS = 10;

// ------------------------------------------------------------------------------------------------
// Errors & diagnostics
// ------------------------------------------------------------------------------------------------

const fmtInt = (n) => (n == null || !Number.isFinite(Number(n)) ? '?' : Math.round(Number(n)).toLocaleString('en-US'));

/** Host of a URL (never the signed query string of a CDN URL). */
function hostOf(url) {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * One line for "העתק פרטי שגיאה":
 * "CLOUD_DOWNLOAD_HTTP · core_library.db.zip.part-02 · HTTP 404 · 1,048,576 / 3,145,728 bytes · host … · reason".
 */
function formatDiagnostic(code, info) {
  const i = info || {};
  const bits = [`CLOUD_DOWNLOAD_${String(code || 'engine').toUpperCase()}`];
  if (i.file) bits.push(i.file);
  if (i.httpStatus) bits.push(`HTTP ${i.httpStatus}`);
  if (i.bytes != null || i.expected != null) bits.push(`${fmtInt(i.bytes)} / ${fmtInt(i.expected)} bytes`);
  if (i.attempts) bits.push(`${i.attempts} attempts`);
  if (i.host) bits.push(`host ${i.host}`);
  if (i.reason) bits.push(String(i.reason));
  return bits.join(' · ');
}

/** Readable Hebrew message of a fatal download error. */
function describeFailure(code, i) {
  const file = i.file || 'החלק';
  switch (code) {
    case 'http':
      if (i.httpStatus === 404) return `הקובץ ${file} לא נמצא בשרת (HTTP 404). ייתכן שהספרייה בענן עודכנה — רעננו את המסך ונסו שוב.`;
      if (i.httpStatus === 401 || i.httpStatus === 403) return `השרת דחה את הגישה ל-${file} (HTTP ${i.httpStatus}). נסו שוב מאוחר יותר.`;
      return `השרת החזיר שגיאה עבור ${file}${i.httpStatus ? ` (HTTP ${i.httpStatus})` : ''}${i.reason ? `: ${i.reason}` : ''}.`;
    case 'network':
      return `ההורדה נעצרה: אין חיבור יציב לשרת אחרי ${i.attempts || MAX_ATTEMPTS} ניסיונות. ההתקדמות נשמרה — לחצו ״המשך הורדה״ כשהרשת תחזור.`;
    case 'checksum':
      return `${file} פגום (SHA-256 לא תואם) גם אחרי ${i.attempts || 1} הורדות.`;
    case 'size':
      return `גודל ${file} בשרת שונה מהצפוי (${fmtInt(i.serverBytes)} במקום ${fmtInt(i.expected)} בתים). ייתכן שהספרייה בענן עודכנה — רעננו את המסך ונסו שוב.`;
    case 'range':
      return `השרת אינו מאפשר להמשיך את הורדת ${file} מאותה נקודה (Range)${i.reason ? `: ${i.reason}` : ''}.`;
    case 'disk':
      return `שמירת ${file} נכשלה: ${i.reason || 'אין מספיק מקום פנוי'}.`;
    default:
      return `הורדת ${file} נכשלה${i.reason ? `: ${i.reason}` : ''}.`;
  }
}

/** A fatal (non-retryable) download failure, with a structured diagnostic. */
class DownloadError extends Error {
  constructor(code, info, message) {
    const i = info || {};
    super(message || describeFailure(code, i));
    this.name = 'DownloadError';
    this.code = code;
    this.info = i;
    this.diagnostic = formatDiagnostic(code, i);
  }
}

/** The download stopped because the user paused it; its progress is saved. */
class DownloadPausedError extends Error {
  constructor(snapshot) {
    super('paused');
    this.name = 'DownloadPausedError';
    this.paused = true;
    this.snapshot = snapshot || null;
  }
}

const isPausedError = (e) => !!(e && e.paused === true && e.name === 'DownloadPausedError');
const cancelledError = () => new Error('cancelled');

/** Rebuilds a DownloadError from its plain form ({ code, info }), e.g. one reported by the native worker. */
function downloadErrorFrom(plain) {
  if (plain instanceof DownloadError) return plain;
  const p = plain || {};
  return new DownloadError(p.code || 'engine', p.info || {}, p.message || undefined);
}

const TRANSIENT_RE =
  /unable to resolve host|no address associated|unknownhost|enotfound|eai_again|econnreset|econnaborted|econnrefused|etimedout|ehostunreach|enetunreach|enetdown|epipe|time[d ]?-?out|connection (?:dropped|reset|closed|aborted|lost|refused)|connect(?:ion)? failed|failed to connect|failed to fetch|load failed|software caused connection abort|unexpected end of stream|stream was reset|socket|network|offline|internet|ssl|handshake|premature|broken pipe|short body|http (?:408|429|5\d\d)\b/i;

/**
 * True for an error worth retrying: DNS / connectivity loss, resets, timeouts, 5xx / 429. HTTP 404 / 403, a full disk
 * or a cancellation are not transient.
 */
function isTransientNetworkError(e) {
  if (e instanceof DownloadError) return false;
  const msg = e instanceof Error ? e.message : String(e == null ? '' : e);
  if (!msg || /^cancelled$/i.test(msg) || /enospc|no space left/i.test(msg)) return false;
  return TRANSIENT_RE.test(msg);
}

/** Exponential backoff: base * 2^attempt (attempt 0-based), capped. 2 s, 4 s, 8 s, 16 s, 30 s, 30 s, ... */
function backoffDelayMs(attempt, baseMs = 2000, capMs = 30000) {
  return Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One macrotask: a poll loop always lets I/O run, even with an injected sleep that resolves at once. */
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

/** Start byte of a `Content-Range: bytes 100-999/1000` header (null when absent / unparsable) and its total. */
function parseContentRange(value) {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(String(value || ''));
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

// ------------------------------------------------------------------------------------------------
// HTTP transfer engine (fetch / node:http)
// ------------------------------------------------------------------------------------------------

/** `fetch` as the engine's `request(url, { headers, signal })`: redirects are returned to the engine, not followed. */
function fetchRequest(doFetch) {
  const f = doFetch || ((...a) => fetch(...a));
  return async (url, { headers, signal }) => {
    let res;
    try {
      // Browsers hide a manual redirect's Location (opaqueredirect): there the browser follows it, keeping Range.
      res = await f(url, { headers, signal, cache: 'no-store', redirect: typeof window === 'undefined' ? 'manual' : 'follow' });
    } catch (e) {
      if (signal && signal.aborted) throw cancelledError();
      throw e;
    }
    return res;
  };
}

/** Async iterator over a response body: web ReadableStream, node stream / async iterable, or arrayBuffer(). */
async function* bodyChunks(res) {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.length) yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // stream already errored / cancelled
      }
    }
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const c of body) if (c && c.length) yield c instanceof Uint8Array ? c : new Uint8Array(c);
    return;
  }
  if (typeof res.arrayBuffer === 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length) yield buf;
  }
}

function discardBody(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') void res.body.cancel().catch(() => undefined);
    else if (res && res.body && typeof res.body.destroy === 'function') res.body.destroy();
  } catch {
    // ignore
  }
}

/**
 * The JS transfer engine. `opts`:
 *   io                PartsIO
 *   request(url, { headers, signal }) -> Response-like { status, headers.get(name), body }  (default: fetch)
 *   connectivity      { isOnline() -> boolean | Promise<boolean> }  (default: always online)
 *   sleep(ms), backoffBaseMs, backoffCapMs, maxAttempts, onlinePollMs
 */
function createHttpEngine(opts) {
  const o = opts || {};
  const io = o.io;
  const request = o.request || fetchRequest(o.fetch);
  const sleep = o.sleep || defaultSleep;
  const maxAttempts = o.maxAttempts == null ? MAX_ATTEMPTS : o.maxAttempts;
  const isOnline = async () => {
    if (!o.connectivity) return true;
    try {
      return !!(await o.connectivity.isOnline());
    } catch {
      return true;
    }
  };
  let run = null; // { id, stopped, abort, promise, status }

  const newStatus = (id) => ({ phase: 'idle', taskId: id, fileName: null, fileBytes: 0, retry: null, error: null });

  async function sleepStoppable(r, ms) {
    for (let left = ms; left > 0 && !r.stopped; left -= 250) await sleep(Math.min(250, left));
    await yieldToEventLoop();
  }

  /** One HTTP exchange into the partial; returns the partial's size afterwards. Throws DownloadError (fatal) or a transient Error. */
  async function fetchInto(r, file, offset, counters) {
    const headers = { 'Accept-Encoding': 'identity' };
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    r.abort = () => ctl && ctl.abort();
    let url = file.url;
    let res;
    for (let hop = 0; ; hop++) {
      res = await request(url, { headers, signal: ctl ? ctl.signal : undefined });
      const s = res.status;
      if (s >= 300 && s < 400 && s !== 304) {
        const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
        discardBody(res);
        if (!loc) throw new DownloadError('http', { file: file.name, httpStatus: s, host: hostOf(url), reason: 'redirect without Location' });
        if (hop >= MAX_REDIRECTS) throw new DownloadError('http', { file: file.name, httpStatus: s, host: hostOf(url), reason: 'too many redirects' });
        url = new URL(loc, url).toString(); // the next hop gets the SAME Range header
        continue;
      }
      break;
    }
    const status = res.status;
    const info = { file: file.name, httpStatus: status, bytes: offset, expected: file.sizeBytes, host: hostOf(url) };
    if (status === 416) {
      discardBody(res);
      // Our offset is past the end of the server's file: the partial is not a prefix of it. Start this file over once.
      if (counters.restarts++ >= 1) throw new DownloadError('range', { ...info, reason: 'HTTP 416 twice' });
      await io.remove(file.partial);
      return 0;
    }
    if (status === 408 || status === 429 || status >= 500) {
      discardBody(res);
      throw new Error(`HTTP ${status}`);
    }
    if (status !== 200 && status !== 206) {
      discardBody(res);
      throw new DownloadError('http', info);
    }
    let append = false;
    let start = 0;
    const header = (n) => (res.headers && res.headers.get ? res.headers.get(n) : null);
    if (status === 206) {
      const cr = parseContentRange(header('content-range'));
      start = cr ? cr.start : offset;
      if (cr && cr.total != null && cr.total !== file.sizeBytes) {
        discardBody(res);
        throw new DownloadError('size', { ...info, serverBytes: cr.total });
      }
      if (start !== offset && start !== 0) {
        discardBody(res);
        throw new DownloadError('range', { ...info, reason: `Content-Range starts at ${start}, expected ${offset}` });
      }
      append = start > 0;
    } else {
      const len = Number(header('content-length'));
      if (len > 0 && len !== file.sizeBytes) {
        discardBody(res);
        throw new DownloadError('size', { ...info, serverBytes: len });
      }
      if (offset > 0) {
        // The server ignored Range (or a proxy stripped it): the body is the whole file. Nothing else can be done
        // but writing it from the start; a server that keeps doing it is reported instead of looping.
        if (counters.restarts++ >= 2) {
          discardBody(res);
          throw new DownloadError('range', { ...info, reason: 'the server ignores Range (HTTP 200)' });
        }
      }
    }
    let written = append ? start : 0;
    r.status.fileBytes = written;
    let w;
    try {
      w = await io.openWrite(file.partial, append);
    } catch (e) {
      discardBody(res);
      throw new DownloadError('disk', { ...info, reason: e instanceof Error ? e.message : String(e) });
    }
    try {
      for await (const chunk of bodyChunks(res)) {
        if (r.stopped) break;
        if (written + chunk.length > file.sizeBytes) throw new DownloadError('size', { ...info, serverBytes: written + chunk.length, reason: 'the server sent more bytes than the manifest size' });
        try {
          await w.write(chunk);
        } catch (e) {
          throw new DownloadError('disk', { ...info, bytes: written, reason: e instanceof Error ? e.message : String(e) });
        }
        written += chunk.length;
        r.status.fileBytes = written;
      }
    } catch (e) {
      if (r.stopped) return written;
      if (e instanceof DownloadError) throw e;
      if (e && /abort/i.test(String(e.name || e.message))) throw new Error('connection aborted');
      throw e;
    } finally {
      await w.close();
    }
    return written;
  }

  async function transferFile(r, file) {
    const counters = { restarts: 0 };
    let failures = 0;
    for (;;) {
      if (r.stopped) return;
      const done = await io.size(file.name);
      if (done === file.sizeBytes) return;
      if (done != null) await io.remove(file.name); // a wrong-size leftover never counts
      let have = (await io.size(file.partial)) || 0;
      if (have > file.sizeBytes) {
        await io.remove(file.partial); // cannot be a prefix of this file
        have = 0;
      }
      r.status.fileName = file.name;
      r.status.fileBytes = have;
      if (have === file.sizeBytes) {
        await io.rename(file.partial, file.name);
        return;
      }
      r.status.phase = 'running';
      let error = null;
      try {
        await fetchInto(r, file, have, counters);
      } catch (e) {
        if (r.stopped) return;
        if (e instanceof DownloadError) throw e;
        error = e;
      }
      if (r.stopped) return;
      const after = (await io.size(file.partial)) || 0;
      if (after > have) failures = 0; // progress refills the retry budget: a flaky link is never abandoned
      if (!error && after >= file.sizeBytes) continue; // complete: renamed at the top of the loop
      const reason = error ? (error instanceof Error ? error.message : String(error)) : `short body (${after} of ${file.sizeBytes} bytes)`;
      if (!(await isOnline())) {
        // Airplane mode / no network: a clean waiting state, not an attempt. Resumes from the saved bytes.
        r.status.phase = 'waiting_for_network';
        r.status.retry = { attempt: 0, maxAttempts, delayMs: 0, reason, offline: true };
        while (!r.stopped && !(await isOnline())) await sleepStoppable(r, o.onlinePollMs || 1000);
        continue;
      }
      if (failures >= maxAttempts) throw new DownloadError('network', { file: file.name, bytes: after, expected: file.sizeBytes, attempts: failures + 1, host: hostOf(file.url), reason });
      const delayMs = backoffDelayMs(failures, o.backoffBaseMs, o.backoffCapMs);
      failures++;
      r.status.phase = 'retrying';
      r.status.retry = { attempt: failures, maxAttempts, delayMs, reason, offline: false };
      await sleepStoppable(r, delayMs);
    }
  }

  async function runTask(r, task) {
    try {
      for (const file of task.files) {
        if (r.stopped) break;
        await transferFile(r, file);
        r.status.retry = null;
      }
      r.status.phase = r.stopped ? 'stopped' : 'completed';
    } catch (e) {
      r.status.phase = r.stopped ? 'stopped' : 'failed';
      if (!r.stopped) r.status.error = e instanceof DownloadError ? e : new DownloadError('engine', { file: r.status.fileName, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      r.abort = null;
    }
  }

  return {
    kind: 'http',
    start(task) {
      if (run && run.id === task.id && !run.stopped && (run.status.phase === 'running' || run.status.phase === 'retrying' || run.status.phase === 'waiting_for_network' || run.status.phase === 'idle')) return;
      const r = { id: task.id, stopped: false, abort: null, status: newStatus(task.id), promise: null };
      r.status.phase = 'running';
      run = r;
      r.promise = runTask(r, task);
    },
    async stop() {
      const r = run;
      if (!r) return;
      r.stopped = true;
      if (r.abort) r.abort();
      await r.promise;
    },
    poll() {
      if (!run) return newStatus(null);
      const s = run.status;
      return { ...s, retry: s.retry ? { ...s.retry } : null };
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Android WorkManager status -> engine poll() (pure: self-tested; used by src/services/backgroundDownload.ts)
// ------------------------------------------------------------------------------------------------

/**
 * Maps `CloudDownload.status()` of modules/cloud-download (WorkInfo state + the worker's progress / output data) to
 * the engine contract's poll() result. `taskId` = the task this engine started (another task's work is ignored).
 *   RUNNING              the worker's own phase: running | retrying | waiting_for_network
 *   ENQUEUED / BLOCKED   queued; waiting_for_network when the device is offline (the CONNECTED constraint)
 *   SUCCEEDED            completed      FAILED   failed (+ the worker's diagnostic)      CANCELLED   stopped
 */
function phaseFromWorkStatus(s, taskId) {
  const st = s || {};
  const base = { taskId: st.task || null, fileName: st.fileName || null, fileBytes: Number(st.fileBytes) || 0, retry: null, error: null };
  if (!st.state || st.state === 'NONE' || (taskId && st.task && st.task !== taskId)) return { ...base, phase: 'idle' };
  switch (st.state) {
    case 'RUNNING': {
      const phase = st.phase === 'retrying' || st.phase === 'waiting_for_network' ? st.phase : 'running';
      const retry =
        phase === 'retrying'
          ? { attempt: Number(st.attempt) || 1, maxAttempts: MAX_ATTEMPTS, delayMs: Number(st.delayMs) || 0, reason: st.reason || null, offline: false }
          : phase === 'waiting_for_network'
            ? { attempt: 0, maxAttempts: MAX_ATTEMPTS, delayMs: 0, reason: st.reason || null, offline: true }
            : null;
      return { ...base, phase, retry };
    }
    case 'ENQUEUED':
    case 'BLOCKED':
      return st.network === false ? { ...base, phase: 'waiting_for_network', retry: { attempt: 0, maxAttempts: MAX_ATTEMPTS, delayMs: 0, reason: 'offline', offline: true } } : { ...base, phase: 'queued' };
    case 'SUCCEEDED':
      return { ...base, phase: 'completed' };
    case 'CANCELLED':
      return { ...base, phase: 'stopped' };
    case 'FAILED': {
      const e = st.error || {};
      const info = {
        file: e.file || null,
        httpStatus: Number(e.httpStatus) || 0,
        bytes: e.bytes == null ? null : Number(e.bytes),
        expected: e.expected == null ? null : Number(e.expected),
        attempts: Number(e.attempts) || 0,
        serverBytes: e.serverBytes == null || Number(e.serverBytes) < 0 ? null : Number(e.serverBytes),
        host: e.host || null,
        reason: e.reason || null,
      };
      return { ...base, phase: 'failed', error: new DownloadError(e.code || 'engine', info) };
    }
    default:
      return { ...base, phase: 'queued' };
  }
}

// ------------------------------------------------------------------------------------------------
// Persisted state
// ------------------------------------------------------------------------------------------------

/** The saved download record, or null (missing / unreadable / another format). */
async function readDownloadState(io) {
  try {
    if ((await io.size(STATE_FILE)) == null) return null;
    const s = JSON.parse(await io.readText(STATE_FILE));
    return s && s.v === STATE_VERSION && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

/** Writes the record (io.writeText is atomic: temp file + rename). */
async function writeDownloadState(io, state) {
  await io.writeText(STATE_FILE, JSON.stringify({ ...state, v: STATE_VERSION, updatedAt: new Date().toISOString() }));
}

async function clearDownloadState(io) {
  await io.remove(STATE_FILE);
}

/** Merges `patch` into the record (creating it). */
async function patchDownloadState(io, patch) {
  const cur = (await readDownloadState(io)) || { v: STATE_VERSION, packages: {} };
  const next = { ...cur, ...patch, packages: { ...(cur.packages || {}), ...(patch.packages || {}) } };
  await writeDownloadState(io, next);
  return next;
}

// ------------------------------------------------------------------------------------------------
// Controller
// ------------------------------------------------------------------------------------------------

/**
 * Bytes of the package on disk (finished parts + each partial, sizes only; `live` = the engine's in-flight file,
 * for backends that write the partial only at the end).
 */
async function bytesOnDisk(io, parts, live) {
  let sum = 0;
  for (const p of parts) {
    const full = await io.size(p.name);
    if (full === p.sizeBytes) {
      sum += full;
      continue;
    }
    let b = Math.min((await io.size(partialName(p.name))) || 0, p.sizeBytes);
    if (live && live.fileName === p.name) b = Math.max(b, Math.min(live.fileBytes || 0, p.sizeBytes));
    sum += b;
  }
  return sum;
}

/** Deletes every downloaded byte of a package (parts + partials). */
async function removePackageFiles(io, parts) {
  for (const p of parts) {
    await io.remove(p.name);
    await io.remove(partialName(p.name));
  }
}

/**
 * Downloads every part of `pkg` (a CloudPackageView: { kind, parts, totalZipBytes, fullZipSha256 }) and verifies it.
 *
 * opts:
 *   engine                    transfer engine (required)
 *   urlOf(part)               asset URL of a part
 *   isCancelled()             cancel: stops, deletes the package's bytes, throws Error('cancelled')
 *   isPauseRequested()        pause: stops, keeps the bytes, persists `paused`, resolves { status: 'paused' }
 *   onUpdate(snapshot)        { state, doneBytes, totalBytes, partIndex, partCount, retry, error }
 *   window                    { offset, total } of a multi-package flow (persisted overall progress)
 *   verifyRetries (2), pollMs (200), sleep
 * Throws DownloadError on a fatal failure (persisted as `error`, bytes kept).
 */
async function downloadPackage(io, pkg, opts) {
  const o = opts || {};
  const engine = o.engine;
  const sleep = o.sleep || defaultSleep;
  const pollMs = o.pollMs == null ? 200 : o.pollMs;
  const verifyRetries = o.verifyRetries == null ? 2 : o.verifyRetries;
  const kind = pkg.kind || 'core';
  const parts = pkg.parts;
  const total = pkg.totalZipBytes;
  const win = o.window || null;
  const taskId = `${kind}:${String(pkg.fullZipSha256).slice(0, 16)}`;
  const cancelled = () => !!(o.isCancelled && o.isCancelled());
  const pauseRequested = () => !!(o.isPauseRequested && o.isPauseRequested());

  // Partials belong to ONE release: those of another (or of an unknown) release can never be continued.
  const saved = await readDownloadState(io);
  let pkgState = saved && saved.packages && saved.packages[kind];
  if (!pkgState || pkgState.release !== pkg.fullZipSha256) {
    for (const p of parts) await io.remove(partialName(p.name));
    pkgState = { release: pkg.fullZipSha256, verified: {}, corrupt: {} };
  }
  pkgState = { verified: {}, corrupt: {}, ...pkgState };

  let high = 0; // strictly monotonic progress
  let last = null;
  const partIndexOf = (name) => {
    const i = parts.findIndex((p) => p.name === name);
    return i < 0 ? null : i + 1;
  };
  const snapshot = (state, extra) => ({ state, doneBytes: high, totalBytes: total, partIndex: 1, partCount: parts.length, retry: null, error: null, ...extra });
  const emit = (s) => {
    last = s;
    if (o.onUpdate) o.onUpdate(s);
  };
  const persist = (status, extra) =>
    patchDownloadState(io, {
      status,
      kind,
      progress: { done: (win ? win.offset : 0) + high, total: win ? win.total : total },
      error: null,
      ...extra,
      packages: { [kind]: { ...pkgState, status } },
    });
  const advance = (bytes) => {
    high = Math.max(high, Math.min(total, bytes));
    return high;
  };

  advance(await bytesOnDisk(io, parts));
  await persist(STATES.DOWNLOADING);
  emit(snapshot(STATES.DOWNLOADING));

  const stopFor = async (why) => {
    await engine.stop();
    advance(await bytesOnDisk(io, parts));
    if (why === 'cancel') {
      await removePackageFiles(io, parts);
      await patchDownloadState(io, { status: STATES.IDLE, packages: { [kind]: null } });
      throw cancelledError();
    }
    await persist(STATES.PAUSED);
    const s = snapshot(STATES.PAUSED, { partIndex: last ? last.partIndex : 1 });
    emit(s);
    return { status: 'paused', doneBytes: high, totalBytes: total };
  };

  const fetched = new Set(); // parts this run had to transfer (the rest were already on disk and valid)
  for (;;) {
    if (cancelled()) return stopFor('cancel');
    if (pauseRequested()) return stopFor('pause');

    // 1. Every part complete on disk is verified (once) before it counts; a corrupt one is fetched again.
    const pending = [];
    for (const [i, p] of parts.entries()) {
      const size = await io.size(p.name);
      if (size === p.sizeBytes && pkgState.verified[p.name] === p.sha256) continue;
      if (size === p.sizeBytes) {
        emit(snapshot(STATES.VERIFYING, { partIndex: i + 1 }));
        const digest = String(await io.sha256(p.name)).toLowerCase();
        if (digest === p.sha256) {
          pkgState.verified[p.name] = p.sha256;
          await persist(STATES.DOWNLOADING);
          continue;
        }
        await io.remove(p.name);
        const n = (pkgState.corrupt[p.name] || 0) + 1;
        pkgState.corrupt[p.name] = n;
        if (n > verifyRetries) {
          const err = new DownloadError('checksum', { file: p.name, bytes: size, expected: p.sizeBytes, attempts: n, reason: `sha256 ${digest.slice(0, 12)}… != ${p.sha256.slice(0, 12)}…` });
          await persist(STATES.ERROR, { error: { code: err.code, message: err.message, diagnostic: err.diagnostic } });
          emit(snapshot(STATES.ERROR, { partIndex: i + 1, error: err }));
          throw err;
        }
        await persist(STATES.DOWNLOADING);
      } else if (size != null) await io.remove(p.name);
      pending.push(p);
    }
    if (!pending.length) break;

    // 2. Transfer what is missing; watch the engine until it completes, fails or is stopped.
    await engine.start({ id: taskId, files: pending.map((p) => ({ name: p.name, url: o.urlOf(p), partial: partialName(p.name), sizeBytes: p.sizeBytes })) });
    for (const p of pending) fetched.add(p.name);
    for (;;) {
      if (cancelled()) return stopFor('cancel');
      if (pauseRequested()) return stopFor('pause');
      const st = (await engine.poll()) || { phase: 'idle' };
      advance(await bytesOnDisk(io, parts, st));
      const partIndex = partIndexOf(st.fileName) || (last ? last.partIndex : 1);
      if (st.phase === 'completed') break;
      if (st.phase === 'failed') {
        const err = downloadErrorFrom(st.error);
        await persist(STATES.ERROR, { error: { code: err.code, message: err.message, diagnostic: err.diagnostic } });
        emit(snapshot(STATES.ERROR, { partIndex, error: err }));
        throw err;
      }
      if (st.phase === 'stopped') {
        // Stopped outside the app (the notification's "השהה", the OS): a pause, the bytes are kept.
        await persist(STATES.PAUSED);
        emit(snapshot(STATES.PAUSED, { partIndex }));
        return { status: 'paused', doneBytes: high, totalBytes: total };
      }
      const waiting = st.phase === 'waiting_for_network' || st.phase === 'retrying';
      const s = snapshot(waiting ? STATES.WAITING : STATES.DOWNLOADING, { partIndex, retry: waiting ? st.retry || { attempt: 0, offline: true } : null });
      if (!last || last.state !== s.state || last.doneBytes !== s.doneBytes || last.partIndex !== s.partIndex || JSON.stringify(last.retry) !== JSON.stringify(s.retry)) {
        if (!last || last.state !== s.state) await persist(s.state === STATES.WAITING ? STATES.WAITING : STATES.DOWNLOADING);
        emit(s);
      }
      await sleep(pollMs);
      await yieldToEventLoop();
    }
  }
  advance(total);
  await persist(STATES.COMPLETED);
  emit(snapshot(STATES.COMPLETED, { partIndex: parts.length }));
  return { status: 'completed', doneBytes: total, totalBytes: total, downloaded: fetched.size, skipped: parts.length - fetched.size };
}

module.exports = {
  STATES,
  STATE_FILE,
  PARTIAL_SUFFIX,
  MAX_ATTEMPTS,
  partialName,
  DownloadError,
  DownloadPausedError,
  isPausedError,
  downloadErrorFrom,
  formatDiagnostic,
  hostOf,
  isTransientNetworkError,
  backoffDelayMs,
  parseContentRange,
  fetchRequest,
  createHttpEngine,
  phaseFromWorkStatus,
  readDownloadState,
  writeDownloadState,
  patchDownloadState,
  clearDownloadState,
  bytesOnDisk,
  removePackageFiles,
  downloadPackage,
};
