/**
 * Reader toolbar toggles: "טעמים" (cantillation) and "ניקוד" (vowel points), persisted in
 * the settings store. Hiding ניקוד also hides טעמים (trope without vowels is unreadable),
 * so טעמים then shows as off; tapping it brings both back. Hiding טעמים alone keeps clean
 * vocalized text.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSettings } from '../../state/settingsStore';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';

export function VocalizationToggles() {
  const s = useThemedStyles(createStyles);
  const showNikkud = useSettings((x) => x.showNikkud);
  const showCantillation = useSettings((x) => x.showCantillation);
  const set = useSettings((x) => x.set);
  const cantillationOn = showNikkud && showCantillation;

  const pill = (label: string, on: boolean, onPress: () => void, a11y: string, testID: string) => (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [s.pill, on ? s.pillOn : s.pillOff, pressed && s.pressed]}
      accessibilityRole="switch"
      aria-checked={on}
      accessibilityLabel={a11y}
      testID={testID}
    >
      <Text style={[s.text, on ? s.textOn : s.textOff]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={s.row}>
      {pill(
        'טעמים',
        cantillationOn,
        () => (showNikkud ? set({ showCantillation: !showCantillation }) : set({ showNikkud: true, showCantillation: true })),
        'הצגת טעמי המקרא',
        'toggle-cantillation',
      )}
      {pill('ניקוד', showNikkud, () => set({ showNikkud: !showNikkud }), 'הצגת ניקוד', 'toggle-nikkud')}
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', gap: 4 },
    pill: { height: 32, minWidth: 44, paddingHorizontal: spacing.xs + 2, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
    pillOn: { backgroundColor: c.accent, borderColor: c.accent },
    pillOff: { backgroundColor: 'transparent', borderColor: c.border },
    pressed: { opacity: 0.7 },
    text: { fontSize: 13, fontWeight: '700' },
    textOn: { color: c.surface },
    textOff: { color: c.textMuted, textDecorationLine: 'line-through' },
  });
