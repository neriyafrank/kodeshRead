'use strict';
/**
 * Navigation history model (pure JS, no React): the contract the app's router calls must follow.
 *
 *  - Every top-level screen (home / search / advanced-search / reader / library-manager) appears AT MOST ONCE in the
 *    back stack. Opening a screen that is already in the stack collapses the stack back to that occurrence
 *    (expo-router `dismissTo`), so `Search -> Reader -> Search -> Reader ...` never piles up.
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

/** Open a screen: collapse onto an existing occurrence, otherwise push. Returns a new stack. */
function open(stack, href) {
  const screen = screenOf(href);
  const at = stack.lastIndexOf(screen);
  return at >= 0 ? stack.slice(0, at + 1) : [...stack, screen];
}

/** Android system Back. `handled` is false on the root (the OS minimises / exits). Never re-pushes the screen it leaves. */
function systemBack(stack) {
  if (stack.length <= 1) return { stack, handled: false };
  return { stack: stack.slice(0, -1), handled: true };
}

/** In-app header Back: straight to Home, empty back stack. */
function appBack() {
  return [HOME];
}

/** In-app header Back of every non-Reader screen: pops one entry (Home when there is none). */
function appBackOne(stack) {
  return stack.length <= 1 ? [HOME] : stack.slice(0, -1);
}

module.exports = { HOME, screenOf, createHistory, open, systemBack, appBack, appBackOne };
