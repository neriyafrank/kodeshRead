import { createContext, useContext } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { BookIndex, QueryAdapter } from '../../shared/quickJump';

export interface Library {
  db: SQLiteDatabase;
  adapter: QueryAdapter;
  /** In-memory title/alias index for Quick Jump (built once at startup). */
  bookIndex: BookIndex;
}

export const LibraryContext = createContext<Library | null>(null);

export function useLibrary(): Library {
  const lib = useContext(LibraryContext);
  if (!lib) throw new Error('useLibrary() must be used inside <LibraryContext.Provider>');
  return lib;
}
