/**
 * Progressive (streaming) full-text search: results reach the UI batch by batch instead of after the
 * whole library was searched. Pure JS over the same plans / SQL as shared/search.js (searchPlan), shared
 * by the app (src/components/search/usePlanResults.ts) and scripts/selftest.js.
 *
 *   createSearchSession()  one cancellation token per run: begin() returns { searchId, signal } and
 *                          aborts the previous run; isCurrent(id) is false for a superseded / cancelled run
 *   streamPlan(db, plan, { onBatch, ... })
 *       phase by phase (exact matches first, then expanded-only variants), database by database in
 *       priority order (core first, then the extended pack, then personal / starter books), keyset
 *       batches by id. The first FIRST_BATCH rows are emitted immediately, later rows in STREAM_BATCH
 *       chunks; whatever one database found is emitted before the next database is queried, so core
 *       results never wait for the extended pack. Every emit carries the run's searchId and happens only
 *       while the run is current: a newer query or "ביטול" stops the loop at the next batch boundary and
 *       no row of a stale run is ever delivered. Stops at `maxRows` (STREAM_CAP, the same cap as the
 *       count) and returns a cursor that shared/search.js searchPlan() continues from (load more).
 */
'use strict';

const search = require('./search');
const hs = require('./hebrewSearch');

/** Rows streamed per run (the result count shows "1000+" beyond it; paging continues from the cursor). */
const STREAM_CAP = search.COUNT_CAP;
/** First emit: enough to fill the screen. */
const FIRST_BATCH = 20;
/** Later emits. */
const STREAM_BATCH = 100;

function abortError() {
  return Object.assign(new Error('search aborted'), { name: 'AbortError' });
}

/** Lets timers / painting run between batches (setTimeout 0 in Node and React Native). */
const yieldTick = () => new Promise((r) => setTimeout(r, 0));

/**
 * One cancellation token per search run. begin() aborts the run before it; cancel() aborts the current one.
 * `AbortController` is optional (a plain { aborted } flag works where it is missing).
 */
function createSearchSession() {
  let current = 0;
  let ctl = null;
  const makeCtl = () => {
    if (typeof AbortController === 'function') return new AbortController();
    const signal = { aborted: false };
    return { signal, abort: () => (signal.aborted = true) };
  };
  return {
    begin() {
      if (ctl) ctl.abort();
      current += 1;
      ctl = makeCtl();
      return { searchId: current, signal: ctl.signal };
    },
    cancel() {
      if (ctl) ctl.abort();
    },
    /** True while `id` is the latest run and was not cancelled. */
    isCurrent(id) {
      return id === current && !!ctl && !ctl.signal.aborted;
    },
    current: () => current,
  };
}

/**
 * Streams the matches of a plan (hebrewSearch.buildQuery()) in batches.
 *
 * @param {object} db  router or plain adapter
 * @param {object} plan
 * @param {{
 *   scope?: object, fts?: boolean, signal?: { aborted: boolean }, searchId?: number,
 *   isCurrent?: (id: number) => boolean,
 *   firstBatch?: number, batchSize?: number, maxRows?: number,
 *   onBatch?: (b: { searchId: number, rows: object[], total: number, batch: number, source: string, phase: number, cursor: { phase: number, afterId: number } }) => void,
 *   onProgress?: (p: { stage: 'verify', scanned: number }) => void,
 *   pause?: (batch: number) => Promise<void>,
 * }} [opts]
 * @returns {Promise<{ searchId: number, total: number, capped: boolean, hasMore: boolean, cursor: { phase: number, afterId: number } | null, batches: number, scanned: number }>}
 *   Rejects with an AbortError when the run was superseded / cancelled (nothing is emitted after that).
 */
async function streamPlan(db, plan, opts) {
  const o = opts || {};
  const searchId = o.searchId == null ? 0 : o.searchId;
  const live = () => !(o.signal && o.signal.aborted) && (!o.isCurrent || o.isCurrent(searchId));
  const check = () => {
    if (!live()) throw abortError();
  };
  const cap = Math.max(1, o.maxRows || STREAM_CAP);
  const first = Math.max(1, o.firstBatch || FIRST_BATCH);
  const size = Math.max(1, o.batchSize || STREAM_BATCH);
  const done = (extra) => ({ searchId, total, batches, scanned, capped: false, hasMore: false, cursor: null, ...extra });
  let total = 0;
  let batches = 0;
  let scanned = 0;
  if (!plan || plan.empty) return done();
  check();

  const phases = search.planPhases(plan, o.fts);
  const sources = search.scopeSources(db, o.scope);
  let pending = [];
  let lastEmitted = null;

  const emit = async (sourceName, phase) => {
    if (!pending.length) return;
    check(); // never deliver rows of a stale run
    const rows = pending;
    pending = [];
    total += rows.length;
    batches += 1;
    lastEmitted = rows[rows.length - 1];
    if (o.onBatch) o.onBatch({ searchId, rows, total, batch: batches, source: sourceName, phase, cursor: { phase: lastEmitted.phase, afterId: lastEmitted.id } });
    if (o.pause) await o.pause(batches);
    else await yieldTick();
    check();
  };
  const target = () => (batches === 0 ? first : size);

  for (let phase = 0; phase < phases.length; phase++) {
    const ph = phases[phase];
    for (const s of sources) {
      let afterId = null;
      for (;;) {
        check();
        // One row beyond the cap tells whether more results exist.
        const room = cap + 1 - total - pending.length;
        const take = ph.verify ? search.VERIFY_BATCH : Math.max(1, Math.min(room, target() - pending.length));
        const rows = await search.sourceCandidates(s.adapter, ph, o, afterId, take);
        check();
        for (const r of rows) {
          afterId = r.id;
          scanned += 1;
          if (ph.verify && !ph.verify(hs.toTokens(r.clean_text || ''))) continue;
          const { clean_text, ...row } = r;
          pending.push({ ...row, phase });
          if (total + pending.length > cap) {
            pending.pop(); // the extra row only proves there is more
            await emit(s.name, phase);
            return done({ capped: true, hasMore: true, cursor: { phase: lastEmitted.phase, afterId: lastEmitted.id } });
          }
          if (pending.length >= target()) await emit(s.name, phase);
        }
        if (rows.length < take) break; // this database is exhausted for this phase
        if (ph.verify) {
          if (o.onProgress) o.onProgress({ stage: 'verify', scanned });
          if (scanned >= search.MAX_COUNT_SCAN) {
            await emit(s.name, phase);
            return done({ capped: true, hasMore: true, cursor: { phase, afterId } });
          }
          await yieldTick();
        }
      }
      // Whatever this database found is shown before the next one is queried.
      await emit(s.name, phase);
    }
  }
  await emit('', phases.length - 1);
  return done();
}

module.exports = { STREAM_CAP, FIRST_BATCH, STREAM_BATCH, createSearchSession, streamPlan };
