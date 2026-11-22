/**
 * High-speed windowed reader for one tab.
 *
 * - Holds only a sliding window of paragraphs (~400 lines around the current line,
 *   at most MAX_WINDOW) and fetches CHUNK_SIZE more as the user nears either edge;
 *   the far edge is trimmed so a book is never loaded whole into state.
 * - FlashList virtualizes rendering; FlashList v2 measures rows itself, so the
 *   typography-derived item-size estimate drives the draw distance instead.
 * - Jumps (Quick Jump / TOC / search) scroll inside the window when the target is
 *   loaded, otherwise the window is re-centred; the target row glows for 2s.
 * - The exact position (top line + pixel offset into it) is saved to the tab.
 */
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import {
  estimateItemSize,
  fetchRange,
  indexOfLine,
  mergeChunk,
  nextChunk,
  prepareDisplayText,
  windowAround,
  type LineRange,
  type ParagraphRow,
} from '../../../shared/reader';
import { useLibrary } from '../../db/LibraryContext';
import { readerFont } from '../../fonts';
import { useSettings } from '../../state/settingsStore';
import { useTabs, type ReaderTab } from '../../state/tabsStore';
import { spacing, useAppTheme, type Palette } from '../../theme';
import { RichText } from '../RichText';

export const BREADCRUMB_HEIGHT = 40;
/**
 * The "reading line": the row under this many px from the list top (just below the
 * breadcrumb bar) is the tab's current line; its offset is saved relative to it.
 */
const ANCHOR = BREADCRUMB_HEIGHT + spacing.sm;
/** Scroll events right after a programmatic jump must not hide the breadcrumb. */
const JUMP_SETTLE_MS = 600;
const HIGHLIGHT_MS = 2000;
const SAVE_DEBOUNCE_MS = 300;
const useNative = Platform.OS !== 'web';

interface WindowState {
  rows: ParagraphRow[];
  range: LineRange;
  /** Bumped on every re-centre; remounts the list with a fresh initialScrollIndex. */
  epoch: number;
  initialIndex: number;
  initialViewOffset: number;
}

interface Typography {
  fontSize: number;
  lineHeight: number;
  regular: string | undefined;
  bold: string | undefined;
  showNiqqud: boolean;
  palette: Palette;
}

interface Props {
  tab: ReaderTab;
  onOpenToc: () => void;
}

export function BookReader({ tab, onOpenToc }: Props) {
  const { adapter, db } = useLibrary();
  const palette = useAppTheme();
  const fontSize = useSettings((s) => s.fontSize);
  const lineHeight = useSettings((s) => s.lineHeight);
  const fontFamily = useSettings((s) => s.fontFamily);
  const showNiqqud = useSettings((s) => s.showNiqqud);
  const updatePosition = useTabs((s) => s.updatePosition);
  const consumeJump = useTabs((s) => s.consumeJump);
  const pendingJump = useTabs((s) => (s.pendingJump?.tabId === tab.tabId ? s.pendingJump : null));

  const { tabId, bookId } = tab;
  const { height: windowHeight } = useWindowDimensions();
  const [totalLines, setTotalLines] = useState<number | null>(null);
  const [win, setWin] = useState<WindowState | null>(null);
  const [highlight, setHighlight] = useState<{ line: number; nonce: number } | null>(null);
  const [topRow, setTopRow] = useState<{ line: number; tocPath: string | null }>({ line: tab.currentLineIndex, tocPath: tab.tocPath });
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<FlashListRef<ParagraphRow>>(null);
  const winRef = useRef<WindowState | null>(null);
  const commitWin = useCallback((next: WindowState) => {
    winRef.current = next;
    setWin(next);
  }, []);
  const loadingEdge = useRef({ forward: false, backward: false });
  const epochRef = useRef(0);

  // --- typography -----------------------------------------------------------
  const font = readerFont(fontFamily);
  const typo = useMemo<Typography>(
    () => ({ fontSize, lineHeight, regular: font.regular, bold: font.bold, showNiqqud, palette }),
    [fontSize, lineHeight, font.regular, font.bold, showNiqqud, palette],
  );
  const estimatedItemSize = estimateItemSize(fontSize, lineHeight);

  // --- position persistence ---------------------------------------------------
  const position = useRef({ currentLineIndex: tab.currentLineIndex, tocPath: tab.tocPath, lineOffset: tab.lineOffset });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    updatePosition(tabId, position.current);
  }, [tabId, updatePosition]);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => st !== 'active' && flush());
    return () => {
      sub.remove();
      flush();
    };
  }, [flush]);

  // --- auto-hiding breadcrumb ------------------------------------------------------
  const [headerY] = useState(() => new Animated.Value(0));
  const headerVisible = useRef(true);
  const lastY = useRef(0);
  const settleUntil = useRef(0);
  const showHeader = useCallback(
    (show: boolean) => {
      if (headerVisible.current === show) return;
      headerVisible.current = show;
      Animated.timing(headerY, { toValue: show ? 0 : -BREADCRUMB_HEIGHT - 2, duration: 180, useNativeDriver: useNative }).start();
    },
    [headerY],
  );


  // --- window loading -----------------------------------------------------------
  /** Re-centre the window on `target`, `lineOffset` px into that row at the reading line. */
  const loadAround = useCallback(
    async (target: number, total: number, lineOffset: number) => {
      const range = windowAround(target, total);
      const rows = await fetchRange(adapter, bookId, range.from, range.to);
      let idx = indexOfLine(rows, target);
      if (idx < 0) idx = rows.length - 1;
      epochRef.current += 1;
      loadingEdge.current = { forward: false, backward: false };
      settleUntil.current = Date.now() + JUMP_SETTLE_MS;
      commitWin({ rows, range, epoch: epochRef.current, initialIndex: Math.max(0, idx), initialViewOffset: lineOffset - ANCHOR });
      const row = rows[idx];
      if (row) {
        position.current = { currentLineIndex: row.line_index, tocPath: row.toc_path, lineOffset };
        setTopRow({ line: row.line_index, tocPath: row.toc_path });
        scheduleSave();
      }
      return row?.line_index ?? target;
    },
    [adapter, bookId, scheduleSave, commitWin],
  );

  const jumpTo = useCallback(
    async (line: number, withHighlight: boolean) => {
      const total = totalLines;
      if (total == null) return;
      const target = Math.min(Math.max(1, line), total);
      const w = winRef.current;
      const idx = w ? indexOfLine(w.rows, target) : -1;
      settleUntil.current = Date.now() + JUMP_SETTLE_MS;
      let landed: number;
      if (w && idx >= 0 && target >= w.range.from && target <= w.range.to && listRef.current) {
        // Place the target on the reading line, just below the breadcrumb bar.
        const row = w.rows[idx];
        landed = row.line_index;
        await listRef.current.scrollToIndex({ index: idx, animated: false, viewOffset: -ANCHOR });
        // The final programmatic scroll does not always emit onScroll: record the position here.
        position.current = { currentLineIndex: row.line_index, tocPath: row.toc_path, lineOffset: 0 };
        setTopRow({ line: row.line_index, tocPath: row.toc_path });
        scheduleSave();
      } else {
        landed = await loadAround(target, total, 0);
      }
      showHeader(true);
      if (withHighlight) setHighlight({ line: landed, nonce: Date.now() });
    },
    [totalLines, loadAround, showHeader, scheduleSave],
  );

  // Initial load: book size, then the window around the pending jump or saved position.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const book = await db.getFirstAsync<{ total_lines: number }>('SELECT total_lines FROM books WHERE id = ?', [bookId]);
        if (!alive) return;
        if (!book) throw new Error('הספר לא נמצא');
        setTotalLines(book.total_lines);
        const pj = useTabs.getState().pendingJump;
        if (pj && pj.tabId === tabId) {
          consumeJump(pj.nonce);
          const landed = await loadAround(pj.line, book.total_lines, 0);
          if (alive && pj.highlight) setHighlight({ line: landed, nonce: pj.nonce });
        } else {
          const saved = useTabs.getState().tabs.find((t) => t.tabId === tabId);
          await loadAround(saved?.currentLineIndex ?? 1, book.total_lines, saved?.lineOffset ?? 0);
        }
      } catch (e) {
        console.error(e);
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // Mount-only: the reader is keyed by tab id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jump requests arriving while this tab is open (TOC, Quick Jump to an open book).
  useEffect(() => {
    if (!pendingJump || totalLines == null || !winRef.current) return;
    consumeJump(pendingJump.nonce);
    jumpTo(pendingJump.line, pendingJump.highlight);
  }, [pendingJump, totalLines, consumeJump, jumpTo]);

  // Highlight lasts 2 seconds.
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS + 100);
    return () => clearTimeout(t);
  }, [highlight]);

  const extend = useCallback(
    async (direction: 'forward' | 'backward') => {
      const total = totalLines;
      if (total == null || loadingEdge.current[direction]) return;
      loadingEdge.current[direction] = true;
      const epoch = epochRef.current;
      try {
        // Skip over runs of empty lines (no paragraphs) until something loads or the book ends.
        for (let guard = 0; guard < 20; guard++) {
          const w = winRef.current;
          if (!w || w.epoch !== epoch) return;
          const chunk = nextChunk(w.range, direction, total);
          if (!chunk) return;
          const rows = await fetchRange(adapter, bookId, chunk.from, chunk.to);
          if (epochRef.current !== epoch || !winRef.current) return;
          const merged = mergeChunk(winRef.current.rows, winRef.current.range, rows, chunk, direction);
          commitWin({ ...winRef.current, rows: merged.rows, range: merged.range });
          if (rows.length) return;
        }
      } finally {
        if (epochRef.current === epoch) loadingEdge.current[direction] = false;
      }
    },
    [adapter, bookId, totalLines, commitWin],
  );

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const dy = y - lastY.current;
    lastY.current = y;
    if (y < BREADCRUMB_HEIGHT || Date.now() < settleUntil.current) showHeader(true);
    else if (dy > 6) showHeader(false);
    else if (dy < -6) showHeader(true);

    const list = listRef.current;
    const w = winRef.current;
    if (!list || !w || !w.rows.length) return;
    // Row under the reading line (content coordinates, excluding the list header). A couple of
    // px of tolerance so a row placed exactly on the line by a jump counts as the current one.
    const lineY = y - list.getFirstItemOffset() + ANCHOR;
    const anchorY = lineY + 2;
    let i = Math.max(0, list.getFirstVisibleIndex());
    let layout = list.getLayout(i);
    while (layout && i < w.rows.length - 1 && layout.y + layout.height <= anchorY) layout = list.getLayout(++i);
    const row = w.rows[i];
    if (!row || !layout) return;
    const lineOffset = Math.max(0, Math.round(lineY - layout.y));
    const prev = position.current;
    if (prev.currentLineIndex !== row.line_index) setTopRow({ line: row.line_index, tocPath: row.toc_path });
    if (prev.currentLineIndex !== row.line_index || prev.lineOffset !== lineOffset) {
      position.current = { currentLineIndex: row.line_index, tocPath: row.toc_path, lineOffset };
      scheduleSave();
    }
  };

  const renderItem = useCallback(
    ({ item }: { item: ParagraphRow }) => (
      <ParagraphView row={item} typo={typo} highlightNonce={highlight && highlight.line === item.line_index ? highlight.nonce : 0} />
    ),
    [typo, highlight],
  );

  const crumbs = topRow.tocPath ? topRow.tocPath.split(' > ') : [];

  return (
    <View style={[styles.root, { backgroundColor: palette.background }]}>
      {error ? (
        <Text style={[styles.message, { color: palette.danger }]}>{error}</Text>
      ) : !win ? (
        <ActivityIndicator style={{ marginTop: spacing.xl * 2 }} color={palette.accent} />
      ) : (
        <FlashList
          key={win.epoch}
          ref={listRef}
          data={win.rows}
          extraData={renderItem}
          keyExtractor={(r) => String(r.line_index)}
          getItemType={(r) => (r.is_heading ? 'h' : 'p')}
          renderItem={renderItem}
          initialScrollIndex={win.initialIndex}
          initialScrollIndexParams={{ viewOffset: win.initialViewOffset }}
          drawDistance={Math.max(600, estimatedItemSize * 6)}
          onEndReached={() => extend('forward')}
          onEndReachedThreshold={1.5}
          onStartReached={() => extend('backward')}
          onStartReachedThreshold={1.5}
          onScroll={onScroll}
          scrollEventThrottle={16}
          ListHeaderComponent={<View style={{ height: BREADCRUMB_HEIGHT + spacing.sm }} />}
          ListFooterComponent={
            totalLines != null && win.range.to >= totalLines ? (
              // Extra room so the last lines can still be scrolled up to the reading line.
              <Text style={[styles.end, { color: palette.textMuted, paddingBottom: Math.round(windowHeight * 0.6) }]}>— סוף הספר —</Text>
            ) : (
              <View style={{ height: 120 }} />
            )
          }
          contentContainerStyle={styles.content}
          testID="reader-list"
        />
      )}

      <Animated.View
        style={[
          styles.breadcrumb,
          { backgroundColor: palette.background, borderBottomColor: palette.border, transform: [{ translateY: headerY }] },
        ]}
      >
        <Pressable
          style={styles.crumbPress}
          onPress={() => {
            flush();
            onOpenToc();
          }}
          accessibilityRole="button"
          accessibilityLabel="פתח תוכן עניינים"
          testID="reader-breadcrumb"
        >
          <Text style={[styles.crumbText, { color: palette.textMuted }]} numberOfLines={1}>
            <Text style={{ color: palette.text, fontWeight: '700' }}>{tab.bookTitle}</Text>
            {crumbs.map((c, i) => (
              <Text key={i} style={i === crumbs.length - 1 ? { color: palette.accent, fontWeight: '600' } : undefined}>
                {'  ‹  ' + c}
              </Text>
            ))}
          </Text>
          <Text style={[styles.crumbIcon, { color: palette.accent }]}>☰</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

interface RowProps {
  row: ParagraphRow;
  typo: Typography;
  /** Non-zero while this row is the highlighted jump target. */
  highlightNonce: number;
}

const ParagraphView = memo(function ParagraphView({ row, typo, highlightNonce }: RowProps) {
  const html = useMemo(() => prepareDisplayText(row.display_text, { showNiqqud: typo.showNiqqud }), [row.display_text, typo.showNiqqud]);
  const [glow] = useState(() => new Animated.Value(0));
  useEffect(() => {
    glow.stopAnimation();
    if (!highlightNonce) {
      glow.setValue(0);
      return;
    }
    glow.setValue(1);
    Animated.timing(glow, { toValue: 0, delay: HIGHLIGHT_MS - 450, duration: 450, useNativeDriver: useNative }).start();
  }, [highlightNonce, glow]);

  const { palette: c } = typo;
  let size = typo.fontSize;
  let headingStyle = null;
  if (row.is_heading) {
    const depth = row.toc_path ? row.toc_path.split(' > ').length : 0; // 0 = book title (h1)
    size = Math.round(typo.fontSize * (depth === 0 ? 1.45 : depth === 1 ? 1.25 : depth === 2 ? 1.12 : 1.05));
    headingStyle = { color: depth === 0 ? c.text : c.accent, marginTop: depth <= 1 ? spacing.lg : spacing.sm, textAlign: depth === 0 ? ('center' as const) : undefined };
  }

  return (
    <View style={styles.row} testID={`para-${row.line_index}`}>
      <Animated.View pointerEvents="none" style={[styles.glow, { backgroundColor: c.highlight, opacity: glow }]} />
      <RichText
        html={html}
        fontSize={size}
        boldFamily={typo.bold}
        style={[
          styles.text,
          {
            color: c.text,
            fontFamily: row.is_heading ? typo.bold : typo.regular,
            fontWeight: row.is_heading && !typo.bold ? '700' : undefined,
            lineHeight: Math.round(size * typo.lineHeight),
          },
          headingStyle,
        ]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: spacing.md },
  row: { paddingVertical: 6, paddingHorizontal: spacing.sm },
  glow: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, borderRadius: 6 },
  text: { writingDirection: 'rtl', textAlign: 'justify' },
  message: { textAlign: 'center', marginTop: spacing.xl, fontSize: 16 },
  end: { textAlign: 'center', paddingVertical: spacing.xl * 2, fontSize: 14 },
  breadcrumb: {
    position: 'absolute',
    top: 0,
    start: 0,
    end: 0,
    height: BREADCRUMB_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  crumbPress: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, gap: spacing.sm, height: '100%' },
  crumbText: { flex: 1, fontSize: 14, writingDirection: 'rtl' },
  crumbIcon: { fontSize: 16 },
});
