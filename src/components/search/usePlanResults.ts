/**
 * Runs a search plan (shared/hebrewSearch.js) against the library: first page, then the capped
 * match count, and cursor paging for more (exact matches first, then expanded variants).
 * Shared by the Simple Search and Advanced Search screens.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { SearchPlan } from '../../../shared/hebrewSearch';
import { countPlan, searchPlan, type PlanCursor, type SearchRow, type SearchScope } from '../../../shared/search';
import { createRequestCounter, initialLifecycle, lifecycleReducer, viewOf } from '../../../shared/searchLifecycle';
import { useLibrary } from '../../db/LibraryContext';

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
  s.kind === 'all' ? 'all' : s.kind === 'category' ? `c:${s.path}` : s.kind === 'corpus' ? `k:${s.ids.join(',')}` : s.kind === 'books' ? `m:${s.ids.join(',')}` : `b:${s.bookId}`;

export const planKey = (plan: SearchPlan | null, scope: SearchScope) =>
  plan && !plan.empty ? JSON.stringify([plan.match, plan.exact?.match ?? null, plan.terms, plan.needsVerify, plan.proximity, scopeKey(scope)]) : '';

declare global {
  // Test hooks (Playwright e2e): slow the first page / the count down so the loading state is deterministic.
  var __KODESHREAD_SEARCH_DELAY_MS__: number | undefined;
  var __KODESHREAD_COUNT_DELAY_MS__: number | undefined;
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

/**
 * `plan` null / empty = idle. `debounceMs` delays the first query (live typing). `runToken` re-runs the
 * same plan (Advanced Search's "חפש" / "חפש שוב").
 *
 * Every run owns a monotonic request id + AbortController (shared/searchLifecycle.js): starting a newer
 * query or pressing ביטול aborts the DB loop and discards late results.
 */
export function usePlanResults(plan: SearchPlan | null, scope: SearchScope, debounceMs: number, runToken?: unknown) {
  const { adapter, fts } = useLibrary();
  const [life, dispatch] = useReducer(lifecycleReducer, undefined, initialLifecycle);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const requests = useRef(createRequestCounter());
  const abort = useRef<AbortController | null>(null);
  const key = planKey(plan, scope);
  const idle = !plan || plan.empty;

  useEffect(() => {
    abort.current?.abort();
    const id = requests.current.next();
    if (!plan || plan.empty) return;
    const ctl = new AbortController();
    abort.current = ctl;
    // Loading state first (stage metadata + timer origin), work after the next paint.
    dispatch({ type: 'start', id, key, now: Date.now() });
    const live = () => !ctl.signal.aborted && requests.current.isCurrent(id);
    const onProgress = (p: { stage: 'verify' | 'count'; scanned: number }) => live() && dispatch({ type: 'progress', id, stage: p.stage, scanned: p.scanned });
    const timer = setTimeout(async () => {
      try {
        await nextFrame();
        await testDelay(globalThis.__KODESHREAD_SEARCH_DELAY_MS__, ctl.signal);
        if (!live()) return;
        const t0 = Date.now();
        const page = await searchPlan(adapter, plan, { scope, fts, signal: ctl.signal, onProgress });
        if (!live()) return;
        const done = !page.hasMore;
        dispatch({
          type: 'page',
          id,
          results: { key, rows: page.rows, terms: plan.terms, hasMore: page.hasMore, cursor: page.cursor, count: done ? { count: page.rows.length, capped: false } : null, elapsed: Date.now() - t0 },
        });
        if (!done) {
          // The first page is already on screen: the total resolves behind a subtle indicator.
          await testDelay(globalThis.__KODESHREAD_COUNT_DELAY_MS__, ctl.signal);
          if (!live()) return;
          const count = await countPlan(adapter, plan, { scope, fts, signal: ctl.signal, onProgress });
          if (live()) dispatch({ type: 'count', id, count });
        }
      } catch (e) {
        if (!live()) return;
        console.warn('search failed', e);
        dispatch({
          type: 'page',
          id,
          results: { key, rows: [], terms: plan.terms, hasMore: false, cursor: null, count: { count: 0, capped: false }, elapsed: 0, error: e instanceof Error ? e.message : String(e) },
        });
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // `key` captures everything about plan + scope that changes the results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, fts, key, debounceMs, runToken, retry]);

  const { phase, current, shown } = viewOf(life, key, idle);
  const loading = phase === 'searching';
  const cancelled = phase === 'cancelled';

  /** ביטול: leaves the loading state at once, stops the DB loop, ignores whatever still arrives. */
  const cancel = useCallback(() => {
    abort.current?.abort();
    dispatch({ type: 'cancel', id: life.id });
  }, [life.id]);
  const rerun = useCallback(() => setRetry((n) => n + 1), []);

  const loadMore = useCallback(async () => {
    if (!plan || !current || !current.hasMore || loadingMore || life.counting) return;
    const id = life.id;
    const signal = abort.current?.signal;
    setLoadingMore(true);
    try {
      const page = await searchPlan(adapter, plan, { scope, fts, cursor: current.cursor, signal });
      if (requests.current.isCurrent(id)) dispatch({ type: 'more', id, rows: page.rows, hasMore: page.hasMore, cursor: page.cursor });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') console.warn('search paging failed', e);
    } finally {
      setLoadingMore(false);
    }
  }, [adapter, current, fts, life.counting, life.id, loadingMore, plan, scope]);

  return { current, shown, loading, cancelled, cancel, rerun, loadMore, loadingMore, idle, counting: !!current && life.counting, progress: { stage: life.stage, scanned: life.scanned, startedAt: life.startedAt } };
}

/** "25 תוצאות · 12 ms" (or "40+ תוצאות" while counting). */
export function countLabel(r: PlanResults, counting = false): string {
  const n = r.count ? `${r.count.count}${r.count.capped ? '+' : ''}` : `${r.rows.length}+`;
  return `${n} תוצאות · ${r.elapsed} ms${counting ? ' · מחשב סך הכל…' : ''}`;
}
