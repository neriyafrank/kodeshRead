/**
 * RTL cascading-columns (Miller columns) library browser.
 *
 *   [ ספרים ]  [ תורה ]  [ תנ"ך ]   <- rightmost: root folders
 *   (column 3)  (column 2) (column 1)
 *
 * Tapping a folder highlights it and opens its sub-folders and books in the next column to its
 * LEFT; tapping a folder in any earlier column replaces everything to its left, so siblings are
 * one tap away and the active path stays visible (also as a breadcrumb above). Tapping a book
 * opens it. Columns scroll vertically on their own (FlatList); the strip scrolls horizontally.
 *
 * Layout: ~2 columns on a phone, 3–4 on a tablet (from the measured width). The strip itself is
 * laid out LTR with the columns in reverse order (deepest first), so the newest column is always
 * at scroll offset 0 on every platform (RTL scroll offsets differ between browsers and Android);
 * the column contents are RTL. The selected path is persisted (useLibraryUi.columnPath).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type ScrollViewInstance } from 'react-native';

import { loadCatalog } from '../../shared/sources';
import { useLibrary } from '../db/LibraryContext';
import { LEFT_CHEVRON, alignRight, nativeDir, setWebDir } from '../lib/direction';
import { useLibraryUi } from '../state/libraryStore';
import { BookIcon, FolderIcon } from './Icons';
import { spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';

interface CategoryRow {
  id: number;
  parent_id: number | null;
  name: string;
}
interface BookRow {
  id: number;
  category_id: number | null;
  title: string;
}
interface Catalog {
  byId: Map<number, CategoryRow>;
  childCats: Map<number | null, CategoryRow[]>;
  childBooks: Map<number | null, BookRow[]>;
  /** Books under each folder, recursively. */
  bookCount: Map<number, number>;
}
type Row = { kind: 'category'; key: string; cat: CategoryRow; count: number; hasChildren: boolean } | { kind: 'book'; key: string; book: BookRow };

function buildCatalog(cats: CategoryRow[], books: BookRow[]): Catalog {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const childCats = new Map<number | null, CategoryRow[]>();
  const childBooks = new Map<number | null, BookRow[]>();
  for (const c of cats) childCats.set(c.parent_id, [...(childCats.get(c.parent_id) ?? []), c]);
  for (const b of books) childBooks.set(b.category_id, [...(childBooks.get(b.category_id) ?? []), b]);
  const bookCount = new Map<number, number>();
  const count = (id: number): number => {
    let n = childBooks.get(id)?.length ?? 0;
    for (const c of childCats.get(id) ?? []) n += count(c.id);
    bookCount.set(id, n);
    return n;
  };
  for (const c of childCats.get(null) ?? []) count(c.id);
  return { byId, childCats, childBooks, bookCount };
}

function rowsOf(cat: Catalog, parent: number | null): Row[] {
  const rows: Row[] = [];
  for (const c of cat.childCats.get(parent) ?? []) {
    const n = cat.bookCount.get(c.id) ?? 0;
    if (!n) continue; // empty folders are noise in a browser
    rows.push({ kind: 'category', key: `c${c.id}`, cat: c, count: n, hasChildren: (cat.childCats.get(c.id)?.length ?? 0) + (cat.childBooks.get(c.id)?.length ?? 0) > 0 });
  }
  for (const b of cat.childBooks.get(parent) ?? []) rows.push({ kind: 'book', key: `b${b.id}`, book: b });
  return rows;
}

/** Longest valid prefix of a saved path (folders may have disappeared after a library change). */
function validPath(cat: Catalog, path: number[]): number[] {
  const out: number[] = [];
  let parent: number | null = null;
  for (const id of path) {
    const c = cat.byId.get(id);
    if (!c || c.parent_id !== parent) break;
    out.push(id);
    parent = id;
  }
  return out;
}

/** Columns that fit side by side: 2 on phones, 3 on small tablets, 4 on large screens. */
export function visibleColumnCount(width: number): number {
  if (width >= 1000) return 4;
  if (width >= 680) return 3;
  return 2;
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
  const { adapter, generation } = useLibrary();
  const savedPath = useLibraryUi((x) => x.columnPath);
  const setColumnPath = useLibraryUi((x) => x.setColumnPath);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Core library + personal books ("הספרים שלי"); ids never collide.
      const { categories, books } = await loadCatalog(adapter);
      if (alive) setCatalog(buildCatalog(categories, books));
    })().catch((e) => console.warn('library catalog failed', e));
    return () => {
      alive = false;
    };
  }, [adapter, generation]);

  const path = useMemo(() => (catalog ? validPath(catalog, savedPath) : []), [catalog, savedPath]);
  // One column per level: the root, then the contents of every selected folder.
  const columns = useMemo(() => {
    if (!catalog) return [];
    const parents: (number | null)[] = [null, ...path];
    return parents.map((parent, depth) => ({ depth, parent, rows: rowsOf(catalog, parent) }));
  }, [catalog, path]);

  const select = useCallback(
    (depth: number, id: number) => {
      // Re-tapping the open folder closes everything to its left.
      const next = path[depth] === id ? path.slice(0, depth) : [...path.slice(0, depth), id];
      setColumnPath(next);
    },
    [path, setColumnPath],
  );

  // Reveal the newest (leftmost) column, keeping its parent visible on its right.
  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollTo({ x: 0, animated: true }), 30);
    return () => clearTimeout(t);
  }, [columns.length, path]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const perScreen = visibleColumnCount(width);
  const colWidth = width ? Math.floor(width / perScreen) : 0;

  const crumbs = path.map((id) => catalog?.byId.get(id)?.name ?? '');

  const renderColumn = (col: (typeof columns)[number]) => (
    <View
      key={`col-${col.depth}-${col.parent ?? 'root'}`}
      ref={(n) => setWebDir(n, 'rtl')}
      style={[s.column, nativeDir('rtl'), { width: colWidth }]}
      testID={`library-column-${col.depth}`}
    >
      <Text style={s.columnTitle} numberOfLines={1}>
        {col.parent == null ? 'ספרייה' : catalog?.byId.get(col.parent)?.name}
      </Text>
      <FlatList
        data={col.rows}
        keyExtractor={(r) => r.key}
        initialNumToRender={24}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={s.emptyCol}>אין ספרים בתיקייה זו</Text>}
        renderItem={({ item }) => {
          if (item.kind === 'book') {
            return (
              <Pressable
                onPress={() => onOpenBook(item.book.id, item.book.title)}
                style={({ pressed }) => [s.row, pressed && s.pressed]}
                accessibilityRole="link"
                testID={`tree-book-${item.book.id}`}
              >
                <BookIcon />
                <Text style={s.bookTitle} numberOfLines={2}>
                  {item.book.title}
                </Text>
              </Pressable>
            );
          }
          const active = path[col.depth] === item.cat.id;
          return (
            <Pressable
              onPress={() => select(col.depth, item.cat.id)}
              style={({ pressed }) => [s.row, active && s.rowActive, pressed && s.pressed]}
              accessibilityRole="button"
              aria-selected={active}
              aria-expanded={active}
              testID={`tree-cat-${item.cat.id}`}
            >
              {active ? <View style={s.activeBar} /> : null}
              <FolderIcon open={active} />
              <Text style={[s.catName, active && s.catNameActive, col.depth === 0 && s.catRoot]} numberOfLines={2}>
                {item.cat.name}
              </Text>
              <Text style={[s.count, active && s.catNameActive]}>{item.count}</Text>
              {/* RTL: the next column opens to the left. */}
              <Text style={[s.chevron, active && s.catNameActive]}>{LEFT_CHEVRON}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  );

  return (
    <View style={s.root}>
      {header}
      {path.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.crumbBar} contentContainerStyle={s.crumbs} testID="library-breadcrumb">
          <Pressable onPress={() => setColumnPath([])} hitSlop={6} testID="library-crumb-root">
            <Text style={s.crumb}>ספרייה</Text>
          </Pressable>
          {crumbs.map((name, i) => (
            <View key={path[i]} style={s.crumbItem}>
              <Text style={s.crumbSep}>{LEFT_CHEVRON}</Text>
              <Pressable onPress={() => setColumnPath(path.slice(0, i + 1))} hitSlop={6} testID={`library-crumb-${i}`}>
                <Text style={[s.crumb, i === crumbs.length - 1 && s.crumbLast]} numberOfLines={1}>
                  {name}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={s.strip} onLayout={onLayout}>
        {!catalog ? (
          <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />
        ) : !columns[0]?.rows.length ? (
          emptyText === '' ? null : <Text style={s.empty}>{emptyText ?? 'הספרייה ריקה. הורידו ספרייה או ייבאו ספרים ממסך ״ניהול״.'}</Text>
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
    strip: { flex: 1 },
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
    rowActive: { backgroundColor: c.accentSoft },
    activeBar: { position: 'absolute', start: 0, top: 0, bottom: 0, width: 3, backgroundColor: c.accent },
    pressed: { opacity: 0.7 },
    catName: { flex: 1, fontSize: 16, fontWeight: '600', color: c.text, ...alignRight },
    catRoot: { fontSize: 17, fontWeight: '700' },
    catNameActive: { color: c.accent },
    count: { fontSize: 12, color: c.textMuted },
    chevron: { fontSize: 18, color: c.textMuted, width: 12, textAlign: 'center' },
    bookTitle: { flex: 1, fontSize: 16, color: c.text, ...alignRight },
    emptyCol: { padding: spacing.lg, color: c.textMuted, fontSize: 13, textAlign: 'center' },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: spacing.xl },
    crumbBar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    crumbs: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 6, gap: 4 },
    crumbItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    crumb: { fontSize: 14, color: c.accent, fontWeight: '600', maxWidth: 160 },
    crumbLast: { color: c.text },
    crumbSep: { fontSize: 14, color: c.textMuted },
  });
