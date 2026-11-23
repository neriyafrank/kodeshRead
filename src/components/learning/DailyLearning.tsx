/**
 * "לימוד יומי" quick-open UI (schedule: shared/dailyLearning.js, library resolution:
 * src/services/dailyLearningNav.ts).
 *
 *   DailyLearningList     today's Hebrew date, the ארץ ישראל / חו"ל switch and one row per study
 *                         cycle (פרשת השבוע + today's aliyah, דף היומי, משנה יומית, רמב"ם 1 / 3
 *                         פרקים); a tap opens the exact place in a tab. Books missing from the
 *                         library are listed greyed out ("לא נמצא בספרייה").
 *   DailyLearningSection  the collapsible block at the top of the TOC drawer.
 *   DailyLearningCard     the collapsible bar on the Library screen.
 * Every label is right-aligned (alignRight).
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ResolvedItem, ResolvedTarget } from '../../../shared/dailyLearning';
import { alignRight } from '../../lib/direction';
import { useDailyLearning } from '../../services/dailyLearningNav';
import { useLearning } from '../../state/learningStore';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';
import { Collapsible } from '../Collapsible';

interface ListProps {
  onOpen: (t: ResolvedTarget) => void;
  /** Smaller type and paddings (TOC drawer). */
  compact?: boolean;
}

export function DailyLearningList({ onOpen, compact }: ListProps) {
  const s = useThemedStyles(createStyles);
  const { schedule, error } = useDailyLearning();
  if (!schedule) return <Text style={s.muted}>{error ? `שגיאה: ${error}` : 'טוען…'}</Text>;
  return (
    <View style={compact ? s.listCompact : s.list} testID="daily-list">
      <View style={s.metaRow}>
        <Text style={s.hebrewDate} testID="daily-hebrew-date">
          {schedule.hebrewDate}
        </Text>
        <LocationSwitch />
      </View>
      {schedule.items.map((it) => (
        <ItemRow key={it.key} item={it} compact={compact} onOpen={onOpen} />
      ))}
    </View>
  );
}

function LocationSwitch() {
  const s = useThemedStyles(createStyles);
  const il = useLearning((x) => x.il);
  const setIl = useLearning((x) => x.setIl);
  const opt = (value: boolean, label: string, id: string) => (
    <Pressable
      onPress={() => setIl(value)}
      style={[s.segment, il === value && s.segmentOn]}
      accessibilityRole="radio"
      aria-checked={il === value}
      accessibilityState={{ selected: il === value }}
      testID={id}
    >
      <Text style={[s.segmentText, il === value && s.segmentTextOn]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={s.segments} accessibilityRole="radiogroup" accessibilityLabel="מיקום ללוח הפרשות">
      {opt(true, 'ארץ ישראל', 'daily-loc-il')}
      {opt(false, 'חו"ל', 'daily-loc-diaspora')}
    </View>
  );
}

function ItemRow({ item, compact, onOpen }: { item: ResolvedItem; compact?: boolean; onOpen: (t: ResolvedTarget) => void }) {
  const s = useThemedStyles(createStyles);
  const main = item.targets.find((t) => t.available) ?? item.targets[0];
  const available = !!main?.available;
  const extra = item.targets.filter((t) => t !== main && t.available);
  return (
    <Pressable
      onPress={() => main && available && onOpen(main)}
      disabled={!available}
      style={({ pressed }) => [s.item, compact && s.itemCompact, !available && s.itemOff, pressed && s.pressed]}
      accessibilityRole="link"
      aria-disabled={!available}
      accessibilityState={{ disabled: !available }}
      accessibilityLabel={`${item.label}: ${item.title}${available ? '' : ' (לא נמצא בספרייה)'}`}
      testID={`daily-item-${item.key}`}
    >
      <Text style={s.itemLabel} numberOfLines={1}>
        {item.label}
      </Text>
      <Text style={[s.itemTitle, compact && s.itemTitleCompact, !available && s.textOff]} testID={`daily-title-${item.key}`}>
        {item.title}
      </Text>
      <Text style={s.itemDetail} numberOfLines={2}>
        {available ? [main.ref, item.detail].filter(Boolean).join(' · ') + (main.exact ? '' : ' (תחילת הספר)') : 'לא נמצא בספרייה'}
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

/** Collapsible "לימוד יומי" block at the top of the TOC drawer. */
export function DailyLearningSection({ onOpen }: { onOpen: (t: ResolvedTarget) => void }) {
  const s = useThemedStyles(createStyles);
  const open = useLearning((x) => x.tocDailyOpen);
  const setOpen = useLearning((x) => x.setTocDailyOpen);
  const { schedule } = useDailyLearning();
  return (
    <View style={s.section} testID="toc-daily">
      <Pressable
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [s.sectionHead, pressed && s.pressed]}
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityState={{ expanded: open }}
        testID="toc-daily-toggle"
      >
        <Text style={s.sectionTitle}>לימוד יומי</Text>
        {/* The open list shows the date itself. */}
        <Text style={s.sectionDate} numberOfLines={1}>
          {open ? '' : (schedule?.hebrewDate ?? '')}
        </Text>
        <Text style={s.caret}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      <Collapsible open={open}>
        <ScrollView style={s.sectionBody} contentContainerStyle={{ paddingBottom: spacing.xs }} nestedScrollEnabled>
          <DailyLearningList compact onOpen={onOpen} />
        </ScrollView>
      </Collapsible>
    </View>
  );
}

/** Collapsible "לימוד יומי" bar on the Library screen. */
export function DailyLearningCard({ onOpen }: { onOpen: (t: ResolvedTarget) => void }) {
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
        <DailyLearningList onOpen={onOpen} />
      </Collapsible>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    list: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.xs },
    listCompact: { paddingHorizontal: spacing.sm, paddingBottom: spacing.xs, gap: 3 },
    muted: { color: c.textMuted, fontSize: 13, padding: spacing.sm, ...alignRight },
    metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.xs, paddingVertical: 4 },
    hebrewDate: { flexShrink: 1, fontSize: 14, fontWeight: '700', color: c.text, ...alignRight },
    segments: { flexDirection: 'row', borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden' },
    segment: { paddingHorizontal: spacing.sm, paddingVertical: 3, backgroundColor: c.surface },
    segmentOn: { backgroundColor: c.accent },
    segmentText: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
    segmentTextOn: { color: c.surface },
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
    itemCompact: { paddingHorizontal: spacing.sm, paddingVertical: 6 },
    itemOff: { backgroundColor: c.surfaceMuted, opacity: 0.75 },
    pressed: { opacity: 0.6 },
    itemLabel: { fontSize: 11, color: c.textMuted, fontWeight: '600', ...alignRight },
    itemTitle: { fontSize: 16, fontWeight: '700', color: c.accent, ...alignRight },
    itemTitleCompact: { fontSize: 14 },
    textOff: { color: c.textMuted },
    itemDetail: { fontSize: 12, color: c.textMuted, ...alignRight },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 4 },
    chip: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 10, backgroundColor: c.accentSoft },
    chipText: { fontSize: 12, color: c.accent, fontWeight: '600' },
    section: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 7, backgroundColor: c.surfaceMuted },
    sectionTitle: { fontSize: 13, fontWeight: '700', color: c.accent, ...alignRight },
    sectionDate: { flex: 1, minWidth: 0, fontSize: 12, color: c.textMuted, ...alignRight },
    sectionBody: { maxHeight: 340 },
    caret: { fontSize: 12, color: c.textMuted },
    card: { marginHorizontal: spacing.md, marginTop: spacing.sm, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.surfaceMuted, overflow: 'hidden' },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    cardTitle: { fontSize: 15, fontWeight: '700', color: c.accent, ...alignRight },
    cardSummary: { flex: 1, minWidth: 0, fontSize: 13, color: c.textMuted, ...alignRight },
  });
