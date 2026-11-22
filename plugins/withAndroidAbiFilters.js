/**
 * Config plugin: package only the given ABIs into the APK (default: arm64-v8a).
 *
 *   "plugins": [["./plugins/withAndroidAbiFilters", { "abiFilters": ["arm64-v8a"] }]]
 *
 * expo-build-properties `android.buildArchs` limits which ABIs React Native / Expo modules
 * *compile* (gradle.properties reactNativeArchitectures), but prebuilt native libraries
 * shipped inside AARs (Hermes, fbjni, SQLite, ...) would still be packaged for all four
 * ABIs. This adds
 *   defaultConfig { ndk { abiFilters "arm64-v8a" } }
 * to android/app/build.gradle during prebuild, which drops the armeabi-v7a / x86 / x86_64
 * copies (~100MB -> ~35-40MB APK).
 *
 * Override for an emulator / older-device build without editing app.json:
 *   KODESHREAD_ABIS=arm64-v8a,x86_64 npx expo prebuild --platform android --clean
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// @kodeshread-abiFilters';
const VALID = new Set(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']);

function resolveAbis(props) {
  const fromEnv = process.env.KODESHREAD_ABIS ? process.env.KODESHREAD_ABIS.split(',') : null;
  const abis = (fromEnv || (props && props.abiFilters) || ['arm64-v8a']).map((a) => String(a).trim()).filter(Boolean);
  for (const a of abis) if (!VALID.has(a)) throw new Error(`withAndroidAbiFilters: unknown ABI "${a}"`);
  return abis;
}

module.exports = function withAndroidAbiFilters(config, props = {}) {
  const abis = resolveAbis(props);
  return withAppBuildGradle(config, (cfg) => {
    const src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;
    const re = /^(\s*)defaultConfig\s*\{\s*$/m;
    if (!re.test(src)) throw new Error('withAndroidAbiFilters: could not find `defaultConfig {` in app/build.gradle');
    cfg.modResults.contents = src.replace(re, (m, indent) => {
      const i = indent + '    ';
      return `${m}\n${i}${MARKER}\n${i}ndk {\n${i}    abiFilters ${abis.map((a) => `"${a}"`).join(', ')}\n${i}}`;
    });
    return cfg;
  });
};

module.exports.resolveAbis = resolveAbis;
