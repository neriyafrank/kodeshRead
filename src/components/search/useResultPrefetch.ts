/**
 * Background prefetch of the visible / top search results (src/services/searchPrefetch.ts) once the search has
 * settled and the screen is idle. Fast scrolling pauses the queue; when the list rests again the visible results
 * are prefetched instead. A new search cancels it (usePlanResults), and so does opening a book (call cancelPrefetch
 * before navigating). Only the focused screen prefetches.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ViewToken } from '@shopify/flash-list';
import { useIsFocused } from 'expo-router';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { PREFETCH_TARGETS } from '../../../shared/prefetchCache';
import type { SearchRow } from '../../../shared/search';
import { useLibrary } from '../../db/LibraryContext';
import { runAfterRender } from '../../lib/perf';
import { cancelPrefetch, pausePrefetch, prefetchTargets } from '../../services/searchPrefetch';

/** Wait this long after the search settles (and after scrolling stops) before reading anything. */
const SETTLE_MS = 350;
/** px per ms above which scrolling counts as "fast" (prefetch paused). */
const FAST_SCROLL = 1.2;

export function useResultPrefetch(rows: SearchRow[], settledResults: boolean, resultKey: string) {
  const { adapter, generation } = useLibrary();
  // Only the screen on top prefetches (a covered copy of a search screen must not replace its run).
  const focused = useIsFocused();
  const settled = settledResults && focused;
  const visible = useRef<SearchRow[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef({ y: 0, t: 0 });
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const schedule = useCallback(
    (delay: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        runAfterRender(() => {
          const pool = visible.current.length ? visible.current : rowsRef.current;
          const targets = pool.slice(0, PREFETCH_TARGETS).map((r) => ({ bookId: r.book_id, line: r.line_index }));
          if (targets.length) prefetchTargets(adapter, generation, targets);
        });
      }, delay);
    },
    [adapter, generation],
  );

  // The search settled: prefetch after the UI is idle. A new key (new search) resets the visible set.
  useEffect(() => {
    visible.current = [];
    if (!settled || !rowsRef.current.length) return;
    schedule(SETTLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [settled, resultKey, schedule]);

  // Leaving the screen (while it is the one on top) stops the queue.
  const focusedRef = useRef(focused);
  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);
  useEffect(() => () => void (focusedRef.current && cancelPrefetch()), []);

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<SearchRow>[] }) => {
    visible.current = viewableItems.map((v) => v.item).filter(Boolean) as SearchRow[];
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      const now = Date.now();
      const dt = Math.max(1, now - last.current.t);
      const fast = Math.abs(y - last.current.y) / dt > FAST_SCROLL;
      last.current = { y, t: now };
      if (fast) pausePrefetch();
      // Resting again: prefetch what is visible now.
      if (settled) schedule(SETTLE_MS);
    },
    [schedule, settled],
  );

  return { onScroll, onViewableItemsChanged };
}
