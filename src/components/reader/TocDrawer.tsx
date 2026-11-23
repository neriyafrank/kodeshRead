/**
 * Book table of contents as RTL cascading columns (shared/tocColumns.js).
 *
 *   [ פסוק א..לא ]  [ פרק א..נ ]     <- rightmost: top-level divisions
 *
 * Tapping a division highlights it and fills the column to its LEFT with its sub-items (deeper
 * heading levels open further columns). A division without sub-headings but with inline verses
 * ("(א) ..." lines, Otzaria Tanach) opens a verse column. Each column is its own FlatList, so a
 * 176-verse chapter never pushes the other chapters away. Tapping a leaf (or "לתחילת …" atop a
 * column) jumps there.
 *
 * Opens synced to the reading position (current chapter and verse pre-selected and scrolled into
 * view). A filter box jumps by name or gematria ("כה", "25", "סימן שכח", "ב ג" = chapter + verse).
 *
 * Narrow screens: a slide-over drawer that closes after a jump. Wide screens (`docked`): a panel
 * beside the text that stays open.
 *
 * Fit to content: every column is as wide as its widest label (shared/tocColumns.tocColumnWidth,
 * 108-220px), and the drawer / panel is the sum of the open columns (at least MIN_PANEL_WIDTH,
 * at most 85% of a phone screen / 42% of a tablet screen; beyond that the columns scroll). A
 * single-level book gets a single slim column; opening a 2nd / 3rd column widens the drawer
 * (animated) only as much as the new column needs.
 *
 * All labels sit flush against the right edge (`alignRight`, src/lib/direction.ts) with the
 * sub-level arrow "‹" at the left edge.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type ScrollViewInstance } from 'react-native';

import { normalizeHebrew } from '../../../shared/hebrew';
import { inlineUnitWord } from '../../../shared/refAlign';
import {
  buildTocTree,
  fetchInlineVerses,
  filterToc,
  hasChildren,
  nodeEnd,
  nodeTrail,
  pathForLine,
  tocColumnWidth,
  tocColumns,
  tocPanelWidth,
  verseForLine,
  type InlineVerse,
  type TocTree,
} from '../../../shared/tocColumns';
import { useLibrary } from '../../db/LibraryContext';
import { LEFT_CHEVRON, alignRight, nativeDir, setWebDir } from '../../lib/direction';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';
import { SideDrawer } from '../Overlay';

interface TocNode {
  id: number;
  parent_id: number | null;
  level: number;
  title: string;
  ref_key: string;
  start_line: number;
}

interface Props {
  visible: boolean;
  bookId: number;
  bookTitle: string;
  currentLine: number;
  onClose: () => void;
  onSelect: (line: number) => void;
  /** Wide screens: render as a panel beside the text (stays open after a jump). */
  docked?: boolean;
}

const ROW_H = 44;
/** Narrowest drawer / panel: keeps the title, filter box and close button usable. */
export const MIN_PANEL_WIDTH = 200;
/** Widest drawer / panel, as a share of the screen width. */
export const DRAWER_WIDTH_RATIO = 0.85;
export const DOCKED_WIDTH_RATIO = 0.42;

// Row / header metrics, shared by the styles and the width estimate.
const ROW_FONT = 15;
const ROW_CHROME = spacing.md + spacing.sm + spacing.xs + 6; // paddings + gap + slack
const CHEVRON_SPACE = 14;
const HEAD_FONT = 13;
const HEAD_CHROME = spacing.md * 2 + 4;
const DIRECT_CHROME = spacing.sm * 2 + spacing.md * 2 + 6;

export function TocDrawer({ visible, docked, onClose, ...rest }: Props) {
  const s = useThemedStyles(createStyles);
  const { width: screenWidth } = useWindowDimensions();
  // Desired width reported by the columns (null until the TOC is loaded).
  const [fit, setFit] = useState<number | null>(null);
  const cap = Math.floor(screenWidth * (docked ? DOCKED_WIDTH_RATIO : DRAWER_WIDTH_RATIO));
  const width = tocPanelWidth([fit ?? MIN_PANEL_WIDTH], { min: MIN_PANEL_WIDTH, cap });
  if (docked) {
    if (!visible) return null;
    // Docked: the width snaps (animating it would re-wrap the text beside it on every frame).
    return (
      <View style={[s.docked, { width }]} testID="toc-drawer">
        <TocPanel {...rest} cap={cap} onFitWidth={setFit} onClose={onClose} docked />
      </View>
    );
  }
  return (
    <SideDrawer visible={visible} onClose={onClose} testID="toc-drawer" maxWidth={cap} widthRatio={1} width={width}>
      {visible ? <TocPanel {...rest} cap={cap} onFitWidth={setFit} onClose={onClose} /> : null}
    </SideDrawer>
  );
}

type PanelProps = Omit<Props, 'visible'> & { cap: number; onFitWidth: (w: number) => void };

function TocPanel({ bookId, bookTitle, currentLine, onClose, onSelect, cap, onFitWidth, docked }: PanelProps) {
  const s = useThemedStyles(createStyles);
  const { adapter } = useLibrary();
  const [data, setData] = useState<{ bookId: number; tree: TocTree<TocNode>; total: number } | null>(null);

  useEffect(() => {
    if (data?.bookId === bookId) return;
    let alive = true;
    const a = adapter.forBook(bookId);
    Promise.all([
      a.all<TocNode>('SELECT id, parent_id, level, title, ref_key, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [bookId]),
      a.all<{ total_lines: number }>('SELECT total_lines FROM books WHERE id = ?', [bookId]),
    ]).then(([list, b]) => alive && setData({ bookId, tree: buildTocTree(list), total: b[0]?.total_lines ?? 0 }));
    return () => {
      alive = false;
    };
  }, [bookId, adapter, data]);

  const ready = data?.bookId === bookId ? data : null;
  return (
    <View style={s.panel}>
      <View style={s.header}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.kicker}>תוכן עניינים</Text>
          <Text style={s.title} numberOfLines={1}>
            {bookTitle}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="סגור תוכן עניינים" style={s.close} testID="toc-close">
          <Text style={s.closeText}>✕</Text>
        </Pressable>
      </View>
      {!ready ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={s.palette.accent} />
      ) : !ready.tree.roots.length ? (
        <Text style={s.empty}>אין תוכן עניינים לספר זה</Text>
      ) : (
        <TocColumnsView
          key={`${bookId}`}
          bookId={bookId}
          tree={ready.tree}
          total={ready.total}
          currentLine={currentLine}
          cap={cap}
          onFitWidth={onFitWidth}
          onJump={(line) => {
            onSelect(line);
            if (!docked) onClose();
          }}
        />
      )}
    </View>
  );
}

interface ColumnsProps {
  bookId: number;
  tree: TocTree<TocNode>;
  total: number;
  currentLine: number;
  /** Widest the panel may get (px). */
  cap: number;
  /**
   * Reports the width the open columns (or filter results) need; the drawer sizes itself from it.
   * The columns derive the same clamped width in their own render: waiting for it to come back
   * down as a prop would lay the freshly mounted columns out twice (and on the web, hold back a
   * FlatList's first window update).
   */
  onFitWidth: (width: number) => void;
  onJump: (line: number) => void;
}

/** Mounted per open, so its initial selection reflects the current reading position. */
function TocColumnsView({ bookId, tree, total, currentLine, cap, onFitWidth, onJump }: ColumnsProps) {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const { adapter, bookIndex } = useLibrary();
  const categoryPath = bookIndex.books.get(bookId)?.categoryPath;
  const [path, setPath] = useState<number[]>(() => pathForLine(tree, currentLine));
  const [verses, setVerses] = useState<{ nodeId: number; list: InlineVerse[] } | null>(null);
  const [query, setQuery] = useState('');
  const scrollRef = useRef<ScrollViewInstance | null>(null);

  const columns = useMemo(() => tocColumns(tree, path), [tree, path]);
  const deepestId = path[path.length - 1];
  const deepest = deepestId != null ? tree.byId.get(deepestId) : undefined;

  // Inline verses of a selected leaf division (e.g. a Tanach chapter without verse headings).
  // Named like the book does: פסוק (Tanach), סעיף (a סימן / כלל of a halacha book), משנה...
  const versesFor = async (node: TocNode) => fetchInlineVerses(adapter, bookId, node.start_line, nodeEnd(tree, node, total), inlineUnitWord(node.title, categoryPath));
  useEffect(() => {
    if (!deepest || hasChildren(tree, deepest.id) || verses?.nodeId === deepest.id) return;
    let alive = true;
    versesFor(deepest).then((list) => alive && setVerses({ nodeId: deepest.id, list }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepest?.id]);
  const verseList = deepest && verses?.nodeId === deepest.id && verses.list.length ? verses.list : null;
  const currentVerse = verseList && deepest && currentLine >= deepest.start_line && currentLine <= nodeEnd(tree, deepest, total) ? verseForLine(verseList, currentLine) : null;

  // --- fit-to-content widths ---------------------------------------------------------------
  const nodeWidths = useMemo(
    () =>
      columns.map((col) => {
        const parent = col.parentId != null ? tree.byId.get(col.parentId) : undefined;
        return tocColumnWidth(
          col.items.map((n) => n.title),
          {
            fontSize: ROW_FONT,
            chrome: ROW_CHROME,
            branch: col.items.some((n) => hasChildren(tree, n.id)),
            branchSpace: CHEVRON_SPACE,
            header: parent ? `לתחילת ${parent.title}` : null,
            headerFontSize: HEAD_FONT,
            headerChrome: HEAD_CHROME,
          },
        );
      }),
    [columns, tree],
  );
  const verseWidth = useMemo(
    () =>
      verseList && deepest
        ? tocColumnWidth(
            verseList.map((v) => v.title),
            { fontSize: ROW_FONT, chrome: ROW_CHROME, header: `לתחילת ${deepest.title}`, headerFontSize: HEAD_FONT, headerChrome: HEAD_CHROME },
          )
        : 0,
    [verseList, deepest],
  );
  // Display order is LTR with the deepest column first (at the left edge).
  const displayWidths = useMemo(() => [...(verseList ? [verseWidth] : []), ...nodeWidths.slice().reverse()], [verseList, verseWidth, nodeWidths]);
  const columnsWidth = displayWidths.reduce((a, b) => a + b, 0);
  const width = tocPanelWidth([columnsWidth], { min: MIN_PANEL_WIDTH, cap });
  // A panel wider than the columns (its minimum width): the deepest column takes the slack.
  const slack = Math.max(0, width - columnsWidth);
  const widthAt = (displayIndex: number) => displayWidths[displayIndex] + (displayIndex === 0 ? slack : 0);
  const totalCols = displayWidths.length;
  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollTo({ x: 0, animated: true }), 30);
    return () => clearTimeout(t);
  }, [totalCols, deepestId]);

  const tapNode = async (depth: number, node: TocNode) => {
    const next = [...path.slice(0, depth), node.id];
    if (hasChildren(tree, node.id)) return setPath(next);
    // A leaf: open its verses when it has inline verses, otherwise jump.
    const list = verses?.nodeId === node.id ? verses.list : await versesFor(node);
    if (list.length) {
      setVerses({ nodeId: node.id, list });
      setPath(next);
    } else {
      setPath(next);
      onJump(node.start_line);
    }
  };

  const nodeColumn = (col: (typeof columns)[number]) => {
    const parent = col.parentId != null ? tree.byId.get(col.parentId) : undefined;
    const selectedIndex = Math.max(0, col.items.findIndex((n) => n.id === col.selectedId));
    return (
      <View
        key={`c${col.depth}-${col.parentId ?? 'root'}`}
        ref={(n) => setWebDir(n, 'rtl')}
        style={[s.column, nativeDir('rtl'), { width: widthAt((verseList ? 1 : 0) + columns.length - 1 - col.depth) }]}
        testID={`toc-col-${col.depth}`}
      >
        {parent ? (
          <Pressable onPress={() => onJump(parent.start_line)} style={({ pressed }) => [s.colHead, pressed && s.pressed]} testID="toc-open-section">
            <Text style={s.colHeadText} numberOfLines={1} testID="toc-col-head">
              לתחילת {parent.title}
            </Text>
          </Pressable>
        ) : null}
        <FlatList
          data={col.items}
          keyExtractor={(n) => String(n.id)}
          getItemLayout={(_, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
          initialScrollIndex={col.selectedId != null ? Math.max(0, selectedIndex - 2) : 0}
          initialNumToRender={30}
          windowSize={9}
          renderItem={({ item }) => {
            const active = item.id === col.selectedId;
            const branch = hasChildren(tree, item.id);
            return (
              <Pressable
                onPress={() => tapNode(col.depth, item)}
                style={({ pressed }) => [s.row, active && s.rowActive, pressed && s.pressed]}
                aria-selected={active}
                accessibilityRole={branch ? 'button' : 'link'}
                testID={`toc-node-${item.id}`}
              >
                {active ? <View style={s.activeBar} /> : null}
                <Text style={[s.nodeTitle, active && s.nodeActive]} numberOfLines={1} testID="toc-label">
                  {item.title}
                </Text>
                {branch ? (
                  <Text style={[s.chevron, active && s.nodeActive]} testID="toc-chevron">
                    {LEFT_CHEVRON}
                  </Text>
                ) : null}
              </Pressable>
            );
          }}
        />
      </View>
    );
  };

  const verseColumn = () => {
    if (!verseList || !deepest) return null;
    const idx = currentVerse ? verseList.indexOf(currentVerse) : -1;
    return (
      <View key={`v${deepest.id}`} ref={(n) => setWebDir(n, 'rtl')} style={[s.column, nativeDir('rtl'), { width: widthAt(0) }]} testID={`toc-col-${columns.length}`}>
        <Pressable onPress={() => onJump(deepest.start_line)} style={({ pressed }) => [s.colHead, pressed && s.pressed]} testID="toc-open-section">
          <Text style={s.colHeadText} numberOfLines={1} testID="toc-col-head">
            לתחילת {deepest.title}
          </Text>
        </Pressable>
        <FlatList
          data={verseList}
          keyExtractor={(v) => String(v.line)}
          getItemLayout={(_, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
          initialScrollIndex={Math.max(0, idx - 2)}
          initialNumToRender={30}
          renderItem={({ item }) => {
            const active = item === currentVerse;
            return (
              <Pressable onPress={() => onJump(item.line)} style={({ pressed }) => [s.row, active && s.rowActive, pressed && s.pressed]} aria-selected={active} accessibilityRole="link" testID={`toc-verse-${item.line}`}>
                {active ? <View style={s.activeBar} /> : null}
                <Text style={[s.nodeTitle, active && s.nodeActive]} numberOfLines={1} testID="toc-label">
                  {item.title}
                </Text>
              </Pressable>
            );
          }}
        />
      </View>
    );
  };

  // --- quick filter ---------------------------------------------------------------------
  const results = useMemo(() => (query.trim() ? filterToc(tree, query, 120) : []), [tree, query]);
  const [direct, setDirect] = useState<{ query: string; title: string; line: number } | null>(null);
  useEffect(() => {
    // "ב ג" / "פרק ב פסוק ג": a division, then a sub-item or inline verse inside it.
    const tokens = normalizeHebrew(query, { keepAmud: true, keepPunctuation: false }).split(' ').filter(Boolean);
    // (A stale result is ignored at render time: it carries the query it answered.)
    if (tokens.length < 2) return;
    let alive = true;
    (async () => {
      const half = Math.floor(tokens.length / 2);
      const first = filterToc(tree, tokens.slice(0, half).join(' '), 20).find((n) => n.parent_id == null || tree.byId.get(n.parent_id) == null) ?? null;
      if (!first) return alive && setDirect(null);
      const second = tokens.slice(half).join(' ');
      const kids = tree.children.get(first.id) ?? [];
      const child = kids.length ? filterToc({ ...tree, roots: kids, children: new Map([[null, kids]]) }, second, 5)[0] : undefined;
      if (child) return alive && setDirect({ query, title: nodeTrail(tree, child.id).join(' › '), line: child.start_line });
      const vs = await versesFor(first);
      const key = normalizeHebrew(second, { keepPunctuation: false }).replace(/^(פסוק|סעיפ|סעיף|משנה|אות) /, '');
      const asNum = /^\d+$/.test(key) ? vs[Number(key) - 1] : vs.find((v) => v.key === key);
      if (alive) setDirect(asNum ? { query, title: `${first.title} › ${asNum.title}`, line: asNum.line } : null);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tree]);

  // While filtering, fit the result trails ("פרק כז › פסוק טו") instead of the columns.
  const showDirect = !!direct && direct.query === query;
  const filterWidth = useMemo(() => {
    if (!query.trim()) return 0;
    const rows = tocColumnWidth(
      results.map((n) => nodeTrail(tree, n.id).join(' › ')),
      { fontSize: ROW_FONT, chrome: ROW_CHROME, max: Infinity },
    );
    const directW = showDirect && direct ? tocColumnWidth([`מעבר: ${direct.title}`], { fontSize: ROW_FONT, chrome: DIRECT_CHROME, max: Infinity }) : 0;
    return Math.max(rows, directW);
  }, [query, results, tree, showDirect, direct]);
  const fit = query.trim() ? filterWidth : columnsWidth;
  useEffect(() => {
    if (fit > 0) onFitWidth(fit);
  }, [fit, onFitWidth]);

  return (
    <View style={{ flex: 1 }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="קפיצה: כה, 25, ב ג…"
        placeholderTextColor={c.textMuted}
        style={s.filter}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="go"
        onSubmitEditing={() => (direct ? onJump(direct.line) : results[0] && onJump(results[0].start_line))}
        testID="toc-filter"
      />
      {query.trim() ? (
        <FlatList
          data={results}
          keyExtractor={(n) => String(n.id)}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            showDirect && direct ? (
              <Pressable onPress={() => onJump(direct.line)} style={({ pressed }) => [s.direct, pressed && s.pressed]} testID="toc-filter-direct">
                <Text style={s.directText} numberOfLines={1}>
                  מעבר: {direct.title}
                </Text>
              </Pressable>
            ) : undefined
          }
          ListEmptyComponent={showDirect ? undefined : <Text style={s.empty}>לא נמצא</Text>}
          renderItem={({ item }) => (
            <Pressable onPress={() => onJump(item.start_line)} style={({ pressed }) => [s.row, pressed && s.pressed]} testID={`toc-result-${item.id}`}>
              <Text style={s.nodeTitle} numberOfLines={1} testID="toc-label">
                {nodeTrail(tree, item.id).join(' › ')}
              </Text>
            </Pressable>
          )}
        />
      ) : (
        <ScrollView
          ref={(n) => {
            scrollRef.current = n;
            setWebDir(n, 'ltr');
          }}
          horizontal
          style={nativeDir('ltr')}
          showsHorizontalScrollIndicator={columnsWidth > width}
          contentContainerStyle={[s.columns, nativeDir('ltr'), { minWidth: width }]}
          testID="toc-columns"
        >
          {/* Deepest column first: LTR order puts it at the left edge, the top level at the right. */}
          {verseColumn()}
          {columns.slice().reverse().map(nodeColumn)}
        </ScrollView>
      )}
    </View>
  );
}

const createStyles = (c: Palette) => ({
  palette: c,
  ...StyleSheet.create({
    docked: { borderEndWidth: StyleSheet.hairlineWidth, borderEndColor: c.border, backgroundColor: c.surface },
    panel: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    kicker: { fontSize: 12, color: c.textMuted, ...alignRight },
    title: { fontSize: 18, fontWeight: '700', color: c.text, ...alignRight },
    close: { padding: spacing.sm },
    closeText: { fontSize: 16, color: c.textMuted },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: spacing.xl },
    filter: {
      margin: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
      fontSize: 15,
      color: c.text,
      ...alignRight,
    },
    columns: { flexDirection: 'row', justifyContent: 'flex-end', flexGrow: 1 },
    column: { borderStartWidth: StyleSheet.hairlineWidth, borderStartColor: c.border },
    colHead: { paddingHorizontal: spacing.md, paddingVertical: 8, backgroundColor: c.surfaceMuted, alignItems: 'stretch' },
    colHeadText: { fontSize: HEAD_FONT, fontWeight: '700', color: c.accent, ...alignRight },
    row: {
      height: ROW_H,
      flexDirection: 'row',
      alignItems: 'center',
      paddingStart: spacing.md,
      paddingEnd: spacing.sm,
      gap: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowActive: { backgroundColor: c.accentSoft },
    activeBar: { position: 'absolute', start: 0, top: 0, bottom: 0, width: 3, backgroundColor: c.accent },
    pressed: { opacity: 0.6 },
    // flex: 1 fills the row from the right edge up to the "‹" indicator, which sits at the left.
    nodeTitle: { flex: 1, minWidth: 0, fontSize: ROW_FONT, color: c.text, ...alignRight },
    nodeActive: { color: c.accent, fontWeight: '700' },
    chevron: { fontSize: 17, color: c.textMuted, width: CHEVRON_SPACE - 4, textAlign: 'center' },
    direct: { margin: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: c.accent },
    directText: { color: c.surface, fontSize: ROW_FONT, fontWeight: '700', ...alignRight },
  }),
});
