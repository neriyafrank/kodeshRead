/**
 * "לימוד יומי" quick-open UI on the Library screen (schedule: shared/dailyLearning.js, library
 * resolution: src/services/dailyLearningNav.ts). The reader's TOC drawer deliberately has none:
 * it navigates the current book only.
 *
 *   DailyLearningList     today's Hebrew date and one row per study
 *                         cycle, two lines each (label + title; a missing book adds "לא נמצא בספרייה" to the label)  (פרשת השבוע + today's aliyah, דף היומי, משנה יומית, רמב"ם 1 / 3
 *                         פרקים); a tap opens the exact place in a tab. Books missing from the
 *                         library are listed greyed out ("לא נמצא בספרייה").
 *   DailyLearningCard     the collapsible bar on the Library screen.
 * Every label is right-aligned (alignRight).
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ResolvedItem, ResolvedTarget } from '../../../shared/dailyLearning';
import { alignRight } from '../../lib/direction';
import { useDailyLearning } from '../../services/dailyLearningNav';
import { useLearning } from '../../state/learningStore';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';
import { Collapsible } from '../Collapsible';

export function DailyLearningList({ onOpen, onMissing }: { onOpen: (t: ResolvedTarget) => void; onMissing?: (item: ResolvedItem) => void }) {
  const s = useThemedStyles(createStyles);
  const { schedule, error } = useDailyLearning();
  if (!schedule) return <Text style={s.muted}>{error ? `שגיאה: ${error}` : 'טוען…'}</Text>;
  return (
    <View style={s.list} testID="daily-list">
      <View style={s.metaRow}>
        <Text style={s.hebrewDate} testID="daily-hebrew-date">
          {schedule.hebrewDate}
        </Text>
      </View>
      {schedule.items.map((it) => (
        <ItemRow key={it.key} item={it} onOpen={onOpen} onMissing={onMissing} />
      ))}
    </View>
  );
}

function ItemRow({ item, onOpen, onMissing }: { item: ResolvedItem; onOpen: (t: ResolvedTarget) => void; onMissing?: (item: ResolvedItem) => void }) {
  const s = useThemedStyles(createStyles);
  const main = item.targets.find((t) => t.available) ?? item.targets[0];
  const available = !!main?.available;
  const extra = item.targets.filter((t) => t !== main && t.available);
  return (
    <Pressable
      // A book that is not on the device is greyed but still tappable: it explains how to get it.
      onPress={() => (main && available ? onOpen(main) : onMissing?.(item))}
      style={({ pressed }) => [s.item, !available && s.itemOff, pressed && s.pressed]}
      accessibilityRole="link"
      aria-disabled={!available}
      // Greyed for accessibility (aria-disabled) but NOT the Pressable's `disabled`: the tap still explains how to get the book.
      accessibilityState={{ disabled: !available }}
      accessibilityHint={available ? undefined : 'הספר עדיין לא במכשיר: הקשה מציגה איך להוריד אותו'}
      accessibilityLabel={`${item.label}: ${item.title}${available ? '' : ' (לא נמצא בספרייה)'}`}
      testID={`daily-item-${item.key}`}
    >
      <Text style={s.itemLabel} numberOfLines={1}>
        {available ? item.label : `${item.label} · לא נמצא בספרייה`}
      </Text>
      <Text style={[s.itemTitle, !available && s.textOff]} testID={`daily-title-${item.key}`}>
        {item.title}
      </Text>
      {extra.length ? (
        <View style={s.chips}>
          {extra.map((t, i) => (
            <Pressable key={`${t.path}-${i}`} onPress={() => onOpen(t)} hitSlop={4} style={({ pressed }) => [s.chip, pressed && s.pressed]} accessibilityRole="link" testID={`daily-extra-${item.key}-${i}`}>
              <Text style={s.chipText}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Collapsible "לימוד יומי" bar on the Library screen. */
export function DailyLearningCard({ onOpen, onMissing }: { onOpen: (t: ResolvedTarget) => void; onMissing?: (item: ResolvedItem) => void }) {
  const s = useThemedStyles(createStyles);
  const open = useLearning((x) => x.libraryDailyOpen);
  const setOpen = useLearning((x) => x.setLibraryDailyOpen);
  const { schedule } = useDailyLearning();
  const parasha = schedule?.items.find((i) => i.key === 'parasha');
  return (
    <View style={s.card} testID="library-daily">
      <Pressable
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [s.cardHead, pressed && s.pressed]}
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityState={{ expanded: open }}
        testID="library-daily-toggle"
      >
        <Text style={s.cardTitle}>לימוד יומי</Text>
        <Text style={s.cardSummary} numberOfLines={1}>
          {schedule && !open ? [schedule.hebrewDate, parasha?.title].filter(Boolean).join(' · ') : ''}
        </Text>
        <Text style={s.caret}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      <Collapsible open={open}>
        <DailyLearningList onOpen={onOpen} onMissing={onMissing} />
      </Collapsible>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    list: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.xs },
    muted: { color: c.textMuted, fontSize: 13, padding: spacing.sm, ...alignRight },
    metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.xs, paddingVertical: 4 },
    hebrewDate: { flexShrink: 1, fontSize: 14, fontWeight: '700', color: c.text, ...alignRight },
    item: {
      alignItems: 'stretch',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
      gap: 1,
    },
    itemOff: { backgroundColor: c.surfaceMuted, opacity: 0.75 },
    pressed: { opacity: 0.6 },
    itemLabel: { fontSize: 11, color: c.textMuted, fontWeight: '600', ...alignRight },
    itemTitle: { fontSize: 16, fontWeight: '700', color: c.accent, ...alignRight },
    textOff: { color: c.textMuted },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 4 },
    chip: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 10, backgroundColor: c.accentSoft },
    chipText: { fontSize: 12, color: c.accent, fontWeight: '600' },
    caret: { fontSize: 12, color: c.textMuted },
    card: { marginHorizontal: spacing.md, marginTop: spacing.sm, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.surfaceMuted, overflow: 'hidden' },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    cardTitle: { fontSize: 15, fontWeight: '700', color: c.accent, ...alignRight },
    cardSummary: { flex: 1, minWidth: 0, fontSize: 13, color: c.textMuted, ...alignRight },
  });
