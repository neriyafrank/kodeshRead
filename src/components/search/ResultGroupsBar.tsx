/**
 * Results jump / filter bar (Simple + Advanced Search): one compact horizontal row of pills with live result
 * counts above the results list — "הכל" + one pill per group (shared/resultGroups.js: broad categories for the
 * whole library, Hilchot books inside משנה תורה, books / folders / sections for narrower scopes). One tap
 * filters the list to that group (and scrolls it to the top); "הכל" resets.
 *
 * Counts grow in place while results stream in; groups are only ever appended (results arrive in library
 * order), the row has a fixed height and the counts use tabular digits, so nothing jumps under the finger.
 */
import { memo, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { createGroupTracker, groupModeFor, type ResultGroup } from '../../../shared/resultGroups';
import type { SearchRow, SearchScope } from '../../../shared/search';
import { useLibrary } from '../../db/LibraryContext';
import { alignRight } from '../../lib/direction';
import { spacing, useThemedStyles, type Palette } from '../../theme';

/**
 * Groups of a (streaming) result list. Recomputed per batch: one pass over at most a few thousand rows, with
 * the group of each book resolved once (createGroupTracker caches it per book id).
 */
export function useResultGroups(rows: SearchRow[], scope: SearchScope, resultKey: string) {
  const { bookIndex } = useLibrary();
  const mode = groupModeFor(scope);
  const tracker = useMemo(
    () => createGroupTracker(mode, { scope, bookInfo: (id: number) => bookIndex.books.get(id) }).add(rows),
    // `resultKey` identifies the search the rows belong to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, mode, bookIndex, resultKey],
  );
  const groups = useMemo(() => tracker.groups(), [tracker]);
  return { groups, tracker, mode };
}

interface Props {
  groups: ResultGroup[];
  total: number;
  /** More rows are still arriving (counts are growing). */
  streaming: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
  testIDPrefix?: string;
}

export const ResultGroupsBar = memo(function ResultGroupsBar({ groups, total, streaming, selected, onSelect, testIDPrefix = 'group' }: Props) {
  const s = useThemedStyles(createStyles);
  const pill = (key: string | null, label: string, count: number, testID: string) => {
    const on = selected === key || (key === null && !selected);
    return (
      <Pressable
        key={key ?? 'all'}
        onPress={() => onSelect(key)}
        style={({ pressed }) => [s.pill, on && s.pillOn, pressed && s.pressed]}
        accessibilityRole="tab"
        aria-selected={on}
        accessibilityState={{ selected: on }}
        accessibilityLabel={`${label}, ${count} תוצאות`}
        testID={testID}
      >
        <Text style={[s.label, on && s.labelOn]} numberOfLines={1} testID={`${testID}-label`}>
          {label}
        </Text>
        <Text style={[s.count, on && s.countOn]} testID={`${testID}-count`}>
          {count}
          {streaming && key === null ? '+' : ''}
        </Text>
      </Pressable>
    );
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={s.bar}
      contentContainerStyle={s.row}
      accessibilityRole="tablist"
      testID={`${testIDPrefix}-bar`}
    >
      {pill(null, 'הכל', total, `${testIDPrefix}-pill-all`)}
      {groups.map((g, i) => pill(g.key, g.label, g.count, `${testIDPrefix}-pill-${i}`))}
    </ScrollView>
  );
});

const createStyles = (c: Palette) =>
  StyleSheet.create({
    // Fixed height: appearing / growing counts never shift the list below.
    bar: { flexGrow: 0, height: 40, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md },
    pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingHorizontal: spacing.md },
    pillOn: { backgroundColor: c.accent, borderColor: c.accent },
    pressed: { opacity: 0.7 },
    label: { fontSize: 13, color: c.text, maxWidth: 170, ...alignRight },
    labelOn: { color: c.background, fontWeight: '700' },
    count: { fontSize: 11, color: c.textMuted, minWidth: 16, textAlign: 'center', fontVariant: ['tabular-nums'] },
    countOn: { color: c.background },
  });
