/**
 * Config plugin: Android foreground service for long library imports.
 *
 *   "plugins": ["./plugins/withImportForegroundService"]
 *
 * Adds to the app's AndroidManifest.xml during `expo prebuild`:
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
 *   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
 *   <uses-permission android:name="android.permission.WAKE_LOCK" />
 *   <service android:name="expo.modules.importforegroundservice.ImportForegroundService"
 *            android:exported="false" android:foregroundServiceType="dataSync" />
 *
 * The service and its JS bridge are the local Expo module in modules/import-foreground-service
 * (autolinked from the project's `modules/` folder); the JS wrapper is
 * src/services/importForegroundService.ts (a no-op on web / iOS).
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const SERVICE_NAME = 'expo.modules.importforegroundservice.ImportForegroundService';
const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
];

/** Adds the permissions and the <service> entry to a parsed AndroidManifest (idempotent). */
function applyImportForegroundService(manifest) {
  const root = manifest.manifest;
  root['uses-permission'] = root['uses-permission'] || [];
  for (const name of PERMISSIONS) {
    if (!root['uses-permission'].some((p) => p.$ && p.$['android:name'] === name)) {
      root['uses-permission'].push({ $: { 'android:name': name } });
    }
  }
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app.service = (app.service || []).filter((s) => !(s.$ && s.$['android:name'] === SERVICE_NAME));
  app.service.push({
    $: {
      'android:name': SERVICE_NAME,
      'android:exported': 'false',
      'android:foregroundServiceType': 'dataSync',
    },
  });
  return manifest;
}

module.exports = function withImportForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyImportForegroundService(cfg.modResults);
    return cfg;
  });
};

module.exports.applyImportForegroundService = applyImportForegroundService;
module.exports.SERVICE_NAME = SERVICE_NAME;
module.exports.PERMISSIONS = PERMISSIONS;
