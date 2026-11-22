/**
 * Slide-over hierarchical table of contents (toc_nodes). Only the node list
 * (id/parent/title/start_line, no text) is loaded; the visible part of the tree is
 * flattened into a FlashList, so huge TOCs (Shulchan Aruch, Shas) stay fast.
 * Opens with the current section's ancestors expanded and the section marked.
 */
import { FlashList } from '@shopify/flash-list';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { tocTrail } from '../../../shared/reader';
import { useLibrary } from '../../db/LibraryContext';
import { spacing, useThemedStyles, type Palette } from '../../theme';
import { SideDrawer } from '../Overlay';

interface TocNode {
  id: number;
  parent_id: number | null;
  level: number;
  title: string;
  start_line: number;
}

interface Row {
  node: TocNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

interface Props {
  visible: boolean;
  bookId: number;
  bookTitle: string;
  currentLine: number;
  onClose: () => void;
  onSelect: (line: number) => void;
}

const INDENT = 16;

export function TocDrawer({ visible, bookId, bookTitle, currentLine, onClose, onSelect }: Props) {
  const s = useThemedStyles(createStyles);
  const { adapter } = useLibrary();
  const [nodes, setNodes] = useState<{ bookId: number; list: TocNode[] } | null>(null);

  useEffect(() => {
    if (!visible || nodes?.bookId === bookId) return;
    let alive = true;
    adapter.forBook(bookId).all<TocNode>('SELECT id, parent_id, level, title, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [bookId]).then(
      (list) => alive && setNodes({ bookId, list }),
    );
    return () => {
      alive = false;
    };
  }, [visible, bookId, adapter, nodes]);

  const list = nodes?.bookId === bookId ? nodes.list : null;

  return (
    <SideDrawer visible={visible} onClose={onClose} testID="toc-drawer">
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.kicker}>תוכן עניינים</Text>
          <Text style={s.title} numberOfLines={1}>
            {bookTitle}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="סגור תוכן עניינים" style={s.close}>
          <Text style={s.closeText}>✕</Text>
        </Pressable>
      </View>
      {!list ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={s.palette.accent} />
      ) : list.length === 0 ? (
        <Text style={s.empty}>אין תוכן עניינים לספר זה</Text>
      ) : (
        <TocTree list={list} currentLine={currentLine} onSelect={onSelect} />
      )}
    </SideDrawer>
  );
}

/** Mounted each time the drawer opens, so its initial state reflects the current position. */
function TocTree({ list, currentLine, onSelect }: { list: TocNode[]; currentLine: number; onSelect: (line: number) => void }) {
  const s = useThemedStyles(createStyles);
  const trail = useMemo(() => tocTrail(list, currentLine), [list, currentLine]);
  const currentId = trail[trail.length - 1];
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(trail));

  const children = useMemo(() => {
    const m = new Map<number | null, TocNode[]>();
    for (const n of list) {
      const arr = m.get(n.parent_id) ?? [];
      arr.push(n);
      m.set(n.parent_id, arr);
    }
    return m;
  }, [list]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const visit = (parent: number | null, depth: number) => {
      for (const node of children.get(parent) ?? []) {
        const hasChildren = (children.get(node.id)?.length ?? 0) > 0;
        const isOpen = expanded.has(node.id);
        out.push({ node, depth, hasChildren, expanded: isOpen });
        if (hasChildren && isOpen) visit(node.id, depth + 1);
      }
    };
    visit(null, 0);
    return out;
  }, [children, expanded]);

  // Start scrolled so the current section is visible (a few rows of context above it).
  const [initialIndex] = useState(() => Math.max(0, rows.findIndex((r) => r.node.id === currentId) - 3));

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <FlashList
      data={rows}
      extraData={currentId}
      keyExtractor={(r) => String(r.node.id)}
      initialScrollIndex={initialIndex}
      renderItem={({ item }) => {
        const active = item.node.id === currentId;
        const inTrail = !active && trail.includes(item.node.id);
        return (
          <View style={[s.row, { paddingStart: spacing.sm + item.depth * INDENT }, active && s.rowActive]}>
            {item.hasChildren ? (
              <Pressable
                onPress={() => toggle(item.node.id)}
                hitSlop={8}
                style={s.chevronBtn}
                accessibilityRole="button"
                accessibilityLabel={item.expanded ? 'כווץ' : 'הרחב'}
                accessibilityState={{ expanded: item.expanded }}
              >
                <Text style={s.chevron}>{item.expanded ? '▾' : '◂'}</Text>
              </Pressable>
            ) : (
              <View style={s.chevronBtn} />
            )}
            <Pressable
              style={({ pressed }) => [s.titleBtn, pressed && s.pressed]}
              onPress={() => onSelect(item.node.start_line)}
              accessibilityRole="link"
              testID={`toc-node-${item.node.id}`}
            >
              <Text style={[s.nodeTitle, item.depth === 0 && s.nodeRoot, (active || inTrail) && s.nodeActive]} numberOfLines={2}>
                {item.node.title}
              </Text>
            </Pressable>
          </View>
        );
      }}
    />
  );
}

const createStyles = (c: Palette) => ({
  palette: c,
  ...StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    kicker: { fontSize: 12, color: c.textMuted },
    title: { fontSize: 19, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    close: { padding: spacing.sm },
    closeText: { fontSize: 16, color: c.textMuted },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: spacing.xl },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 44,
      paddingEnd: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowActive: { backgroundColor: c.accentSoft },
    chevronBtn: { width: 28, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
    chevron: { fontSize: 13, color: c.textMuted },
    titleBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: 4 },
    pressed: { opacity: 0.6 },
    nodeTitle: { fontSize: 16, color: c.text, writingDirection: 'rtl' },
    nodeRoot: { fontWeight: '600' },
    nodeActive: { color: c.accent, fontWeight: '700' },
  }),
});
