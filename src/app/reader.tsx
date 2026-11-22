/**
 * Reading workspace: tab strip + the active tab's windowed reader, the TOC
 * drawer and the `Aa` appearance sheet. Only the active tab's reader is mounted;
 * the others are restored from their saved positions when re-activated.
 */
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SearchIcon } from '../components/Icons';
import { AppearanceSheet } from '../components/reader/AppearanceSheet';
import { BookReader } from '../components/reader/BookReader';
import { TabStrip } from '../components/reader/TabStrip';
import { TocDrawer } from '../components/reader/TocDrawer';
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

  const goLibrary = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false, title: activeTab?.bookTitle ?? 'קורא' }} />
      <View style={[s.toolbar, { paddingTop: insets.top + spacing.xs }]}>
        <Pressable onPress={goLibrary} hitSlop={8} style={s.iconBtn} accessibilityRole="button" accessibilityLabel="חזרה לספרייה" testID="reader-back">
          <Text style={s.iconText}>→</Text>
        </Pressable>
        <TabStrip />
        <Pressable
          onPress={() => setTocOpen(true)}
          disabled={!activeTab}
          hitSlop={6}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="תוכן עניינים"
          testID="toc-button"
        >
          <Text style={s.iconText}>☰</Text>
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
      </View>

      {activeTab ? (
        <BookReader key={activeTab.tabId} tab={activeTab} onOpenToc={() => setTocOpen(true)} />
      ) : (
        <View style={s.empty}>
          <Text style={s.emptyText}>אין ספרים פתוחים</Text>
          <Pressable onPress={goLibrary} style={s.emptyBtn} accessibilityRole="button">
            <Text style={s.emptyBtnText}>לספרייה</Text>
          </Pressable>
        </View>
      )}

      {activeTab ? (
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
      <AppearanceSheet visible={appearanceOpen} onClose={() => setAppearanceOpen(false)} />
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.xs,
      gap: spacing.xs,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      zIndex: 2,
    },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    iconText: { fontSize: 20, color: c.accent },
    aaBtn: { backgroundColor: c.accentSoft },
    aaText: { fontSize: 17, fontWeight: '700', color: c.accent },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
    emptyText: { fontSize: 16, color: c.textMuted },
    emptyBtn: { backgroundColor: c.accent, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, borderRadius: radius.md },
    emptyBtnText: { color: c.surface, fontSize: 16, fontWeight: '600' },
  });
