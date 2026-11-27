import { Stack } from 'expo-router';
import { useCallback } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { homeLayout } from '../../shared/homeLayout';
import type { JumpResult } from '../../shared/quickJump';
import { SearchIcon } from '../components/Icons';
import { DailyLearningCard } from '../components/learning/DailyLearning';
import { JobStatus } from '../components/library/JobStatus';
import { OnboardingCard } from '../components/library/OnboardingCard';
import { ResumeCards } from '../components/library/ResumeCard';
import { StarterBooks } from '../components/library/StarterBooks';
import { LibraryColumns } from '../components/LibraryColumns';
import { QuickJumpBar } from '../components/QuickJumpBar';
import { useLibrary } from '../db/LibraryContext';
import { useLibrarySettings } from '../state/libraryStore';
import { useOpenLearningTarget } from '../services/dailyLearningNav';
import { useTabs } from '../state/tabsStore';
import { radius, spacing, useThemedStyles, type Palette } from '../theme';
import { useAppNav } from '../lib/appNav';

export default function LibraryScreen() {
  const s = useThemedStyles(createStyles);
  const nav = useAppNav();
  const insets = useSafeAreaInsets();
  const openBookInTab = useTabs((x) => x.openBook);
  const tabCount = useTabs((x) => x.tabs.length);
  const { core, starter, userBookCount } = useLibrary();
  const onboardingDismissed = useLibrarySettings((x) => x.onboardingDismissed);
  // First launch: no core library yet. Stays until a library exists (or, once personal
  // books were imported, until the user hides it).
  const showOnboarding = !core && !(userBookCount > 0 && onboardingDismissed);
  // No full library yet: the cloud starter books are the instant first-launch library.
  const starterOpen = useLibrarySettings((x) => x.starterOpen);
  const layout = homeLayout({ core: !!core, starter: !!starter, userBookCount, starterOpen });
  const starterMode = layout.starter;

  const openBook = useCallback(
    (bookId: number, bookTitle: string, line?: number, highlight = false) => {
      openBookInTab({ bookId, bookTitle }, { line, highlight });
      nav.open('/reader');
    },
    [openBookInTab, nav],
  );

  const onJump = useCallback((r: JumpResult) => openBook(r.bookId, r.bookTitle, r.targetLine, !r.suggestion), [openBook]);
  const openLearningTarget = useOpenLearningTarget();
  // A study item whose book is not on the device (not in the personal / starter books either): explain how to get it.
  const onMissingLearning = useCallback(
    (item: { title: string }) => {
      const go = () => nav.open('/library-manager');
      const msg = `הספר ״${item.title}״ עדיין לא נמצא במכשיר. אפשר להוריד ספרייה מוכנה מהענן, או לייבא אותו כספר אישי. לפתוח את ניהול הספרייה?`;
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.confirm(msg)) go();
        return;
      }
      Alert.alert('הספר לא נמצא', msg, [
        { text: 'ביטול', style: 'cancel' },
        { text: 'לניהול ספרייה', onPress: go },
      ]);
    },
    [nav],
  );

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: 'ספרייה',
          headerRight: () => (
            <View style={s.headerBtns}>
              <Pressable
                onPress={() => nav.open('/library-manager')}
                hitSlop={8}
                style={s.searchBtn}
                accessibilityRole="button"
                accessibilityLabel="ניהול ספרייה ועדכונים"
                testID="open-library-manager"
              >
                <Text style={s.tabsBtnText}>ניהול</Text>
              </Pressable>
              <Pressable onPress={() => nav.open('/search')} hitSlop={8} style={s.searchBtn} accessibilityRole="button" accessibilityLabel="חיפוש בטקסט" testID="open-search">
                <SearchIcon size={18} />
                <Text style={s.tabsBtnText}>חיפוש</Text>
              </Pressable>
              {tabCount ? (
                <Pressable onPress={() => nav.open('/reader')} hitSlop={8} style={s.tabsBtn} accessibilityRole="button" testID="open-workspace">
                  <Text style={s.tabsBtnText}>לשוניות</Text>
                  <View style={s.badge}>
                    <Text style={s.badgeText}>{tabCount}</Text>
                  </View>
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <JobStatus compact onPress={() => nav.open('/library-manager')} />
      <ResumeCards />
      <QuickJumpBar onJump={onJump} />
      {/* Always shown, above the starter books: never hidden by them. */}
      <DailyLearningCard onOpen={(t) => openLearningTarget(t) && nav.open('/reader')} onMissing={onMissingLearning} />
      <View style={s.divider} />
      {starterMode ? (
        // The onboarding card (import / full download) closes the starter list.
        <StarterBooks
          onOpenBook={(id, title) => openBook(id, title)}
          footer={showOnboarding ? <OnboardingCard hasUserBooks={userBookCount > 0} starter /> : null}
          compact={layout.starterCompact}
        />
      ) : null}
      {layout.personal ? (
        <View style={s.tree}>
          <LibraryColumns
            onOpenBook={(id, title) => openBook(id, title)}
            header={showOnboarding && !starterMode ? <OnboardingCard hasUserBooks={userBookCount > 0} /> : undefined}
            emptyText={showOnboarding ? '' : undefined}
          />
        </View>
      ) : null}
      {/* Pinned to the bottom edge: license attribution, out of the way of the library. */}
      <Pressable
        onPress={() => nav.open('/about')}
        hitSlop={8}
        style={[s.footer, { paddingBottom: spacing.xs + insets.bottom }]}
        accessibilityRole="button"
        testID="open-about"
      >
        <Text style={s.footerText}>אודות</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    divider: { height: 1, backgroundColor: c.border },
    tree: { flex: 1 },
    footer: { marginTop: 'auto', alignItems: 'center', paddingTop: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    footerText: { color: c.textMuted, fontSize: 13 },
    headerBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    searchBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm },
    tabsBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm },
    tabsBtnText: { color: c.accent, fontSize: 15, fontWeight: '600' },
    badge: { minWidth: 22, height: 22, borderRadius: radius.md, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
    badgeText: { color: c.surface, fontSize: 12, fontWeight: '700' },
  });
