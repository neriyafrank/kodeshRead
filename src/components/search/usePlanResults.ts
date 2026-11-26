/**
 * Runs a search plan (shared/hebrewSearch.js) against the library PROGRESSIVELY (shared/searchStream.js): the
 * first rows of the fast core database are on screen at once, the rest streams in batch by batch (core, then the
 * extended pack, then personal books) up to STREAM_CAP while a subtle indicator shows that more are arriving;
 * cursor paging continues beyond the cap (exact matches first, then expanded variants).
 * Shared by the Simple Search and Advanced Search screens.
 */
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { SearchPlan } from '../../../shared/hebrewSearch';
import { searchPlan, type PlanCursor, type SearchRow, type SearchScope } from '../../../shared/search';
import { initialLifecycle, lifecycleReducer, viewOf } from '../../../shared/searchLifecycle';
import { createSearchSession, streamPlan } from '../../../shared/searchStream';
import { useLibrary } from '../../db/LibraryContext';
import { cancelPrefetch } from '../../services/searchPrefetch';

export interface PlanResults {
  key: string;
  rows: SearchRow[];
  terms: string[];
  hasMore: boolean;
  cursor: PlanCursor | null;
  count: { count: number; capped: boolean } | null;
  elapsed: number;
  error?: string;
}

export const scopeKey = (s: SearchScope) =>
  s.kind === 'all' ? 'all' : s.kind === 'category' ? `c:${s.path}` : s.kind === 'books' ? `m:${s.ids.join(',')}` : `b:${s.bookId}`;

export const planKey = (plan: SearchPlan | null, scope: SearchScope) =>
  plan && !plan.empty ? JSON.stringify([plan.match, plan.exact?.match ?? null, plan.terms, plan.needsVerify, plan.proximity, scopeKey(scope)]) : '';

declare global {
  // Test hooks (Playwright e2e): slow the first batch / every later streamed batch down so the loading and
  // streaming states are deterministic (`__KODESHREAD_COUNT_DELAY_MS__` is the older name of the stream delay).
  var __KODESHREAD_SEARCH_DELAY_MS__: number | undefined;
  var __KODESHREAD_STREAM_DELAY_MS__: number | undefined;
  var __KODESHREAD_COUNT_DELAY_MS__: number | undefined;
  var __KODESHREAD_STREAM_BATCH__: number | undefined;
}

/** Waits `ms` (test hook), ending early when the request is cancelled. */
const testDelay = (ms: number | undefined, signal: AbortSignal) =>
  ms && ms > 0
    ? new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      })
    : Promise.resolve();

/** Lets the loading state paint before any heavy JS / DB work starts. */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame;
    if (raf) raf(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 16);
  });

/** Between streamed batches: a paint (and the e2e stream delay). */
const betweenBatches = (signal: AbortSignal) => async () => {
  await nextFrame();
  await testDelay(globalThis.__KODESHREAD_STREAM_DELAY_MS__ ?? globalThis.__KODESHREAD_COUNT_DELAY_MS__, signal);
};

/**
 * `plan` null / empty = idle. `debounceMs` delays the first query (live typing). `runToken` re-runs the
 * same plan (Advanced Search's "חפש" / "חפש שוב").
 *
 * Every run owns a searchId + AbortController (createSearchSession): starting a newer query or pressing ביטול
 * aborts the stream at its next batch boundary, and the reducer drops any batch of a superseded id, so stale
 * rows are never merged into the newer results.
 *
 * Only a focused screen searches: a search screen covered by the reader (expo-router keeps it mounted) stops
 * its stream and never re-runs the shared query in the background; back on top it re-runs only when its
 * results are not those of the current query.
 */
export function usePlanResults(plan: SearchPlan | null, scope: SearchScope, debounceMs: number, runToken?: unknown) {
  const { adapter, fts } = useLibrary();
  const [life, dispatch] = useReducer(lifecycleReducer, undefined, initialLifecycle);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const session = useRef(createSearchSession());
  const key = planKey(plan, scope);
  const idle = !plan || plan.empty;
  const focused = useIsFocused();
  /** The inputs of the last run that finished: refocusing with the same inputs re-runs nothing. */
  const completed = useRef<{ key: string; runToken: unknown; retry: number; adapter: unknown; fts: boolean } | null>(null);

  useEffect(() => {
    if (!focused) return; // covered screen: the previous run was stopped by the cleanup, nothing new starts
    const c = completed.current;
    if (c && c.key === key && c.runToken === runToken && c.retry === retry && c.adapter === adapter && c.fts === fts) return;
    const { searchId: id, signal } = session.current.begin(); // aborts the previous run
    completed.current = null; // the reducer now belongs to this run
    if (!plan || plan.empty) return;
    cancelPrefetch(); // a new search: background prefetching of the old results stops at once
    // Loading state first (stage metadata + timer origin), work after the next paint.
    dispatch({ type: 'start', id, key, now: Date.now() });
    const live = () => !signal.aborted && session.current.isCurrent(id);
    const onProgress = (p: { stage: 'verify' | 'count'; scanned: number }) => live() && dispatch({ type: 'progress', id, stage: p.stage, scanned: p.scanned });
    const timer = setTimeout(async () => {
      let t0 = Date.now();
      const base = () => ({ key, terms: plan.terms, elapsed: Date.now() - t0 });
      try {
        await nextFrame();
        await testDelay(globalThis.__KODESHREAD_SEARCH_DELAY_MS__, signal as AbortSignal);
        if (!live()) return;
        t0 = Date.now(); // "N תוצאות · 12 ms" = time to the first rows, not the paint / test delay
        const batch = globalThis.__KODESHREAD_STREAM_BATCH__;
        let firstAt = 0;
        const res = await streamPlan(adapter, plan, {
          scope,
          fts,
          signal,
          searchId: id,
          isCurrent: session.current.isCurrent,
          firstBatch: batch,
          batchSize: batch,
          onProgress,
          pause: betweenBatches(signal as AbortSignal),
          onBatch: (b) => {
            if (!firstAt) firstAt = Date.now() - t0;
            if (live() && b.searchId === id) dispatch({ type: 'batch', id: b.searchId, base: { key, terms: plan.terms, elapsed: firstAt }, rows: b.rows, cursor: b.cursor });
          },
        });
        if (!live()) return;
        dispatch({ type: 'end', id, base: { ...base(), elapsed: firstAt || Date.now() - t0 }, count: { count: res.total, capped: res.capped }, hasMore: res.hasMore, cursor: res.cursor });
        completed.current = { key, runToken, retry, adapter, fts };
      } catch (e) {
        if (!live() || (e as Error)?.name === 'AbortError') return;
        console.warn('search failed', e);
        const error = e instanceof Error ? e.message : String(e);
        dispatch({ type: 'end', id, base: { ...base(), elapsed: 0, error }, count: { count: 0, capped: false }, hasMore: false, cursor: null });
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      session.current.cancel();
    };
    // `key` captures everything about plan + scope that changes the results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, fts, key, debounceMs, runToken, retry, focused]);

  const { phase, current, shown } = viewOf(life, key, idle);
  const loading = phase === 'searching';
  const cancelled = phase === 'cancelled';

  /** ביטול: leaves the loading state at once, stops the stream, ignores whatever still arrives. */
  const cancel = useCallback(() => {
    session.current.cancel();
    dispatch({ type: 'cancel', id: life.id });
  }, [life.id]);
  const rerun = useCallback(() => setRetry((n) => n + 1), []);

  const loadMore = useCallback(async () => {
    if (!plan || !current || !current.hasMore || loadingMore || life.counting || life.streaming) return;
    const id = life.id;
    setLoadingMore(true);
    try {
      const page = await searchPlan(adapter, plan, { scope, fts, cursor: current.cursor });
      if (session.current.current() === id) dispatch({ type: 'more', id, rows: page.rows, hasMore: page.hasMore, cursor: page.cursor });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') console.warn('search paging failed', e);
    } finally {
      setLoadingMore(false);
    }
  }, [adapter, current, fts, life.counting, life.streaming, life.id, loadingMore, plan, scope]);

  const streaming = !!current && life.streaming;
  return {
    current,
    shown,
    loading,
    cancelled,
    cancel,
    rerun,
    loadMore,
    loadingMore,
    idle,
    /** Rows are on screen and more are still arriving (progressive search). */
    streaming,
    /** Older name of `streaming` (the total is still resolving). */
    counting: streaming,
    progress: { stage: life.stage, scanned: life.scanned, startedAt: life.startedAt },
  };
}

/** "25 תוצאות · 12 ms" (or "40+ תוצאות · מחפש עוד…" while results are still streaming in). */
export function countLabel(r: PlanResults, streaming = false): string {
  const n = r.count && !streaming ? `${r.count.count}${r.count.capped ? '+' : ''}` : `${r.rows.length}+`;
  return `${n} תוצאות · ${r.elapsed} ms${streaming ? ' · מחפש עוד…' : ''}`;
}
