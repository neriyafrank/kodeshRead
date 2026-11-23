/**
 * Simple Search ("חיפוש רגיל"): one search bar, results, and the "חיפוש מתקדם" button.
 *
 *  - literal FTS5 matching (shared/hebrewSearch.js SIMPLE_DEFAULTS): every word is matched as
 *    typed — no prefixes / suffixes, no plene / defective spelling, no acronyms, no Aramaic;
 *    words are AND-ed and "quoted text" is an exact phrase. Punctuation never breaks a query;
 *  - scope: Entire Library / folder / book (ScopeSheet);
 *  - KWIC result cards; tapping opens (or re-uses) the book's tab, jumps to the line and
 *    highlights it for 2 seconds;
 *  - "חיפוש מתקדם" opens the dedicated Advanced Search screen (/advanced-search) with the query.
 *
 * Route params (optional): bookId + title preset the scope to that book
 * (used by the reader's search button).
 */
import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { buildQuery } from '../../shared/hebrewSearch';
import type { SearchRow } from '../../shared/search';
import { SearchIcon, SlidersIcon } from '../components/Icons';
import { ResultCard } from '../components/search/ResultCard';
import { ScopeChips } from '../components/search/ScopeChips';
import { ScopeSheet } from '../components/search/ScopeSheet';
import { countLabel, usePlanResults } from '../components/search/usePlanResults';
import { alignRight, inputAlignRight } from '../lib/direction';
import { scopeLabel, useSearch } from '../state/searchStore';
import { useTabs } from '../state/tabsStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';

const DEBOUNCE_MS = 250;

export default function SearchScreen() {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const router = useRouter();
  const params = useLocalSearchParams<{ bookId?: string; title?: string }>();
  const query = useSearch((x) => x.query);
  const setQuery = useSearch((x) => x.setQuery);
  const scope = useSearch((x) => x.scope);
  const setScope = useSearch((x) => x.setScope);
  const recent = useSearch((x) => x.recent);
  const remember = useSearch((x) => x.remember);
  const clearRecent = useSearch((x) => x.clearRecent);
  const advanced = useSearch((x) => x.advanced);
  const setAdvanced = useSearch((x) => x.setAdvanced);
  const openBook = useTabs((x) => x.openBook);
  const [scopeOpen, setScopeOpen] = useState(false);

  // Preset scope from route params (reader's "search in this book").
  useEffect(() => {
    const id = Number(params.bookId);
    if (Number.isFinite(id) && id > 0) setScope({ kind: 'book', bookId: id, title: params.title ?? '' });
  }, [params.bookId, params.title, setScope]);

  // Literal plan: no expansion, no operators.
  const plan = useMemo(() => buildQuery(query), [query]);
  const { current, shown, loading, loadMore, loadingMore } = usePlanResults(plan, scope, DEBOUNCE_MS);

  const openAdvanced = useCallback(() => {
    Keyboard.dismiss();
    // Carry the typed words over (the advanced fields keep their own state otherwise).
    if (query.trim() && !advanced.fields.query.trim()) setAdvanced({ fields: { ...advanced.fields, query } });
    const book = scope.kind === 'book' ? { bookId: String(scope.bookId), title: scope.title } : undefined;
    router.push(book ? { pathname: '/advanced-search', params: book } : '/advanced-search');
  }, [advanced.fields, query, router, scope, setAdvanced]);

  const onOpen = useCallback(
    (row: SearchRow) => {
      Keyboard.dismiss();
      remember(query);
      openBook({ bookId: row.book_id, bookTitle: row.book_title }, { line: row.line_index, highlight: true, terms: shown?.terms ?? [] });
      router.navigate('/reader');
    },
    [openBook, query, remember, router, shown?.terms],
  );

  const renderItem = useCallback(
    ({ item }: { item: SearchRow }) => <ResultCard row={item} terms={shown?.terms ?? []} onPress={onOpen} />,
    [shown?.terms, onOpen],
  );

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'חיפוש בטקסט' }} />
      <View style={s.top}>
        <View style={s.searchRow}>
          <View style={s.inputRow}>
            <View style={s.icon}>
              <SearchIcon />
            </View>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder='חיפוש מילים, או "ביטוי מדויק"'
              placeholderTextColor={c.textMuted}
              style={s.input}
              autoFocus={!query}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              onSubmitEditing={() => remember(query)}
              accessibilityLabel="חיפוש בטקסט"
              testID="search-input"
            />
            {query ? (
              <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="נקה" style={s.clear} testID="search-clear">
                <Text style={s.clearText}>✕</Text>
              </Pressable>
            ) : null}
          </View>
          <Pressable
            onPress={openAdvanced}
            style={({ pressed }) => [s.advancedBtn, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel="חיפוש מתקדם"
            testID="open-advanced-search"
          >
            <SlidersIcon size={13} color={c.accent} />
            <Text style={s.advancedText}>חיפוש מתקדם</Text>
          </Pressable>
        </View>
        <View style={s.metaRow}>
          <Pressable onPress={() => setScopeOpen(true)} style={({ pressed }) => [s.scopeBtn, pressed && s.pressed]} accessibilityRole="button" testID="scope-button">
            <Text style={s.scopeLabel}>היקף:</Text>
            <Text style={s.scopeValue} numberOfLines={1}>
              {scopeLabel(scope)}
            </Text>
            <Text style={s.scopeCaret}>▾</Text>
          </Pressable>
          {scope.kind !== 'all' ? (
            <Pressable onPress={() => setScope({ kind: 'all' })} hitSlop={8} accessibilityLabel="חיפוש בכל הספרייה" testID="scope-reset">
              <Text style={s.clearText}>✕</Text>
            </Pressable>
          ) : null}
          <View style={s.flex} />
          {loading ? <ActivityIndicator size="small" color={c.accent} /> : null}
          {!loading && current ? (
            <Text style={s.count} testID="search-count">
              {countLabel(current)}
            </Text>
          ) : null}
        </View>
        <ScopeChips scope={scope} onChange={setScope} />
      </View>

      {plan.empty ? (
        <View style={s.help}>
          <Text style={s.helpTitle}>טיפים</Text>
          <Text style={s.helpText}>• כמה מילים — יימצאו פסקאות שמכילות את כולן, בדיוק כפי שהוקלדו.</Text>
          <Text style={s.helpText}>• ביטוי במירכאות — התאמה מדויקת: &quot;שני כחות&quot;</Text>
          <Text style={s.helpText}>• ניקוד, טעמים, אותיות סופיות וגרשיים אינם משנים את החיפוש.</Text>
          <Text style={s.helpText}>• תחיליות וסופיות, כתיב מלא/חסר, ראשי תיבות, ארמית, קרבת מילים וסינון לפי מדור — בחיפוש המתקדם.</Text>
          {recent.length ? (
            <>
              <View style={s.recentHeader}>
                <Text style={s.helpTitle}>חיפושים אחרונים</Text>
                <Pressable onPress={clearRecent} hitSlop={8}>
                  <Text style={s.recentClear}>ניקוי</Text>
                </Pressable>
              </View>
              <View style={s.chips}>
                {recent.map((r) => (
                  <Pressable key={r} onPress={() => setQuery(r)} style={s.chip} testID="search-recent">
                    <Text style={s.chipText}>{r}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </View>
      ) : current?.error ? (
        <Text style={s.empty}>שגיאה בחיפוש: {current.error}</Text>
      ) : current && current.rows.length === 0 && !current.hasMore ? (
        <Text style={s.empty} testID="search-empty">
          לא נמצאו תוצאות{scope.kind !== 'all' ? ` ב${scopeLabel(scope)}` : ''}
        </Text>
      ) : (
        <FlashList
          data={shown?.rows ?? []}
          keyExtractor={(r) => String(r.id)}
          renderItem={renderItem}
          extraData={shown?.terms}
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={s.list}
          ListFooterComponent={loadingMore ? <ActivityIndicator style={s.footer} color={c.accent} /> : null}
        />
      )}

      <ScopeSheet visible={scopeOpen} scope={scope} onSelect={setScope} onClose={() => setScopeOpen(false)} />
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    flex: { flex: 1 },
    top: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    inputRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1.5,
      borderColor: c.accent,
      paddingStart: spacing.md,
      paddingEnd: spacing.sm,
      minHeight: 50,
    },
    icon: { marginEnd: spacing.md },
    input: { flex: 1, minWidth: 0, fontSize: 18, color: c.text, paddingVertical: spacing.sm, ...inputAlignRight },
    clear: { padding: spacing.sm },
    clearText: { fontSize: 15, color: c.textMuted },
    advancedBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      minHeight: 50,
      paddingHorizontal: 8,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.accent,
      backgroundColor: 'transparent',
    },
    advancedText: { fontSize: 12, fontWeight: '600', color: c.accent, ...alignRight },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32 },
    scopeBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: '55%',
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: c.accentSoft,
    },
    pressed: { opacity: 0.7 },
    scopeLabel: { fontSize: 13, color: c.textMuted, ...alignRight },
    scopeValue: { flexShrink: 1, fontSize: 14, color: c.accent, fontWeight: '700', ...alignRight },
    scopeCaret: { fontSize: 12, color: c.accent },
    count: { fontSize: 13, color: c.textMuted, ...alignRight },
    list: { paddingTop: spacing.sm, paddingBottom: spacing.xl },
    footer: { marginVertical: spacing.lg },
    empty: { color: c.textMuted, fontSize: 15, padding: spacing.xl, textAlign: 'center' },
    help: { padding: spacing.lg, gap: 6 },
    helpTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginTop: spacing.sm, ...alignRight },
    helpText: { fontSize: 14, color: c.textMuted, lineHeight: 21, ...alignRight },
    recentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    recentClear: { fontSize: 13, color: c.accent },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: { backgroundColor: c.accentSoft, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: 6 },
    chipText: { color: c.accent, fontSize: 14 },
  });
