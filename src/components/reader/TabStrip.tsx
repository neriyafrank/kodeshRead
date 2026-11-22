/** Horizontal strip of open book tabs (tap to switch, ✕ to close). */
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';

import { useTabs } from '../../state/tabsStore';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';

export function TabStrip() {
  const s = useThemedStyles(createStyles);
  const tabs = useTabs((x) => x.tabs);
  const activeTabId = useTabs((x) => x.activeTabId);
  const activate = useTabs((x) => x.activate);
  const closeTab = useTabs((x) => x.closeTab);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const tabX = useRef(new Map<string, number>());

  useEffect(() => {
    const x = activeTabId ? tabX.current.get(activeTabId) : undefined;
    if (x != null) scrollRef.current?.scrollTo({ x: Math.max(0, x - 24), animated: true });
  }, [activeTabId]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.strip}
      style={s.scroll}
      testID="tab-strip"
    >
      {tabs.map((t) => {
        const active = t.tabId === activeTabId;
        const section = t.tocPath?.split(' > ').pop();
        return (
          <View
            key={t.tabId}
            style={[s.tab, active && s.tabActive]}
            onLayout={(e) => tabX.current.set(t.tabId, e.nativeEvent.layout.x)}
          >
            <Pressable
              onPress={() => activate(t.tabId)}
              style={s.tabBody}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              testID={`tab-${t.bookId}`}
            >
              <Text style={[s.tabTitle, active && s.tabTitleActive]} numberOfLines={1}>
                {t.bookTitle}
              </Text>
              {section ? (
                <Text style={s.tabSection} numberOfLines={1}>
                  {section}
                </Text>
              ) : null}
            </Pressable>
            <Pressable onPress={() => closeTab(t.tabId)} hitSlop={8} style={s.close} accessibilityLabel={`סגור ${t.bookTitle}`}>
              <Text style={s.closeText}>✕</Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    scroll: { flexGrow: 1, flexShrink: 1 },
    strip: { gap: spacing.xs, paddingHorizontal: spacing.xs, alignItems: 'center' },
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      maxWidth: 170,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceMuted,
      paddingStart: spacing.md,
      paddingEnd: spacing.xs,
      height: 40,
    },
    tabActive: { backgroundColor: c.surface, borderColor: c.accent },
    tabBody: { flexShrink: 1, justifyContent: 'center' },
    tabTitle: { fontSize: 14, color: c.textMuted, fontWeight: '600', writingDirection: 'rtl' },
    tabTitleActive: { color: c.text },
    tabSection: { fontSize: 11, color: c.textMuted, writingDirection: 'rtl' },
    close: { paddingHorizontal: 6, paddingVertical: 4, marginStart: 2 },
    closeText: { fontSize: 12, color: c.textMuted },
  });
