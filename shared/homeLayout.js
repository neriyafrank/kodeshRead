/**
 * What the Library (home) screen shows, as one pure decision (src/app/index.tsx, scripts/selftest.js).
 *
 *   daily     the "לימוד יומי" bar: ALWAYS shown, above everything below it (never hidden or replaced by the
 *             starter books, whatever is installed)
 *   starter   the ספרי התחלה section (only while no full library is installed)
 *   starterOpen  its list is expanded (the persisted preference); collapsed = only its header row
 *   personal  the library tree (personal books / the full library); with personal books it is shown next to the
 *             starter section, expanded or collapsed, and takes all the room the starter section gives up
 */
'use strict';

/** @param {{ core: boolean, starter: boolean, userBookCount: number, starterOpen: boolean }} s */
function homeLayout(s) {
  const starter = !s.core && !!s.starter;
  const personal = !starter || s.userBookCount > 0;
  return {
    daily: true,
    starter,
    starterOpen: starter && s.starterOpen !== false,
    // Share the screen with the personal books: a bounded list while expanded.
    starterCompact: starter && s.userBookCount > 0,
    personal,
    order: ['daily', ...(starter ? ['starter'] : []), ...(personal ? ['personal'] : [])],
  };
}

module.exports = { homeLayout };
