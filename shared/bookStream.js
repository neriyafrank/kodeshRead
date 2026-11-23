/**
 * Streaming text input for book ingestion (no dependencies; shared by the device indexer and the
 * self-tests). A book is never held in memory as one string: it is read in byte chunks, decoded
 * incrementally and cut into lines, so peak memory per book is one chunk + one line, whatever the
 * file size (some Otzaria books are tens of MB).
 *
 *   createUtf8Decoder()        bytes -> text, multi-byte sequences split across chunks handled
 *   createLineSplitter(opts)   text chunks -> physical lines with exactly the semantics of
 *                              raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
 *   openTextReader(open, opts) a byte source ({ read(n) -> Uint8Array, close() }) -> text chunks
 */
'use strict';

/** Longest physical line accepted (a "book" with no line breaks is not an Otzaria text). */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/**
 * Bytes per read on the device. Decoding a chunk is the one JS step that is not interrupted by an
 * awaited insert (the parser yields every 150 paragraphs), so it is kept small: 64KB decodes in a
 * few milliseconds even with the pure-JS decoder, and a 30MB book is still only ~470 reads.
 */
const DEFAULT_CHUNK_BYTES = 64 * 1024;

class LineTooLongError extends Error {
  constructor(max) {
    super(`שורה ארוכה מדי (מעל ${Math.round(max / 1024 / 1024)}M תווים) — הקובץ אינו ספר טקסט תקין`);
    this.name = 'LineTooLongError';
  }
}

/**
 * Incremental UTF-8 decoder. Uses the platform TextDecoder when available (stream mode), else a
 * small pure-JS decoder (Hermes builds without TextDecoder). Invalid bytes decode to U+FFFD.
 */
function createUtf8Decoder(opts) {
  const forceJs = opts && opts.forceJs;
  if (!forceJs && typeof TextDecoder === 'function') {
    try {
      const td = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
      return {
        write: (bytes) => td.decode(bytes, { stream: true }),
        end: () => td.decode(),
      };
    } catch {
      // fall through to the JS decoder
    }
  }
  let pending = null; // bytes of an incomplete trailing sequence
  const CHUNK = 8192;
  const decode = (bytes, final) => {
    let buf = bytes;
    if (pending && pending.length) {
      buf = new Uint8Array(pending.length + bytes.length);
      buf.set(pending, 0);
      buf.set(bytes, pending.length);
      pending = null;
    }
    let out = '';
    const units = [];
    const flushUnits = () => {
      out += String.fromCharCode.apply(null, units);
      units.length = 0;
    };
    let i = 0;
    const n = buf.length;
    while (i < n) {
      const b = buf[i];
      let need = 0;
      let cp = 0;
      if (b < 0x80) {
        units.push(b);
        i++;
        if (units.length >= CHUNK) flushUnits();
        continue;
      } else if (b >= 0xc2 && b <= 0xdf) {
        need = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        need = 2;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        need = 3;
        cp = b & 0x07;
      } else {
        units.push(0xfffd);
        i++;
        continue;
      }
      if (i + need >= n) {
        // The sequence continues in the next chunk: keep its bytes (when they are still valid).
        if (!final) {
          let ok = true;
          for (let k = i + 1; k < n; k++) if ((buf[k] & 0xc0) !== 0x80) ok = false;
          if (ok) {
            pending = buf.slice(i);
            break;
          }
        }
        units.push(0xfffd);
        i++;
        continue;
      }
      let valid = true;
      for (let k = 1; k <= need; k++) {
        const c = buf[i + k];
        if ((c & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (c & 0x3f);
      }
      // Overlong / surrogate / out-of-range forms are invalid.
      if (valid && ((need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)))) valid = false;
      if (!valid) {
        units.push(0xfffd);
        i++;
        continue;
      }
      if (cp >= 0x10000) {
        const v = cp - 0x10000;
        units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else {
        units.push(cp);
      }
      i += need + 1;
      if (units.length >= CHUNK) flushUnits();
    }
    if (units.length) flushUnits();
    return out;
  };
  return {
    write: (bytes) => decode(bytes, false),
    end: () => {
      if (!pending || !pending.length) return '';
      const p = pending;
      pending = null;
      return decode(p, true);
    },
  };
}

/**
 * Cuts text chunks into physical lines: a leading BOM is dropped, "\r\n" and a lone "\r" end a line
 * like "\n" (also when "\r" and "\n" arrive in different chunks). `push(text)` returns the lines
 * completed so far; `end()` returns the last line (possibly empty). Line numbers therefore match
 * text.split('\n') of the normalized whole text exactly.
 */
function createLineSplitter(opts) {
  const max = (opts && opts.maxLineChars) || MAX_LINE_CHARS;
  let carry = '';
  let started = false;
  let skipLF = false; // the previous chunk ended with "\r"
  const check = () => {
    if (carry.length > max) throw new LineTooLongError(max);
  };
  return {
    push(text) {
      let t = String(text || '');
      if (!t) return [];
      if (!started) {
        started = true;
        if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      }
      if (skipLF) {
        skipLF = false;
        if (t.charCodeAt(0) === 10) t = t.slice(1);
      }
      const lines = [];
      let from = 0;
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        lines.push(carry + t.slice(from, i));
        carry = '';
        if (c === 13) {
          if (i + 1 < t.length) {
            if (t.charCodeAt(i + 1) === 10) i++;
          } else {
            skipLF = true;
          }
        }
        from = i + 1;
      }
      carry += t.slice(from);
      check();
      return lines;
    },
    end() {
      const last = carry;
      carry = '';
      return [last];
    },
  };
}

/**
 * Text-chunk reader over a byte source. `openBytes()` resolves to { read(n): Promise<Uint8Array>,
 * close() } (an expo-file-system FileHandle wrapper, or a node fd in tests). The reader yields
 * decoded strings, then null; close() is always safe to call (also after an error).
 */
async function openTextReader(openBytes, opts) {
  const chunkBytes = (opts && opts.chunkBytes) || DEFAULT_CHUNK_BYTES;
  const src = await openBytes();
  const dec = createUtf8Decoder(opts);
  let done = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await src.close();
    } catch {
      // already closed / never opened
    }
  };
  return {
    async read() {
      if (done) return null;
      for (;;) {
        const bytes = await src.read(chunkBytes);
        if (!bytes || !bytes.length) {
          done = true;
          const tail = dec.end();
          return tail ? tail : null;
        }
        const text = dec.write(bytes);
        if (text) return text;
      }
    },
    close,
  };
}

// ---------------------------------------------------------------------------
// Names of listed entries
// ---------------------------------------------------------------------------

const decodeName = (n) => {
  if (!/%[0-9A-F]{2}/i.test(n)) return n;
  try {
    return decodeURIComponent(n);
  } catch {
    return n;
  }
};
const lastSegment = (n) => {
  const cut = Math.max(n.lastIndexOf('/'), n.lastIndexOf(':'));
  return cut >= 0 ? n.slice(cut + 1) : n;
};

/** A reported entry name, URL-decoded and without any path / document-id prefix. */
function cleanName(name) {
  return lastSegment(decodeName(String(name || '')));
}

/**
 * File / folder name from its URI alone, or null when the URI does not carry it. Reading `name`
 * on a SAF (content://) entry is a synchronous content-provider query per file; for path-based
 * providers the document id already ends with the name:
 *   content://…/tree/primary%3AOtzaria/document/primary%3AOtzaria%2F%D7%AA%D7%A0%D7%9A -> "תנך"
 * Opaque ids ("msf:1234", "1234") -> null (ask the entry).
 */
function nameFromUri(uri) {
  const u = String(uri || '');
  if (!u) return null;
  if (u.startsWith('file:')) return lastSegment(decodeName(u.replace(/\/+$/, ''))) || null;
  const m = /\/document\/([^/?#]+)/.exec(u);
  if (!m) return null;
  const docId = decodeName(m[1]);
  const colon = docId.indexOf(':');
  if (colon < 0) return null;
  const rest = docId.slice(colon + 1).replace(/\/+$/, '');
  if (!rest || /^\d+$/.test(rest)) return null;
  return lastSegment(rest) || null;
}

module.exports = {
  cleanName,
  nameFromUri, MAX_LINE_CHARS, DEFAULT_CHUNK_BYTES, LineTooLongError, createUtf8Decoder, createLineSplitter, openTextReader };
