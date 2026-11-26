/**
 * Preset corpus selector shared by Simple Search (one compact scrolling row) and Advanced Search
 * (wrapping chips): "הכל" + the presets of shared/corpora.js (תנ"ך, משנה, בבלי, ... ). Chips show only the
 * name (no book counts: numbers live exclusively on the results filter bar); a preset that resolved to no
 * books is dimmed. Themed, RTL (the first chip sits at the start/right edge).
 */
import { ScrollView, Pressable, StyleSheet, Text, View } from 'react-native';

import { alignRight } from '../../lib/direction';
import { spacing, useThemedStyles, type Palette } from '../../theme';

export interface PresetItem {
  id: string;
  label: string;
  /** Matched books: never rendered, only dims an empty preset (null / undefined while the catalog loads). */
  count?: number | null;
}

interface Props {
  items: PresetItem[];
  selected: string[];
  onToggle: (id: string) => void;
  /** testID = `${testIDPrefix}-${id}` */
  testIDPrefix: string;
  /** Wrap onto several lines (Advanced Search) instead of one scrolling row (Simple Search). */
  wrap?: boolean;
}

export function CorpusPresets({ items, selected, onToggle, testIDPrefix, wrap }: Props) {
  const s = useThemedStyles(createStyles);
  const chips = items.map((k) => {
    const on = selected.includes(k.id);
    const empty = k.count === 0;
    return (
      <Pressable
        key={k.id}
        onPress={() => onToggle(k.id)}
        style={[s.chip, on && s.chipOn, empty && !on && s.chipEmpty]}
        accessibilityRole="checkbox"
        aria-checked={on}
        accessibilityLabel={k.label}
        testID={`${testIDPrefix}-${k.id}`}
      >
        <Text style={[s.text, on && s.textOn]} numberOfLines={1}>
          {k.label}
        </Text>
      </Pressable>
    );
  });
  if (wrap) return <View style={s.wrap}>{chips}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={s.row} testID={`${testIDPrefix}-strip`}>
      {chips}
    </ScrollView>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingHorizontal: spacing.md, paddingVertical: 5 },
    chipOn: { backgroundColor: c.accentSoft, borderColor: c.accent },
    chipEmpty: { opacity: 0.55 },
    text: { fontSize: 14, color: c.text, ...alignRight },
    textOn: { color: c.accent, fontWeight: '700' },
  });
