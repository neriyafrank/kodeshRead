/**
 * Advanced Search ("חיפוש מתקדם"): a Responsa-Project-style search form over the same offline
 * FTS5 index as Simple Search (shared/hebrewSearch.js + shared/search.js searchPlan).
 *
 *  - one query field: מילות החיפוש / ביטוי with inline operators (a|b, -word, word*, "exact"); a `?` button next
 *    to its label opens / dismisses the operators guide. Header: just ← and the title;
 *  - linguistic toggles: תחיליות וסופיות (on), כתיב מלא/חסר, ראשי תיבות (off);
 *  - קרבת מילים: פסקה | ביטוי מדויק | קרבה 3 / 5 / 10 (+ שמור על סדר המילים);
 *  - סינון לפי מדור: הכל, הספר הנוכחי, תנ"ך, משנה, בבלי, רמב"ם, שולחן ערוך, מפרשים;
 *  - "חפש" runs the query (exact matches first, then expanded variants, all highlighted); results stream in
 *    progressively under a jump / filter bar of result groups (ResultGroupsBar) and the top / visible ones are
 *    prefetched for a zero-delay open;
 *    "נקה הכל" restores the defaults. The form folds into a summary bar over the results.
 *
 * Route params (optional): bookId + title name the "current book" chip.
 */
import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback, useMemo, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ADVANCED_DEFAULTS, NEAR_DISTANCES, buildQuery, type ProximityMode, type SearchPlan } from '../../shared/hebrewSearch';
import { CORPORA } from '../../shared/corpora';
import { filterByGroup } from '../../shared/resultGroups';
import type { SearchRow, SearchScope } from '../../shared/search';
import { CorpusPresets } from '../components/search/CorpusPresets';
import { ResultCard } from '../components/search/ResultCard';
import { ResultGroupsBar, useResultGroups } from '../components/search/ResultGroupsBar';
import { ScopeChips } from '../components/search/ScopeChips';
import { ScopeSheet } from '../components/search/ScopeSheet';
import { LoadingMoreFooter, SearchProgress } from '../components/search/SearchProgress';
import { countLabel, usePlanResults } from '../components/search/usePlanResults';
import { useResultPrefetch } from '../components/search/useResultPrefetch';
import { useCorpora } from '../db/useCorpora';
import { alignRight, inputAlignRight } from '../lib/direction';
import { cancelPrefetch } from '../services/searchPrefetch';
import { advancedDefaults, scopeLabel, useSearch, type AdvancedState, type LinguisticOptions } from '../state/searchStore';
import { selectActiveTab, useTabs } from '../state/tabsStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';
import { useAppNav } from '../lib/appNav';

const TOGGLES: { key: keyof LinguisticOptions; label: string; hint: string }[] = [
  { key: 'prefixesAndSuffixes', label: 'תחיליות וסופיות', hint: 'ושבת, בשבת, שבתות, שבתו · תפילה → לתפילתו' },
  { key: 'pleneDefective', label: 'כתיב מלא/חסר', hint: 'מצווה ↔ מצוה · שולחן ↔ שלחן · תפילה ↔ תפלה' },
  { key: 'acronyms', label: 'ראשי תיבות', hint: 'שו"ע ↔ שולחן ערוך · ק"ו ↔ קל וחומר' },
];

/** Operators of the main input (the `?` guide). */
const OPERATORS: { op: string; text: string }[] = [
  { op: 'א|ב', text: 'אחת מהמילים (או)' },
  { op: '-מילה', text: 'ללא המילה (שלילה)' },
  { op: 'מיל*', text: 'תחילת מילה' },
  { op: '"ביטוי מדויק"', text: 'חיפוש ביטוי רצוף' },
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

/** Corpus chips -> search scope ("book" needs an open book; several presets are OR-ed into one `books` scope). */
function scopeOf(corpora: string[], book: CurrentBook | null, picked: SearchScope, scopeFor: (ids: string[]) => SearchScope): SearchScope {
  // Books / commentaries picked in the scope picker take precedence over the corpus chips.
  if (picked.kind === 'books' && !picked.corpora) return picked;
  if (corpora.includes('book') && book) return { kind: 'book', bookId: book.bookId, title: book.title };
  const ids = corpora.filter((id) => CORPORA.some((c) => c.id === id));
  return ids.length ? scopeFor(ids) : { kind: 'all' };
}

function planOf(a: AdvancedState): SearchPlan {
  return buildQuery(a.fields, { ...ADVANCED_DEFAULTS, ...a.options, proximity: a.proximity });
}

export default function AdvancedSearchScreen() {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const nav = useAppNav();
  const insets = useSafeAreaInsets();
  const [helpOpen, setHelpOpen] = useState(false);
  const params = useLocalSearchParams<{ bookId?: string; title?: string }>();
  const advanced = useSearch((x) => x.advanced);
  const setAdvanced = useSearch((x) => x.setAdvanced);
  const resetAdvanced = useSearch((x) => x.resetAdvanced);
  const picked = useSearch((x) => x.scope);
  const setPicked = useSearch((x) => x.setScope);
  const [scopeOpen, setScopeOpen] = useState(false);
  const presets = useCorpora();
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
  const submittedScope = useMemo<SearchScope>(() => submitted?.scope ?? { kind: 'all' }, [submitted]);
  const { current, shown, loading, cancelled, cancel, rerun, loadMore, loadingMore, streaming, progress } = usePlanResults(submitted?.plan ?? null, submittedScope, 0, submitted);
  const draftPlan = useMemo(() => planOf(advanced), [advanced]);

  const setField = (k: keyof AdvancedState['fields'], v: string) => setAdvanced({ fields: { ...advanced.fields, [k]: v } });
  const setOption = (k: keyof LinguisticOptions) => setAdvanced({ options: { ...advanced.options, [k]: !advanced.options[k] } });
  const setProximity = (p: Partial<AdvancedState['proximity']>) => setAdvanced({ proximity: { ...advanced.proximity, ...p } });

  // A preset picked in Simple Search (a `books` scope remembering its presets) carries over to the chips.
  const pickedBooks = picked.kind === 'books' && !picked.corpora ? picked : null;
  const effective = useMemo(() => (picked.kind === 'books' && picked.corpora ? picked.corpora : advanced.corpora), [picked, advanced.corpora]);
  const toggleCorpus = (id: string) => {
    if (picked.kind === 'books') setPicked({ kind: 'all' });
    if (id === 'all' || id === 'book') return setAdvanced({ corpora: [id] });
    const rest = effective.filter((x) => x !== 'all' && x !== 'book');
    const next = rest.includes(id) ? rest.filter((x) => x !== id) : [...rest, id];
    setAdvanced({ corpora: next.length ? next : ['all'] });
  };
  const corpora = useMemo(() => (effective.includes('book') && !book ? ['all'] : effective), [effective, book]);
  const needsPresets = corpora.some((id) => CORPORA.some((c) => c.id === id));
  const waiting = needsPresets && !pickedBooks && !presets.ready;

  const onSearch = useCallback(() => {
    Keyboard.dismiss();
    const plan = planOf(advanced);
    if (plan.empty) return;
    remember(advanced.fields.query);
    setSubmitted({ plan, scope: scopeOf(corpora, book, picked, presets.scopeFor) });
    setFormOpen(false);
  }, [advanced, book, corpora, picked, presets.scopeFor, remember]);

  const onReset = useCallback(() => {
    resetAdvanced();
    setSubmitted(null);
    setFormOpen(true);
  }, [resetAdvanced]);

  const back = nav.goHome; // in-app Back always lands on Home with an empty back stack

  const onOpen = useCallback(
    (row: SearchRow) => {
      Keyboard.dismiss();
      cancelPrefetch(); // the reader's own queries go first
      openBook({ bookId: row.book_id, bookTitle: row.book_title }, { line: row.line_index, highlight: true, terms: shown?.terms ?? [] });
      nav.open('/reader');
    },
    [openBook, nav, shown?.terms],
  );

  // Jump / filter bar over the (streaming) results; a new search resets it to הכל.
  const allRows = useMemo(() => shown?.rows ?? [], [shown?.rows]);
  const resultKey = shown?.key ?? '';
  const { groups, tracker } = useResultGroups(allRows, submittedScope, resultKey);
  const [pickedGroup, setPickedGroup] = useState<{ key: string; group: string | null }>({ key: '', group: null });
  const group = pickedGroup.key === resultKey && groups.some((g) => g.key === pickedGroup.group) ? pickedGroup.group : null;
  const rows = useMemo(() => filterByGroup(allRows, group, tracker), [allRows, group, tracker]);
  // A picked group opens its results from the top (the list is keyed by the group).
  const selectGroup = useCallback((g: string | null) => setPickedGroup({ key: resultKey, group: g }), [resultKey]);
  const prefetch = useResultPrefetch(rows, !!current && !loading && !streaming, `${resultKey}|${group ?? ''}`);
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

  const summary = advanced.fields.query;
  const isDefault = JSON.stringify(advanced) === JSON.stringify(advancedDefaults());

  const form = (
    <View style={s.form} testID="adv-form">
      <View style={s.field}>
        <View style={s.labelRow}>
          <Text style={s.label}>מילות החיפוש / ביטוי</Text>
          <Pressable
            onPress={() => setHelpOpen((v) => !v)}
            hitSlop={8}
            style={[s.helpBtn, helpOpen && { backgroundColor: c.accentSoft, borderColor: c.accent }]}
            accessibilityRole="button"
            aria-expanded={helpOpen}
            accessibilityState={{ expanded: helpOpen }}
            accessibilityLabel="עזרה: אופרטורים בחיפוש"
            testID="adv-help"
          >
            <Text style={s.helpText}>?</Text>
          </Pressable>
        </View>
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
        {helpOpen ? (
          <Pressable onPress={() => setHelpOpen(false)} style={s.helpBox} accessibilityRole="button" accessibilityLabel="סגור את ההסבר" testID="adv-help-box">
            {OPERATORS.map((o) => (
              <View key={o.op} style={s.opRow}>
                <Text style={s.opCode}>{`\u2066${o.op}\u2069`}</Text>
                <Text style={s.opText}>{o.text}</Text>
              </View>
            ))}
          </Pressable>
        ) : null}
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
      <View>
        <CorpusPresets
          wrap
          items={[
            { id: 'all', label: 'הכל' },
            ...(book ? [{ id: 'book', label: `הספר הנוכחי${book.title ? ` · ${book.title}` : ''}` }] : []),
            ...CORPORA.map((c) => ({ id: c.id, label: c.label, count: presets.counts ? presets.counts[c.id] : null })),
          ]}
          selected={pickedBooks ? [] : corpora}
          onToggle={toggleCorpus}
          testIDPrefix="adv-corpus"
        />
      </View>

      <Pressable onPress={() => setScopeOpen(true)} style={({ pressed }) => [s.scopeBtn, pickedBooks && s.chipOn, pressed && s.pressed]} accessibilityRole="button" testID="adv-scope-button">
        <Text style={[s.chipText, pickedBooks && s.chipTextOn]} numberOfLines={1}>
          {pickedBooks ? `ספרים ופרשנים: ${scopeLabel(pickedBooks)}` : 'בחירת ספרים ופרשנים…'}
        </Text>
        <Text style={s.chipText}>▾</Text>
      </Pressable>
      <ScopeChips scope={picked} onChange={setPicked} />

      <View style={s.actions}>
        <Pressable
          onPress={onSearch}
          disabled={draftPlan.empty || waiting}
          style={({ pressed }) => [s.primary, (draftPlan.empty || waiting) && s.disabled, pressed && s.pressed]}
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
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[s.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={back} hitSlop={10} style={({ pressed }) => [s.backBtn, pressed && s.pressed]} accessibilityRole="button" accessibilityLabel="חזרה" testID="adv-back">
          <Text style={s.backText}>←</Text>
        </Pressable>
        <Text style={s.heading} numberOfLines={1} accessibilityRole="header" testID="adv-title">
          חיפוש מתקדם
        </Text>
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
                {submitted.scope.kind === 'all' ? 'כל הספרייה' : submitted.scope.kind === 'book' ? submitted.scope.title : submitted.scope.kind === 'books' ? submitted.scope.name : ''}
                {submitted.plan.hasExpansions ? ' · כולל צורות נוספות' : ''}
              </Text>
            </View>
            <Text style={s.editText}>עריכה ▾</Text>
          </Pressable>
          <View style={s.resultsHeader}>
            {!loading && current ? (
              <Text style={s.count} testID="adv-count">
                {countLabel(current, streaming)}
              </Text>
            ) : null}
            <View style={s.flex} />
            {submitted.plan.hasExpansions ? <Text style={s.note}>התאמות מדויקות תחילה</Text> : null}
          </View>
          <SearchProgress phase={loading ? 'searching' : cancelled ? 'cancelled' : 'quiet'} streaming={streaming} scope={submitted.scope} progress={progress} onCancel={cancel} onRetry={rerun} testIDPrefix="adv" />
          {!current?.error && allRows.length ? (
            <ResultGroupsBar groups={groups} total={allRows.length} streaming={streaming} selected={group} onSelect={selectGroup} testIDPrefix="adv-group" />
          ) : null}
          {current?.error ? (
            <Text style={s.empty}>שגיאה בחיפוש: {current.error}</Text>
          ) : current && current.rows.length === 0 && !current.hasMore ? (
            <Text style={s.empty} testID="adv-empty">
              לא נמצאו תוצאות
            </Text>
          ) : (
            <FlashList
              key={group ?? 'all'}
              data={rows}
              keyExtractor={(r) => String(r.id)}
              renderItem={renderItem}
              extraData={shown?.terms}
              onEndReached={loadMore}
              onEndReachedThreshold={0.6}
              onScroll={prefetch.onScroll}
              scrollEventThrottle={64}
              onViewableItemsChanged={prefetch.onViewableItemsChanged}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={s.list}
              ListFooterComponent={
                loadingMore ? (
                  <LoadingMoreFooter />
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
    heading: { flex: 1, fontSize: 18, fontWeight: '800', color: c.text, ...alignRight },
    backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
    backText: { fontSize: 24, fontWeight: '700', color: c.accent },
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    helpBtn: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    helpText: { fontSize: 12, fontWeight: '700', color: c.textMuted },
    helpBox: { gap: 6, padding: spacing.md, borderRadius: radius.md, backgroundColor: c.accentSoft, borderWidth: 1, borderColor: c.border },
    opRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    opCode: { minWidth: 96, fontSize: 15, fontWeight: '700', color: c.accent, textAlign: 'center' },
    opText: { flex: 1, fontSize: 14, color: c.text, ...alignRight },
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
    more: { alignSelf: 'center', marginVertical: spacing.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 999, backgroundColor: c.accentSoft },
    moreText: { color: c.accent, fontWeight: '700' },
    divider: { marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm, paddingVertical: 4, borderTopWidth: 1, borderTopColor: c.border },
    dividerText: { fontSize: 13, fontWeight: '700', color: c.textMuted, ...alignRight },
    empty: { color: c.textMuted, fontSize: 15, padding: spacing.xl, textAlign: 'center' },
  });
