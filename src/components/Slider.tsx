/**
 * Dependency-free slider (PanResponder). In RTL layouts the minimum sits on the
 * right, matching native Android RTL sliders.
 */
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { I18nManager, PanResponder, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { useAppTheme } from '../theme';

interface Props {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  accessibilityLabel: string;
  testID?: string;
}

const THUMB = 24;
// `start` follows I18nManager (on web it stays left even with dir=rtl).
const isRTL = () => I18nManager.isRTL;

export function Slider({ value, min, max, step, onChange, accessibilityLabel, testID }: Props) {
  const c = useAppTheme();
  const [width, setWidth] = useState(0);
  const track = useRef({ x: 0, width: 0 });
  const viewRef = useRef<ComponentRef<typeof View>>(null);
  const cb = useRef({ onChange, min, max, step, value });
  useEffect(() => {
    cb.current = { onChange, min, max, step, value };
  });

  // The gesture callbacks read the latest props/width from refs at event time, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => {
    const update = (e: GestureResponderEvent) => {
      const { x: left, width: w } = track.current;
      if (!w) return;
      const { min: lo, max: hi, step: st, onChange: emit, value: cur } = cb.current;
      // pageX against the measured track (locationX is unreliable across platforms/targets).
      const x = Math.min(w, Math.max(0, e.nativeEvent.pageX - left));
      const frac = isRTL() ? 1 - x / w : x / w;
      const raw = lo + frac * (hi - lo);
      const v = Math.min(hi, Math.max(lo, Math.round(raw / st) * st));
      const rounded = Math.round(v * 1000) / 1000;
      if (rounded !== cur) emit(rounded);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        // Re-measure on touch: the sheet may have moved since layout (open animation).
        viewRef.current?.measureInWindow((x, _y, width) => {
          track.current = { x, width };
          update(e);
        });
      },
      onPanResponderMove: update,
    });
  });

  const frac = max > min ? (value - min) / (max - min) : 0;
  const pos = frac * Math.max(0, width - THUMB);

  return (
    <View
      ref={viewRef}
      style={styles.hit}
      onLayout={(e) => {
        setWidth(e.nativeEvent.layout.width);
        viewRef.current?.measureInWindow((x: number, _y: number, w: number) => (track.current = { x, width: w }));
      }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const d = e.nativeEvent.actionName === 'increment' ? step : -step;
        onChange(Math.round(Math.min(max, Math.max(min, value + d)) * 1000) / 1000);
      }}
      testID={testID}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={[styles.track, { backgroundColor: c.border }]} />
      <View pointerEvents="none" style={[styles.fill, { backgroundColor: c.accent, width: pos + THUMB / 2 }]} />
      <View pointerEvents="none" style={[styles.thumb, { start: pos, backgroundColor: c.surface, borderColor: c.accent }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { height: 40, justifyContent: 'center', flex: 1 },
  track: { position: 'absolute', start: THUMB / 2, end: THUMB / 2, height: 4, borderRadius: 2 },
  fill: { position: 'absolute', start: 0, height: 4, borderRadius: 2 },
  thumb: { position: 'absolute', width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 2.5 },
});
