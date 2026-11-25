/**
 * File store of the library catalog snapshot (shared/catalogCache.js decides what is valid). Lives in the cache
 * directory: the OS may clear it, which only costs one rebuild. No store on the web preview (no file system).
 */
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { CatalogStore } from '../../shared/catalogCache';

const NAME = 'library-catalog-cache.json';

export const catalogStore: CatalogStore | null =
  Platform.OS === 'web'
    ? null
    : {
        read: async () => {
          const f = new File(Paths.cache, NAME);
          return f.exists ? await f.text() : null;
        },
        write: async (text) => {
          // Written beside the target and renamed over it: a kill mid-write never leaves a half snapshot to parse.
          const tmp = new File(Paths.cache, NAME + '.tmp');
          if (tmp.exists) tmp.delete();
          tmp.create();
          await tmp.write(text);
          await tmp.move(new File(Paths.cache, NAME), { overwrite: true });
        },
      };
