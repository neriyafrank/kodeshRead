/**
 * Search Scope Filter: Entire Library, a Category/Folder (category_path LIKE
 * 'folder/%', i.e. the folder and all its sub-folders) or a single Book.
 *
 * The tree is ids + names only (small even for the full library). Folders are
 * collapsible; typing in the filter box shows a flat list of matching folders
 * and books instead.
 */
import { FlashList } from '@shopify/flash-list';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { normalizeHebrew } from '../../../shared/hebrew';
import type { SearchScope } from '../../../shared/search';
import { loadCatalog } from '../../../shared/sources';
import { useLibrary } from '../../db/LibraryContext';
import { selectActiveTab, useTabs } from '../../state/tabsStore';
import { BookIcon, FolderIcon } from '../Icons';
import { BottomSheet } from '../Overlay';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';

interface CatRow {
  id: number;
  parent_id: number | null;
  name: string;
  path: string;
}
interface BookRow {
  id: number;
  category_id: number | null;
  title: string;
}

type Row =
  | { kind: 'all'; key: string }
  | { kind: 'category'; key: string; depth: number; cat: CatRow; hasChildren: boolean; expanded: boolean }
  | { kind: 'book'; key: string; depth: number; book: BookRow; folder?: string };

const INDENT = 16;
const norm = (s: string) => normalizeHebrew(s, { keepPunctuation: false });

interface Props {
  visible: boolean;
  scope: SearchScope;
  onSelect: (scope: SearchScope) => void;
  onClose: () => void;
}

export function ScopeSheet({ visible, scope, onSelect, onClose }: Props) {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const { height } = useWindowDimensions();
  const { adapter, generation } = useLibrary();
  const activeTab = useTabs(selectActiveTab);
  const [data, setData] = useState<{ cats: CatRow[]; books: BookRow[]; generation: number } | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!visible || data?.generation === generation) return;
    let alive = true;
    (async () => {
      const { categories, books } = await loadCatalog(adapter);
      if (alive) setData({ cats: categories, books, generation });
    })().catch((e) => console.warn('scope catalog failed', e));
    return () => {
      alive = false;
    };
  }, [visible, data, adapter, generation]);

  // Folders leading to the current scope start open (user toggles override).
  const scopeAncestors = useMemo(() => {
    const open = new Set<number>();
    if (!data) return open;
    const byId = new Map(data.cats.map((x) => [x.id, x]));
    let start: number | null = null;
    if (scope.kind === 'category') start = data.cats.find((x) => x.path === scope.path)?.parent_id ?? null;
    else if (scope.kind === 'book') start = data.books.find((b) => b.id === scope.bookId)?.category_id ?? null;
    for (let id = start; id != null; id = byId.get(id)?.parent_id ?? null) open.add(id);
    return open;
  }, [data, scope]);
  const isExpanded = useCallback((id: number) => expanded[id] ?? scopeAncestors.has(id), [expanded, scopeAncestors]);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const out: Row[] = [{ kind: 'all', key: 'all' }];
    const f = norm(filter);
    const catPath = new Map(data.cats.map((x) => [x.id, x.path]));
    if (f) {
      for (const cat of data.cats) if (norm(cat.name).includes(f)) out.push({ kind: 'category', key: `c${cat.id}`, depth: 0, cat, hasChildren: false, expanded: false });
      for (const book of data.books)
        if (norm(book.title).includes(f))
          out.push({ kind: 'book', key: `b${book.id}`, depth: 0, book, folder: book.category_id != null ? catPath.get(book.category_id) : undefined });
      return out;
    }
    const childCats = new Map<number | null, CatRow[]>();
    const childBooks = new Map<number | null, BookRow[]>();
    for (const x of data.cats) childCats.set(x.parent_id, [...(childCats.get(x.parent_id) ?? []), x]);
    for (const b of data.books) childBooks.set(b.category_id, [...(childBooks.get(b.category_id) ?? []), b]);
    const visit = (parent: number | null, depth: number) => {
      for (const cat of childCats.get(parent) ?? []) {
        const isOpen = isExpanded(cat.id);
        out.push({ kind: 'category', key: `c${cat.id}`, depth, cat, hasChildren: true, expanded: isOpen });
        if (isOpen) visit(cat.id, depth + 1);
      }
      for (const book of childBooks.get(parent) ?? []) out.push({ kind: 'book', key: `b${book.id}`, depth, book });
    };
    visit(null, 0);
    return out;
  }, [data, isExpanded, filter]);

  const isSelected = (r: Row) =>
    (r.kind === 'all' && scope.kind === 'all') ||
    (r.kind === 'category' && scope.kind === 'category' && scope.path === r.cat.path) ||
    (r.kind === 'book' && scope.kind === 'book' && scope.bookId === r.book.id);

  const pick = (next: SearchScope) => {
    onSelect(next);
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} testID="scope-sheet">
      <View style={s.header}>
        <Text style={s.title}>היקף החיפוש</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="סגור">
          <Text style={s.close}>✕</Text>
        </Pressable>
      </View>
      {activeTab ? (
        <Pressable
          onPress={() => pick({ kind: 'book', bookId: activeTab.bookId, title: activeTab.bookTitle })}
          style={({ pressed }) => [s.chip, pressed && s.pressed]}
          accessibilityRole="button"
          testID="scope-open-book"
        >
          <BookIcon />
          <Text style={s.chipText} numberOfLines={1}>
            בספר הפתוח: {activeTab.bookTitle}
          </Text>
        </Pressable>
      ) : null}
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder="סינון תיקיות וספרים…"
        placeholderTextColor={c.textMuted}
        style={s.filter}
        autoCorrect={false}
        testID="scope-filter"
      />
      <View style={{ height: height * 0.5 }}>
        <FlashList
          data={rows}
          keyExtractor={(r) => r.key}
          getItemType={(r) => r.kind}
          extraData={scope}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const selected = isSelected(item);
            if (item.kind === 'all')
              return (
                <Pressable onPress={() => pick({ kind: 'all' })} style={({ pressed }) => [s.row, selected && s.selected, pressed && s.pressed]} testID="scope-all">
                  <Text style={[s.rowText, s.bold]}>כל הספרייה</Text>
                  {selected ? <Text style={s.check}>✓</Text> : null}
                </Pressable>
              );
            if (item.kind === 'category')
              return (
                <View style={[s.row, selected && s.selected, { paddingStart: spacing.md + item.depth * INDENT }]}>
                  {item.hasChildren ? (
                    <Pressable
                      onPress={() => setExpanded((e) => ({ ...e, [item.cat.id]: !isExpanded(item.cat.id) }))}
                      hitSlop={8}
                      style={s.chevronBtn}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: item.expanded }}
                      accessibilityLabel={item.expanded ? 'כווץ' : 'הרחב'}
                      testID={`scope-toggle-${item.cat.id}`}
                    >
                      <Text style={s.chevron}>{item.expanded ? '▾' : '◂'}</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => pick({ kind: 'category', path: item.cat.path, name: item.cat.name })}
                    style={({ pressed }) => [s.rowMain, pressed && s.pressed]}
                    accessibilityRole="button"
                    testID={`scope-cat-${item.cat.id}`}
                  >
                    <FolderIcon open={item.expanded} />
                    <Text style={[s.rowText, s.bold]} numberOfLines={1}>
                      {filter ? item.cat.path.replace(/\//g, ' › ') : item.cat.name}
                    </Text>
                    {selected ? <Text style={s.check}>✓</Text> : null}
                  </Pressable>
                </View>
              );
            return (
              <Pressable
                onPress={() => pick({ kind: 'book', bookId: item.book.id, title: item.book.title })}
                style={({ pressed }) => [s.row, selected && s.selected, pressed && s.pressed, { paddingStart: spacing.md + item.depth * INDENT + 26 }]}
                accessibilityRole="button"
                testID={`scope-book-${item.book.id}`}
              >
                <BookIcon />
                <Text style={s.rowText} numberOfLines={1}>
                  {item.book.title}
                  {item.folder ? <Text style={s.muted}>{'  ' + item.folder.replace(/\//g, ' › ')}</Text> : null}
                </Text>
                {selected ? <Text style={s.check}>✓</Text> : null}
              </Pressable>
            );
          }}
        />
      </View>
    </BottomSheet>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    close: { fontSize: 18, color: c.textMuted },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.accentSoft,
    },
    chipText: { flex: 1, color: c.accent, fontSize: 15, fontWeight: '600', writingDirection: 'rtl' },
    filter: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceMuted,
      color: c.text,
      fontSize: 16,
      writingDirection: 'rtl',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 46,
      paddingStart: spacing.md,
      paddingEnd: spacing.lg,
      gap: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'stretch' },
    rowText: { flex: 1, fontSize: 16, color: c.text, writingDirection: 'rtl' },
    bold: { fontWeight: '600' },
    muted: { fontSize: 13, color: c.textMuted, fontWeight: '400' },
    chevronBtn: { width: 22, alignItems: 'center' },
    chevron: { fontSize: 13, color: c.textMuted },
    check: { color: c.accent, fontSize: 16, fontWeight: '700' },
    selected: { backgroundColor: c.accentSoft },
    pressed: { opacity: 0.7 },
  });
