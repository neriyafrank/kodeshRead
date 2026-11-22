/**
 * Web preview only (Metro picks this file for web bundles; native bundles get
 * webSeed.ts, so the APK never contains a database). The browser has no file system
 * to download into, so the sample library built by `npm run db:sample` is imported
 * from this asset as the core library.
 */
import dbVersion from '../../assets/db/db-version.json';

export const webSeed: { asset: number; version: string } | null = {
  asset: require('../../assets/db/library.db'),
  version: dbVersion.version,
};
