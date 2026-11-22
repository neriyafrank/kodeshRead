/**
 * Config plugin: keep the bundled SQLite database uncompressed inside the APK.
 *
 *   "plugins": [["./plugins/withAndroidNoCompress", { "noCompress": ["db"] }]]
 *
 * expo-build-properties has no noCompress option, so this adds
 *   androidResources { noCompress += ["db"] }
 * to android/app/build.gradle during prebuild (AGP 8+ DSL).
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// @kodeshread-noCompress';

module.exports = function withAndroidNoCompress(config, props = {}) {
  const exts = (props.noCompress && props.noCompress.length ? props.noCompress : ['db']).map((e) => String(e).replace(/^\./, ''));
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;
    const block = `\n    ${MARKER}\n    androidResources {\n        noCompress += [${exts.map((e) => `"${e}"`).join(', ')}]\n    }\n`;
    const re = /^android\s*\{\s*$/m;
    if (!re.test(src)) throw new Error('withAndroidNoCompress: could not find `android {` block in app/build.gradle');
    cfg.modResults.contents = src.replace(re, (m) => m + block);
    return cfg;
  });
};
