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
  tocColumns,
  verseForLine,
  type InlineVerse,
  type TocTree,
} from '../../../shared/tocColumns';
import { useLibrary } from '../../db/LibraryContext';
import { LEFT_CHEVRON, nativeDir, setWebDir } from '../../lib/direction';
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
/** Width of the docked panel. */
export const DOCKED_TOC_WIDTH = 440;

export function TocDrawer({ visible, docked, onClose, ...rest }: Props) {
  const s = useThemedStyles(createStyles);
  if (docked) {
    if (!visible) return null;
    return (
      <View style={[s.docked, { width: DOCKED_TOC_WIDTH }]} testID="toc-drawer">
        <TocPanel {...rest} width={DOCKED_TOC_WIDTH} onClose={onClose} docked />
      </View>
    );
  }
  return (
    <SideDrawer visible={visible} onClose={onClose} testID="toc-drawer" maxWidth={560} widthRatio={0.94}>
      {visible ? <DrawerBody {...rest} onClose={onClose} /> : null}
    </SideDrawer>
  );
}

function DrawerBody(props: Omit<Props, 'visible' | 'docked'>) {
  const { width } = useWindowDimensions();
  return <TocPanel {...props} width={Math.min(560, width * 0.94)} />;
}

function TocPanel({ bookId, bookTitle, currentLine, onClose, onSelect, width, docked }: Omit<Props, 'visible'> & { width: number }) {
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
        <View style={{ flex: 1 }}>
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
          width={width}
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
  width: number;
  onJump: (line: number) => void;
}

/** Mounted per open, so its initial selection reflects the current reading position. */
function TocColumnsView({ bookId, tree, total, currentLine, width, onJump }: ColumnsProps) {
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

  // Two columns side by side in a drawer, three on wide panels; the newest column is revealed.
  const perScreen = width >= 700 ? 3 : 2;
  const colW = Math.floor(width / perScreen);
  const totalCols = columns.length + (verseList ? 1 : 0);
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
      <View key={`c${col.depth}-${col.parentId ?? 'root'}`} ref={(n) => setWebDir(n, 'rtl')} style={[s.column, nativeDir('rtl'), { width: colW }]} testID={`toc-col-${col.depth}`}>
        {parent ? (
          <Pressable onPress={() => onJump(parent.start_line)} style={({ pressed }) => [s.colHead, pressed && s.pressed]} testID="toc-open-section">
            <Text style={s.colHeadText} numberOfLines={1}>
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
                <Text style={[s.nodeTitle, active && s.nodeActive]} numberOfLines={1}>
                  {item.title}
                </Text>
                {branch ? <Text style={[s.chevron, active && s.nodeActive]}>{LEFT_CHEVRON}</Text> : null}
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
      <View key={`v${deepest.id}`} ref={(n) => setWebDir(n, 'rtl')} style={[s.column, nativeDir('rtl'), { width: colW }]} testID={`toc-col-${columns.length}`}>
        <Pressable onPress={() => onJump(deepest.start_line)} style={({ pressed }) => [s.colHead, pressed && s.pressed]} testID="toc-open-section">
          <Text style={s.colHeadText} numberOfLines={1}>
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
                <Text style={[s.nodeTitle, active && s.nodeActive]}>{item.title}</Text>
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

  return (
    <View style={{ flex: 1 }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="קפיצה: פרק / סימן / דף (כה, 25, ב ג)…"
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
            direct && direct.query === query ? (
              <Pressable onPress={() => onJump(direct.line)} style={({ pressed }) => [s.direct, pressed && s.pressed]} testID="toc-filter-direct">
                <Text style={s.directText} numberOfLines={1}>
                  מעבר: {direct.title}
                </Text>
              </Pressable>
            ) : undefined
          }
          ListEmptyComponent={direct && direct.query === query ? undefined : <Text style={s.empty}>לא נמצא</Text>}
          renderItem={({ item }) => (
            <Pressable onPress={() => onJump(item.start_line)} style={({ pressed }) => [s.row, pressed && s.pressed]} testID={`toc-result-${item.id}`}>
              <Text style={s.nodeTitle} numberOfLines={1}>
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
    kicker: { fontSize: 12, color: c.textMuted },
    title: { fontSize: 18, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
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
      writingDirection: 'rtl',
      textAlign: 'right',
    },
    columns: { flexDirection: 'row', justifyContent: 'flex-end', flexGrow: 1 },
    column: { borderStartWidth: StyleSheet.hairlineWidth, borderStartColor: c.border },
    colHead: { paddingHorizontal: spacing.md, paddingVertical: 8, backgroundColor: c.surfaceMuted },
    colHeadText: { fontSize: 13, fontWeight: '700', color: c.accent, textAlign: 'right', writingDirection: 'rtl' },
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
    nodeTitle: { flex: 1, fontSize: 15, color: c.text, textAlign: 'right', writingDirection: 'rtl' },
    nodeActive: { color: c.accent, fontWeight: '700' },
    chevron: { fontSize: 17, color: c.textMuted },
    direct: { margin: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: c.accent },
    directText: { color: c.surface, fontSize: 15, fontWeight: '700', textAlign: 'right', writingDirection: 'rtl' },
  }),
});
