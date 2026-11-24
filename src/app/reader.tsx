/**
 * Reading workspace: a slim bar over the active tab's windowed reader.
 *   row 1: back · tab strip (scrolls, long-press actions) · open-tabs counter (switcher) · tools
 *   row 2 (folded away by default, toggled by the tools button): תוכן עניינים · search ·
 *          טעמים / ניקוד · Aa
 * The text gets the full height while row 2 is collapsed; the breadcrumb above the text still
 * opens the TOC.
 * The TOC (RTL cascading columns) is a slide-over drawer on phones and a docked panel beside the
 * text on wide screens. Only the active tab's reader is mounted; the others are restored from
 * their saved positions when re-activated.
 */
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Collapsible } from '../components/Collapsible';
import { SearchIcon, SlidersIcon } from '../components/Icons';
import { AppearanceSheet } from '../components/reader/AppearanceSheet';
import { BookReader } from '../components/reader/BookReader';
import { TabStrip } from '../components/reader/TabStrip';
import { TabSwitcher } from '../components/reader/TabSwitcher';
import { TocDrawer } from '../components/reader/TocDrawer';
import { VocalizationToggles } from '../components/reader/VocalizationToggles';
import { selectActiveTab, useTabs } from '../state/tabsStore';
import { radius, spacing, useThemedStyles, type Palette } from '../theme';

export default function ReaderWorkspace() {
  const s = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const activeTab = useTabs(selectActiveTab);
  const requestJump = useTabs((x) => x.requestJump);
  const [tocOpen, setTocOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Reader tools (row 2) start folded so the text gets the full height.
  const [toolsOpen, setToolsOpen] = useState(false);
  const { width } = useWindowDimensions();
  // Tablets / desktop: the TOC docks beside the text and stays open after a jump.
  const docked = width >= 900;

  const goLibrary = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false, title: activeTab?.bookTitle ?? 'קורא' }} />
      <View style={[s.toolbar, { paddingTop: insets.top + 2 }]}>
        <Pressable onPress={goLibrary} hitSlop={8} style={s.iconBtn} accessibilityRole="button" accessibilityLabel="חזרה לספרייה" testID="reader-back">
          <Text style={s.iconText}>→</Text>
        </Pressable>
        <TabStrip onOpenSwitcher={() => setSwitcherOpen(true)} />
        <Pressable
          onPress={() => setToolsOpen((v) => !v)}
          hitSlop={6}
          style={({ pressed }) => [s.toolsBtn, toolsOpen && s.toolsBtnOn, pressed && s.pressed]}
          accessibilityRole="button"
          aria-expanded={toolsOpen}
          accessibilityState={{ expanded: toolsOpen }}
          accessibilityLabel={toolsOpen ? 'הסתר כלי קריאה' : 'הצג כלי קריאה'}
          testID="reader-tools-toggle"
        >
          <SlidersIcon size={18} />
        </Pressable>
      </View>
      <Collapsible open={toolsOpen} style={s.displayBar} testID="reader-tools">
        <Pressable
          onPress={() => setTocOpen((v) => !v)}
          disabled={!activeTab}
          hitSlop={6}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="תוכן עניינים"
          testID="toc-button"
        >
          <Text style={s.iconText}>☰</Text>
          <Text style={s.barLabel}>תוכן</Text>
        </Pressable>
        <Pressable
          onPress={() =>
            activeTab
              ? router.navigate({ pathname: '/search', params: { bookId: String(activeTab.bookId), title: activeTab.bookTitle } })
              : router.navigate('/search')
          }
          hitSlop={6}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="חיפוש בספר"
          testID="reader-search"
        >
          <SearchIcon size={19} />
        </Pressable>
        <View style={s.flex} />
        <VocalizationToggles />
        <Pressable
          onPress={() => setAppearanceOpen(true)}
          hitSlop={6}
          style={[s.iconBtn, s.aaBtn]}
          accessibilityRole="button"
          accessibilityLabel="הגדרות תצוגה"
          testID="aa-button"
        >
          <Text style={s.aaText}>Aa</Text>
        </Pressable>
      </Collapsible>

      {activeTab ? (
        <View style={s.body}>
          {docked ? (
            <TocDrawer
              docked
              visible={tocOpen}
              bookId={activeTab.bookId}
              bookTitle={activeTab.bookTitle}
              currentLine={activeTab.currentLineIndex}
              onClose={() => setTocOpen(false)}
              onSelect={(line) => requestJump(activeTab.tabId, line, true)}
            />
          ) : null}
          <View style={s.flex}>
            <BookReader key={activeTab.tabId} tab={activeTab} onOpenToc={() => setTocOpen(true)} />
          </View>
        </View>
      ) : (
        <View style={s.empty}>
          <Text style={s.emptyText}>אין ספרים פתוחים</Text>
          <Pressable onPress={goLibrary} style={s.emptyBtn} accessibilityRole="button">
            <Text style={s.emptyBtnText}>לספרייה</Text>
          </Pressable>
        </View>
      )}

      {activeTab && !docked ? (
        <TocDrawer
          visible={tocOpen}
          bookId={activeTab.bookId}
          bookTitle={activeTab.bookTitle}
          currentLine={activeTab.currentLineIndex}
          onClose={() => setTocOpen(false)}
          onSelect={(line) => {
            setTocOpen(false);
            requestJump(activeTab.tabId, line, true);
          }}
        />
      ) : null}
      <AppearanceSheet visible={appearanceOpen} onClose={() => setAppearanceOpen(false)} bookId={activeTab?.bookId} />
      <TabSwitcher visible={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.xs,
      paddingBottom: 2,
      gap: 2,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      zIndex: 2,
    },
    displayBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      gap: spacing.xs,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      zIndex: 2,
    },
    body: { flex: 1, flexDirection: 'row' },
    flex: { flex: 1 },
    barLabel: { fontSize: 13, fontWeight: '600', color: c.accent },
    toolsBtn: { width: 34, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    toolsBtnOn: { backgroundColor: c.accentSoft },
    pressed: { opacity: 0.6 },
    iconBtn: { minWidth: 36, height: 34, paddingHorizontal: 4, flexDirection: 'row', gap: 4, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    iconText: { fontSize: 20, color: c.accent },
    aaBtn: { backgroundColor: c.accentSoft },
    aaText: { fontSize: 17, fontWeight: '700', color: c.accent },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
    emptyText: { fontSize: 16, color: c.textMuted },
    emptyBtn: { backgroundColor: c.accent, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, borderRadius: radius.md },
    emptyBtnText: { color: c.surface, fontSize: 16, fontWeight: '600' },
  });
