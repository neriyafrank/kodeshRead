/**
 * Search Scope Picker: a multi-select over the canonical library catalog (shared/libraryCatalog.js,
 * the same tree as the Library screen). Two tabs:
 *   ספרי בסיס          sections -> sub-sections -> base books (traditional order, no commentaries);
 *   פרשנים לפי ספר     base books that have commentaries; a book opens its commentary group, with a
 *                      "כל הפרשנים על [ספר]" row plus every commentary in canonical rank order.
 * Check any mix of books and commentaries, or a whole section with "בחר הכל"; shortcuts add the open
 * book / the open book with all its commentaries. A live filter (abbreviation aware) narrows both
 * tabs. The selection is a draft until "החל": an empty selection means the whole library (כל הספרייה).
 * The result is a `books` scope (shared/search.js): one `book_id IN (...)` query for all of them.
 */
import { FlashList } from '@shopify/flash-list';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { filterTree, titleMatches, treeBookIds, type CatalogNode, type LibraryCatalog } from '../../../shared/libraryCatalog';
import { booksScope, type SearchScope } from '../../../shared/search';
import { useLibraryCatalog } from '../../db/useLibraryCatalog';
import { alignRight, inputAlignRight } from '../../lib/direction';
import { selectActiveTab, useTabs } from '../../state/tabsStore';
import { BookIcon, FolderIcon } from '../Icons';
import { BottomSheet } from '../Overlay';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';

type Tab = 'base' | 'comm';
type Pick = [number, string];

type Row =
  | { kind: 'section'; key: string; node: CatalogNode; depth: number; open: boolean }
  | { kind: 'book'; key: string; id: number; title: string; depth: number; cc: number; expandable: boolean; open: boolean }
  | { kind: 'allcomm'; key: string; baseId: number; title: string; depth: number; count: number }
  | { kind: 'comm'; key: string; id: number; title: string; name: string; tier: string; depth: number }
  | { kind: 'empty'; key: string };

const INDENT = 14;

interface Props {
  visible: boolean;
  scope: SearchScope;
  onSelect: (scope: SearchScope) => void;
  onClose: () => void;
}

/** Ids (+ titles) of every selectable book below a section: base books, or their commentaries. */
function sectionPicks(catalog: LibraryCatalog, node: CatalogNode, tab: Tab): Pick[] {
  if (tab === 'base') return treeBookIds([node]).map((id) => [id, catalog.bookTitle(id)]);
  const out: Pick[] = [];
  const walk = (n: CatalogNode) => {
    if (n.kind === 'section') n.children?.forEach(walk);
    else if (n.kind === 'commentary' && n.bookId != null) out.push([n.bookId, n.title ?? n.name]);
    else if (n.bookId != null) for (const id of catalog.commentaryIds(n.bookId)) out.push([id, catalog.bookTitle(id)]);
  };
  walk(node);
  return out;
}

export function ScopeSheet({ visible, scope, onSelect, onClose }: Props) {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const { height } = useWindowDimensions();
  const catalog = useLibraryCatalog(visible);
  const activeTab = useTabs(selectActiveTab);
  const [tab, setTab] = useState<Tab>('base');
  const [filter, setFilter] = useState('');
  const [picks, setPicks] = useState<Map<number, string>>(new Map());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // A fresh draft from the active scope each time the sheet opens (derived during render).
  const [wasVisible, setWasVisible] = useState(false);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      const next = new Map<number, string>();
      if (scope.kind === 'books') for (const p of scope.picks ?? scope.ids.map((id) => ({ id, title: '' }))) next.set(p.id, p.title);
      else if (scope.kind === 'book') next.set(scope.bookId, scope.title);
      setPicks(next);
      setFilter('');
    }
  }

  // Section id lists are stable per catalog and tab (a top section can hold thousands of commentaries).
  const idCache = useRef<{ catalog: LibraryCatalog | null; map: Map<string, Pick[]> }>({ catalog: null, map: new Map() });
  const picksOf = useCallback(
    (node: CatalogNode): Pick[] => {
      if (!catalog) return [];
      if (idCache.current.catalog !== catalog) idCache.current = { catalog, map: new Map() };
      const key = tab + node.id;
      let list = idCache.current.map.get(key);
      if (!list) {
        list = sectionPicks(catalog, node, tab);
        idCache.current.map.set(key, list);
      }
      return list;
    },
    [catalog, tab],
  );

  const toggleMany = useCallback((list: Pick[]) => {
    setPicks((prev) => {
      const next = new Map(prev);
      if (list.length && list.every(([id]) => next.has(id))) for (const [id] of list) next.delete(id);
      else for (const [id, title] of list) next.set(id, title);
      return next;
    });
  }, []);
  const addMany = useCallback((list: Pick[]) => setPicks((prev) => new Map([...prev, ...list])), []);

  const query = filter.trim();
  const rows = useMemo<Row[]>(() => {
    if (!catalog) return [];
    const out: Row[] = [];
    const tree = tab === 'base' ? catalog.sections : catalog.commentarySections;
    const extra =
      tab === 'comm' && query
        ? (n: CatalogNode) => n.kind === 'book' && n.bookId != null && catalog.commentariesOf(n.bookId).some((x) => titleMatches(query, x.name, x.categoryPath ?? undefined))
        : undefined;
    const nodes = query ? filterTree(tree, query, extra) : tree;
    const walk = (list: CatalogNode[], depth: number) => {
      for (const n of list) {
        if (n.kind === 'section') {
          const isOpen = open[n.id] ?? !!query;
          out.push({ kind: 'section', key: n.id, node: n, depth, open: isOpen });
          if (isOpen && n.children) walk(n.children, depth + 1);
        } else if (n.kind === 'commentary') {
          out.push({ kind: 'comm', key: n.id, id: n.bookId ?? 0, title: n.title ?? n.name, name: n.title ?? n.name, tier: '', depth });
        } else if (tab === 'base') {
          out.push({ kind: 'book', key: n.id, id: n.bookId ?? 0, title: n.title ?? n.name, depth, cc: n.commentaryCount ?? 0, expandable: false, open: false });
        } else {
          const bookId = n.bookId ?? 0;
          const isOpen = open[n.id] ?? (!!query && !!extra && !titleMatches(query, n.title ?? '', n.categoryPath));
          out.push({ kind: 'book', key: n.id, id: bookId, title: n.title ?? n.name, depth, cc: n.commentaryCount ?? 0, expandable: true, open: isOpen });
          if (isOpen) {
            const all = catalog.commentariesOf(bookId);
            // A filter that matched a commentator (not the book itself) shows just those commentaries.
            const bookHit = !query || titleMatches(query, n.title ?? '', n.categoryPath);
            const shown = bookHit ? all : all.filter((x) => titleMatches(query, x.name, x.categoryPath ?? undefined));
            out.push({ kind: 'allcomm', key: 'all:' + n.id, baseId: bookId, title: n.title ?? n.name, depth: depth + 1, count: all.length });
            for (const x of shown) out.push({ kind: 'comm', key: `c${bookId}:${x.bookId}`, id: x.bookId, title: x.title, name: x.name, tier: x.tier, depth: depth + 1 });
          }
        }
      }
    };
    walk(nodes, 0);
    if (!out.length) out.push({ kind: 'empty', key: 'empty' });
    return out;
  }, [catalog, tab, query, open]);

  const toggleOpen = (key: string, current: boolean) => setOpen((o) => ({ ...o, [key]: !current }));

  const apply = () => {
    onSelect(booksScope([...picks].map(([id, title]) => ({ id, title: title || catalog?.bookTitle(id) || '' }))));
    onClose();
  };

  const openBook = activeTab ? { id: activeTab.bookId, title: activeTab.bookTitle } : null;
  const openBookComms = openBook && catalog ? catalog.commentaryIds(openBook.id) : [];
  const openBookPicks: Pick[] = openBook ? [[openBook.id, openBook.title]] : [];
  const openBookAll: Pick[] = openBook ? [...openBookPicks, ...openBookComms.map((id): Pick => [id, catalog?.bookTitle(id) ?? ''])] : [];
  const covers = (list: Pick[]) => list.length > 0 && list.every(([id]) => picks.has(id));

  const Check = ({ state }: { state: 'all' | 'some' | 'none' }) => (
    <View style={[s.box, state !== 'none' && s.boxOn]}>
      <Text style={s.boxMark}>{state === 'all' ? '✓' : state === 'some' ? '–' : ''}</Text>
    </View>
  );
  const stateOf = (list: Pick[]): 'all' | 'some' | 'none' => {
    if (!list.length) return 'none';
    let n = 0;
    for (const [id] of list) if (picks.has(id)) n++;
    return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
  };

  const renderRow = (item: Row) => {
    if (item.kind === 'empty') return <Text style={s.empty}>לא נמצאו ספרים</Text>;
    if (item.kind === 'section') {
      const list = picksOf(item.node);
      const st = stateOf(list);
      return (
        <View style={[s.row, { paddingStart: spacing.md + item.depth * INDENT }]}>
          <Pressable onPress={() => toggleOpen(item.key, item.open)} style={({ pressed }) => [s.rowMain, pressed && s.pressed]} accessibilityRole="button" aria-expanded={item.open} testID={`scope-toggle-${item.node.id}`}>
            <Text style={s.chevron}>{item.open ? '▾' : '◂'}</Text>
            <FolderIcon open={item.open} />
            <Text style={[s.rowText, s.bold]} numberOfLines={1}>
              {item.node.name}
              <Text style={s.muted}>{`  ${item.node.count}`}</Text>
            </Text>
          </Pressable>
          {list.length ? (
            <Pressable onPress={() => toggleMany(list)} hitSlop={6} style={({ pressed }) => [s.selectAll, pressed && s.pressed]} accessibilityRole="checkbox" aria-checked={st === 'all'} accessibilityLabel={`בחר הכל: ${item.node.name}`} testID={`scope-all-${item.node.id}`}>
              <Text style={s.selectAllText}>{st === 'all' ? 'בטל הכל' : 'בחר הכל'}</Text>
              <Check state={st} />
            </Pressable>
          ) : null}
        </View>
      );
    }
    if (item.kind === 'book') {
      const on = picks.has(item.id);
      return (
        <View style={[s.row, on && s.selected, { paddingStart: spacing.md + item.depth * INDENT }]}>
          {item.expandable ? (
            <Pressable onPress={() => toggleOpen(item.key, item.open)} hitSlop={6} style={s.chevronBtn} accessibilityRole="button" aria-expanded={item.open} accessibilityLabel={item.open ? 'כווץ מפרשים' : 'הצג מפרשים'} testID={`scope-expand-${item.id}`}>
              <Text style={s.chevron}>{item.open ? '▾' : '◂'}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => toggleMany([[item.id, item.title]])} style={({ pressed }) => [s.rowMain, pressed && s.pressed]} accessibilityRole="checkbox" aria-checked={on} testID={`scope-book-${item.id}`}>
            <Check state={on ? 'all' : 'none'} />
            <BookIcon />
            <Text style={s.rowText} numberOfLines={1}>
              {item.title}
              {item.cc ? <Text style={s.muted}>{`  · ${item.cc} מפרשים`}</Text> : null}
            </Text>
          </Pressable>
        </View>
      );
    }
    if (item.kind === 'allcomm') {
      const ids = catalog?.commentaryIds(item.baseId) ?? [];
      const list: Pick[] = ids.map((id) => [id, catalog?.bookTitle(id) ?? '']);
      const st = stateOf(list);
      return (
        <Pressable onPress={() => toggleMany(list)} style={({ pressed }) => [s.row, s.allComm, st === 'all' && s.selected, pressed && s.pressed, { paddingStart: spacing.md + item.depth * INDENT }]} accessibilityRole="checkbox" aria-checked={st === 'all'} testID={`scope-allcomm-${item.baseId}`}>
          <Check state={st} />
          <Text style={[s.rowText, s.bold, s.accent]} numberOfLines={1}>
            {`כל הפרשנים על ${item.title}`}
            <Text style={s.muted}>{`  (${item.count})`}</Text>
          </Text>
        </Pressable>
      );
    }
    const on = picks.has(item.id);
    return (
      <Pressable onPress={() => toggleMany([[item.id, item.title]])} style={({ pressed }) => [s.row, on && s.selected, pressed && s.pressed, { paddingStart: spacing.md + item.depth * INDENT }]} accessibilityRole="checkbox" aria-checked={on} testID={`scope-comm-${item.id}`}>
        <Check state={on ? 'all' : 'none'} />
        <Text style={s.rowText} numberOfLines={1}>
          {item.name}
          {item.title !== item.name ? <Text style={s.muted}>{`  ${item.title}`}</Text> : null}
        </Text>
        {item.tier ? <Text style={[s.tier, item.tier === 'עיקריים' && s.tierCore]}>{item.tier}</Text> : null}
      </Pressable>
    );
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} testID="scope-sheet">
      <View style={s.header}>
        <Text style={s.title}>היקף החיפוש</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="סגור">
          <Text style={s.close}>✕</Text>
        </Pressable>
      </View>
      {openBook ? (
        <View style={s.shortcuts}>
          <Pressable onPress={() => addMany(openBookPicks)} style={({ pressed }) => [s.chip, covers(openBookPicks) && s.chipOn, pressed && s.pressed]} accessibilityRole="button" testID="scope-open-book">
            <BookIcon />
            <Text style={s.chipText} numberOfLines={1}>
              הספר הפתוח כעת
            </Text>
          </Pressable>
          {openBookComms.length ? (
            <Pressable onPress={() => addMany(openBookAll)} style={({ pressed }) => [s.chip, covers(openBookAll) && s.chipOn, pressed && s.pressed]} accessibilityRole="button" testID="scope-open-book-comm">
              <BookIcon />
              <Text style={s.chipText} numberOfLines={1}>
                הספר הפתוח + מפרשיו
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={s.segment} accessibilityRole="tablist">
        {(
          [
            ['base', 'ספרי בסיס'],
            ['comm', 'פרשנים לפי ספר'],
          ] as const
        ).map(([t, label]) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.segBtn, tab === t && s.segBtnOn]} accessibilityRole="tab" aria-selected={tab === t} testID={`scope-tab-${t}`}>
            <Text style={[s.segText, tab === t && s.segTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput value={filter} onChangeText={setFilter} placeholder={tab === 'base' ? 'סינון ספרים: שו״ע או״ח, ב״ק…' : 'סינון ספרים ופרשנים: רש״י, תוספות…'} placeholderTextColor={c.textMuted} style={s.filter} autoCorrect={false} autoCapitalize="none" testID="scope-filter" />
      <View style={{ height: Math.min(height * 0.42, 460) }}>
        <FlashList data={rows} keyExtractor={(r) => r.key} getItemType={(r) => r.kind} extraData={picks} keyboardShouldPersistTaps="handled" renderItem={({ item }) => renderRow(item)} />
      </View>
      <View style={s.footer}>
        <Text style={s.summary} testID="scope-summary">
          {picks.size ? `נבחרו ${picks.size} ספרים` : 'כל הספרייה'}
        </Text>
        {picks.size ? (
          <Pressable onPress={() => setPicks(new Map())} hitSlop={8} style={({ pressed }) => [s.clearBtn, pressed && s.pressed]} accessibilityRole="button" testID="scope-clear">
            <Text style={s.clearText}>נקה</Text>
          </Pressable>
        ) : null}
        <View style={s.flex} />
        <Pressable onPress={apply} style={({ pressed }) => [s.applyBtn, pressed && s.pressed]} accessibilityRole="button" testID="scope-apply">
          <Text style={s.applyText}>{picks.size ? 'החל' : 'חפש בכל הספרייה'}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    title: { fontSize: 18, fontWeight: '700', color: c.text, ...alignRight },
    close: { fontSize: 18, color: c.textMuted },
    shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: c.surfaceMuted, borderWidth: 1, borderColor: c.border },
    chipOn: { backgroundColor: c.accentSoft, borderColor: c.accent },
    chipText: { color: c.accent, fontSize: 13, fontWeight: '600', ...alignRight },
    segment: { flexDirection: 'row', marginHorizontal: spacing.lg, marginBottom: spacing.sm, backgroundColor: c.surfaceMuted, borderRadius: radius.md, padding: 3, gap: 3 },
    segBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 34, borderRadius: radius.md - 3 },
    segBtnOn: { backgroundColor: c.accent },
    segText: { fontSize: 14, fontWeight: '600', color: c.textMuted },
    segTextOn: { color: c.background, fontWeight: '700' },
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
      fontSize: 15,
      ...inputAlignRight,
    },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingStart: spacing.md, paddingEnd: spacing.md, gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'stretch' },
    rowText: { flex: 1, fontSize: 15, color: c.text, ...alignRight },
    bold: { fontWeight: '600' },
    accent: { color: c.accent },
    muted: { fontSize: 12, color: c.textMuted, fontWeight: '400' },
    chevronBtn: { width: 22, alignItems: 'center', alignSelf: 'stretch', justifyContent: 'center' },
    chevron: { fontSize: 13, color: c.textMuted, width: 14, textAlign: 'center' },
    allComm: { backgroundColor: c.surfaceMuted },
    selectAll: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    selectAllText: { fontSize: 12, color: c.accent, fontWeight: '600', ...alignRight },
    box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: c.textMuted, alignItems: 'center', justifyContent: 'center' },
    boxOn: { borderColor: c.accent, backgroundColor: c.accent },
    boxMark: { color: c.background, fontSize: 13, fontWeight: '800', lineHeight: 16 },
    tier: { fontSize: 10, color: c.textMuted, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingHorizontal: 6, paddingVertical: 1 },
    tierCore: { color: c.accent, borderColor: c.accent },
    selected: { backgroundColor: c.accentSoft },
    pressed: { opacity: 0.7 },
    empty: { padding: spacing.xl, textAlign: 'center', color: c.textMuted },
    footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
    summary: { fontSize: 14, color: c.text, fontWeight: '600', ...alignRight },
    clearBtn: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: c.border },
    clearText: { fontSize: 13, color: c.textMuted, ...alignRight },
    applyBtn: { paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.md, backgroundColor: c.accent },
    applyText: { fontSize: 15, fontWeight: '700', color: c.background },
  });
