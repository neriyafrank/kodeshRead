/**
 * Search lifecycle (pure, shared by the app and scripts/selftest.js): the state machine behind the
 * Search Progress UI of Simple Search and Advanced Search.
 *
 *   idle -> searching -> done | cancelled | (done with error)
 *
 * Every action carries the id of the request that produced it (monotonic, from createRequestCounter).
 * Actions of a superseded request are ignored, so a slow older query can never overwrite the state
 * of a newer one, and results that arrive after "ביטול" are dropped.
 */
'use strict';

/** The status banner (and its cancel button) appears only after this long: instant queries never flicker. */
const BANNER_DELAY_MS = 300;

/** Stage -> user-facing text. */
const STAGE_LABELS = {
  query: 'מחפש במאגר…',
  verify: 'מעבד התאמות…',
  count: 'מחשב סך תוצאות…',
};

/** Monotonic request ids. */
function createRequestCounter() {
  let last = 0;
  return { next: () => ++last, current: () => last, isCurrent: (id) => id === last };
}

function initialLifecycle() {
  return { status: 'idle', id: 0, key: '', stage: 'query', scanned: 0, startedAt: 0, counting: false, results: null };
}

/**
 * @param {ReturnType<typeof initialLifecycle>} state
 * @param {{ type: string, id: number, [k: string]: any }} a
 */
function lifecycleReducer(state, a) {
  if (a.type === 'start') {
    if (a.id <= state.id) return state; // never go back to an older request
    return { ...state, status: 'searching', id: a.id, key: a.key, stage: 'query', scanned: 0, startedAt: a.now, counting: false };
  }
  if (a.id !== state.id) return state; // stale: a newer request owns the state
  switch (a.type) {
    case 'progress':
      if (state.status !== 'searching' && !state.counting) return state;
      return { ...state, stage: a.stage, scanned: a.scanned == null ? state.scanned : a.scanned };
    case 'page':
      if (state.status !== 'searching') return state; // cancelled meanwhile
      return { ...state, status: 'done', results: a.results, counting: !a.results.error && !a.results.count, stage: 'count', scanned: 0 };
    case 'count':
      if (state.status !== 'done' || !state.counting || !state.results) return state; // not counting (cancelled)
      return { ...state, counting: false, results: { ...state.results, count: a.count } };
    case 'more':
      if (state.status !== 'done' || !state.results) return state;
      return { ...state, results: { ...state.results, rows: state.results.rows.concat(a.rows), hasMore: a.hasMore, cursor: a.cursor } };
    case 'cancel':
      if (state.status === 'searching') return { ...state, status: 'cancelled', counting: false };
      if (state.counting) return { ...state, counting: false }; // keep the first page, drop only the count
      return state;
    default:
      return state;
  }
}

/** Where the UI is, given the current query key (a changed key means "a new search is about to run"). */
function viewOf(state, key, idle) {
  if (idle) return { phase: 'idle', current: null, shown: null };
  const keyed = state.key === key;
  const phase = !keyed ? 'searching' : state.status === 'idle' ? 'searching' : state.status;
  const current = keyed && state.status === 'done' ? state.results : null;
  // While a new query runs the previous rows stay visible instead of flashing an empty list.
  const shown = current || (phase === 'cancelled' ? null : state.results);
  return { phase, current, shown };
}

/** "מחפש בכל הספרייה…" / "מחפש ב-5 ספרים נבחרים…". */
function scopeSearchLabel(scope) {
  if (!scope || scope.kind === 'all') return 'מחפש בכל הספרייה…';
  if (scope.kind === 'book') return `מחפש בספר ${scope.title}…`;
  // Preset corpora carry their book count in the name: "מחפש בבבלי (37 ספרים)…".
  if (scope.kind === 'books' && scope.corpora && scope.corpora.length) return `מחפש ב${scope.name}…`;
  if (scope.kind === 'books') {
    const n = scope.ids.length;
    return n === 1 ? 'מחפש בספר נבחר…' : `מחפש ב-${n} ספרים נבחרים…`;
  }
  return `מחפש ב${scope.name}…`;
}

/** Banner text: the scope while querying, the stage (with the real progress count) afterwards. */
function stageLabel(stage, scanned, scope) {
  if (stage === 'verify') return scanned ? `${STAGE_LABELS.verify} (${isolateLtr(scanned.toLocaleString('en-US'))} פסקאות נבדקו)` : STAGE_LABELS.verify;
  if (stage === 'count') return STAGE_LABELS.count;
  return scopeSearchLabel(scope);
}

/** Wraps each number in an LTR isolate so digits keep their order inside a Hebrew line. */
function isolateLtr(text) {
  return String(text).replace(/\d[\d.,]*/g, (m) => `⁦${m}⁩`);
}

/** "1.4 שניות" (number isolated LTR), "1:05 דקות" from 60 seconds. */
function formatElapsed(ms) {
  const t = Math.max(0, Number(ms) || 0);
  if (t >= 60000) {
    const s = Math.floor(t / 1000);
    return `${isolateLtr(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)} דקות`;
  }
  const sec = Math.floor(t / 100) / 10;
  return `${isolateLtr(sec.toFixed(1))} ${sec === 1 ? 'שנייה' : 'שניות'}`;
}

module.exports = { BANNER_DELAY_MS, STAGE_LABELS, createRequestCounter, initialLifecycle, lifecycleReducer, viewOf, scopeSearchLabel, stageLabel, formatElapsed, isolateLtr };
