/**
 * Config plugin: sign `assembleRelease` with a real keystore when one is provided through the
 * environment, otherwise leave the generated project untouched (it signs release with the debug
 * keystore, which still gives an installable APK).
 *
 * Active only when ALL of these are set at prebuild time (GitHub Actions: build-android-apk.yml):
 *   KODESHREAD_KEYSTORE_FILE       absolute path of the decoded keystore
 *   KODESHREAD_KEYSTORE_PASSWORD
 *   KODESHREAD_KEY_ALIAS
 *   KODESHREAD_KEY_PASSWORD
 * Only the keystore path is written into android/app/build.gradle; the passwords and alias are read
 * with System.getenv(...) at Gradle time, so no secret is ever written to disk.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// @kodeshread-releaseSigning';
const VARS = ['KODESHREAD_KEYSTORE_FILE', 'KODESHREAD_KEYSTORE_PASSWORD', 'KODESHREAD_KEY_ALIAS', 'KODESHREAD_KEY_PASSWORD'];

function isConfigured(env = process.env) {
  return VARS.every((v) => env[v] && String(env[v]).length > 0);
}

function patchGradle(src, keystoreFile) {
  if (src.includes(MARKER)) return src;
  const signingRe = /^(\s*)signingConfigs\s*\{\s*$/m;
  if (!signingRe.test(src)) throw new Error('withAndroidReleaseSigning: could not find `signingConfigs {` in app/build.gradle');
  let out = src.replace(signingRe, (m, indent) => {
    const i = indent + '    ';
    return [
      m,
      `${i}${MARKER}`,
      `${i}release {`,
      `${i}    storeFile file(${JSON.stringify(keystoreFile)})`,
      `${i}    storePassword System.getenv('KODESHREAD_KEYSTORE_PASSWORD')`,
      `${i}    keyAlias System.getenv('KODESHREAD_KEY_ALIAS')`,
      `${i}    keyPassword System.getenv('KODESHREAD_KEY_PASSWORD')`,
      `${i}}`,
    ].join('\n');
  });
  // Point the release build type at it (the template uses signingConfigs.debug there).
  const btIdx = out.search(/^\s*buildTypes\s*\{/m);
  if (btIdx < 0) throw new Error('withAndroidReleaseSigning: could not find `buildTypes {` in app/build.gradle');
  const relRe = /^(\s*)release\s*\{[\s\S]*?signingConfig\s+signingConfigs\.debug/m;
  const tail = out.slice(btIdx);
  if (!relRe.test(tail)) throw new Error('withAndroidReleaseSigning: could not find the release buildType signingConfig');
  out = out.slice(0, btIdx) + tail.replace(relRe, (m) => m.replace(/signingConfig\s+signingConfigs\.debug$/, 'signingConfig signingConfigs.release'));
  return out;
}

module.exports = function withAndroidReleaseSigning(config) {
  if (!isConfigured()) return config;
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = patchGradle(cfg.modResults.contents, process.env.KODESHREAD_KEYSTORE_FILE);
    return cfg;
  });
};

module.exports.isConfigured = isConfigured;
module.exports.patchGradle = patchGradle;
