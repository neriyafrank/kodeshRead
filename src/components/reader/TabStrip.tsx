/**
 * Reader tab bar for many open tabs.
 *
 *  - RTL strip of compact pills (book title + innermost section, ✕ to close); the active tab is
 *    kept scrolled into view whenever tabs change or a tab opens.
 *  - Long-press a pill: close / close others / close the tabs to its left.
 *  - A counter button pinned at the end of the bar opens the all-tabs switcher.
 *
 * The strip scrolls in an LTR container with the tabs reversed (first tab at the right edge), so
 * scroll offsets are plain LTR numbers on every platform (see src/lib/direction.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type ScrollViewInstance } from 'react-native';

import { tabSubtitle } from '../../../shared/tabs';
import { nativeDir, setWebDir } from '../../lib/direction';
import { useTabs, type ReaderTab } from '../../state/tabsStore';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';
import { BottomSheet } from '../Overlay';

interface Props {
  onOpenSwitcher: () => void;
}

export function TabStrip({ onOpenSwitcher }: Props) {
  const s = useThemedStyles(createStyles);
  const tabs = useTabs((x) => x.tabs);
  const activeTabId = useTabs((x) => x.activeTabId);
  const activate = useTabs((x) => x.activate);
  const closeTab = useTabs((x) => x.closeTab);
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const layouts = useRef(new Map<string, { x: number; width: number }>());
  const [viewWidth, setViewWidth] = useState(0);
  const [menuTab, setMenuTab] = useState<ReaderTab | null>(null);

  // Keep the active tab in view (centered when possible) after any change of tabs.
  const reveal = () => {
    const l = activeTabId ? layouts.current.get(activeTabId) : undefined;
    if (!l || !viewWidth) return;
    scrollRef.current?.scrollTo({ x: Math.max(0, l.x - (viewWidth - l.width) / 2), animated: true });
  };
  useEffect(() => {
    const t = setTimeout(reveal, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabs.length, viewWidth]);

  const onTabLayout = (id: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    layouts.current.set(id, { x, width });
    if (id === activeTabId) reveal();
  };

  return (
    <View style={s.bar}>
      <ScrollView
        ref={(n) => {
          scrollRef.current = n;
          setWebDir(n, 'ltr');
        }}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[s.scroll, nativeDir('ltr')]}
        contentContainerStyle={[s.strip, nativeDir('ltr'), { minWidth: viewWidth }]}
        onLayout={(e) => setViewWidth(Math.round(e.nativeEvent.layout.width))}
        testID="tab-strip"
      >
        {tabs
          .slice()
          .reverse()
          .map((t) => {
            const active = t.tabId === activeTabId;
            const section = tabSubtitle(t.tocPath);
            return (
              <View
                key={t.tabId}
                ref={(n) => setWebDir(n, 'rtl')}
                style={[s.tab, nativeDir('rtl'), active && s.tabActive]}
                onLayout={onTabLayout(t.tabId)}
              >
                <Pressable
                  onPress={() => activate(t.tabId)}
                  onLongPress={() => setMenuTab(t)}
                  delayLongPress={350}
                  style={s.tabBody}
                  accessibilityRole="tab"
                  aria-selected={active}
                  accessibilityHint="לחיצה ארוכה לפעולות"
                  testID={`tab-${t.bookId}`}
                >
                  <Text style={[s.tabTitle, active && s.tabTitleActive]} numberOfLines={1}>
                    {t.bookTitle}
                  </Text>
                  {section ? (
                    <Text style={[s.tabSection, active && s.tabSectionActive]} numberOfLines={1}>
                      {section}
                    </Text>
                  ) : null}
                </Pressable>
                <Pressable onPress={() => closeTab(t.tabId)} hitSlop={8} style={s.close} accessibilityLabel={`סגור ${t.bookTitle}`} testID={`tab-close-${t.bookId}`}>
                  <Text style={s.closeText}>×</Text>
                </Pressable>
              </View>
            );
          })}
      </ScrollView>
      <Pressable
        onPress={onOpenSwitcher}
        hitSlop={6}
        style={({ pressed }) => [s.counter, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
        accessibilityLabel={`${tabs.length} לשוניות פתוחות — הצג הכל`}
        testID="tabs-counter"
      >
        <Text style={s.counterText}>{tabs.length}</Text>
      </Pressable>
      <TabMenu tab={menuTab} onClose={() => setMenuTab(null)} />
    </View>
  );
}

/** Long-press actions for one tab. */
function TabMenu({ tab, onClose }: { tab: ReaderTab | null; onClose: () => void }) {
  const s = useThemedStyles(createStyles);
  const tabs = useTabs((x) => x.tabs);
  const closeTab = useTabs((x) => x.closeTab);
  const closeOthers = useTabs((x) => x.closeOthers);
  const closeToLeft = useTabs((x) => x.closeToLeft);
  const idx = tab ? tabs.findIndex((t) => t.tabId === tab.tabId) : -1;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const actions: { label: string; testID: string; disabled: boolean; run: () => void }[] = tab
    ? [
        { label: 'סגור לשונית', testID: 'tab-action-close', disabled: false, run: () => closeTab(tab.tabId) },
        { label: 'סגור לשוניות אחרות', testID: 'tab-action-close-others', disabled: tabs.length < 2, run: () => closeOthers(tab.tabId) },
        { label: 'סגור לשוניות משמאל', testID: 'tab-action-close-left', disabled: idx < 0 || idx >= tabs.length - 1, run: () => closeToLeft(tab.tabId) },
      ]
    : [];
  return (
    <BottomSheet visible={!!tab} onClose={onClose} testID="tab-menu">
      <Text style={s.menuTitle} numberOfLines={1}>
        {tab?.bookTitle}
      </Text>
      {actions.map((a) => (
        <Pressable
          key={a.testID}
          onPress={act(a.run)}
          disabled={a.disabled}
          style={({ pressed }) => [s.menuItem, pressed && { opacity: 0.6 }, a.disabled && { opacity: 0.35 }]}
          accessibilityRole="button"
          testID={a.testID}
        >
          <Text style={s.menuText}>{a.label}</Text>
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    bar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minWidth: 0 },
    scroll: { flexGrow: 1, flexShrink: 1 },
    strip: { gap: spacing.xs, paddingHorizontal: spacing.xs, alignItems: 'center', justifyContent: 'flex-end', flexDirection: 'row' },
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      maxWidth: 150,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceMuted,
      paddingStart: spacing.sm,
      paddingEnd: 2,
      height: 40,
    },
    tabActive: { backgroundColor: c.accentSoft, borderColor: c.accent, borderWidth: 1.5 },
    tabBody: { flexShrink: 1, justifyContent: 'center' },
    tabTitle: { fontSize: 13, color: c.textMuted, fontWeight: '600', writingDirection: 'rtl', textAlign: 'right' },
    tabTitleActive: { color: c.text, fontWeight: '700' },
    tabSection: { fontSize: 11, color: c.textMuted, writingDirection: 'rtl', textAlign: 'right' },
    tabSectionActive: { color: c.accent },
    close: { paddingHorizontal: 6, paddingVertical: 4 },
    closeText: { fontSize: 17, lineHeight: 18, color: c.textMuted },
    counter: {
      minWidth: 34,
      height: 32,
      paddingHorizontal: 6,
      borderRadius: radius.sm,
      borderWidth: 2,
      borderColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    counterText: { fontSize: 14, fontWeight: '800', color: c.accent },
    menuTitle: { fontSize: 16, fontWeight: '700', color: c.text, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, writingDirection: 'rtl' },
    menuItem: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    menuText: { fontSize: 16, color: c.text, writingDirection: 'rtl' },
  });
