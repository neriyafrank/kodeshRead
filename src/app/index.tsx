import { Stack, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { JumpResult } from '../../shared/quickJump';
import { LibraryTree } from '../components/LibraryTree';
import { QuickJumpBar } from '../components/QuickJumpBar';
import { useTabs } from '../state/tabsStore';
import { radius, spacing, useThemedStyles, type Palette } from '../theme';

export default function LibraryScreen() {
  const s = useThemedStyles(createStyles);
  const router = useRouter();
  const openBookInTab = useTabs((x) => x.openBook);
  const tabCount = useTabs((x) => x.tabs.length);

  const openBook = useCallback(
    (bookId: number, bookTitle: string, line?: number, highlight = false) => {
      openBookInTab({ bookId, bookTitle }, { line, highlight });
      router.navigate('/reader');
    },
    [openBookInTab, router],
  );

  const onJump = useCallback((r: JumpResult) => openBook(r.bookId, r.bookTitle, r.targetLine, !r.suggestion), [openBook]);

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: 'ספרייה',
          headerRight: () =>
            tabCount ? (
              <Pressable onPress={() => router.navigate('/reader')} hitSlop={8} style={s.tabsBtn} accessibilityRole="button" testID="open-workspace">
                <Text style={s.tabsBtnText}>לשוניות</Text>
                <View style={s.badge}>
                  <Text style={s.badgeText}>{tabCount}</Text>
                </View>
              </Pressable>
            ) : null,
        }}
      />
      <QuickJumpBar onJump={onJump} />
      <View style={s.divider} />
      <View style={s.tree}>
        <LibraryTree onOpenBook={(id, title) => openBook(id, title)} />
      </View>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    divider: { height: 1, backgroundColor: c.border },
    tree: { flex: 1 },
    tabsBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm },
    tabsBtnText: { color: c.accent, fontSize: 15, fontWeight: '600' },
    badge: { minWidth: 22, height: 22, borderRadius: radius.md, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
    badgeText: { color: c.surface, fontSize: 12, fontWeight: '700' },
  });
