import { useNavigationContainerRef, useRouter, type Href } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { BackHandler } from 'react-native';

import { HOME, backPlan, openAction, screenOf, type NavHref } from '../../shared/navHistory';

/**
 * The only way screens navigate (model + rules: shared/navHistory.js).
 *  - INVARIANT: no two consecutive entries of one screen, and Back never lands on the screen it leaves.
 *  - `open`: the screen you are ON is updated in place with `replace` (new params, no new entry); a screen deeper in the
 *    stack is returned to with `dismissTo` (everything above it is popped, params refreshed); otherwise it is pushed.
 *    So a screen is never in the stack twice (no Search <-> Reader ping-pong).
 *  - `goHome`: the READER's in-app Back button. Pops everything above Home; Android Back afterwards leaves the app.
 *  - `back`: the in-app Back button of every other screen: pops one entry (Home when there is no previous screen).
 * Android system Back is the stack's native pop (one entry per press, overlays' `Modal.onRequestClose` first).
 */
export function useAppNav() {
  const router = useRouter();
  const container = useNavigationContainerRef();
  return useMemo(
    () => ({
      open: (href: NavHref) => {
        const action = openAction(currentStack(container), href);
        if (action === 'replace') return router.replace(href as Href);
        return action === 'dismissTo' ? router.dismissTo(href as Href) : router.push(href as Href);
      },
      back: () => {
        const stack = currentStack(container);
        if (stack.length === 1 && stack[0] === HOME) return;
        const plan = backPlan(stack);
        if (plan.home) router.replace('/');
        else if (plan.pop > 1) router.dismiss(plan.pop); // duplicate run on top: pop it whole
        else router.back();
      },
      goHome: () => {
        const stack = currentStack(container);
        if (stack.length === 1 && stack[0] === HOME) return;
        if (stack.includes(HOME)) return router.dismissTo('/');
        // Deep-linked / restored without Home underneath: drop everything and make Home the root.
        if (stack.length > 1) router.dismissAll();
        router.replace('/');
      },
    }),
    [router, container],
  );
}

/**
 * Mounted once in the root layout: Android system / gesture Back on a stack whose top is a run of the same screen
 * (corrupted / restored state) pops the whole run (or goes Home), so it never lands on the screen it leaves.
 * A healthy stack is left to the native pop.
 */
export function useBackGuard() {
  const router = useRouter();
  const container = useNavigationContainerRef();
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const stack = currentStack(container);
      const plan = backPlan(stack);
      if (plan.home) {
        if (stack.length && stack[stack.length - 1] !== HOME) {
          router.replace('/');
          return true;
        }
        return false; // Home: default exit
      }
      if (plan.pop > 1) {
        router.dismiss(plan.pop);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [router, container]);
}

type StackState = { routes?: { name: string; state?: StackState }[]; index?: number };

/** Screen names of the live back stack (the deepest navigator state of the root stack), read fresh at call time. */
function currentStack(container: { isReady(): boolean; getRootState(): unknown }): string[] {
  if (!container.isReady()) return [];
  let state = container.getRootState() as StackState | undefined;
  // The root layout is the stack; descend while the focused route hosts a nested navigator.
  while (state?.routes) {
    const focused = state.routes[state.index ?? state.routes.length - 1];
    if (!focused?.state) break;
    state = focused.state;
  }
  return (state?.routes ?? []).map((r) => screenOf(r.name));
}
