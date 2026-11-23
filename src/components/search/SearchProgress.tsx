/**
 * Search Progress UI shared by Simple Search and Advanced Search (RTL, themed):
 *
 *  - an indeterminate sweep bar (native-driver animation, so it keeps moving while JS is busy) shown
 *    the moment a search is pending — a fixed 3 px track, so nothing jumps when it appears;
 *  - a status banner after BANNER_DELAY_MS (no flicker on instant queries): the scope / real stage,
 *    a live elapsed timer (numbers isolated LTR) and a compact "ביטול" button;
 *  - a "החיפוש בוטל" banner with "חפש שוב" (distinct from "לא נמצאו תוצאות");
 *  - LoadingMoreFooter for pagination.
 */
import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { SearchScope } from '../../../shared/search';
import { BANNER_DELAY_MS, formatElapsed, stageLabel, type SearchStage } from '../../../shared/searchLifecycle';
import { alignRight } from '../../lib/direction';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';

const SWEEP_MS = 1100;
const THUMB = 0.38;

/** Re-renders only this component every 100 ms while `active`. */
function useElapsed(startedAt: number, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [active, startedAt]);
  return active ? Math.max(0, now - startedAt) : 0;
}

function SweepBar({ active }: { active: boolean }) {
  const s = useThemedStyles(createStyles);
  const [w, setW] = useState(0);
  const sweep = useState(() => new Animated.Value(0))[0];
  const fade = useState(() => new Animated.Value(0))[0];

  // Fade in / out so a query that finishes in < 200 ms never produces a hard flash.
  useEffect(() => {
    Animated.timing(fade, { toValue: active ? 1 : 0, duration: active ? 160 : 220, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [active, fade]);

  useEffect(() => {
    if (!active || !w) return;
    sweep.setValue(0);
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: SWEEP_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }));
    loop.start();
    return () => loop.stop();
  }, [active, w, sweep]);

  const thumb = w * THUMB;
  // The thumb starts at the right (RTL start edge) and travels left across the track.
  const translateX = sweep.interpolate({ inputRange: [0, 1], outputRange: [thumb, -w] });
  return (
    <View
      style={s.track}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      testID="search-progress-track"
      accessibilityRole="progressbar"
      accessibilityLabel="מחפש"
    >
      {w ? (
        <Animated.View testID="search-progress-bar" style={[s.thumb, { width: thumb, opacity: fade, transform: [{ translateX }] }]} />
      ) : null}
    </View>
  );
}

interface Props {
  /** 'searching' | 'cancelled' | other = quiet. */
  phase: string;
  scope: SearchScope;
  progress: { stage: SearchStage; scanned: number; startedAt: number };
  onCancel: () => void;
  onRetry: () => void;
  testIDPrefix?: string;
}

export const SearchProgress = memo(function SearchProgress({ phase, scope, progress, onCancel, onRetry, testIDPrefix = 'search' }: Props) {
  const s = useThemedStyles(createStyles);
  const searching = phase === 'searching';
  const elapsed = useElapsed(progress.startedAt, searching);
  const showBanner = searching && elapsed >= BANNER_DELAY_MS;
  return (
    <View>
      <SweepBar active={searching} />
      {showBanner ? (
        <View style={s.banner} testID={`${testIDPrefix}-status`} accessibilityLiveRegion="polite">
          <Text style={s.stage} numberOfLines={1} testID={`${testIDPrefix}-stage`}>
            {stageLabel(progress.stage === 'count' ? 'query' : progress.stage, progress.scanned, scope)}
          </Text>
          <Text style={s.elapsed} testID={`${testIDPrefix}-elapsed`}>
            {formatElapsed(elapsed)}
          </Text>
          <Pressable onPress={onCancel} style={({ pressed }) => [s.cancel, pressed && s.pressed]} accessibilityRole="button" accessibilityLabel="ביטול" testID={`${testIDPrefix}-cancel`}>
            <Text style={s.cancelText}>ביטול</Text>
          </Pressable>
        </View>
      ) : null}
      {phase === 'cancelled' ? (
        <View style={s.banner} testID={`${testIDPrefix}-cancelled`}>
          <Text style={s.stage}>החיפוש בוטל</Text>
          <Pressable onPress={onRetry} style={({ pressed }) => [s.cancel, pressed && s.pressed]} accessibilityRole="button" testID={`${testIDPrefix}-retry`}>
            <Text style={s.cancelText}>חפש שוב</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

/** Spinner + "טוען תוצאות נוספות…" at the end of the list while the next page loads. */
export function LoadingMoreFooter() {
  const s = useThemedStyles(createStyles);
  const c = useAppTheme();
  return (
    <View style={s.more} testID="search-loading-more">
      <ActivityIndicator size="small" color={c.accent} />
      <Text style={s.moreText}>טוען תוצאות נוספות…</Text>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    track: { height: 3, overflow: 'hidden', backgroundColor: c.accentSoft, alignItems: 'flex-start' },
    thumb: { height: 3, borderRadius: 2, backgroundColor: c.accent },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 40,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
      backgroundColor: c.surfaceMuted,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    stage: { flex: 1, minWidth: 0, fontSize: 14, color: c.text, ...alignRight },
    elapsed: { fontSize: 13, color: c.textMuted, fontVariant: ['tabular-nums'], ...alignRight },
    cancel: { paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radius.lg, borderWidth: 1, borderColor: c.accent },
    cancelText: { fontSize: 13, fontWeight: '700', color: c.accent },
    pressed: { opacity: 0.6 },
    more: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginVertical: spacing.lg },
    moreText: { fontSize: 13, color: c.textMuted },
  });
