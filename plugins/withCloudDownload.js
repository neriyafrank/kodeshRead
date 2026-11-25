/**
 * Config plugin: OS-managed background download of the cloud library (modules/cloud-download, WorkManager).
 *
 *   "plugins": ["./plugins/withCloudDownload"]
 *
 * Adds to the app's AndroidManifest.xml during `expo prebuild`:
 *   <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />   (CONNECTED constraint, offline state)
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
 *   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
 *   <uses-permission android:name="android.permission.WAKE_LOCK" />
 *   <service android:name="androidx.work.impl.foreground.SystemForegroundService"
 *            android:foregroundServiceType="dataSync" tools:node="merge" />
 *
 * Android 14+ requires a foreground-service type for WorkManager's long-running workers; the library's own manifest
 * declares the service without one, so it is merged here (tools:node="merge" keeps WorkManager's other attributes).
 * The work-runtime dependency comes from modules/cloud-download/android/build.gradle (autolinked from `modules/`).
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const SERVICE_NAME = 'androidx.work.impl.foreground.SystemForegroundService';
const PERMISSIONS = [
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
];
const TOOLS_NS = 'http://schemas.android.com/tools';

/** Adds the permissions, the tools namespace and the merged <service> entry to a parsed AndroidManifest (idempotent). */
function applyCloudDownload(manifest) {
  const root = manifest.manifest;
  root.$ = root.$ || {};
  if (!root.$['xmlns:tools']) root.$['xmlns:tools'] = TOOLS_NS;
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
      'android:foregroundServiceType': 'dataSync',
      'android:exported': 'false',
      'tools:node': 'merge',
    },
  });
  return manifest;
}

module.exports = function withCloudDownload(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyCloudDownload(cfg.modResults);
    return cfg;
  });
};

module.exports.applyCloudDownload = applyCloudDownload;
module.exports.SERVICE_NAME = SERVICE_NAME;
module.exports.PERMISSIONS = PERMISSIONS;
