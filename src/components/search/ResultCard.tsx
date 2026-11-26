/**
 * Compact KWIC (Key Word In Context) search result: Book Title + toc_path
 * breadcrumb, then a snippet around the first hit with matched words emphasized.
 */
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RLM, needsRtlMark } from '../../../shared/reader';
import { buildKwic, formatTocPath, type SearchRow } from '../../../shared/search';
import { readerFont } from '../../fonts';
import { useSettings } from '../../state/settingsStore';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';

interface Props {
  row: SearchRow;
  terms: string[];
  onPress: (row: SearchRow) => void;
}

export const ResultCard = memo(function ResultCard({ row, terms, onPress }: Props) {
  const s = useThemedStyles(createStyles);
  const showNikkud = useSettings((x) => x.showNikkud);
  const fontKey = useSettings((x) => x.fontFamily);
  const font = readerFont(fontKey);
  const showCantillation = useSettings((x) => x.showCantillation);
  const kwic = useMemo(() => buildKwic(row.display_text, terms, { showNikkud, showCantillation }), [row.display_text, terms, showNikkud, showCantillation]);
  const crumb = formatTocPath(row.toc_path);
  const plain = kwic.segments.map((x) => x.text).join('');
  const rlm = needsRtlMark(plain) ? RLM : '';

  return (
    <Pressable
      onPress={() => onPress(row)}
      style={({ pressed }) => [s.card, pressed && s.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${row.book_title} ${crumb}`}
      testID="search-result"
      // Web: id="result-<book>-<line>" (e2e reads the target line of a result).
      nativeID={`result-${row.book_id}-${row.line_index}`}
    >
      <View style={s.header}>
        <Text style={s.title} numberOfLines={1}>
          {row.book_title}
          {crumb ? <Text style={s.crumb}>{'  ‹  ' + crumb.split(' › ').join('  ‹  ')}</Text> : null}
        </Text>
        {kwic.hitCount > 1 ? <Text style={s.hits}>×{kwic.hitCount}</Text> : null}
      </View>
      <Text style={[s.snippet, font.regular ? { fontFamily: font.regular } : null]} numberOfLines={3}>
        {rlm}
        {kwic.clippedStart ? '… ' : ''}
        {kwic.segments.map((seg, i) =>
          seg.hit ? (
            <Text key={i} testID="search-hit" style={[s.hit, font.bold ? { fontFamily: font.bold } : { fontWeight: '700' }]}>
              {seg.text}
            </Text>
          ) : (
            seg.text
          ),
        )}
        {kwic.clippedEnd ? ' …' : ''}
      </Text>
    </Pressable>
  );
});

const createStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginHorizontal: spacing.md,
      marginBottom: spacing.sm,
      gap: 4,
    },
    pressed: { backgroundColor: c.accentSoft },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { flex: 1, fontSize: 15, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    crumb: { fontSize: 13, fontWeight: '500', color: c.accent },
    hits: { fontSize: 12, color: c.textMuted },
    snippet: { fontSize: 16, lineHeight: 25, color: c.text, writingDirection: 'rtl' },
    hit: { color: c.accent, backgroundColor: c.highlight },
  });
