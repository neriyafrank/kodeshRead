/** Live progress of the running library job (bar + stage + detail + cancel) and its result. */
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { isolateLtr } from '../../lib/direction';
import { useLibraryJobs } from '../../state/libraryJobs';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';
import { ErrorDetails } from './ErrorDetails';

/** Cancelling an import discards its progress (pausing keeps it): ask first on the device. */
function confirmCancel(resumable: boolean, onOk: () => void) {
  if (!resumable || Platform.OS === 'web') return onOk();
  Alert.alert('לבטל את הפעולה?', 'ההתקדמות תימחק. כדי להמשיך מאותה נקודה מאוחר יותר בחרו ״השהה״.', [
    { text: 'חזרה', style: 'cancel' },
    { text: 'בטל ומחק', style: 'destructive', onPress: onOk },
  ]);
}

export function ProgressBar({ fraction }: { fraction: number | null }) {
  const s = useThemedStyles(createStyles);
  const pct = fraction == null ? null : Math.max(0, Math.min(1, fraction));
  return (
    <View style={s.track} accessibilityRole="progressbar" accessibilityValue={pct == null ? undefined : { min: 0, max: 100, now: Math.round(pct * 100) }}>
      <View style={[s.fill, pct == null ? s.indeterminate : { width: `${pct * 100}%` }]} />
    </View>
  );
}

/** Full card for the manager screen. `compact` = one-line banner for the Library screen. */
export function JobStatus({ compact, onPress }: { compact?: boolean; onPress?: () => void }) {
  const s = useThemedStyles(createStyles);
  const job = useLibraryJobs((x) => x.job);
  const result = useLibraryJobs((x) => x.result);
  const cancelRequested = useLibraryJobs((x) => x.cancelRequested);
  const requestCancel = useLibraryJobs((x) => x.requestCancel);
  const requestPause = useLibraryJobs((x) => x.requestPause);
  const stopRequested = useLibraryJobs((x) => x.stopRequested);
  const clearResult = useLibraryJobs((x) => x.clearResult);

  if (job) {
    const pct = job.fraction == null ? '' : ` ${Math.round(job.fraction * 100)}%`;
    if (compact) {
      return (
        <Pressable onPress={onPress} style={s.banner} accessibilityRole="button" testID="job-banner">
          <Text style={s.bannerText} numberOfLines={1}>
            {job.stage}
            {pct}
            {job.detail ? ` · ${isolateLtr(job.detail)}` : ''}
          </Text>
          <ProgressBar fraction={job.fraction} />
        </Pressable>
      );
    }
    return (
      <View style={s.card} testID="job-status">
        <View style={s.row}>
          <Text style={s.stage}>
            {job.stage}
            {pct}
          </Text>
          {job.resumable || job.pausable ? (
            <Pressable onPress={() => requestPause(false)} disabled={!!stopRequested} hitSlop={8} accessibilityRole="button" testID="job-pause">
              <Text style={[s.pause, !!stopRequested && s.muted]}>{stopRequested === 'pause' ? 'משהה…' : 'השהה'}</Text>
            </Pressable>
          ) : null}
          {job.kind !== 'delete' ? (
            <Pressable onPress={() => confirmCancel(job.resumable || !!job.pausable, requestCancel)} disabled={cancelRequested} hitSlop={8} accessibilityRole="button" testID="job-cancel">
              <Text style={[s.cancel, cancelRequested && s.muted]}>{cancelRequested ? 'מבטל…' : 'ביטול'}</Text>
            </Pressable>
          ) : null}
        </View>
        <ProgressBar fraction={job.fraction} />
        {job.detail ? (
          <Text style={s.detail} numberOfLines={2}>
            {isolateLtr(job.detail)}
          </Text>
        ) : null}
        {job.resumable ? <Text style={s.hint}>ההתקדמות נשמרת אחרי כל ספר — אפשר להשהות ולהמשיך גם אחרי סגירת האפליקציה.</Text> : null}
        {job.pausable ? (
          <Text style={s.hint} testID="job-download-hint">
            ההורדה נמשכת גם ברקע ובמסך כבוי. אפשר להשהות ולהמשיך מאותה נקודה, גם אחרי סגירת האפליקציה או ניתוק מהרשת.
          </Text>
        ) : null}
      </View>
    );
  }
  if (result && !compact) {
    return (
      <View style={[s.card, result.ok && !result.paused ? s.ok : result.ok ? null : s.fail]} testID="job-result">
        <View style={s.row}>
          <Text style={[s.resultText, !result.ok && s.failText]}>{result.message}</Text>
          <Pressable onPress={clearResult} hitSlop={10} accessibilityRole="button" accessibilityLabel="סגור">
            <Text style={s.muted}>✕</Text>
          </Pressable>
        </View>
        {!result.ok && result.diagnostic ? <ErrorDetails diagnostic={result.diagnostic} context={`job ${result.kind}`} testID="job-error-details" /> : null}
        {result.errors?.length ? (
          <View style={s.errors} testID="job-errors">
            <Text style={s.errorsTitle}>קבצים שדולגו בגלל שגיאה ({result.errors.length}):</Text>
            {result.errors.slice(0, 8).map((e) => (
              <Text key={e.path} style={s.errorLine} numberOfLines={2}>
                • {e.path} — {e.message}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    );
  }
  return null;
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    track: { height: 8, borderRadius: 4, backgroundColor: c.surfaceMuted, overflow: 'hidden', marginTop: spacing.sm },
    fill: { height: '100%', borderRadius: 4, backgroundColor: c.accent },
    indeterminate: { width: '35%', opacity: 0.55 },
    card: { backgroundColor: c.surface, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, padding: spacing.md, marginBottom: spacing.md },
    ok: { borderColor: c.accent, backgroundColor: c.accentSoft },
    fail: { borderColor: c.danger },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    stage: { flex: 1, fontSize: 16, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    detail: { marginTop: spacing.xs, fontSize: 13, color: c.textMuted, writingDirection: 'rtl' },
    cancel: { color: c.danger, fontSize: 15, fontWeight: '600' },
    pause: { color: c.accent, fontSize: 15, fontWeight: '600', marginEnd: spacing.sm },
    hint: { marginTop: spacing.xs, fontSize: 12, color: c.textMuted, writingDirection: 'rtl' },
    errors: { marginTop: spacing.sm, gap: 2 },
    errorsTitle: { fontSize: 13, fontWeight: '700', color: c.danger, writingDirection: 'rtl' },
    errorLine: { fontSize: 12, color: c.textMuted, writingDirection: 'rtl' },
    muted: { color: c.textMuted },
    resultText: { flex: 1, fontSize: 15, color: c.text, writingDirection: 'rtl' },
    failText: { color: c.danger },
    banner: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, backgroundColor: c.accentSoft, borderBottomWidth: 1, borderBottomColor: c.border },
    bannerText: { fontSize: 13, color: c.text, writingDirection: 'rtl' },
  });
