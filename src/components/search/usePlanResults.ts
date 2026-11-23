/**
 * Runs a search plan (shared/hebrewSearch.js) against the library: first page, then the capped
 * match count, and cursor paging for more (exact matches first, then expanded variants).
 * Shared by the Simple Search and Advanced Search screens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SearchPlan } from '../../../shared/hebrewSearch';
import { countPlan, searchPlan, type PlanCursor, type SearchRow, type SearchScope } from '../../../shared/search';
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

/** `plan` null / empty = idle. `debounceMs` delays the first query (live typing). */
export function usePlanResults(plan: SearchPlan | null, scope: SearchScope, debounceMs: number) {
  const { adapter, fts } = useLibrary();
  const [results, setResults] = useState<PlanResults | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);
  const key = planKey(plan, scope);

  useEffect(() => {
    const id = ++requestId.current;
    if (!plan || plan.empty) return;
    const timer = setTimeout(async () => {
      const t0 = Date.now();
      try {
        const page = await searchPlan(adapter, plan, { scope, fts });
        if (id !== requestId.current) return;
        const elapsed = Date.now() - t0;
        const done = !page.hasMore;
        setResults({ key, rows: page.rows, terms: plan.terms, hasMore: page.hasMore, cursor: page.cursor, count: done ? { count: page.rows.length, capped: false } : null, elapsed });
        if (!done) {
          const count = await countPlan(adapter, plan, { scope, fts });
          if (id === requestId.current) setResults((r) => (r && r.key === key ? { ...r, count } : r));
        }
      } catch (e) {
        if (id !== requestId.current) return;
        console.warn('search failed', e);
        setResults({ key, rows: [], terms: plan.terms, hasMore: false, cursor: null, count: { count: 0, capped: false }, elapsed: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }, debounceMs);
    return () => clearTimeout(timer);
    // `key` captures everything about plan + scope that changes the results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, fts, key, debounceMs]);

  const idle = !plan || plan.empty;
  const current = !idle && results && results.key === key ? results : null;
  const loading = !idle && !current;
  // While a new query runs keep showing the previous results instead of flashing an empty list.
  const shown = current ?? (idle ? null : results);

  const loadMore = useCallback(async () => {
    if (!plan || !current || !current.hasMore || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const page = await searchPlan(adapter, plan, { scope, fts, cursor: current.cursor });
      if (id === requestId.current) setResults((r) => (r && r.key === current.key ? { ...r, rows: r.rows.concat(page.rows), hasMore: page.hasMore, cursor: page.cursor } : r));
    } catch (e) {
      console.warn('search paging failed', e);
    } finally {
      setLoadingMore(false);
    }
  }, [adapter, current, fts, loadingMore, plan, scope]);

  return { current, shown, loading, loadMore, loadingMore, idle };
}

/** "25 תוצאות · 12 ms" (or "40+ תוצאות" while counting). */
export function countLabel(r: PlanResults): string {
  const n = r.count ? `${r.count.count}${r.count.capped ? '+' : ''}` : `${r.rows.length}+`;
  return `${n} תוצאות · ${r.elapsed} ms`;
}
