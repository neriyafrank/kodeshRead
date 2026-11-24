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
 * - Typography (shared/typography.js): the line height grows with the visible marks (niqqud /
 *   te'amim) so stacked marks never touch the neighbouring lines, Android keeps the font
 *   padding, and leading verse / seif numbers "(א)" sit in a subtle margin column.
 * - Paragraphs with entries in `links` open the commentary drawer when tapped (counts are fetched
 *   with each window chunk; there is no count badge), docked under the text as a resizable split
 *   view and synchronized to it.
 * - Chumash books (בראשית..דברים) get subtle centered parsha / aliyah dividers above the verse
 *   each one starts at (shared/torahParshiot.js). They are drawn outside the paragraph rows'
 *   press targets and change no stored line, index or link.
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
  type ViewStyle,
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
import { attachLinkCounts, fetchLinkCounts } from '../../../shared/commentary';
import { lineHeightMultiplier, splitVerseMarker, verseGutterWidth } from '../../../shared/typography';
import { formatCopy } from '../../../shared/copyFormat';
import { markTerms } from '../../../shared/search';
import { parallelMember } from '../../../shared/parallelWorks';
import type { LineDivider } from '../../../shared/torahParshiot';
import { useLibrary } from '../../db/LibraryContext';
import { readerFont } from '../../fonts';
import { useChumashBook, useChumashDividers } from '../../services/parshiotNav';
import { useSettings } from '../../state/settingsStore';
import { useTabs, type ReaderTab } from '../../state/tabsStore';
import { spacing, useAppTheme, type Palette } from '../../theme';
import { RichText } from '../RichText';
import { CommentaryPane, commentaryPaneHeight } from './CommentaryPane';
import { ParagraphToolbar, useCopyMode, useCopyToast } from './CopyToolbar';

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

/** A window row plus the number of linked commentaries/links on that line. */
type ReaderRow = ParagraphRow & { link_count: number };

interface WindowState {
  rows: ReaderRow[];
  range: LineRange;
  /** Bumped on every re-centre; remounts the list with a fresh initialScrollIndex. */
  epoch: number;
  initialIndex: number;
  initialViewOffset: number;
}

interface Typography {
  fontSize: number;
  /** Effective multiplier (slider + room for the visible marks). */
  lineHeight: number;
  regular: string | undefined;
  bold: string | undefined;
  showNikkud: boolean;
  showCantillation: boolean;
  palette: Palette;
}

interface Props {
  tab: ReaderTab;
  onOpenToc: () => void;
}

export function BookReader({ tab, onOpenToc }: Props) {
  const { adapter } = useLibrary();
  const palette = useAppTheme();
  const fontSize = useSettings((s) => s.fontSize);
  const lineHeight = useSettings((s) => s.lineHeight);
  const fontFamily = useSettings((s) => s.fontFamily);
  const showNikkud = useSettings((s) => s.showNikkud);
  const showCantillation = useSettings((s) => s.showCantillation);
  const updatePosition = useTabs((s) => s.updatePosition);
  const openBook = useTabs((s) => s.openBook);
  const commentaryFollow = useSettings((s) => s.commentaryFollow);
  const commentaryRatio = useSettings((s) => s.commentaryRatio);
  const consumeJump = useTabs((s) => s.consumeJump);
  const pendingJump = useTabs((s) => (s.pendingJump?.tabId === tab.tabId ? s.pendingJump : null));

  const { tabId, bookId } = tab;
  const { height: windowHeight } = useWindowDimensions();
  const [totalLines, setTotalLines] = useState<number | null>(null);
  const [win, setWin] = useState<WindowState | null>(null);
  // `end`: last highlighted line when a whole unit (commentary block / verse) is the target.
  const [highlight, setHighlight] = useState<{ line: number; end?: number; nonce: number; terms?: string[] } | null>(null);
  const [topRow, setTopRow] = useState<{ line: number; tocPath: string | null }>({ line: tab.currentLineIndex, tocPath: tab.tocPath });
  const [error, setError] = useState<string | null>(null);
  /** Paragraph the commentary drawer is showing (null = drawer closed). */
  const [selected, setSelected] = useState<{ line: number; tocPath: string | null } | null>(null);
  const [areaHeight, setAreaHeight] = useState(0);
  const [resizing, setResizing] = useState(false);
  const listHeight = useRef(0);
  // Parsha / aliyah dividers (Chumash books only; null elsewhere).
  const chumash = useChumashBook(bookId, tab.bookTitle);
  const dividers = useChumashDividers(bookId, chumash);

  const listRef = useRef<FlashListRef<ReaderRow>>(null);
  const winRef = useRef<WindowState | null>(null);
  const commitWin = useCallback((next: WindowState) => {
    winRef.current = next;
    setWin(next);
  }, []);
  const loadingEdge = useRef({ forward: false, backward: false });
  const epochRef = useRef(0);

  // --- typography -----------------------------------------------------------
  const font = readerFont(fontFamily);
  const effectiveLineHeight = lineHeightMultiplier(lineHeight, { showNikkud, showCantillation });
  const typo = useMemo<Typography>(
    () => ({ fontSize, lineHeight: effectiveLineHeight, regular: font.regular, bold: font.bold, showNikkud, showCantillation, palette }),
    [fontSize, effectiveLineHeight, font.regular, font.bold, showNikkud, showCantillation, palette],
  );
  const estimatedItemSize = estimateItemSize(fontSize, effectiveLineHeight);

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
      Animated.timing(headerY, { toValue: show ? 0 : -BREADCRUMB_HEIGHT - 2, duration: 180, useNativeDriver: useNative, isInteraction: false }).start();
    },
    [headerY],
  );


  // --- window loading -----------------------------------------------------------
  /** Paragraphs [from, to] with their link counts (one indexed query each). */
  const loadRows = useCallback(
    async (from: number, to: number): Promise<ReaderRow[]> => {
      const [rows, counts] = await Promise.all([fetchRange(adapter, bookId, from, to), fetchLinkCounts(adapter, bookId, from, to)]);
      return attachLinkCounts(rows, counts);
    },
    [adapter, bookId],
  );

  /** Re-centre the window on `target`, `lineOffset` px into that row at the reading line. */
  const loadAround = useCallback(
    async (target: number, total: number, lineOffset: number) => {
      const range = windowAround(target, total);
      const rows = await loadRows(range.from, range.to);
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
    [loadRows, scheduleSave, commitWin],
  );

  const jumpTo = useCallback(
    async (line: number, withHighlight: boolean, terms?: string[], end?: number) => {
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
      if (withHighlight) setHighlight({ line: landed, end: end != null && end > landed ? end : undefined, nonce: Date.now(), terms });
    },
    [totalLines, loadAround, showHeader, scheduleSave],
  );

  // Initial load: book size, then the window around the pending jump or saved position.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [book] = await adapter.forBook(bookId).all<{ total_lines: number }>('SELECT total_lines FROM books WHERE id = ?', [bookId]);
        if (!alive) return;
        if (!book) throw new Error('הספר לא נמצא');
        setTotalLines(book.total_lines);
        const pj = useTabs.getState().pendingJump;
        if (pj && pj.tabId === tabId) {
          consumeJump(pj.nonce);
          const landed = await loadAround(pj.line, book.total_lines, 0);
          if (alive && pj.highlight) setHighlight({ line: landed, end: pj.highlightEnd != null && pj.highlightEnd > landed ? pj.highlightEnd : undefined, nonce: pj.nonce, terms: pj.terms });
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
    jumpTo(pendingJump.line, pendingJump.highlight, pendingJump.terms, pendingJump.highlightEnd);
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
          const rows = await loadRows(chunk.from, chunk.to);
          if (epochRef.current !== epoch || !winRef.current) return;
          const merged = mergeChunk(winRef.current.rows, winRef.current.range, rows, chunk, direction);
          commitWin({ ...winRef.current, rows: merged.rows, range: merged.range });
          if (rows.length) return;
        }
      } finally {
        if (epochRef.current === epoch) loadingEdge.current[direction] = false;
      }
    },
    [loadRows, totalLines, commitWin],
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
    if (prev.currentLineIndex !== row.line_index) {
      setTopRow({ line: row.line_index, tocPath: row.toc_path });
      if (followRef.current) followReadingLine(w.rows, i);
    }
    if (prev.currentLineIndex !== row.line_index || prev.lineOffset !== lineOffset) {
      position.current = { currentLineIndex: row.line_index, tocPath: row.toc_path, lineOffset };
      scheduleSave();
    }
  };

  // --- commentary drawer --------------------------------------------------------------
  // A book of a parallel family (טור / שו"ע / ערוך השולחן, משנה / בבלי / ירושלמי, חומש / מדרש רבה ...)
  // opens the drawer from any paragraph: its parallel סימן / פרק / פרשה is shown even without commentaries.
  const parallelRef = useRef(false);
  useEffect(() => {
    let alive = true;
    parallelRef.current = false;
    parallelMember(adapter, bookId).then(
      (m) => {
        if (alive) parallelRef.current = !!m;
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [adapter, bookId]);
  const selectedLine = selected?.line ?? null;
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedLine;
  const followRef = useRef(commentaryFollow);
  followRef.current = commentaryFollow && selectedLine != null;

  /** Follow mode: show the first paragraph with links at/after the reading line (a few rows ahead). */
  const followReadingLine = useCallback((rows: ReaderRow[], from: number) => {
    for (let j = from; j < Math.min(rows.length, from + 6); j++) {
      const r = rows[j];
      if (r.link_count > 0) {
        if (selectedRef.current !== r.line_index) setSelected({ line: r.line_index, tocPath: r.toc_path });
        return;
      }
    }
  }, []);

  /** Keep the selected paragraph visible above the drawer (it may now cover it). */
  const revealRow = useCallback((line: number) => {
    requestAnimationFrame(() => {
      const list = listRef.current;
      const w = winRef.current;
      if (!list || !w) return;
      const idx = indexOfLine(w.rows, line);
      const layout = idx >= 0 ? list.getLayout(idx) : undefined;
      if (!layout || !listHeight.current) return;
      const top = layout.y + list.getFirstItemOffset() - lastY.current;
      const bottom = top + layout.height;
      if (top < ANCHOR || bottom > listHeight.current) {
        settleUntil.current = Date.now() + JUMP_SETTLE_MS;
        list.scrollToIndex({ index: idx, animated: true, viewOffset: -ANCHOR });
      }
    });
  }, []);

  // Long-press toolbar: copy a paragraph (with / without citation) or select several / part of the text.
  const copyMode = useCopyMode();
  const copyToast = useCopyToast();
  const rowsRef = useRef<ReaderRow[]>([]);
  rowsRef.current = win?.rows ?? [];
  const typoRef = useRef(typo);
  typoRef.current = typo;
  const copyItems = (keys: string[]) => {
    const want = new Set(keys);
    return rowsRef.current
      .filter((r) => want.has(String(r.line_index)))
      .map((r) => ({
        bookTitle: tab.bookTitle,
        tocPath: r.toc_path,
        html: prepareDisplayText(r.display_text, { showNikkud: typoRef.current.showNikkud, showCantillation: typoRef.current.showCantillation }),
      }));
  };
  const copyKeys = copyMode.state.mode === 'actions' ? [copyMode.state.key] : copyMode.state.mode === 'select' ? copyMode.state.keys : [];
  const doCopy = (citation: boolean) => {
    void copyToast.copy(formatCopy(copyItems(copyKeys), { citation }));
    copyMode.reset();
  };
  const onLongPressRow = useCallback(
    (row: ReaderRow) => {
      const key = String(row.line_index);
      if (copyMode.ref.current.mode === 'select') copyMode.rangeTo(key, rowsRef.current.map((r) => String(r.line_index)));
      else copyMode.openActions(key);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [copyMode.rangeTo, copyMode.openActions],
  );

  const onPressRow = useCallback((row: ReaderRow) => {
    // While copying: a tap toggles a paragraph into the selection (select mode) or just dismisses the toolbar.
    const cm = copyMode.ref.current.mode;
    if (cm === 'select') return copyMode.toggle(String(row.line_index));
    if (cm === 'actions') return copyMode.reset();
    const open = selectedRef.current != null;
    if (open && selectedRef.current === row.line_index) {
      setSelected(null); // tapping the selected paragraph again closes the drawer
      return;
    }
    if (row.link_count > 0 || open || (parallelRef.current && !row.is_heading)) {
      setSelected({ line: row.line_index, tocPath: row.toc_path });
      if (!open) setTimeout(() => revealRow(row.line_index), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRow, copyMode.toggle, copyMode.reset]);

  /** Neighbouring paragraph with links inside the loaded window. */
  const linkedNeighbour = (dir: 1 | -1): ReaderRow | null => {
    const rows = win?.rows;
    if (!rows || selectedLine == null) return null;
    let i = indexOfLine(rows, selectedLine);
    if (i < 0) return null;
    for (i += dir; i >= 0 && i < rows.length; i += dir) if (rows[i].link_count > 0) return rows[i];
    return null;
  };
  const prevLinked = linkedNeighbour(-1);
  const nextLinked = linkedNeighbour(1);
  const stepTo = (row: ReaderRow | null) => {
    if (!row) return;
    setSelected({ line: row.line_index, tocPath: row.toc_path });
    jumpTo(row.line_index, false);
  };

  const renderItem = useCallback(
    ({ item }: { item: ReaderRow }) => (
      <ParagraphView
        row={item}
        typo={typo}
        selected={item.line_index === selectedLine}
        divider={dividers?.get(item.line_index)}
        onPress={onPressRow}
        onLongPress={onLongPressRow}
        marked={copyMode.marked(String(item.line_index))}
        selectable={copyMode.selecting}
        highlightNonce={highlight && item.line_index >= highlight.line && item.line_index <= (highlight.end ?? highlight.line) ? highlight.nonce : 0}
        highlightTerms={highlight && highlight.line === item.line_index ? highlight.terms : undefined}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typo, highlight, selectedLine, onPressRow, onLongPressRow, dividers, copyMode.state],
  );

  const crumbs = topRow.tocPath ? topRow.tocPath.split(' > ') : [];

  return (
    <View style={[styles.root, { backgroundColor: palette.background }]} onLayout={(e) => setAreaHeight(e.nativeEvent.layout.height)}>
      <View
        style={[styles.textArea, { marginBottom: selected && areaHeight > 0 ? commentaryPaneHeight(areaHeight, commentaryRatio) : 0 }, resizing && styles.noSelect]}
        onLayout={(e) => (listHeight.current = e.nativeEvent.layout.height)}>
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
          getItemType={(r) => (r.is_heading ? 'h' : dividers?.has(r.line_index) ? 'd' : 'p')}
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
      {copyMode.state.mode !== 'idle' ? (
        <ParagraphToolbar
          style={styles.copyBar}
          info={copyMode.state.mode === 'select' ? `${copyMode.state.keys.length} נבחרו` : null}
          actions={
            copyMode.state.mode === 'select'
              ? [
                  { key: 'cite', label: 'העתק עם ציטוט', onPress: () => doCopy(true), testID: 'copy-with-citation', primary: true },
                  { key: 'plain', label: 'העתק ללא ציטוט', onPress: () => doCopy(false), testID: 'copy-plain' },
                ]
              : [
                  { key: 'cite', label: 'העתק עם ציטוט', onPress: () => doCopy(true), testID: 'copy-with-citation', primary: true },
                  { key: 'plain', label: 'העתק ללא ציטוט', onPress: () => doCopy(false), testID: 'copy-plain' },
                  { key: 'select', label: 'בחירת טקסט', onPress: copyMode.startSelect, testID: 'copy-select' },
                ]
          }
          closeLabel={copyMode.state.mode === 'select' ? 'סיום' : undefined}
          onClose={copyMode.reset}
        />
      ) : null}
      {copyToast.toast}
      </View>

      {selected && areaHeight > 0 ? (
        <CommentaryPane
          bookId={bookId}
          bookTitle={tab.bookTitle}
          line={selected.line}
          tocPath={selected.tocPath}
          areaHeight={areaHeight}
          hasPrev={!!prevLinked}
          hasNext={!!nextLinked}
          onPrev={() => stepTo(prevLinked)}
          onNext={() => stepTo(nextLinked)}
          onClose={() => setSelected(null)}
          onDragging={setResizing}
          onOpenEntry={(e) => {
            flush();
            openBook({ bookId: e.bookId, bookTitle: e.bookTitle }, { line: e.line, highlight: true, highlightEnd: e.endLine });
          }}
        />
      ) : null}
    </View>
  );
}

interface RowProps {
  row: ReaderRow;
  typo: Typography;
  /** The commentary drawer is showing this paragraph. */
  selected: boolean;
  onPress: (row: ReaderRow) => void;
  /** Long-press: the copy toolbar. */
  onLongPress: (row: ReaderRow) => void;
  /** The paragraph is the target / part of the copy selection. */
  marked: boolean;
  /** Copy-selection mode: native text selection inside the paragraph. */
  selectable: boolean;
  /** Non-zero while this row is the highlighted jump target. */
  highlightNonce: number;
  /** Search terms marked inside the row while it is highlighted. */
  highlightTerms?: string[];
  /** Parsha / aliyah starting at this verse (Chumash). */
  divider?: LineDivider;
}

/** Subtle centered marker above a verse: "פרשת וישלח" (with rules) and / or the aliyah ("שני"). */
function TorahDivider({ divider, palette: c, fontSize }: { divider: LineDivider; palette: Palette; fontSize: number }) {
  const line = divider.line;
  return (
    <View pointerEvents="none" style={styles.dividerBox} testID={`torah-divider-${line}`}>
      {divider.parsha ? (
        <View style={styles.dividerRow} accessibilityRole="header" testID={`parsha-divider-${line}`}>
          <View style={[styles.dividerRule, { backgroundColor: c.border }]} />
          <Text style={[styles.parshaText, { color: c.accent, fontSize: Math.max(13, Math.round(fontSize * 0.82)) }]} numberOfLines={1}>
            {divider.parsha}
          </Text>
          <View style={[styles.dividerRule, { backgroundColor: c.border }]} />
        </View>
      ) : null}
      {divider.aliyot.length ? (
        <View style={styles.dividerRow} testID={`aliyah-divider-${line}`}>
          <View style={[styles.aliyahRule, { backgroundColor: c.border }]} />
          <Text style={[styles.aliyahText, { color: c.verseNumber, borderColor: c.border, fontSize: Math.max(11, Math.round(fontSize * 0.62)) }]} numberOfLines={1}>
            {divider.aliyot.join(' · ')}
          </Text>
          <View style={[styles.aliyahRule, { backgroundColor: c.border }]} />
        </View>
      ) : null}
    </View>
  );
}

const ParagraphView = memo(function ParagraphView({ row, typo, selected, onPress, onLongPress, marked, selectable, highlightNonce, highlightTerms, divider }: RowProps) {
  const { html, verse } = useMemo(() => {
    const prepared = prepareDisplayText(row.display_text, { showNikkud: typo.showNikkud, showCantillation: typo.showCantillation });
    // "(א) ..." -> the verse number goes to the margin column, the text keeps a clean edge.
    const split = row.is_heading ? { marker: null, text: prepared } : splitVerseMarker(prepared);
    // The search hit stays marked for the highlight's lifetime (2 s), then the row re-renders plain.
    const body = highlightNonce && highlightTerms?.length ? markTerms(split.text, highlightTerms) : split.text;
    return { html: body, verse: split.marker };
  }, [row.display_text, row.is_heading, typo.showNikkud, typo.showCantillation, highlightNonce, highlightTerms]);
  // Accent at ~35% alpha: stays visible on top of the (highlight-coloured) row glow.
  const markStyle = useMemo(() => ({ backgroundColor: `${typo.palette.accent}59`, borderRadius: 3 }), [typo.palette.accent]);
  const [glow] = useState(() => new Animated.Value(0));
  useEffect(() => {
    glow.stopAnimation();
    if (!highlightNonce) {
      glow.setValue(0);
      return;
    }
    glow.setValue(1);
    // Decorative: as an "interaction" it would hold back every FlatList's rendering (the TOC
    // columns, commentaries) for the whole 2 s highlight.
    Animated.timing(glow, { toValue: 0, delay: HIGHLIGHT_MS - 450, duration: 450, useNativeDriver: useNative, isInteraction: false }).start();
  }, [highlightNonce, glow]);

  const { palette: c } = typo;
  let size = typo.fontSize;
  let headingStyle = null;
  if (row.is_heading) {
    const depth = row.toc_path ? row.toc_path.split(' > ').length : 0; // 0 = book title (h1)
    size = Math.round(typo.fontSize * (depth === 0 ? 1.45 : depth === 1 ? 1.25 : depth === 2 ? 1.12 : 1.05));
    headingStyle = { color: depth === 0 ? c.text : c.accent, marginTop: depth <= 1 ? spacing.lg : spacing.sm, textAlign: depth === 0 ? ('center' as const) : undefined };
  }

  const links = row.link_count;
  const lineHeightPx = Math.ceil(size * typo.lineHeight);
  const text = (
    <RichText
      html={html}
      fontSize={size}
      boldFamily={typo.bold}
      markStyle={markStyle}
      style={[
        styles.text,
        {
          color: c.text,
          fontFamily: row.is_heading ? typo.bold : typo.regular,
          fontWeight: row.is_heading && !typo.bold ? '700' : undefined,
          lineHeight: lineHeightPx,
        },
        headingStyle,
        verse ? styles.verseText : null,
      ]}
      selectable={selectable}
      testID={verse ? `verse-text-${row.line_index}` : undefined}
    />
  );
  const body = (
    <Pressable
      onPress={() => onPress(row)}
      onLongPress={() => onLongPress(row)}
      delayLongPress={450}
      style={[styles.row, selected && { backgroundColor: c.selection }, marked && { backgroundColor: c.accentSoft }]}
      accessibilityHint={links ? `${links} מפרשים` : undefined}
      testID={`para-${row.line_index}`}
    >
      {selected || marked ? <View pointerEvents="none" style={[styles.selectedBar, { backgroundColor: c.accent }]} /> : null}
      <Animated.View pointerEvents="none" style={[styles.glow, { backgroundColor: c.highlight, opacity: glow }]} />
      {verse ? (
        <View style={styles.verseRow}>
          {/*
            The marker gutter spans from the screen's edge (the row reaches back over the list + row padding) to the
            start of the text, and the letter is centred in it both ways: horizontally between the edge and the
            text, vertically on the first line (the box is exactly one line high at the current font size /
            line height, so it follows every setting).
          */}
          <View
            style={[styles.verseGutter, { width: EDGE_INSET + verseGutterWidth(size), height: lineHeightPx }]}
            testID={`verse-gutter-${row.line_index}`}
          >
            <Text
              style={[styles.verseNum, { fontSize: Math.max(11, Math.round(size * 0.58)), lineHeight: Math.ceil(size * 0.58 * 1.25), color: c.verseNumber }]}
              accessibilityLabel={`פסוק ${verse}`}
              testID={`verse-num-${row.line_index}`}
            >
              {verse}
            </Text>
          </View>
          {text}
          {/* Gives the end edge back the inset the row spans (order-based, so it is the same in LTR preview and RTL native). */}
          <View style={{ width: EDGE_INSET }} />
        </View>
      ) : (
        text
      )}
    </Pressable>
  );
  if (!divider) return body;
  return (
    <View>
      <TorahDivider divider={divider} palette={c} fontSize={typo.fontSize} />
      {body}
    </View>
  );
});

/** Screen edge -> paragraph box: list padding + row padding (the verse-marker gutter starts at the edge). */
const EDGE_INSET = spacing.md + spacing.sm;

const styles = StyleSheet.create({
  root: { flex: 1 },
  textArea: { flex: 1 },
  // Web preview: a mouse drag on the drawer grabber must not select (and auto-scroll) the text.
  noSelect: { userSelect: 'none' } as ViewStyle,
  content: { paddingHorizontal: spacing.md },
  copyBar: { position: 'absolute', top: spacing.xs, start: spacing.sm, end: spacing.sm, zIndex: 30 },
  row: { paddingVertical: 6, paddingHorizontal: spacing.sm },
  glow: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, borderRadius: 6 },
  selectedBar: { position: 'absolute', top: 4, bottom: 4, start: -spacing.sm, width: 3, borderRadius: 2 },
  // Android: keep the font's ascent / descent padding so te'amim above the first line and below
  // the last one are never clipped by the text view.
  text: { writingDirection: 'rtl', textAlign: 'justify', includeFontPadding: true },
  // Spans the full screen width (symmetric negative margin = the list + row padding, direction-independent), so the margin letter's
  // gutter starts at the screen edge; the trailing spacer restores the same inset on the other side of the text.
  verseRow: { flexDirection: 'row', alignItems: 'flex-start', marginHorizontal: -EDGE_INSET },
  verseText: { flex: 1, minWidth: 0 },
  // Start-side (right) margin: small, muted sans-serif digits-as-letters, like a printed Chumash.
  verseGutter: { alignItems: 'center', justifyContent: 'center' },
  verseNum: { textAlign: 'center', fontWeight: '600', includeFontPadding: false, fontVariant: ['tabular-nums'] },
  message: { textAlign: 'center', marginTop: spacing.xl, fontSize: 16 },
  // Parsha / aliyah dividers: centered, hairline rules, no effect on the verse rows below.
  dividerBox: { paddingTop: spacing.sm, paddingBottom: 2, gap: 4 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  dividerRule: { flex: 1, height: StyleSheet.hairlineWidth, maxWidth: 140 },
  parshaText: { fontWeight: '700', textAlign: 'center', writingDirection: 'rtl', letterSpacing: 0.3 },
  aliyahRule: { width: 28, height: StyleSheet.hairlineWidth },
  aliyahText: {
    fontWeight: '600',
    textAlign: 'center',
    writingDirection: 'rtl',
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
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
