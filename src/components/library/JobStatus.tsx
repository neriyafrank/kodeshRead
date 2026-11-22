/** Live progress of the running library job (bar + stage + detail + cancel) and its result. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useLibraryJobs } from '../../state/libraryJobs';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';

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
  const clearResult = useLibraryJobs((x) => x.clearResult);

  if (job) {
    const pct = job.fraction == null ? '' : ` ${Math.round(job.fraction * 100)}%`;
    if (compact) {
      return (
        <Pressable onPress={onPress} style={s.banner} accessibilityRole="button" testID="job-banner">
          <Text style={s.bannerText} numberOfLines={1}>
            {job.stage}
            {pct}
            {job.detail ? ` · ${job.detail}` : ''}
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
          {job.kind !== 'delete' ? (
            <Pressable onPress={requestCancel} disabled={cancelRequested} hitSlop={8} accessibilityRole="button" testID="job-cancel">
              <Text style={[s.cancel, cancelRequested && s.muted]}>{cancelRequested ? 'מבטל…' : 'ביטול'}</Text>
            </Pressable>
          ) : null}
        </View>
        <ProgressBar fraction={job.fraction} />
        {job.detail ? (
          <Text style={s.detail} numberOfLines={2}>
            {job.detail}
          </Text>
        ) : null}
      </View>
    );
  }
  if (result && !compact) {
    return (
      <View style={[s.card, result.ok ? s.ok : s.fail]} testID="job-result">
        <View style={s.row}>
          <Text style={[s.resultText, !result.ok && s.failText]}>{result.message}</Text>
          <Pressable onPress={clearResult} hitSlop={10} accessibilityRole="button" accessibilityLabel="סגור">
            <Text style={s.muted}>✕</Text>
          </Pressable>
        </View>
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
    muted: { color: c.textMuted },
    resultText: { flex: 1, fontSize: 15, color: c.text, writingDirection: 'rtl' },
    failText: { color: c.danger },
    banner: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, backgroundColor: c.accentSoft, borderBottomWidth: 1, borderBottomColor: c.border },
    bannerText: { fontSize: 13, color: c.text, writingDirection: 'rtl' },
  });
