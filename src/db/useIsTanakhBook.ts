/**
 * Is the given book a Tanakh base book (shared/corpora.js 'tanach' preset: canonical תנ"ך title under the
 * תנ"ך / מקרא root, never a commentary or translation)? Used to show the טעמים switch only where cantillation
 * exists. Reads the cached library catalog; `enabled` defers building it until the sheet is opened.
 * Returns null while unknown.
 */
import { useMemo } from 'react';

import { inCorpus } from '../../shared/corpora';
import { useLibraryCatalog } from './useLibraryCatalog';

export function useIsTanakhBook(bookId: number | null | undefined, enabled = true): boolean | null {
  const catalog = useLibraryCatalog(enabled && bookId != null);
  return useMemo(() => {
    if (bookId == null || !catalog) return null;
    const book = catalog.bookInfos.find((b) => b.id === bookId);
    return book ? inCorpus(book, 'tanach', { isCommentary: catalog.isCommentary }) : false;
  }, [catalog, bookId]);
}
