/**
 * Preset corpora (shared/corpora.js) resolved against the current library: book count per preset and
 * the `books` scope of a selection. Shared by Simple Search and Advanced Search, so both resolve
 * identical book ids. `ready` is false until the library catalog (commentary flags) has loaded.
 */
import { useCallback, useMemo } from 'react';

import { corpusCounts, corpusScope } from '../../shared/corpora';
import type { SearchScope } from '../../shared/search';
import { useLibraryCatalog } from './useLibraryCatalog';

export function useCorpora() {
  const catalog = useLibraryCatalog();
  const opts = useMemo(() => (catalog ? { isCommentary: catalog.isCommentary } : null), [catalog]);
  const counts = useMemo(() => (catalog && opts ? corpusCounts(catalog.bookInfos, opts) : null), [catalog, opts]);
  const scopeFor = useCallback((ids: string[]): SearchScope => (catalog && opts ? corpusScope(catalog.bookInfos, ids, opts) : { kind: 'all' }), [catalog, opts]);
  return { ready: !!catalog, counts, scopeFor };
}
