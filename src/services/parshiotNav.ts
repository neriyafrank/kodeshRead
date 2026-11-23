/**
 * Parshiot & aliyot of an open Chumash book (shared/torahParshiot.js): the line of every verse,
 * computed once per book and library generation (two indexed queries), feeding the reader's
 * inline dividers and the TOC drawer's פרשות mode.
 */
import { useEffect, useMemo, useState } from 'react';

import { chumashBookOf, chumashVerseLines, dividerLines, parshiotWithLines, type ChumashBook, type LineDivider, type ResolvedParsha } from '../../shared/torahParshiot';
import { useLibrary } from '../db/LibraryContext';

const cache = new Map<string, Promise<Map<string, number>>>();

/** The Chumash book (בראשית..דברים) an open library book is, or null. */
export function useChumashBook(bookId: number, bookTitle: string): ChumashBook | null {
  const { bookIndex } = useLibrary();
  const categoryPath = bookIndex.books.get(bookId)?.categoryPath;
  return useMemo(() => chumashBookOf(bookTitle, categoryPath), [bookTitle, categoryPath]);
}

/** "chapter:verse" -> line for a Chumash book (null while loading, or when not a Chumash). */
export function useChumashLines(bookId: number, book: ChumashBook | null): Map<string, number> | null {
  const { adapter, generation } = useLibrary();
  const key = `${generation}|${bookId}`;
  const [state, setState] = useState<{ key: string; lines: Map<string, number> } | null>(null);
  useEffect(() => {
    if (!book) return;
    let alive = true;
    let p = cache.get(key);
    if (!p) {
      if (cache.size > 12) cache.clear();
      p = chumashVerseLines(adapter, bookId);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    p.then(
      (lines) => alive && setState({ key, lines }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [adapter, bookId, book, key]);
  return book && state?.key === key ? state.lines : null;
}

/** Inline parsha / aliyah dividers of a Chumash book: line -> divider (null when none). */
export function useChumashDividers(bookId: number, book: ChumashBook | null): Map<number, LineDivider> | null {
  const lines = useChumashLines(bookId, book);
  return useMemo(() => (book && lines ? dividerLines(book, lines) : null), [book, lines]);
}

/** The book's parshiot with resolved lines for the TOC's פרשות mode. */
export function useResolvedParshiot(bookId: number, book: ChumashBook | null): ResolvedParsha[] | null {
  const lines = useChumashLines(bookId, book);
  return useMemo(() => (book && lines ? parshiotWithLines(book, lines) : null), [book, lines]);
}
