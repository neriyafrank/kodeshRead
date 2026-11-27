'use strict';
/**
 * Navigation history model (pure JS, no React): the contract the app's router calls must follow.
 *
 *  - Every top-level screen (home / search / advanced-search / reader / library-manager / about) appears AT MOST ONCE in the
 *    back stack. Opening a screen that is already in the stack collapses the stack back to that occurrence
 *    (expo-router `dismissTo`), so `Search -> Reader -> Search -> Reader ...` never piles up.
 *  - INVARIANT: the stack never holds two consecutive entries of one screen (opening the screen you are on updates params in
 *    place via `replace`), and Back always lands on a DIFFERENT screen (it pops the whole run of the current screen).
 *  - Android system Back (hardware / gesture) pops exactly one entry; on Home it is not handled (default exit).
 *    Overlays (TOC, `Aa`, filters ... = RN `Modal.onRequestClose`) consume the press first.
 *  - The in-app header Back of the READER (`goHome` / `appBack`) goes Home and empties the stack; every other screen's
 *    header Back (`back` / `appBackOne`) pops one entry like system Back, falling back to Home without a previous screen.
 */

const HOME = 'home';

/** `/reader`, `{ pathname: '/search', params }`, `/library-manager?x=1` -> 'reader' / 'search' / 'library-manager'. */
function screenOf(href) {
  const raw = typeof href === 'string' ? href : href && href.pathname ? href.pathname : '';
  const name = String(raw).split('?')[0].replace(/^\/+|\/+$/g, '');
  return name === '' || name === 'index' ? HOME : name;
}

function createHistory() {
  return [HOME];
}

/** Drop consecutive duplicates (`[home, reader, reader]` -> `[home, reader]`): repairs a corrupted stack. */
function collapse(stack) {
  const out = [];
  for (const s of stack) if (out[out.length - 1] !== s) out.push(s);
  return out.length ? out : [HOME];
}

/** What `open` must do against the live stack: same screen on top -> `replace` (params only), existing deeper -> `dismissTo`, else `push`. */
function openAction(stack, href) {
  const screen = screenOf(href);
  if (stack.length && stack[stack.length - 1] === screen) return 'replace';
  return stack.includes(screen) ? 'dismissTo' : 'push';
}

/** Open a screen: collapse onto an existing occurrence, otherwise push. Same screen on top never adds an entry. Returns a new stack. */
function open(stack, href) {
  const screen = screenOf(href);
  const base = collapse(stack);
  const at = base.lastIndexOf(screen);
  return at >= 0 ? base.slice(0, at + 1) : [...base, screen];
}

/**
 * Back plan for any stack: pop the whole trailing run of the current screen (1 for a healthy stack, more when a duplicate
 * was injected) so the landing screen is ALWAYS different. `pop` = entries to pop; `home` = nothing different underneath
 * (the run is the whole stack): go to Home, or leave the app when already on Home.
 */
function backPlan(stack) {
  const top = stack[stack.length - 1];
  let run = 0;
  while (run < stack.length && stack[stack.length - 1 - run] === top) run++;
  if (run >= stack.length) return { pop: 0, home: true, stack: [HOME] };
  return { pop: run, home: false, stack: stack.slice(0, stack.length - run) };
}

/** Android system Back. `handled` is false on the root (the OS minimises / exits). Never lands on the screen it leaves. */
function systemBack(stack) {
  const plan = backPlan(stack);
  if (plan.home) return { stack: [HOME], handled: stack[stack.length - 1] !== HOME && stack.length > 0 };
  return { stack: plan.stack, handled: true };
}

/** In-app header Back of the READER: straight to Home, empty back stack. */
function appBack() {
  return [HOME];
}

/** In-app header Back of every non-Reader screen: pops to the previous DIFFERENT screen (Home when there is none). */
function appBackOne(stack) {
  return backPlan(stack).stack;
}

module.exports = { HOME, screenOf, createHistory, collapse, openAction, open, backPlan, systemBack, appBack, appBackOne };
