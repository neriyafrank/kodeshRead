/**
 * "לימוד יומי" in the app: today's schedule (shared/dailyLearning.js, fully offline), mapped onto
 * the books of the open library and resolved to exact lines (chapter / verse, daf, mishnah, perek)
 * through their TOC headings and inline markers.
 *
 * Results are cached per (library generation, date, ארץ ישראל / חו"ל), so re-opening the Library
 * screen's card does not resolve again. A book missing from the library (the small sample DB has
 * no Mishnah or Rambam) comes back `available: false` and is shown greyed out, never thrown.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { computeDailyLearning, detectIl, resolveDailyLearning, type ResolvedSchedule, type ResolvedTarget } from '../../shared/dailyLearning';
import type { LibraryDb } from '../../shared/sources';
import { useLibrary } from '../db/LibraryContext';
import { useTabs } from '../state/tabsStore';

declare global {
  // e2e / QA only: pins "today" ("YYYY-MM-DD") so the schedule is deterministic.
  var __KODESHREAD_TODAY__: string | undefined;
  // e2e / QA only: pretends the device is in this IANA time zone ("Asia/Jerusalem" = ארץ ישראל, anything else = חו"ל).
  var __KODESHREAD_TZ__: string | undefined;
}

/**
 * ארץ ישראל or חו"ל, decided by the device's time zone (Asia/Jerusalem = Israel, else the Diaspora; Israel when the
 * zone cannot be read). There is no switch in the UI: it only changes the weekly parsha on some weeks of the year.
 */
export function deviceIsIsrael(): boolean {
  return detectIl(typeof globalThis.__KODESHREAD_TZ__ === 'string' ? globalThis.__KODESHREAD_TZ__ : undefined);
}

/** Today's local civil date (midnight). */
export function today(): Date {
  const pinned = globalThis.__KODESHREAD_TODAY__;
  const m = typeof pinned === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(pinned) : null;
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Re-renders when the date changes (next midnight, or when the app returns to the foreground). */
export function useToday(): Date {
  const [day, setDay] = useState(today);
  useEffect(() => {
    const refresh = () => setDay((prev) => (dateKey(prev) === dateKey(today()) ? prev : today()));
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5).getTime() - now.getTime();
    const timer = setTimeout(refresh, Math.max(1000, midnight));
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [day]);
  return day;
}

const cache = new Map<string, Promise<ResolvedSchedule>>();

/** Today's schedule resolved against the library (cached). */
export function loadDailyLearning(db: LibraryDb, generation: number, date: Date, il: boolean): Promise<ResolvedSchedule> {
  const key = `${generation}|${dateKey(date)}|${il ? 'il' : 'diaspora'}`;
  let hit = cache.get(key);
  if (!hit) {
    if (cache.size > 8) cache.clear();
    hit = resolveDailyLearning(db, computeDailyLearning(date, { il }));
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

export function useDailyLearning(): { schedule: ResolvedSchedule | null; error: string | null } {
  const { adapter, generation } = useLibrary();
  const il = deviceIsIsrael();
  const day = useToday();
  const [state, setState] = useState<{ key: string; schedule: ResolvedSchedule | null; error: string | null }>({ key: '', schedule: null, error: null });
  const key = `${generation}|${dateKey(day)}|${il}`;
  useEffect(() => {
    let alive = true;
    loadDailyLearning(adapter, generation, day, il).then(
      (schedule) => alive && setState({ key, schedule, error: null }),
      (e) => alive && setState({ key, schedule: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [adapter, generation, day, il, key]);
  // Keep showing the previous schedule while a new one (other location / day) resolves.
  return { schedule: state.schedule, error: state.key === key ? state.error : null };
}

/** Opens a resolved target in a tab (re-using the book's tab), highlighted. Returns false if unavailable. */
export function useOpenLearningTarget(): (t: ResolvedTarget) => boolean {
  const openBook = useTabs((s) => s.openBook);
  return useCallback(
    (t: ResolvedTarget) => {
      if (!t.available || t.bookId == null) return false;
      openBook({ bookId: t.bookId, bookTitle: t.libraryTitle ?? t.bookTitle }, { line: t.line ?? 1, highlight: true });
      return true;
    },
    [openBook],
  );
}
