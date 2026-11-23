/**
 * "המשך בנייה שנעצרה" — shown on the Library screen and in the manager when an import
 * stopped before finishing (paused, or the app was killed): progress so far, skipped
 * malformed files, and Resume / Discard & Reset.
 */
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useLibraryActions } from '../../services/libraryActions';
import { useInterruptedImports } from '../../services/ingestionLifecycle';
import type { InterruptedImport } from '../../services/localIndexer';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';
import { ProgressBar } from './JobStatus';

function confirm(title: string, message: string, ok: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: 'חזרה', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: onOk },
  ]);
}

const num = (n: number) => Number(n || 0).toLocaleString('he-IL');

export function ResumeCards() {
  const { items } = useInterruptedImports();
  if (!items.length) return null;
  return (
    <>
      {items.map((it) => (
        <ResumeCard key={it.target} item={it} />
      ))}
    </>
  );
}

function ResumeCard({ item }: { item: InterruptedImport }) {
  const s = useThemedStyles(createStyles);
  const actions = useLibraryActions();
  const st = item.state;
  const core = item.target === 'core';
  const total = Number(st.total_count) || 0;
  const done = Math.min(Number(st.processed_count) || 0, total);
  const phase = st.phase === 'scan' ? ' · שלב סריקת התיקיות' : st.phase === 'links' ? ' · שלב קישור הפרשנים' : st.phase === 'finalize' ? ' · שלב מיטוב האינדקס' : '';
  const killed = st.status === 'in_progress';

  const onDiscard = () =>
    confirm(
      core ? 'מחיקת הבנייה שנעצרה' : 'ביטול הייבוא שנעצר',
      core ? 'כל מה שנבנה עד עכשיו יימחק. הספרייה המותקנת לא תושפע.' : 'הספרים שיובאו בפעולה זו יימחקו מהספרים האישיים.',
      'מחק ואפס',
      () => void actions.discardImport(item),
    );

  return (
    <View style={s.card} testID={`resume-card-${item.target}`}>
      <Text style={s.title}>{core ? 'המשך בנייה שנעצרה' : 'המשך ייבוא שנעצר'}</Text>
      <Text style={s.body} numberOfLines={2}>
        {core ? 'ספריית ליבה' : 'ספרים אישיים'} מ״{st.source_name ?? 'תיקייה'}״{killed ? ' — הפעולה נקטעה' : ' — הושהתה'}
        {phase}
      </Text>
      <ProgressBar fraction={total ? done / total : null} />
      <Text style={s.count} testID="resume-progress">
        {num(done)} / {num(total)} ספרים הושלמו
      </Text>
      {st.error_count ? (
        <Text style={s.warn} numberOfLines={3}>
          {num(st.error_count)} קבצים פגומים דולגו{item.errors[0] ? `: ${item.errors.map((e) => e.file_path.split('/').pop()).slice(0, 3).join(', ')}` : ''}
        </Text>
      ) : null}
      <View style={s.row}>
        <Pressable onPress={() => void actions.resumeImport(item)} style={({ pressed }) => [s.primary, pressed && s.pressed]} accessibilityRole="button" testID="resume-import">
          <Text style={s.primaryText}>המשך</Text>
        </Pressable>
        <Pressable onPress={onDiscard} style={({ pressed }) => [s.danger, pressed && s.pressed]} accessibilityRole="button" testID="discard-import">
          <Text style={s.dangerText}>מחק ואפס</Text>
        </Pressable>
      </View>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    card: { backgroundColor: c.accentSoft, borderRadius: radius.md, borderWidth: 1, borderColor: c.accent, padding: spacing.md, marginHorizontal: spacing.lg, marginVertical: spacing.sm, gap: spacing.xs },
    title: { fontSize: 16, fontWeight: '800', color: c.text, writingDirection: 'rtl' },
    body: { fontSize: 14, color: c.text, writingDirection: 'rtl' },
    count: { fontSize: 13, color: c.textMuted, writingDirection: 'rtl' },
    warn: { fontSize: 13, color: c.danger, writingDirection: 'rtl' },
    row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
    primary: { flexGrow: 1, backgroundColor: c.accent, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
    primaryText: { color: c.surface, fontSize: 15, fontWeight: '700' },
    danger: { flexGrow: 1, borderWidth: 1, borderColor: c.danger, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
    dangerText: { color: c.danger, fontSize: 15, fontWeight: '700' },
    pressed: { opacity: 0.8 },
  });
