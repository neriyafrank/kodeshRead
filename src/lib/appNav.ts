import { useNavigationContainerRef, useRouter, type Href } from 'expo-router';
import { useMemo } from 'react';

import { HOME, screenOf, type NavHref } from '../../shared/navHistory';

/**
 * The only way screens navigate (model + rules: shared/navHistory.js).
 *  - `open`: a screen already in the stack is returned to with `dismissTo` (everything above it is popped, params
 *    refreshed); otherwise it is pushed. So a screen is never in the stack twice (no Search <-> Reader ping-pong).
 *  - `goHome`: the READER's in-app Back button. Pops everything above Home; Android Back afterwards leaves the app.
 *  - `back`: the in-app Back button of every other screen: pops one entry (Home when there is no previous screen).
 * Android system Back is the stack's native pop (one entry per press, overlays' `Modal.onRequestClose` first).
 */
export function useAppNav() {
  const router = useRouter();
  const container = useNavigationContainerRef();
  return useMemo(
    () => ({
      open: (href: NavHref) => (currentStack(container).includes(screenOf(href)) ? router.dismissTo(href as Href) : router.push(href as Href)),
      back: () => {
        const stack = currentStack(container);
        if (stack.length > 1) router.back();
        else if (!(stack.length === 1 && stack[0] === HOME)) router.replace('/');
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
