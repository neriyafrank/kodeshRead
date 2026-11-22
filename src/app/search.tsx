/**
 * Hebrew full-text search (FTS5).
 *
 *  - input goes through the shared normalizeHebrew() + FTS5 sanitization
 *    (shared/search.js), so punctuation can never cause a syntax error;
 *  - words are AND-ed; "quoted text" is an exact phrase;
 *  - scope: Entire Library / folder / book (ScopeSheet);
 *  - KWIC result cards; tapping opens (or re-uses) the book's tab, jumps to the
 *    line and highlights it for 2 seconds.
 *
 * Route params (optional): bookId + title preset the scope to that book
 * (used by the reader's search button).
 */
import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { countMatches, parseSearchQuery, searchParagraphs, type SearchRow, type SearchScope } from '../../shared/search';
import { SearchIcon } from '../components/Icons';
import { ResultCard } from '../components/search/ResultCard';
import { ScopeSheet } from '../components/search/ScopeSheet';
import { useLibrary } from '../db/LibraryContext';
import { scopeLabel, useSearch } from '../state/searchStore';
import { useTabs } from '../state/tabsStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';

const DEBOUNCE_MS = 250;

interface ResultsState {
  key: string;
  rows: SearchRow[];
  terms: string[];
  hasMore: boolean;
  count: { count: number; capped: boolean } | null;
  elapsed: number;
  error?: string;
}

const scopeKey = (s: SearchScope) => (s.kind === 'all' ? 'all' : s.kind === 'category' ? `c:${s.path}` : `b:${s.bookId}`);

export default function SearchScreen() {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const router = useRouter();
  const params = useLocalSearchParams<{ bookId?: string; title?: string }>();
  const { adapter, fts } = useLibrary();
  const query = useSearch((x) => x.query);
  const setQuery = useSearch((x) => x.setQuery);
  const scope = useSearch((x) => x.scope);
  const setScope = useSearch((x) => x.setScope);
  const recent = useSearch((x) => x.recent);
  const remember = useSearch((x) => x.remember);
  const clearRecent = useSearch((x) => x.clearRecent);
  const openBook = useTabs((x) => x.openBook);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [results, setResults] = useState<ResultsState | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);

  // Preset scope from route params (reader's "search in this book").
  useEffect(() => {
    const id = Number(params.bookId);
    if (Number.isFinite(id) && id > 0) setScope({ kind: 'book', bookId: id, title: params.title ?? '' });
  }, [params.bookId, params.title, setScope]);

  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const key = `${parsed.match}|${scopeKey(scope)}`;

  useEffect(() => {
    const id = ++requestId.current;
    if (parsed.empty) return;
    const timer = setTimeout(async () => {
      const t0 = Date.now();
      try {
        const page = await searchParagraphs(adapter, parsed, { scope, fts });
        if (id !== requestId.current) return;
        const elapsed = Date.now() - t0;
        setResults({ key, rows: page.rows, terms: parsed.terms, hasMore: page.hasMore, count: page.hasMore ? null : { count: page.rows.length, capped: false }, elapsed });
        if (page.hasMore) {
          const count = await countMatches(adapter, parsed, { scope, fts });
          if (id === requestId.current) setResults((r) => (r && r.key === key ? { ...r, count } : r));
        }
      } catch (e) {
        if (id !== requestId.current) return;
        console.warn('search failed', e);
        setResults({ key, rows: [], terms: parsed.terms, hasMore: false, count: { count: 0, capped: false }, elapsed: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [adapter, fts, parsed, scope, key]);

  const current = !parsed.empty && results && results.key === key ? results : null;
  const loading = !parsed.empty && !current;
  // While a new query runs keep showing the previous results instead of flashing an empty list.
  const shown = current ?? (parsed.empty ? null : results);

  const loadMore = useCallback(async () => {
    if (!current || !current.hasMore || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const last = current.rows[current.rows.length - 1];
      const page = await searchParagraphs(adapter, parsed, { scope, fts, afterId: last.id });
      if (id === requestId.current) setResults((r) => (r && r.key === current.key ? { ...r, rows: r.rows.concat(page.rows), hasMore: page.hasMore } : r));
    } catch (e) {
      console.warn('search paging failed', e);
    } finally {
      setLoadingMore(false);
    }
  }, [adapter, current, fts, loadingMore, parsed, scope]);

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
              {current.count ? `${current.count.count}${current.count.capped ? '+' : ''} תוצאות` : `${current.rows.length}+ תוצאות`} · {current.elapsed} ms
            </Text>
          ) : null}
        </View>
      </View>

      {parsed.empty ? (
        <View style={s.help}>
          <Text style={s.helpTitle}>טיפים</Text>
          <Text style={s.helpText}>• כמה מילים — יימצאו פסקאות שמכילות את כולן.</Text>
          <Text style={s.helpText}>• ביטוי במירכאות — התאמה מדויקת: &quot;שני כחות&quot;</Text>
          <Text style={s.helpText}>• ניקוד, טעמים, אותיות סופיות וגרשיים אינם משנים את החיפוש.</Text>
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
      ) : current && current.rows.length === 0 ? (
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
    inputRow: {
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
    input: { flex: 1, fontSize: 18, color: c.text, paddingVertical: spacing.sm, writingDirection: 'rtl' },
    clear: { padding: spacing.sm },
    clearText: { fontSize: 15, color: c.textMuted },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32 },
    scopeBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: '65%',
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: c.accentSoft,
    },
    pressed: { opacity: 0.7 },
    scopeLabel: { fontSize: 13, color: c.textMuted },
    scopeValue: { flexShrink: 1, fontSize: 14, color: c.accent, fontWeight: '700', writingDirection: 'rtl' },
    scopeCaret: { fontSize: 12, color: c.accent },
    count: { fontSize: 13, color: c.textMuted },
    list: { paddingTop: spacing.sm, paddingBottom: spacing.xl },
    footer: { marginVertical: spacing.lg },
    empty: { color: c.textMuted, fontSize: 15, padding: spacing.xl, textAlign: 'center' },
    help: { padding: spacing.lg, gap: 6 },
    helpTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginTop: spacing.sm, writingDirection: 'rtl' },
    helpText: { fontSize: 14, color: c.textMuted, lineHeight: 21, writingDirection: 'rtl' },
    recentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    recentClear: { fontSize: 13, color: c.accent },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: { backgroundColor: c.accentSoft, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: 6 },
    chipText: { color: c.accent, fontSize: 14 },
  });
