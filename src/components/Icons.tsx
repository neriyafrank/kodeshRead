/** Tiny dependency-free icons drawn with Views (no icon font needed). */
import { StyleSheet, View } from 'react-native';

import { useAppTheme } from '../theme';

export function SearchIcon({ color: colorProp, size = 20 }: { color?: string; size?: number }) {
  const colors = useAppTheme();
  const color = colorProp ?? colors.accent;
  const ring = size * 0.68;
  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no">
      <View style={{ position: 'absolute', top: 0, start: 0, width: ring, height: ring, borderRadius: ring / 2, borderWidth: 2, borderColor: color }} />
      <View
        style={{
          position: 'absolute',
          width: size * 0.42,
          height: 2.4,
          borderRadius: 2,
          backgroundColor: color,
          top: size * 0.76,
          start: size * 0.52,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

export function FolderIcon({ open, size = 18 }: { open?: boolean; size?: number }) {
  const colors = useAppTheme();
  const color = open ? colors.accent : colors.textMuted;
  return (
    <View style={{ width: size, height: size * 0.8, justifyContent: 'flex-end' }}>
      <View style={[styles.folderTab, { width: size * 0.45, height: size * 0.2, borderColor: color, backgroundColor: open ? color : 'transparent' }]} />
      <View style={{ width: size, height: size * 0.62, borderWidth: 1.6, borderColor: color, borderRadius: 2, borderTopStartRadius: 0, backgroundColor: open ? colors.accentSoft : 'transparent' }} />
    </View>
  );
}

export function BookIcon({ size = 16 }: { size?: number }) {
  const colors = useAppTheme();
  return (
    <View style={{ width: size * 0.72, height: size, borderWidth: 1.6, borderColor: colors.accent, borderRadius: 2, borderStartWidth: 3.5 }} />
  );
}

/** Three slider tracks with knobs: "tools / display options". */
export function SlidersIcon({ color: colorProp, size = 20 }: { color?: string; size?: number }) {
  const colors = useAppTheme();
  const color = colorProp ?? colors.accent;
  const knob = Math.round(size * 0.3);
  const knobs = [0.68, 0.28, 0.52];
  return (
    <View style={{ width: size, height: size, justifyContent: 'space-evenly' }} accessibilityElementsHidden importantForAccessibility="no">
      {knobs.map((at, i) => (
        <View key={i} style={{ height: knob, justifyContent: 'center' }}>
          <View style={{ height: 2, borderRadius: 1, backgroundColor: color }} />
          <View
            style={{
              position: 'absolute',
              start: Math.round((size - knob) * at),
              width: knob,
              height: knob,
              borderRadius: knob / 2,
              borderWidth: 2,
              borderColor: color,
              backgroundColor: colors.surface,
            }}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  folderTab: { borderWidth: 1.6, borderBottomWidth: 0, borderTopStartRadius: 2, borderTopEndRadius: 2 },
});
