/**
 * Writing-direction helpers for horizontally scrolling RTL layouts (library columns, TOC
 * columns, tab strip).
 *
 * Horizontal ScrollViews are laid out LTR with their items in reverse order, so the "newest"
 * edge sits at scroll offset 0 on every platform (RTL scroll offsets differ between browsers and
 * Android); the items' own content stays RTL. Yoga's `direction` style does this on native;
 * react-native-web neither supports that style nor forwards a `dir` prop, so there the HTML
 * attribute is set on the DOM node from a ref.
 */
import { Platform } from 'react-native';

export const nativeDir = (direction: 'ltr' | 'rtl') => (Platform.OS === 'web' ? null : { direction });

export function setWebDir(node: unknown, dir: 'ltr' | 'rtl') {
  if (Platform.OS !== 'web' || !node) return;
  const el = (typeof (node as { getScrollableNode?: () => unknown }).getScrollableNode === 'function'
    ? (node as { getScrollableNode: () => unknown }).getScrollableNode()
    : node) as { setAttribute?: (k: string, v: string) => void } | null;
  el?.setAttribute?.('dir', dir);
}

/** "‹" is bidi-mirrored (it would render as "›" in RTL text): LRM marks keep it pointing left. */
export const LEFT_CHEVRON = '‎‹‎';
