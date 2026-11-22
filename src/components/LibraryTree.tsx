/**
 * Collapsible, indented RTL library tree (categories -> books).
 *
 * The whole tree structure is small (ids + names only, no book text), so it is
 * loaded once; only the *visible* rows are flattened and handed to FlashList,
 * which keeps it fast for the full Otzaria library (thousands of books).
 */
import { FlashList } from '@shopify/flash-list';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { useLibrary } from '../db/LibraryContext';
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

interface TreeData {
  childCats: Map<number | null, CategoryRow[]>;
  childBooks: Map<number | null, BookRow[]>;
  /** Total books under each category (recursive). */
  bookCount: Map<number, number>;
}

type VisibleRow =
  | { kind: 'category'; key: string; depth: number; cat: CategoryRow; expanded: boolean; count: number }
  | { kind: 'book'; key: string; depth: number; book: BookRow };

const INDENT = 18;

function buildTree(cats: CategoryRow[], books: BookRow[]): TreeData {
  const childCats = new Map<number | null, CategoryRow[]>();
  const childBooks = new Map<number | null, BookRow[]>();
  for (const c of cats) {
    const list = childCats.get(c.parent_id) ?? [];
    list.push(c);
    childCats.set(c.parent_id, list);
  }
  for (const b of books) {
    const list = childBooks.get(b.category_id) ?? [];
    list.push(b);
    childBooks.set(b.category_id, list);
  }
  const bookCount = new Map<number, number>();
  const count = (id: number): number => {
    let n = childBooks.get(id)?.length ?? 0;
    for (const c of childCats.get(id) ?? []) n += count(c.id);
    bookCount.set(id, n);
    return n;
  };
  for (const c of childCats.get(null) ?? []) count(c.id);
  return { childCats, childBooks, bookCount };
}

function flatten(tree: TreeData, expanded: Record<number, true>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const visit = (parent: number | null, depth: number) => {
    for (const cat of tree.childCats.get(parent) ?? []) {
      const isOpen = !!expanded[cat.id];
      rows.push({ kind: 'category', key: `c${cat.id}`, depth, cat, expanded: isOpen, count: tree.bookCount.get(cat.id) ?? 0 });
      if (isOpen) visit(cat.id, depth + 1);
    }
    for (const book of tree.childBooks.get(parent) ?? []) rows.push({ kind: 'book', key: `b${book.id}`, depth, book });
  };
  visit(null, 0);
  return rows;
}

interface Props {
  onOpenBook: (bookId: number, title: string) => void;
  header?: ReactElement;
}

export function LibraryTree({ onOpenBook, header }: Props) {
  const colors = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const { db } = useLibrary();
  const expanded = useLibraryUi((s) => s.expanded);
  const toggle = useLibraryUi((s) => s.toggle);
  const [tree, setTree] = useState<TreeData | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [cats, books] = await Promise.all([
        db.getAllAsync<CategoryRow>('SELECT id, parent_id, name FROM categories ORDER BY id'),
        db.getAllAsync<BookRow>('SELECT id, category_id, title FROM books ORDER BY id'),
      ]);
      if (alive) setTree(buildTree(cats, books));
    })();
    return () => {
      alive = false;
    };
  }, [db]);

  const rows = useMemo(() => (tree ? flatten(tree, expanded) : []), [tree, expanded]);

  return (
    <FlashList
      data={rows}
      keyExtractor={(r) => r.key}
      getItemType={(r) => r.kind}
      ListHeaderComponent={header}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={
        tree ? <Text style={styles.empty}>הספרייה ריקה</Text> : <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />
      }
      renderItem={({ item }) =>
        item.kind === 'category' ? (
          <Pressable
            onPress={() => toggle(item.cat.id)}
            style={({ pressed }) => [styles.row, { paddingStart: spacing.lg + item.depth * INDENT }, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityState={{ expanded: item.expanded }}
            testID={`tree-cat-${item.cat.id}`}
          >
            {/* RTL: a collapsed folder's chevron points left (toward the content). */}
            <Text style={styles.chevron}>{item.expanded ? '▾' : '◂'}</Text>
            <FolderIcon open={item.expanded} />
            <Text style={[styles.catName, item.depth === 0 && styles.catRoot]} numberOfLines={1}>
              {item.cat.name}
            </Text>
            <Text style={styles.count}>{item.count}</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => onOpenBook(item.book.id, item.book.title)}
            style={({ pressed }) => [styles.row, { paddingStart: spacing.lg + item.depth * INDENT + 20 }, pressed && styles.pressed]}
            accessibilityRole="link"
            testID={`tree-book-${item.book.id}`}
          >
            <BookIcon />
            <Text style={styles.bookTitle} numberOfLines={1}>
              {item.book.title}
            </Text>
          </Pressable>
        )
      }
    />
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 46,
    paddingEnd: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  pressed: { backgroundColor: colors.accentSoft },
  chevron: { width: 14, fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  catName: { flex: 1, fontSize: 17, color: colors.text, fontWeight: '600', writingDirection: 'rtl' },
  catRoot: { fontSize: 18, fontWeight: '700' },
  count: { fontSize: 13, color: colors.textMuted, minWidth: 20, textAlign: 'center' },
  bookTitle: { flex: 1, fontSize: 17, color: colors.text, writingDirection: 'rtl' },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.xl },
});
