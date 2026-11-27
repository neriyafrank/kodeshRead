/**
 * Attribution facts shown by the "אודות" screen (pure JS, shared by src/app/about.tsx and scripts/selftest.js).
 *
 * The ready-made cloud library is built from LIBRARY_SOURCE_REPO: it must stay equal to the default `source_repo`
 * of .github/workflows/build-library.yml (self-tested). Building the published release from any other repository
 * (the workflow also offers `Otzaria/otzaria-library`, which has different license terms) makes this screen wrong.
 *
 * CC BY-NC-SA 4.0 is the Otzaria project's license; texts taken from external sources keep their own licenses.
 */
'use strict';

const LIBRARY_SOURCE_REPO = 'Sivan22/otzaria-library';

const ABOUT = {
  sourceRepo: LIBRARY_SOURCE_REPO,
  sourceUrl: `https://github.com/${LIBRARY_SOURCE_REPO}`,
  licenseName: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  licenseDeedHeUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.he',
};

module.exports = { ABOUT };
