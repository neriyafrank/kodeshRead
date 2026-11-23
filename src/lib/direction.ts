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

/**
 * Hebrew <Text> flush against the RIGHT edge of its box, on every platform. Use it instead of a
 * raw `textAlign: 'right'` on any Text (labels, headings, body lines); inputs use
 * `inputAlignRight`.
 *
 * The app runs with I18nManager.forceRTL + swapLeftAndRightInRTL, and React Native's native text
 * views resolve `textAlign: 'left' | 'right'` relative to the paragraph's (RTL) layout direction:
 * on Android `'right'` becomes the END edge, i.e. the LEFT side (TextLayoutManager /
 * TextAttributeProps.getTextAlignment). There the physical right edge is `'left'`. The web
 * preview takes `'right'` literally. `writingDirection: 'rtl'` keeps the bidi base RTL so trailing
 * punctuation ("דף ב.", "(א)") stays on the correct side.
 *
 * Unlike natural alignment (no textAlign), this also holds for strings that start with digits or
 * Latin text ("25 תוצאות", "Otzaria/…"), which Android would otherwise align to the left.
 */
export const alignRight = (Platform.OS === 'web' ? { textAlign: 'right', writingDirection: 'rtl' } : { textAlign: 'left', writingDirection: 'rtl' }) as {
  textAlign: 'left' | 'right';
  writingDirection: 'rtl';
};

/**
 * Hebrew <TextInput> text (and placeholder) flush right, on every platform.
 *
 * Android's EditText is NOT mirrored like <Text>: ReactTextInputManager.setTextAlign maps
 * `'right'` straight to Gravity.RIGHT (the physical right edge), so `alignRight`'s native `'left'`
 * would put the text on the LEFT of an input.
 */
export const inputAlignRight = { textAlign: 'right', writingDirection: 'rtl' } as const;

/**
 * Wraps each number (with its unit / percent sign) in an LTR isolate so "1.4 GB / 3.2 GB · 44%" keeps
 * its order inside a Hebrew line instead of being reshuffled by the bidi algorithm.
 */
export const isolateLtr = (text: string) => text.replace(/\d[\d.,]*(?: ?(?:GB|MB|KB|%))?/g, (m) => `\u2066${m}\u2069`);
