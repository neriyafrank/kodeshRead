/**
 * Minimal reader used by Milestone 1 so Quick Jump / tree taps land somewhere real.
 * It loads only a small window around the target line and highlights it for 2s.
 * Milestone 2 replaces this with the sliding-window FlashList reader, TOC drawer,
 * tabs and the Aa typography panel.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';

import { RichText } from '../../components/RichText';
import { useLibrary } from '../../db/LibraryContext';
import { colors, radius, spacing } from '../../theme';

interface Para {
  line_index: number;
  display_text: string;
  is_heading: number;
  toc_path: string | null;
}

const BEFORE = 15;
const AFTER = 60;
const HIGHLIGHT_MS = 2000;

export default function ReaderScreen() {
  const { bookId, line, highlight } = useLocalSearchParams<{ bookId: string; line?: string; highlight?: string }>();
  const { db } = useLibrary();
  const target = Math.max(1, Number(line) || 1);
  const [title, setTitle] = useState('');
  const [rows, setRows] = useState<Para[] | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(highlight === '1' ? target : null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const targetY = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const book = await db.getFirstAsync<{ title: string }>('SELECT title FROM books WHERE id = ?', [Number(bookId)]);
      const paras = await db.getAllAsync<Para>(
        'SELECT line_index, display_text, is_heading, toc_path FROM paragraphs WHERE book_id = ? AND line_index BETWEEN ? AND ? ORDER BY line_index',
        [Number(bookId), target - BEFORE, target + AFTER],
      );
      if (!alive) return;
      setTitle(book?.title ?? '');
      setRows(paras);
    })();
    return () => {
      alive = false;
    };
  }, [db, bookId, target]);

  useEffect(() => {
    if (highlighted == null) return;
    const t = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlighted]);

  const crumb = rows?.find((r) => r.line_index >= target)?.toc_path;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: title || '…' }} />
      {crumb ? <Text style={styles.crumb}>{crumb.split(' > ').join('  ‹  ')}</Text> : null}
      {!rows ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />
      ) : (
        <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
          {rows.map((p) => (
            <View
              key={p.line_index}
              onLayout={(e) => {
                if (p.line_index === target && targetY.current == null) {
                  targetY.current = e.nativeEvent.layout.y;
                  scrollRef.current?.scrollTo({ y: Math.max(0, targetY.current - 24), animated: false });
                }
              }}
              style={[styles.para, highlighted === p.line_index && styles.highlight]}
              testID={p.line_index === target ? 'reader-target' : undefined}
            >
              <RichText
                html={/[()\d]/.test(p.display_text) ? '‏' + p.display_text : p.display_text}
                fontSize={p.is_heading ? 22 : 19}
                style={[styles.text, p.is_heading ? styles.heading : null]}
              />
            </View>
          ))}
          <Text style={styles.note}>תצוגה זמנית — הקורא המלא (גלילה רציפה, תוכן עניינים, לשוניות) יגיע באבן הדרך הבאה.</Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  crumb: {
    fontSize: 13,
    color: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    writingDirection: 'rtl',
  },
  content: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  para: { paddingVertical: 6, paddingHorizontal: spacing.sm, borderRadius: radius.sm },
  highlight: { backgroundColor: colors.highlight },
  text: { color: colors.text, lineHeight: 32, writingDirection: 'rtl' },
  heading: { fontWeight: '700', color: colors.accent, marginTop: spacing.md },
  note: { marginTop: spacing.xl, fontSize: 12, color: colors.textMuted, textAlign: 'center' },
});
