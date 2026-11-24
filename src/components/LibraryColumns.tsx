/**
 * Main library browser: RTL cascading columns (Miller columns) over the canonical catalog
 * (shared/libraryCatalog.js), in the traditional Jewish order, not the raw Otzaria folders.
 *
 *   [ ספרים ]  [ תנ"ך ]  [ תורה ]   <- rightmost: top sections (תנ"ך, משנה, תלמוד בבלי, ...)
 *
 * A segmented switch at the top chooses the view:
 *   ספרי בסיס          sections -> sub-sections -> base books only. A book with commentaries has a
 *                      just the book icon and its full title (no action pills);
 *   מפרשים לפי ספר     the base books that have commentaries (same sections); selecting one opens
 *                      all of its commentaries together (ראשונים / אחרונים / תרגומים alike) in
 *                      canonical rank order (רש"י, תוספות, רמב"ן, ...). "מפרשים כלליים" lists the
 *                      commentaries that name no single base book.
 * A live filter (abbreviation aware: שו"ע או"ח, ב"ק) flattens either view into a result list.
 *
 * Tapping a section highlights it and opens its contents in the next column to its LEFT; tapping a
 * section in an earlier column replaces everything to its left. Columns scroll vertically on their
 * own (FlatList); the strip scrolls horizontally, laid out LTR with the columns in reverse order
 * (deepest first) so the newest column is at scroll offset 0 on every platform (RTL scroll offsets
 * differ between browsers and Android); the column contents are RTL. Mode and path persist
 * (useLibraryUi.catalogMode / catalogPath).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type ScrollViewInstance } from 'react-native';

import { filterTree, titleMatches, type CatalogNode, type LibraryCatalog } from '../../shared/libraryCatalog';
import { useLibraryCatalog } from '../db/useLibraryCatalog';
import { LEFT_CHEVRON, alignRight, inputAlignRight, nativeDir, setWebDir } from '../lib/direction';
import { useLibraryUi } from '../state/libraryStore';
import { BookIcon, FolderIcon } from './Icons';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';

type Mode = 'base' | 'comm';

type Row =
  | { kind: 'section'; key: string; node: CatalogNode }
  | { kind: 'book'; key: string; node: CatalogNode }
  | { kind: 'commentary'; key: string; bookId: number; title: string; name: string; tier: string; leaf: boolean }
  | { kind: 'open-base'; key: string; bookId: number; title: string };

interface Column {
  depth: number;
  /** Node id of the selected parent (null: root). */
  parent: string | null;
  title: string;
  rows: Row[];
}

const rowOf = (n: CatalogNode): Row => (n.kind === 'section' ? { kind: 'section', key: n.id, node: n } : n.kind === 'commentary' ? leafRow(n) : { kind: 'book', key: n.id, node: n });
const leafRow = (n: CatalogNode): Row => ({ kind: 'commentary', key: n.id, bookId: n.bookId ?? 0, title: n.title ?? n.name, name: n.title ?? n.name, tier: '', leaf: true });

/** Columns that fit side by side: 2 on phones, 3 on small tablets, 4 on large screens. */
export function visibleColumnCount(width: number): number {
  if (width >= 1000) return 4;
  if (width >= 680) return 3;
  return 2;
}

/** node id -> ids from the root down to (and including) it. */
function indexPaths(nodes: CatalogNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (list: CatalogNode[], prefix: string[]) => {
    for (const n of list) {
      const p = [...prefix, n.id];
      out.set(n.id, p);
      if (n.kind === 'section' && n.children) walk(n.children, p);
    }
  };
  walk(nodes, []);
  return out;
}

/** Longest valid prefix of a saved path, and its columns. */
function buildColumns(catalog: LibraryCatalog, mode: Mode, saved: string[]): { columns: Column[]; path: string[] } {
  const tree = mode === 'base' ? catalog.sections : catalog.commentarySections;
  const columns: Column[] = [{ depth: 0, parent: null, title: 'ספרייה', rows: tree.map(rowOf) }];
  const path: string[] = [];
  let nodes = tree;
  for (const id of saved) {
    const node = nodes.find((n) => n.id === id);
    if (!node) break;
    if (node.kind === 'section' && node.children) {
      path.push(id);
      columns.push({ depth: path.length, parent: id, title: node.name, rows: node.children.map(rowOf) });
      nodes = node.children;
    } else if (node.kind === 'book' && mode === 'comm' && node.bookId != null) {
      path.push(id);
      const rows: Row[] = [{ kind: 'open-base', key: 'open-' + node.id, bookId: node.bookId, title: node.title ?? node.name }];
      for (const c of catalog.commentariesOf(node.bookId)) rows.push({ kind: 'commentary', key: 'c' + c.bookId, bookId: c.bookId, title: c.title, name: c.name, tier: c.tier, leaf: false });
      columns.push({ depth: path.length, parent: id, title: `מפרשים על ${node.title ?? node.name}`, rows });
      break;
    } else break;
  }
  return { columns, path };
}

interface Props {
  onOpenBook: (bookId: number, title: string) => void;
  header?: ReactElement;
  /** Text when the library is empty ('' = none). */
  emptyText?: string;
}

export function LibraryColumns({ onOpenBook, header, emptyText }: Props) {
  const colors = useAppTheme();
  const s = useThemedStyles(createStyles);
  const catalog = useLibraryCatalog();
  const mode = useLibraryUi((x) => x.catalogMode);
  const savedPath = useLibraryUi((x) => x.catalogPath);
  const setMode = useLibraryUi((x) => x.setCatalogMode);
  const setPath = useLibraryUi((x) => x.setCatalogPath);
  const showCatalog = useLibraryUi((x) => x.showCatalog);
  const [filter, setFilter] = useState('');
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<ScrollViewInstance>(null);

  const { columns, path } = useMemo(() => (catalog ? buildColumns(catalog, mode, savedPath) : { columns: [] as Column[], path: [] as string[] }), [catalog, mode, savedPath]);
  const commPaths = useMemo(() => (catalog ? indexPaths(catalog.commentarySections) : new Map<string, string[]>()), [catalog]);

  /** Filtered results: a flat list of matching books (with their section), in canonical order. */
  const results = useMemo(() => {
    if (!catalog || !filter.trim()) return null;
    const tree = mode === 'base' ? catalog.sections : catalog.commentarySections;
    const extra = mode === 'comm' ? (n: CatalogNode) => n.kind === 'book' && n.bookId != null && catalog.commentariesOf(n.bookId).some((c) => titleMatches(filter, c.name, c.categoryPath ?? undefined)) : undefined;
    const out: { row: Row; where: string }[] = [];
    const walk = (list: CatalogNode[], where: string[]) => {
      for (const n of list) {
        if (n.kind === 'section' && n.children) walk(n.children, [...where, n.name]);
        else out.push({ row: rowOf(n), where: where.join(' › ') });
      }
    };
    walk(filterTree(tree, filter, extra), []);
    return out;
  }, [catalog, filter, mode]);

  const select = useCallback(
    (depth: number, id: string) => {
      // Re-tapping the open node closes everything to its left.
      setPath(path[depth] === id ? path.slice(0, depth) : [...path.slice(0, depth), id]);
    },
    [path, setPath],
  );

  // Reveal the newest (leftmost) column, keeping its parent visible on its right.
  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollTo({ x: 0, animated: true }), 30);
    return () => clearTimeout(t);
  }, [columns.length, path]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const perScreen = visibleColumnCount(width);
  const colWidth = width ? Math.floor(width / perScreen) : 0;

  const nameOf = (id: string) => {
    const col = columns.find((c) => c.parent === id);
    return col ? col.title.replace(/^מפרשים על /, '') : id;
  };

  const renderRow = (row: Row, depth: number, where?: string) => {
    if (row.kind === 'section') {
      const active = path[depth] === row.node.id;
      return (
        <Pressable
          onPress={() => select(depth, row.node.id)}
          style={({ pressed }) => [s.row, active && s.rowActive, pressed && s.pressed]}
          accessibilityRole="button"
          aria-selected={active}
          aria-expanded={active}
          testID={`tree-sec-${row.node.id}`}
        >
          {active ? <View style={s.activeBar} /> : null}
          <FolderIcon open={active} />
          <Text style={[s.catName, active && s.catNameActive, depth === 0 && s.catRoot]} numberOfLines={2}>
            {row.node.name}
          </Text>
          <Text style={[s.count, active && s.catNameActive]}>{row.node.count}</Text>
          {/* RTL: the next column opens to the left. */}
          <Text style={[s.chevron, active && s.catNameActive]}>{LEFT_CHEVRON}</Text>
        </Pressable>
      );
    }
    if (row.kind === 'book') {
      const n = row.node;
      const bookId = n.bookId ?? 0;
      const cc = n.commentaryCount ?? 0;
      if (mode === 'comm') {
        const active = path[depth] === n.id;
        return (
          <Pressable
            onPress={() => {
              setFilter('');
              if (where != null) showCatalog('comm', commPaths.get(n.id) ?? [n.id]);
              else select(depth, n.id);
            }}
            style={({ pressed }) => [s.row, active && s.rowActive, pressed && s.pressed]}
            accessibilityRole="button"
            aria-selected={active}
            testID={`tree-book-${bookId}`}
          >
            {active ? <View style={s.activeBar} /> : null}
            <BookIcon />
            <View style={s.flex}>
              <Text style={[s.bookTitle, active && s.catNameActive]} numberOfLines={2}>
                {n.title}
              </Text>
              {where ? <Text style={s.where} numberOfLines={1}>{where}</Text> : null}
            </View>
            <Text style={[s.count, active && s.catNameActive]}>{cc}</Text>
            <Text style={[s.chevron, active && s.catNameActive]}>{LEFT_CHEVRON}</Text>
          </Pressable>
        );
      }
      return (
        <View style={s.row}>
          <Pressable onPress={() => onOpenBook(bookId, n.title ?? n.name)} style={({ pressed }) => [s.rowMain, pressed && s.pressed]} accessibilityRole="link" testID={`tree-book-${bookId}`}>
            <BookIcon />
            <View style={s.flex}>
              <Text style={s.bookTitle} numberOfLines={2}>
                {n.title}
              </Text>
              {where ? <Text style={s.where} numberOfLines={1}>{where}</Text> : null}
            </View>
          </Pressable>
        </View>
      );
    }
    if (row.kind === 'open-base') {
      return (
        <Pressable onPress={() => onOpenBook(row.bookId, row.title)} style={({ pressed }) => [s.row, s.openBase, pressed && s.pressed]} accessibilityRole="link" testID={`tree-open-base-${row.bookId}`}>
          <BookIcon />
          <Text style={[s.catName, s.catNameActive]} numberOfLines={2}>
            {`פתח את ${row.title}`}
          </Text>
        </Pressable>
      );
    }
    return (
      <Pressable onPress={() => onOpenBook(row.bookId, row.title)} style={({ pressed }) => [s.row, pressed && s.pressed]} accessibilityRole="link" testID={`tree-commentary-${row.bookId}`}>
        <BookIcon />
        <View style={s.flex}>
          <Text style={s.bookTitle} numberOfLines={2}>
            {row.leaf ? row.title : row.name}
          </Text>
          {!row.leaf && row.title !== row.name ? <Text style={s.where} numberOfLines={1}>{row.title}</Text> : null}
        </View>
        {row.tier ? (
          <Text style={[s.tier, row.tier === 'עיקריים' && s.tierCore]} numberOfLines={1}>
            {row.tier}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  const renderColumn = (col: Column) => (
    <View key={`col-${col.depth}-${col.parent ?? 'root'}`} ref={(n) => setWebDir(n, 'rtl')} style={[s.column, nativeDir('rtl'), { width: colWidth }]} testID={`library-column-${col.depth}`}>
      <Text style={s.columnTitle} numberOfLines={1}>
        {col.title}
      </Text>
      <FlatList
        data={col.rows}
        keyExtractor={(r) => r.key}
        initialNumToRender={24}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={s.emptyCol}>אין ספרים בתיקייה זו</Text>}
        renderItem={({ item }) => renderRow(item, col.depth)}
      />
    </View>
  );

  const libraryEmpty = !!catalog && !catalog.sections.length && !catalog.commentarySections.length;

  return (
    <View style={s.root}>
      {header}
      <View style={s.tools}>
        <View style={s.segment} accessibilityRole="tablist">
          {(
            [
              ['base', 'ספרי בסיס'],
              ['comm', 'מפרשים לפי ספר'],
            ] as const
          ).map(([m, label]) => (
            <Pressable
              key={m}
              onPress={() => {
                setFilter('');
                if (m !== mode) setMode(m);
              }}
              style={[s.segBtn, mode === m && s.segBtnOn]}
              accessibilityRole="tab"
              aria-selected={mode === m}
              testID={`library-mode-${m}`}
            >
              <Text style={[s.segText, mode === m && s.segTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={s.filterRow}>
          <TextInput
            value={filter}
            onChangeText={setFilter}
            placeholder={mode === 'base' ? 'סינון ספרים: שו״ע או״ח, ב״ק, רמב״ם…' : 'סינון ספרים ומפרשים: רש״י, תוספות…'}
            placeholderTextColor={colors.textMuted}
            style={s.filter}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel="סינון הספרייה"
            testID="library-filter"
          />
          {filter ? (
            <Pressable onPress={() => setFilter('')} hitSlop={10} style={s.filterClear} accessibilityLabel="נקה סינון" testID="library-filter-clear">
              <Text style={s.clearText}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {path.length && !results ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.crumbBar} contentContainerStyle={s.crumbs} testID="library-breadcrumb">
          <Pressable onPress={() => setPath([])} hitSlop={6} testID="library-crumb-root">
            <Text style={s.crumb}>ספרייה</Text>
          </Pressable>
          {path.map((id, i) => (
            <View key={id} style={s.crumbItem}>
              <Text style={s.crumbSep}>{LEFT_CHEVRON}</Text>
              <Pressable onPress={() => setPath(path.slice(0, i + 1))} hitSlop={6} testID={`library-crumb-${i}`}>
                <Text style={[s.crumb, i === path.length - 1 && s.crumbLast]} numberOfLines={1}>
                  {nameOf(id)}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={s.strip} onLayout={onLayout}>
        {!catalog ? (
          <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />
        ) : libraryEmpty ? (
          emptyText === '' ? null : <Text style={s.empty}>{emptyText ?? 'הספרייה ריקה. הורידו ספרייה או ייבאו ספרים ממסך ״ניהול״.'}</Text>
        ) : results ? (
          <FlatList
            data={results}
            keyExtractor={(r) => r.row.key}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={s.emptyCol} testID="library-filter-empty">לא נמצאו ספרים</Text>}
            renderItem={({ item }) => renderRow(item.row, 0, item.where || 'ספרייה')}
            testID="library-results"
          />
        ) : colWidth ? (
          <ScrollView
            ref={(n) => {
              scrollRef.current = n;
              setWebDir(n, 'ltr');
            }}
            horizontal
            style={nativeDir('ltr')}
            contentContainerStyle={[s.columns, nativeDir('ltr'), { minWidth: width }]}
            showsHorizontalScrollIndicator
            testID="library-columns"
          >
            {/* Deepest column first: LTR order puts it at the left edge, the root at the right. */}
            {columns.slice().reverse().map(renderColumn)}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    strip: { flex: 1 },
    tools: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.sm },
    segment: { flexDirection: 'row', backgroundColor: c.surfaceMuted, borderRadius: radius.md, padding: 3, gap: 3 },
    segBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 36, borderRadius: radius.md - 3 },
    segBtnOn: { backgroundColor: c.accent },
    segText: { fontSize: 14, fontWeight: '600', color: c.textMuted },
    segTextOn: { color: c.background, fontWeight: '700' },
    filterRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, paddingStart: spacing.md, paddingEnd: spacing.sm },
    filter: { flex: 1, minHeight: 40, fontSize: 15, color: c.text, paddingVertical: 6, ...inputAlignRight },
    filterClear: { padding: spacing.sm },
    clearText: { fontSize: 15, color: c.textMuted },
    columns: { flexDirection: 'row', justifyContent: 'flex-end', flexGrow: 1 },
    column: { borderStartWidth: StyleSheet.hairlineWidth, borderStartColor: c.border, backgroundColor: c.background },
    columnTitle: {
      fontSize: 12,
      fontWeight: '700',
      color: c.textMuted,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      backgroundColor: c.surfaceMuted,
      ...alignRight,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 48,
      paddingStart: spacing.md,
      paddingEnd: spacing.sm,
      paddingVertical: 6,
      gap: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'stretch', minHeight: 36 },
    rowActive: { backgroundColor: c.accentSoft },
    openBase: { backgroundColor: c.surfaceMuted },
    activeBar: { position: 'absolute', start: 0, top: 0, bottom: 0, width: 3, backgroundColor: c.accent },
    pressed: { opacity: 0.7 },
    catName: { flex: 1, fontSize: 16, fontWeight: '600', color: c.text, ...alignRight },
    catRoot: { fontSize: 17, fontWeight: '700' },
    catNameActive: { color: c.accent },
    count: { fontSize: 12, color: c.textMuted },
    chevron: { fontSize: 18, color: c.textMuted, width: 12, textAlign: 'center' },
    bookTitle: { fontSize: 16, color: c.text, ...alignRight },
    where: { fontSize: 11, color: c.textMuted, ...alignRight },
    tier: { fontSize: 10, color: c.textMuted, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingHorizontal: 6, paddingVertical: 1 },
    tierCore: { color: c.accent, borderColor: c.accent },
    emptyCol: { padding: spacing.lg, color: c.textMuted, fontSize: 13, textAlign: 'center' },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: spacing.xl },
    crumbBar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    crumbs: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 6, gap: 4 },
    crumbItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    crumb: { fontSize: 14, color: c.accent, fontWeight: '600', maxWidth: 160 },
    crumbLast: { color: c.text },
    crumbSep: { fontSize: 14, color: c.textMuted },
  });
