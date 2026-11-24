#!/usr/bin/env node
/**
 * Build matrix of .github/workflows/build-library.yml (Node built-ins only).
 *
 *   node scripts/ci/edition-matrix.js <both|full|classic>
 *
 * Prints the GitHub Actions matrix JSON: one entry per edition to build
 * { edition, scope, tag, starter }. `starter` is true for exactly one entry, so the instant-starter packs
 * (`starter-latest`) are exported and published once per run: from the classic build when it is part of the
 * run (the starter books are classical corpora), otherwise from the full build.
 */
'use strict';

const editions = require('../../shared/editions');

function buildMatrix(which) {
  const choice = which || 'both';
  const ids = choice === 'both' ? ['full', 'classic'] : [editions.assertEdition(choice)];
  const starterEdition = ids.includes('classic') ? 'classic' : ids[0];
  return {
    include: ids.map((id) => ({
      edition: id,
      scope: editions.editionScope(id),
      tag: editions.editionTag(id),
      title: editions.EDITIONS[id].title,
      starter: id === starterEdition,
    })),
  };
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(buildMatrix(process.argv[2])) + '\n');
  } catch (e) {
    console.error(`[edition-matrix] ${e.message}`);
    process.exit(1);
  }
}

module.exports = { buildMatrix };
