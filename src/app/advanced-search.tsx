/**
 * Advanced Search ("חיפוש מתקדם"): a Responsa-Project-style search form over the same offline
 * FTS5 index as Simple Search (shared/hebrewSearch.js + shared/search.js searchPlan).
 *
 *  - structured fields: מילות החיפוש / ביטוי (inline a|b, -word, word*, "exact"),
 *    אחת מהמילים (OR) and ללא המילים (NOT);
 *  - linguistic toggles: תחיליות וסופיות (on), כתיב מלא/חסר, ראשי תיבות, עברית ↔ ארמית (off);
 *  - קרבת מילים: פסקה | ביטוי מדויק | קרבה 3 / 5 / 10 (+ שמור על סדר המילים);
 *  - סינון לפי מדור: הכל, הספר הנוכחי, תנ"ך, משנה, בבלי, רמב"ם, שולחן ערוך, מפרשים;
 *  - "חפש" runs the query (exact matches first, then expanded variants, all highlighted);
 *    "נקה הכל" restores the defaults. The form folds into a summary bar over the results.
 *
 * Route params (optional): bookId + title name the "current book" chip.
 */
import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ADVANCED_DEFAULTS, NEAR_DISTANCES, buildQuery, type ProximityMode, type SearchPlan } from '../../shared/hebrewSearch';
import { CORPORA, type SearchRow, type SearchScope } from '../../shared/search';
import { ResultCard } from '../components/search/ResultCard';
import { ScopeChips } from '../components/search/ScopeChips';
import { ScopeSheet } from '../components/search/ScopeSheet';
import { countLabel, usePlanResults } from '../components/search/usePlanResults';
import { alignRight, inputAlignRight } from '../lib/direction';
import { advancedDefaults, scopeLabel, useSearch, type AdvancedState, type LinguisticOptions } from '../state/searchStore';
import { selectActiveTab, useTabs } from '../state/tabsStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';

const TOGGLES: { key: keyof LinguisticOptions; label: string; hint: string }[] = [
  { key: 'prefixesAndSuffixes', label: 'תחיליות וסופיות', hint: 'ושבת, בשבת, שבתות, שבתו · תפילה → לתפילתו' },
  { key: 'pleneDefective', label: 'כתיב מלא/חסר', hint: 'מצווה ↔ מצוה · שולחן ↔ שלחן · תפילה ↔ תפלה' },
  { key: 'acronyms', label: 'ראשי תיבות', hint: 'שו"ע ↔ שולחן ערוך · ק"ו ↔ קל וחומר' },
  { key: 'aramaicEquiv', label: 'עברית ↔ ארמית', hint: 'מותר ↔ שרי · הלכה ↔ הלכתא · ספק ↔ ספיקא' },
];

const PROXIMITY: { mode: ProximityMode; label: string }[] = [
  { mode: 'paragraph', label: 'פסקה' },
  { mode: 'phrase', label: 'ביטוי מדויק' },
  { mode: 'near', label: 'קרבה' },
];

interface CurrentBook {
  bookId: number;
  title: string;
}

/** Corpus chips -> search scope ("book" needs an open book; several corpora are OR-ed). */
function scopeOf(corpora: string[], book: CurrentBook | null, picked: SearchScope): SearchScope {
  // Books / commentaries picked in the scope picker take precedence over the corpus chips.
  if (picked.kind === 'books') return picked;
  if (corpora.includes('book') && book) return { kind: 'book', bookId: book.bookId, title: book.title };
  const ids = corpora.filter((id) => CORPORA.some((c) => c.id === id));
  if (!ids.length) return { kind: 'all' };
  return { kind: 'corpus', ids, name: CORPORA.filter((c) => ids.includes(c.id)).map((c) => c.label).join(' · ') };
}

function planOf(a: AdvancedState): SearchPlan {
  return buildQuery(a.fields, { ...ADVANCED_DEFAULTS, ...a.options, proximity: a.proximity });
}

export default function AdvancedSearchScreen() {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const router = useRouter();
  const params = useLocalSearchParams<{ bookId?: string; title?: string }>();
  const advanced = useSearch((x) => x.advanced);
  const setAdvanced = useSearch((x) => x.setAdvanced);
  const resetAdvanced = useSearch((x) => x.resetAdvanced);
  const picked = useSearch((x) => x.scope);
  const setPicked = useSearch((x) => x.setScope);
  const [scopeOpen, setScopeOpen] = useState(false);
  const remember = useSearch((x) => x.remember);
  const openBook = useTabs((x) => x.openBook);
  const activeTab = useTabs(selectActiveTab);

  const book = useMemo<CurrentBook | null>(() => {
    const id = Number(params.bookId);
    if (Number.isFinite(id) && id > 0) return { bookId: id, title: params.title ?? '' };
    return activeTab ? { bookId: activeTab.bookId, title: activeTab.bookTitle } : null;
  }, [activeTab, params.bookId, params.title]);

  // The query runs on "חפש": a snapshot of the form.
  const [submitted, setSubmitted] = useState<{ plan: SearchPlan; scope: SearchScope } | null>(null);
  const [formOpen, setFormOpen] = useState(true);
  const { current, shown, loading, loadMore, loadingMore } = usePlanResults(submitted?.plan ?? null, submitted?.scope ?? { kind: 'all' }, 0);
  const draftPlan = useMemo(() => planOf(advanced), [advanced]);

  const setField = (k: keyof AdvancedState['fields'], v: string) => setAdvanced({ fields: { ...advanced.fields, [k]: v } });
  const setOption = (k: keyof LinguisticOptions) => setAdvanced({ options: { ...advanced.options, [k]: !advanced.options[k] } });
  const setProximity = (p: Partial<AdvancedState['proximity']>) => setAdvanced({ proximity: { ...advanced.proximity, ...p } });

  const toggleCorpus = (id: string) => {
    if (picked.kind === 'books') setPicked({ kind: 'all' });
    if (id === 'all' || id === 'book') return setAdvanced({ corpora: [id] });
    const rest = advanced.corpora.filter((x) => x !== 'all' && x !== 'book');
    const next = rest.includes(id) ? rest.filter((x) => x !== id) : [...rest, id];
    setAdvanced({ corpora: next.length ? next : ['all'] });
  };
  const corpora = useMemo(() => (advanced.corpora.includes('book') && !book ? ['all'] : advanced.corpora), [advanced.corpora, book]);

  const onSearch = useCallback(() => {
    Keyboard.dismiss();
    const plan = planOf(advanced);
    if (plan.empty) return;
    remember(advanced.fields.query || advanced.fields.anyOf);
    setSubmitted({ plan, scope: scopeOf(corpora, book, picked) });
    setFormOpen(false);
  }, [advanced, book, corpora, picked, remember]);

  const onReset = useCallback(() => {
    resetAdvanced();
    setSubmitted(null);
    setFormOpen(true);
  }, [resetAdvanced]);

  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/search');
  }, [router]);

  const onOpen = useCallback(
    (row: SearchRow) => {
      Keyboard.dismiss();
      openBook({ bookId: row.book_id, bookTitle: row.book_title }, { line: row.line_index, highlight: true, terms: shown?.terms ?? [] });
      router.navigate('/reader');
    },
    [openBook, router, shown?.terms],
  );

  const rows = useMemo(() => shown?.rows ?? [], [shown?.rows]);
  const renderItem = useCallback(
    ({ item, index }: { item: SearchRow; index: number }) => {
      const firstExpanded = item.phase === 1 && (index === 0 || rows[index - 1]?.phase !== 1);
      return (
        <>
          {firstExpanded ? (
            <View style={s.divider} testID="adv-expanded-divider">
              <Text style={s.dividerText}>התאמות נוספות · צורות ווריאנטים</Text>
            </View>
          ) : null}
          <ResultCard row={item} terms={shown?.terms ?? []} onPress={onOpen} />
        </>
      );
    },
    [onOpen, rows, s.divider, s.dividerText, shown?.terms],
  );

  const summary = [advanced.fields.query, advanced.fields.anyOf && `או: ${advanced.fields.anyOf}`, advanced.fields.exclude && `ללא: ${advanced.fields.exclude}`].filter(Boolean).join(' · ');
  const isDefault = JSON.stringify(advanced) === JSON.stringify(advancedDefaults());

  const form = (
    <View style={s.form} testID="adv-form">
      <Field label="מילות החיפוש / ביטוי" hint='אופרטורים: א|ב (או) · ‎-מילה (ללא) · מיל* (התחלה) · "ביטוי מדויק"'>
        <TextInput
          value={advanced.fields.query}
          onChangeText={(v) => setField('query', v)}
          placeholder="לדוגמה: שבת | יום טוב -מוקצה"
          placeholderTextColor={c.textMuted}
          style={[s.input, s.mainInput]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={onSearch}
          accessibilityLabel="מילות החיפוש"
          testID="adv-query"
        />
      </Field>
      <View style={s.pair}>
        <Field label="אחת מהמילים · או" style={s.flex}>
          <TextInput
            value={advanced.fields.anyOf}
            onChangeText={(v) => setField('anyOf', v)}
            placeholder="רבא, אביי"
            placeholderTextColor={c.textMuted}
            style={s.input}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={onSearch}
            accessibilityLabel="אחת מהמילים"
            testID="adv-any"
          />
        </Field>
        <Field label="ללא המילים · שלילה" style={s.flex}>
          <TextInput
            value={advanced.fields.exclude}
            onChangeText={(v) => setField('exclude', v)}
            placeholder="מילים שלא יופיעו"
            placeholderTextColor={c.textMuted}
            style={s.input}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={onSearch}
            accessibilityLabel="ללא המילים"
            testID="adv-exclude"
          />
        </Field>
      </View>

      <Text style={s.section}>אפשרויות לשוניות</Text>
      <View style={s.card}>
        {TOGGLES.map((t, i) => (
          <Toggle key={t.key} label={t.label} hint={t.hint} value={advanced.options[t.key]} onPress={() => setOption(t.key)} testID={`adv-opt-${t.key}`} last={i === TOGGLES.length - 1} />
        ))}
      </View>

      <Text style={s.section}>קרבת מילים</Text>
      <View style={s.segment} accessibilityRole="radiogroup">
        {PROXIMITY.map((p) => {
          const on = advanced.proximity.mode === p.mode;
          return (
            <Pressable
              key={p.mode}
              onPress={() => setProximity({ mode: p.mode })}
              style={[s.segmentItem, on && s.segmentOn]}
              accessibilityRole="radio"
              aria-selected={on}
              testID={`adv-prox-${p.mode}`}
            >
              <Text style={[s.segmentText, on && s.segmentTextOn]}>{p.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {advanced.proximity.mode === 'near' ? (
        <View style={s.nearBox}>
          <View style={s.chips}>
            <Text style={s.nearLabel}>עד</Text>
            {NEAR_DISTANCES.map((d) => {
              const on = advanced.proximity.distance === d;
              return (
                <Pressable
                  key={d}
                  onPress={() => setProximity({ distance: d })}
                  style={[s.chip, on && s.chipOn]}
                  accessibilityRole="radio"
                  aria-selected={on}
                  testID={`adv-dist-${d}`}
                >
                  <Text style={[s.chipText, on && s.chipTextOn]}>{d}</Text>
                </Pressable>
              );
            })}
            <Text style={s.nearLabel}>מילים ביניהן</Text>
          </View>
          <View style={s.card}>
            <Toggle label="שמור על סדר המילים" hint="המילים יופיעו בסדר שבו הוקלדו" value={advanced.proximity.ordered} onPress={() => setProximity({ ordered: !advanced.proximity.ordered })} testID="adv-ordered" last />
          </View>
        </View>
      ) : null}

      <Text style={s.section}>סינון לפי מדור</Text>
      <View style={s.chips}>
        {[{ id: 'all', label: 'הכל' }, ...(book ? [{ id: 'book', label: `הספר הנוכחי${book.title ? ` · ${book.title}` : ''}` }] : []), ...CORPORA].map((k) => {
          const on = picked.kind !== 'books' && corpora.includes(k.id);
          return (
            <Pressable
              key={k.id}
              onPress={() => toggleCorpus(k.id)}
              style={[s.chip, on && s.chipOn]}
              accessibilityRole="checkbox"
              aria-checked={on}
              testID={`adv-corpus-${k.id}`}
            >
              <Text style={[s.chipText, on && s.chipTextOn]} numberOfLines={1}>
                {k.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable onPress={() => setScopeOpen(true)} style={({ pressed }) => [s.scopeBtn, picked.kind === 'books' && s.chipOn, pressed && s.pressed]} accessibilityRole="button" testID="adv-scope-button">
        <Text style={[s.chipText, picked.kind === 'books' && s.chipTextOn]} numberOfLines={1}>
          {picked.kind === 'books' ? `ספרים ופרשנים: ${scopeLabel(picked)}` : 'בחירת ספרים ופרשנים…'}
        </Text>
        <Text style={s.chipText}>▾</Text>
      </Pressable>
      <ScopeChips scope={picked} onChange={setPicked} />

      <View style={s.actions}>
        <Pressable
          onPress={onSearch}
          disabled={draftPlan.empty}
          style={({ pressed }) => [s.primary, draftPlan.empty && s.disabled, pressed && s.pressed]}
          accessibilityRole="button"
          aria-disabled={draftPlan.empty}
          testID="adv-submit"
        >
          <Text style={s.primaryText}>חפש</Text>
        </Pressable>
        <Pressable onPress={onReset} disabled={isDefault && !submitted} style={({ pressed }) => [s.secondary, pressed && s.pressed]} accessibilityRole="button" testID="adv-reset">
          <Text style={s.secondaryText}>נקה הכל</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <View style={s.screen} testID="advanced-search">
      <Stack.Screen options={{ title: 'חיפוש מתקדם' }} />
      <View style={s.topBar}>
        <Text style={s.heading} numberOfLines={1}>
          לא מקוון
        </Text>
        <Pressable onPress={back} style={({ pressed }) => [s.backBtn, pressed && s.pressed]} accessibilityRole="button" testID="adv-back">
          <Text style={s.backText}>חזרה לחיפוש רגיל</Text>
        </Pressable>
      </View>

      {formOpen || !submitted ? (
        <ScrollView style={s.flex} contentContainerStyle={s.formScroll} keyboardShouldPersistTaps="handled">
          {form}
        </ScrollView>
      ) : (
        <>
          <Pressable onPress={() => setFormOpen(true)} style={({ pressed }) => [s.summary, pressed && s.pressed]} accessibilityRole="button" testID="adv-edit">
            <View style={s.flex}>
              <Text style={s.summaryText} numberOfLines={1}>
                {summary}
              </Text>
              <Text style={s.summaryMeta} numberOfLines={1}>
                {submitted.scope.kind === 'all' ? 'כל הספרייה' : submitted.scope.kind === 'book' ? submitted.scope.title : submitted.scope.kind === 'corpus' || submitted.scope.kind === 'books' ? submitted.scope.name : ''}
                {submitted.plan.hasExpansions ? ' · כולל צורות נוספות' : ''}
              </Text>
            </View>
            <Text style={s.editText}>עריכה ▾</Text>
          </Pressable>
          <View style={s.resultsHeader}>
            {loading ? <ActivityIndicator size="small" color={c.accent} /> : null}
            {!loading && current ? (
              <Text style={s.count} testID="adv-count">
                {countLabel(current)}
              </Text>
            ) : null}
            <View style={s.flex} />
            {submitted.plan.hasExpansions ? <Text style={s.note}>התאמות מדויקות תחילה</Text> : null}
          </View>
          {current?.error ? (
            <Text style={s.empty}>שגיאה בחיפוש: {current.error}</Text>
          ) : current && current.rows.length === 0 && !current.hasMore ? (
            <Text style={s.empty} testID="adv-empty">
              לא נמצאו תוצאות
            </Text>
          ) : (
            <FlashList
              data={rows}
              keyExtractor={(r) => String(r.id)}
              renderItem={renderItem}
              extraData={shown?.terms}
              onEndReached={loadMore}
              onEndReachedThreshold={0.6}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={s.list}
              ListFooterComponent={
                loadingMore ? (
                  <ActivityIndicator style={s.footer} color={c.accent} />
                ) : current?.hasMore && rows.length < 10 ? (
                  <Pressable onPress={loadMore} style={s.more} testID="adv-more">
                    <Text style={s.moreText}>המשך חיפוש…</Text>
                  </Pressable>
                ) : null
              }
            />
          )}
        </>
      )}
      <ScopeSheet visible={scopeOpen} scope={picked} onSelect={setPicked} onClose={() => setScopeOpen(false)} />
    </View>
  );
}

function Field({ label, hint, style, children }: { label: string; hint?: string; style?: object; children: React.ReactNode }) {
  const s = useThemedStyles(createStyles);
  return (
    <View style={[s.field, style]}>
      <Text style={s.label}>{label}</Text>
      {children}
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

function Toggle({ label, hint, value, onPress, testID, last }: { label: string; hint: string; value: boolean; onPress: () => void; testID: string; last?: boolean }) {
  const s = useThemedStyles(createStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.toggleRow, !last && s.toggleSep, pressed && s.pressed]}
      accessibilityRole="switch"
      aria-checked={value}
      accessibilityLabel={label}
      testID={testID}
    >
      <View style={s.flex}>
        <Text style={s.toggleLabel}>{label}</Text>
        <Text style={s.toggleHint}>{hint}</Text>
      </View>
      <View style={[s.track, value && s.trackOn]}>
        <View style={[s.knob, value && s.knobOn]} />
      </View>
    </Pressable>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    flex: { flex: 1 },
    pressed: { opacity: 0.7 },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    heading: { flex: 1, fontSize: 13, color: c.textMuted, ...alignRight },
    backBtn: { paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: c.accent },
    backText: { fontSize: 13, fontWeight: '700', color: c.accent, ...alignRight },
    formScroll: { paddingBottom: spacing.xl },
    form: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
    field: { gap: 4 },
    label: { fontSize: 14, fontWeight: '700', color: c.text, ...alignRight },
    hint: { fontSize: 12, color: c.textMuted, ...alignRight },
    input: {
      fontSize: 16,
      color: c.text,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      minHeight: 44,
      ...inputAlignRight,
    },
    mainInput: { fontSize: 18, borderWidth: 1.5, borderColor: c.accent, minHeight: 50 },
    pair: { flexDirection: 'row', gap: spacing.sm },
    section: { fontSize: 15, fontWeight: '800', color: c.accent, marginTop: spacing.md, ...alignRight },
    card: { backgroundColor: c.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden' },
    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, minHeight: 52 },
    toggleSep: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    toggleLabel: { fontSize: 15, fontWeight: '600', color: c.text, ...alignRight },
    toggleHint: { fontSize: 12, color: c.textMuted, ...alignRight },
    track: { width: 42, height: 24, borderRadius: 12, backgroundColor: c.surfaceMuted, borderWidth: 1, borderColor: c.border, justifyContent: 'center', paddingHorizontal: 2 },
    trackOn: { backgroundColor: c.accent, borderColor: c.accent },
    knob: { width: 18, height: 18, borderRadius: 9, backgroundColor: c.surface, alignSelf: 'flex-start' },
    // RTL switch: the knob moves to the left when on.
    knobOn: { alignSelf: 'flex-end', backgroundColor: c.background },
    segment: { flexDirection: 'row', borderRadius: radius.md, borderWidth: 1, borderColor: c.border, overflow: 'hidden', backgroundColor: c.surface },
    segmentItem: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm },
    segmentOn: { backgroundColor: c.accent },
    segmentText: { fontSize: 14, color: c.text },
    segmentTextOn: { color: c.background, fontWeight: '700' },
    nearBox: { gap: spacing.sm },
    nearLabel: { fontSize: 13, color: c.textMuted, ...alignRight },
    chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
    chip: { maxWidth: '100%', borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingHorizontal: spacing.md, paddingVertical: 6 },
    chipOn: { backgroundColor: c.accentSoft, borderColor: c.accent },
    scopeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    chipText: { fontSize: 14, color: c.text, ...alignRight },
    chipTextOn: { color: c.accent, fontWeight: '700' },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
    primary: { flex: 2, alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: radius.md, backgroundColor: c.accent },
    primaryText: { fontSize: 17, fontWeight: '800', color: c.background },
    disabled: { opacity: 0.45 },
    secondary: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    secondaryText: { fontSize: 15, fontWeight: '600', color: c.text },
    summary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginTop: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.accent,
    },
    summaryText: { fontSize: 16, fontWeight: '700', color: c.text, ...alignRight },
    summaryMeta: { fontSize: 12, color: c.textMuted, ...alignRight },
    editText: { fontSize: 13, fontWeight: '700', color: c.accent },
    resultsHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minHeight: 36 },
    count: { fontSize: 13, color: c.textMuted, ...alignRight },
    note: { fontSize: 12, color: c.accent, ...alignRight },
    list: { paddingBottom: spacing.xl },
    footer: { marginVertical: spacing.lg },
    more: { alignSelf: 'center', marginVertical: spacing.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 999, backgroundColor: c.accentSoft },
    moreText: { color: c.accent, fontWeight: '700' },
    divider: { marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm, paddingVertical: 4, borderTopWidth: 1, borderTopColor: c.border },
    dividerText: { fontSize: 13, fontWeight: '700', color: c.textMuted, ...alignRight },
    empty: { color: c.textMuted, fontSize: 15, padding: spacing.xl, textAlign: 'center' },
  });
