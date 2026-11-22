/**
 * "קפיצה מהירה למקור" — type a shorthand reference ("שוע אוח כה ה", "שבת ב.",
 * "בראשית יב א") and get instant clickable preview cards. Abbreviations and
 * structural words are understood ("שו\"ע או\"ח סי' שכח ד", "ב\"ק דף ב ע\"ב");
 * a fully resolved reference gets a prominent "פתח: ספר — מיקום" card on top.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { resolveReference, type JumpResult } from '../../shared/quickJump';
import { useLibrary } from '../db/LibraryContext';
import { SearchIcon } from './Icons';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';

const EXAMPLES = ['שבת ב.', 'ר"ה טז:', 'בר\' יב א', 'במדבר כז טו'];
const DEBOUNCE_MS = 90;

interface Props {
  onJump: (result: JumpResult) => void;
}

export function QuickJumpBar({ onJump }: Props) {
  const colors = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const { adapter, bookIndex } = useLibrary();
  const [query, setQuery] = useState('');
  const [resolved, setResolved] = useState<{ query: string; results: JumpResult[]; elapsed: number } | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    if (!query.trim()) return;
    const timer = setTimeout(async () => {
      const t0 = Date.now();
      try {
        const res = await resolveReference(adapter, bookIndex, query);
        if (id === requestId.current) setResolved({ query, results: res, elapsed: Date.now() - t0 });
      } catch (e) {
        if (id === requestId.current) setResolved({ query, results: [], elapsed: 0 });
        console.warn('quick jump failed', e);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, adapter, bookIndex]);

  // Results are kept only while they belong to a non-empty query (cleared input = no cards).
  const results = query.trim() && resolved ? resolved.results : [];
  const elapsed = query.trim() && resolved ? resolved.elapsed : null;

  const jump = (r: JumpResult) => {
    onJump(r);
  };

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <View style={styles.icon}>
          <SearchIcon />
        </View>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="קפיצה מהירה למקור…  למשל: שבת ב."
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="go"
          onSubmitEditing={() => results[0] && jump(results[0])}
          accessibilityLabel="קפיצה מהירה למקור"
          testID="quick-jump-input"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="נקה" style={styles.clear}>
            <Text style={styles.clearText}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {!query ? (
        <View style={styles.examples}>
          {EXAMPLES.map((ex) => (
            <Pressable key={ex} onPress={() => setQuery(ex)} style={styles.chip}>
              <Text style={styles.chipText}>{ex}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {query.trim() && results.length === 0 && elapsed !== null ? (
        <Text style={styles.empty}>לא נמצא ספר בשם זה</Text>
      ) : null}

      {results[0]?.direct ? (
        <Pressable
          onPress={() => jump(results[0])}
          style={({ pressed }) => [styles.direct, pressed && styles.cardPressed]}
          accessibilityRole="button"
          testID="quick-jump-direct"
        >
          <Text style={styles.directText} numberOfLines={2}>
            פתח: {results[0].bookTitle}
            {results[0].location ? ` — ${results[0].location}` : ''}
          </Text>
          <Text style={styles.directGo}>←</Text>
        </Pressable>
      ) : null}

      {results.map((r) => (
        <Pressable
          key={`${r.bookId}:${r.targetLine}`}
          onPress={() => jump(r)}
          style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          accessibilityRole="button"
          testID="quick-jump-result"
        >
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {r.bookTitle}
              {r.path.length ? <Text style={styles.cardPath}>{'  ‹  ' + r.path.join('  ‹  ')}</Text> : null}
              {r.marker ? <Text style={styles.cardPath}>{`  ‹  (${r.marker})`}</Text> : null}
            </Text>
            <Text style={styles.go}>{r.suggestion ? 'פתח' : 'מעבר'} ←</Text>
          </View>
          {r.categoryPath ? (
            <Text style={styles.category} numberOfLines={1}>
              {r.categoryPath.split('/').join(' / ')}
            </Text>
          ) : null}
          {r.preview ? (
            <Text style={styles.preview} numberOfLines={2}>
              {r.preview}
            </Text>
          ) : null}
          {!r.complete && !r.suggestion && r.unmatched.length ? (
            <Text style={styles.unmatched}>לא זוהה: {r.unmatched.join(' ')}</Text>
          ) : null}
        </Pressable>
      ))}
      {results.length && elapsed !== null ? <Text style={styles.timing}>{elapsed} ms</Text> : null}
    </View>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.accent,
    paddingStart: spacing.md,
    paddingEnd: spacing.sm,
    minHeight: 52,
  },
  icon: { marginEnd: spacing.md },
  input: {
    flex: 1,
    fontSize: 18,
    color: colors.text,
    paddingVertical: spacing.md,
    writingDirection: 'rtl',
  },
  clear: { padding: spacing.sm },
  clearText: { fontSize: 16, color: colors.textMuted },
  examples: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.accentSoft,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipText: { color: colors.accent, fontSize: 14 },
  empty: { color: colors.textMuted, fontSize: 14, paddingStart: spacing.xs },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 2,
  },
  cardPressed: { backgroundColor: colors.accentSoft },
  direct: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  directText: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.background, writingDirection: 'rtl' },
  directGo: { fontSize: 18, fontWeight: '700', color: colors.background },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  cardPath: { fontSize: 15, fontWeight: '500', color: colors.accent },
  go: { fontSize: 14, color: colors.accent, fontWeight: '600' },
  category: { fontSize: 12, color: colors.textMuted, writingDirection: 'rtl' },
  preview: { fontSize: 15, color: colors.text, lineHeight: 22, writingDirection: 'rtl', marginTop: 2 },
  unmatched: { fontSize: 13, color: colors.danger, marginTop: 2 },
  timing: { fontSize: 11, color: colors.textMuted, alignSelf: 'flex-end' },
});
