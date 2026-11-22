/**
 * All-tabs switcher: every open tab as a card (book, exact location, folder badge, ✕), most
 * recently used first, with an instant filter that understands abbreviations and other spellings
 * (shared/tabs.js filterTabs -> hebrewTorahDict: "רמב\"ם שבת", "שו\"ע או\"ח", "ב\"ק").
 * Header actions: close the other tabs, close all (asks for a second tap to confirm).
 */
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { filterTabs, tabLocation } from '../../../shared/tabs';
import { useLibrary } from '../../db/LibraryContext';
import { useTabs, type ReaderTab } from '../../state/tabsStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';
import { BottomSheet } from '../Overlay';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function TabSwitcher({ visible, onClose }: Props) {
  return (
    <BottomSheet visible={visible} onClose={onClose} testID="tab-switcher">
      {visible ? <SwitcherBody onClose={onClose} /> : null}
    </BottomSheet>
  );
}

function SwitcherBody({ onClose }: { onClose: () => void }) {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const { bookIndex } = useLibrary();
  const tabs = useTabs((x) => x.tabs);
  const activeTabId = useTabs((x) => x.activeTabId);
  const activate = useTabs((x) => x.activate);
  const closeTab = useTabs((x) => x.closeTab);
  const closeOthers = useTabs((x) => x.closeOthers);
  const closeAll = useTabs((x) => x.closeAll);
  const [query, setQuery] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);

  const categoryOf = (t: ReaderTab) => bookIndex.books.get(t.bookId)?.categoryPath;
  const shown = useMemo(() => {
    // Most recently used first (stable for tabs never activated since this feature).
    const recent = tabs.map((t, i) => ({ t, i })).sort((a, b) => (b.t.lastUsed ?? 0) - (a.t.lastUsed ?? 0) || b.i - a.i).map((x) => x.t);
    return filterTabs(recent, query, categoryOf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, query, bookIndex]);

  const pick = (t: ReaderTab) => {
    activate(t.tabId);
    onClose();
  };

  return (
    <View style={s.body}>
      <View style={s.header}>
        <Text style={s.title}>לשוניות פתוחות · {tabs.length}</Text>
        <Pressable
          onPress={() => activeTabId && closeOthers(activeTabId)}
          disabled={tabs.length < 2 || !activeTabId}
          style={({ pressed }) => [s.headerBtn, (tabs.length < 2 || !activeTabId) && s.disabled, pressed && s.pressed]}
          accessibilityRole="button"
          testID="tabs-close-others"
        >
          <Text style={s.headerBtnText}>סגור טאבים אחרים</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            if (!confirmAll) return setConfirmAll(true);
            closeAll();
            onClose();
          }}
          disabled={!tabs.length}
          style={({ pressed }) => [s.headerBtn, confirmAll && s.danger, !tabs.length && s.disabled, pressed && s.pressed]}
          accessibilityRole="button"
          testID={confirmAll ? 'tabs-close-all-confirm' : 'tabs-close-all'}
        >
          <Text style={[s.headerBtnText, confirmAll && s.dangerText]}>{confirmAll ? 'לאשר סגירת הכל?' : 'סגור הכל'}</Text>
        </Pressable>
      </View>
      <TextInput
        value={query}
        onChangeText={(v) => {
          setQuery(v);
          setConfirmAll(false);
        }}
        placeholder='סינון: שם ספר או קיצור (רמב"ם, שו"ע או"ח)…'
        placeholderTextColor={c.textMuted}
        style={s.input}
        autoCorrect={false}
        autoCapitalize="none"
        testID="tabs-filter"
      />
      <FlatList
        data={shown}
        keyExtractor={(t) => t.tabId}
        keyboardShouldPersistTaps="handled"
        style={s.list}
        ListEmptyComponent={<Text style={s.empty}>{tabs.length ? 'אין לשוניות מתאימות' : 'אין לשוניות פתוחות'}</Text>}
        renderItem={({ item }) => {
          const active = item.tabId === activeTabId;
          const where = tabLocation(item.tocPath, 3);
          const cat = categoryOf(item);
          return (
            <Pressable onPress={() => pick(item)} style={({ pressed }) => [s.card, active && s.cardActive, pressed && s.pressed]} accessibilityRole="button" testID={`tab-card-${item.bookId}`}>
              <View style={{ flex: 1 }}>
                <View style={s.cardTop}>
                  <Text style={[s.cardTitle, active && { color: c.accent }]} numberOfLines={1}>
                    {item.bookTitle}
                  </Text>
                  {cat ? (
                    <Text style={s.badge} numberOfLines={1}>
                      {cat.split('/')[0]}
                    </Text>
                  ) : null}
                </View>
                <Text style={s.where} numberOfLines={1}>
                  {where || 'תחילת הספר'}
                </Text>
              </View>
              <Pressable onPress={() => closeTab(item.tabId)} hitSlop={8} style={s.close} accessibilityLabel={`סגור ${item.bookTitle}`} testID={`tab-card-close-${item.bookId}`}>
                <Text style={s.closeText}>×</Text>
              </Pressable>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    body: { maxHeight: '100%' },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    title: { flex: 1, fontSize: 17, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    headerBtn: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.accent },
    headerBtnText: { fontSize: 13, fontWeight: '600', color: c.accent },
    danger: { borderColor: c.danger, backgroundColor: c.danger },
    dangerText: { color: c.surface },
    disabled: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
    input: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
      fontSize: 16,
      color: c.text,
      writingDirection: 'rtl',
      textAlign: 'right',
    },
    list: { flexGrow: 0 },
    empty: { textAlign: 'center', color: c.textMuted, padding: spacing.xl },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: spacing.lg,
      marginBottom: spacing.xs,
      paddingStart: spacing.md,
      paddingEnd: spacing.xs,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    cardActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    cardTitle: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    badge: { fontSize: 11, color: c.textMuted, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 120 },
    where: { fontSize: 13, color: c.textMuted, marginTop: 2, writingDirection: 'rtl', textAlign: 'right' },
    close: { padding: spacing.sm },
    closeText: { fontSize: 20, color: c.textMuted },
  });
