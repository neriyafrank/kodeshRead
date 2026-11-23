/**
 * Active search scope as removable RTL chips: each picked book / commentary gets a ✕ chip (up to
 * four), a larger selection collapses into "נבחרו N ספרים" + "נקה". Shown under the scope button
 * on Simple Search and Advanced Search.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { booksScope, type SearchScope } from '../../../shared/search';
import { alignRight } from '../../lib/direction';
import { spacing, useThemedStyles, type Palette } from '../../theme';

const MAX_CHIPS = 4;

interface Props {
  scope: SearchScope;
  onChange: (scope: SearchScope) => void;
}

export function ScopeChips({ scope, onChange }: Props) {
  const s = useThemedStyles(createStyles);
  if (scope.kind !== 'books') return null;
  const picks = scope.picks ?? scope.ids.map((id) => ({ id, title: String(id) }));
  const clear = () => onChange({ kind: 'all' });
  if (picks.length > MAX_CHIPS)
    return (
      <View style={s.row} testID="scope-chips">
        <View style={s.chip}>
          <Text style={s.chipText} testID="scope-badge">{`נבחרו ${picks.length} ספרים`}</Text>
        </View>
        <Pressable onPress={clear} hitSlop={8} accessibilityRole="button" style={s.clear} testID="scope-chips-clear">
          <Text style={s.clearText}>נקה</Text>
        </Pressable>
      </View>
    );
  return (
    <View style={s.row} testID="scope-chips">
      {picks.map((p) => (
        <View key={p.id} style={s.chip} testID={`scope-chip-${p.id}`}>
          <Text style={s.chipText} numberOfLines={1}>
            {p.title}
          </Text>
          <Pressable onPress={() => onChange(booksScope(picks.filter((x) => x.id !== p.id)))} hitSlop={8} accessibilityRole="button" accessibilityLabel={`הסר ${p.title}`} testID={`scope-chip-remove-${p.id}`}>
            <Text style={s.x}>✕</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', paddingStart: spacing.md, paddingEnd: spacing.sm, paddingVertical: 4, borderRadius: 999, backgroundColor: c.accentSoft },
    chipText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: c.accent, ...alignRight },
    x: { fontSize: 12, color: c.accent },
    clear: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
    clearText: { fontSize: 13, color: c.textMuted, ...alignRight },
  });
