// Learn more https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Bundle the pre-built SQLite library (assets/db/library.db) as an asset.
if (!config.resolver.assetExts.includes('db')) config.resolver.assetExts.push('db');

// Web preview only: expo-sqlite's web build runs wa-sqlite (WebAssembly) and needs
// SharedArrayBuffer, i.e. cross-origin isolation headers on the dev server.
if (!config.resolver.assetExts.includes('wasm')) config.resolver.assetExts.push('wasm');
config.server = config.server || {};
const prevEnhance = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const base = prevEnhance ? prevEnhance(middleware, server) : middleware;
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    return base(req, res, next);
  };
};

// Never let Metro crawl the raw Otzaria sources or build temp files.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : config.resolver.blockList ? [config.resolver.blockList] : []),
  /[\\/]raw_library[\\/].*/,
  /[\\/]raw_links[\\/].*/,
  /[\\/]assets[\\/]db[\\/].*\.tmp$/,
];

module.exports = config;
