/** Tiny dependency-free icons drawn with Views (no icon font needed). */
import { StyleSheet, View } from 'react-native';

import { colors } from '../theme';

export function SearchIcon({ color = colors.accent, size = 20 }: { color?: string; size?: number }) {
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
  const color = open ? colors.accent : colors.textMuted;
  return (
    <View style={{ width: size, height: size * 0.8, justifyContent: 'flex-end' }}>
      <View style={[styles.folderTab, { width: size * 0.45, height: size * 0.2, borderColor: color, backgroundColor: open ? color : 'transparent' }]} />
      <View style={{ width: size, height: size * 0.62, borderWidth: 1.6, borderColor: color, borderRadius: 2, borderTopStartRadius: 0, backgroundColor: open ? colors.accentSoft : 'transparent' }} />
    </View>
  );
}

export function BookIcon({ size = 16 }: { size?: number }) {
  return (
    <View style={{ width: size * 0.72, height: size, borderWidth: 1.6, borderColor: colors.accent, borderRadius: 2, borderStartWidth: 3.5 }} />
  );
}

const styles = StyleSheet.create({
  folderTab: { borderWidth: 1.6, borderBottomWidth: 0, borderTopStartRadius: 2, borderTopEndRadius: 2 },
});
