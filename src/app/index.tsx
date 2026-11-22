import { Stack, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import type { JumpResult } from '../../shared/quickJump';
import { LibraryTree } from '../components/LibraryTree';
import { QuickJumpBar } from '../components/QuickJumpBar';
import { colors } from '../theme';

export default function LibraryScreen() {
  const router = useRouter();

  const openBook = useCallback(
    (bookId: number, line?: number, highlight = false) => {
      router.push({
        pathname: '/reader/[bookId]',
        params: { bookId: String(bookId), line: String(line ?? 1), highlight: highlight ? '1' : '0' },
      });
    },
    [router],
  );

  const onJump = useCallback((r: JumpResult) => openBook(r.bookId, r.targetLine, !r.suggestion), [openBook]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'ספרייה' }} />
      <QuickJumpBar onJump={onJump} />
      <View style={styles.divider} />
      <View style={styles.tree}>
        <LibraryTree onOpenBook={(id) => openBook(id)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  divider: { height: 1, backgroundColor: colors.border },
  tree: { flex: 1 },
});
