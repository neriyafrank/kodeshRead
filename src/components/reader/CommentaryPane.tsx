/**
 * Parallel commentaries drawer (Otzaria-style split view).
 *
 * A non-modal panel docked under the text: the reader stays scrollable above it.
 * It shows everything linked to the selected paragraph, grouped by commentator book
 * (רש"י, רמב"ן, אונקלוס, ...), rendered with the active theme, typography, niqqud and
 * cantillation settings:
 *  - heading-aligned units (Otzaria reference alignment, `ref_links`): the WHOLE block of
 *    each commentator for the selected verse / amud / seif — every דיבור המתחיל, untruncated.
 *    "פתח בספר" opens the commentary at the block and highlights all of it. From a
 *    commentary, the same drawer shows the base text of its unit;
 *  - explicit Otzaria line links (`links`); paragraphs a link file points at exactly are
 *    marked inside their block.
 * Each entry also opens its book at that line in a tab.
 *
 * - Drag the grabber to resize (persisted as a share of the reader height); tap it
 *   to toggle between a short and a tall drawer.
 * - ‹ / › step to the previous / next paragraph with commentaries (the text follows).
 * - The link toggle makes the drawer follow the reading line while scrolling.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent, type ScrollViewInstance } from 'react-native';

import { fetchLinkedEntries, groupLinkedEntries, type CommentaryGroup, type LinkedEntry } from '../../../shared/commentary';
import { prepareDisplayText } from '../../../shared/reader';
import { useLibrary } from '../../db/LibraryContext';
import { readerFont } from '../../fonts';
import { COMMENTARY_RATIO, useSettings } from '../../state/settingsStore';
import { radius, spacing, useAppTheme, type Palette } from '../../theme';
import { RichText } from '../RichText';

const GRABBER_HEIGHT = 22;

/** Committed drawer height for a reader area (the text area above is shrunk by this). */
export function commentaryPaneHeight(areaHeight: number, ratio: number): number {
  const minH = Math.round(areaHeight * COMMENTARY_RATIO.min);
  const maxH = Math.round(areaHeight * COMMENTARY_RATIO.max);
  return Math.min(maxH, Math.max(minH, Math.round(areaHeight * ratio)));
}
const TYPE_LABEL: Record<string, string> = { commentary: 'מפרש', targum: 'תרגום', translation: 'תרגום', reference: 'הפניה', source: 'מקור' };

interface Props {
  bookId: number;
  line: number;
  /** Breadcrumb of the selected paragraph (toc_path). */
  tocPath: string | null;
  /** Height of the whole reader area the drawer splits with the text. */
  areaHeight: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  /** `endLine`: highlight the whole unit up to this line (a commentary block). */
  onOpenEntry: (entry: { bookId: number; bookTitle: string; line: number; endLine?: number }) => void;
  /** Resize drag started/ended (the web preview disables text selection meanwhile). */
  onDragging?: (dragging: boolean) => void;
}

export function CommentaryPane({ bookId, line, tocPath, areaHeight, hasPrev, hasNext, onPrev, onNext, onClose, onOpenEntry, onDragging }: Props) {
  const c = useAppTheme();
  const s = useMemo(() => createStyles(c), [c]);
  const { adapter } = useLibrary();
  const ratio = useSettings((x) => x.commentaryRatio);
  const follow = useSettings((x) => x.commentaryFollow);
  const setCommentary = useSettings((x) => x.setCommentary);
  const fontSize = useSettings((x) => x.fontSize);
  const lineHeight = useSettings((x) => x.lineHeight);
  const fontFamily = useSettings((x) => x.fontFamily);
  const showNiqqud = useSettings((x) => x.showNiqqud);
  const showCantillation = useSettings((x) => x.showCantillation);
  const font = readerFont(fontFamily);

  // --- data --------------------------------------------------------------------
  const [data, setData] = useState<{ key: string; groups: CommentaryGroup[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${bookId}:${line}`;
  useEffect(() => {
    let alive = true;
    fetchLinkedEntries(adapter, bookId, line).then(
      (entries: LinkedEntry[]) => {
        if (!alive) return;
        setError(null);
        setData({ key, groups: groupLinkedEntries(entries) });
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [adapter, bookId, line, key]);
  const loading = data?.key !== key;
  const groups = data?.groups ?? [];
  const total = groups.reduce((n, g) => n + g.entries.length, 0);

  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const toggleGroup = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Back to the top of the list whenever the drawer moves to another paragraph.
  const scrollRef = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [key]);

  // --- resizing ------------------------------------------------------------------
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const minH = Math.round(areaHeight * COMMENTARY_RATIO.min);
  const maxH = Math.round(areaHeight * COMMENTARY_RATIO.max);
  // While dragging, the drawer overlays the text; the text area is resized once on release
  // (resizing a FlashList viewport on every move makes it jump).
  const height = dragHeight == null ? commentaryPaneHeight(areaHeight, ratio) : Math.min(maxH, Math.max(minH, dragHeight));
  // Plain responder props (not PanResponder) so the handlers always see current state.
  const drag = useRef({ startY: 0, startH: 0, moved: 0 });
  const grabberHandlers = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: GestureResponderEvent) => {
      onDragging?.(true);
      drag.current = { startY: e.nativeEvent.pageY, startH: height, moved: 0 };
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const dy = e.nativeEvent.pageY - drag.current.startY;
      drag.current.moved = Math.max(drag.current.moved, Math.abs(dy));
      setDragHeight(drag.current.startH - dy);
    },
    onResponderRelease: (e: GestureResponderEvent) => {
      const dy = e.nativeEvent.pageY - drag.current.startY;
      if (areaHeight > 0) {
        // A tap (no drag) toggles between a short and a tall drawer.
        const next = drag.current.moved < 4 ? (ratio < 0.6 ? 0.75 : COMMENTARY_RATIO.default) : (drag.current.startH - dy) / areaHeight;
        setCommentary({ ratio: next });
      }
      setDragHeight(null);
      onDragging?.(false);
    },
    onResponderTerminate: () => {
      setDragHeight(null);
      onDragging?.(false);
    },
  };

  const entrySize = Math.max(13, Math.round(fontSize * 0.88));
  const crumbs = tocPath ? tocPath.split(' > ') : [];

  return (
    <View style={[s.pane, { height }]} testID="commentary-pane">
      <View {...grabberHandlers} style={s.grabberArea} accessibilityRole="adjustable" accessibilityLabel="שינוי גובה חלונית המפרשים" testID="commentary-grabber">
        <View style={s.grabber} />
      </View>

      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.kicker} numberOfLines={1}>
            מפרשים וקישורים{total ? ` · ${total}` : ''}
          </Text>
          <Text style={s.where} numberOfLines={1}>
            {crumbs.length ? crumbs.join(' ‹ ') : `שורה ${line}`}
          </Text>
        </View>
        <IconButton label="→" a11y="הפסקה הקודמת עם מפרשים" disabled={!hasPrev} onPress={onPrev} palette={c} testID="commentary-prev" />
        <IconButton label="←" a11y="הפסקה הבאה עם מפרשים" disabled={!hasNext} onPress={onNext} palette={c} testID="commentary-next" />
        <Pressable
          onPress={() => setCommentary({ follow: !follow })}
          style={[s.followBtn, follow && { backgroundColor: c.accent }]}
          accessibilityRole="switch"
          accessibilityState={{ checked: follow }}
          accessibilityLabel="סנכרון עם הגלילה"
          testID="commentary-follow"
        >
          <Text style={[s.followText, follow && { color: c.surface }]}>סנכרון</Text>
        </Pressable>
        <IconButton label="✕" a11y="סגור מפרשים" onPress={onClose} palette={c} testID="commentary-close" />
      </View>

      {error ? (
        <Text style={s.message}>{error}</Text>
      ) : loading && !data ? (
        <ActivityIndicator style={{ marginTop: spacing.lg }} color={c.accent} />
      ) : !groups.length ? (
        <Text style={s.message}>אין מפרשים לפסקה זו</Text>
      ) : (
        <ScrollView ref={scrollRef} style={{ flex: 1, opacity: loading ? 0.5 : 1 }} contentContainerStyle={s.scroll} testID="commentary-list">
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.bookId);
            return (
              <View key={g.bookId} style={s.group} testID="commentary-group">
                <Pressable
                  onPress={() => toggleGroup(g.bookId)}
                  style={s.groupHeader}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !isCollapsed }}
                  accessibilityLabel={`${g.name}, ${g.entries.length}`}
                >
                  <Text style={s.chevron}>{isCollapsed ? '‹' : '⌄'}</Text>
                  <Text style={[s.groupName, { fontFamily: font.bold }]} numberOfLines={1} testID="commentary-group-name">
                    {g.name}
                  </Text>
                  {g.linkType && TYPE_LABEL[g.linkType] ? <Text style={s.typeTag}>{TYPE_LABEL[g.linkType]}</Text> : null}
                  <Text style={s.groupCount}>{g.entries.length}</Text>
                </Pressable>
                {!isCollapsed && g.block ? (
                  <View style={s.blockBar} testID="commentary-block">
                    <Text style={s.entryPath} numberOfLines={1}>
                      {g.bookTitle} ‹ {g.block.refKey.split('|').join(' ‹ ')}
                    </Text>
                    <Pressable
                      onPress={() => onOpenEntry({ bookId: g.bookId, bookTitle: g.bookTitle, line: g.block!.start, endLine: g.block!.end })}
                      hitSlop={8}
                      style={s.openBtn}
                      accessibilityRole="button"
                      accessibilityLabel={`פתח את ${g.bookTitle} ב${g.block.refKey.split('|').join(' ')}`}
                      testID="commentary-open-block"
                    >
                      <Text style={s.openText}>פתח בספר ↗</Text>
                    </Pressable>
                  </View>
                ) : null}
                {isCollapsed
                  ? null
                  : g.entries.map((e) => (
                      <View
                        key={`${e.book_id}:${e.line}`}
                        style={[s.entry, g.block && e.direct ? { borderStartWidth: 3, borderStartColor: c.accent } : null]}
                        testID={e.direct && g.block ? 'commentary-entry-direct' : 'commentary-entry'}
                      >
                        <View style={s.entryMeta}>
                          <Text style={s.entryPath} numberOfLines={1}>
                            {g.block ? '' : g.bookTitle}
                            {e.toc_path && !g.block ? ` ‹ ${e.toc_path.split(' > ').join(' ‹ ')}` : ''}
                          </Text>
                          <Pressable
                            onPress={() => onOpenEntry({ bookId: e.book_id, bookTitle: e.book_title, line: e.line })}
                            hitSlop={8}
                            style={s.openBtn}
                            accessibilityRole="button"
                            accessibilityLabel={`פתח את ${e.book_title} בכרטיסייה`}
                            testID="commentary-open"
                          >
                            <Text style={s.openText}>פתח ↗</Text>
                          </Pressable>
                        </View>
                        <RichText
                          html={prepareDisplayText(e.display_text ?? '—', { showNiqqud, showCantillation })}
                          fontSize={entrySize}
                          boldFamily={font.bold}
                          style={[s.entryText, { fontFamily: font.regular, fontSize: entrySize, lineHeight: Math.round(entrySize * lineHeight) }]}
                        />
                      </View>
                    ))}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function IconButton({
  label,
  a11y,
  onPress,
  disabled,
  palette,
  testID,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  disabled?: boolean;
  palette: Palette;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={[iconStyles.btn, { opacity: disabled ? 0.35 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
    >
      <Text style={[iconStyles.text, { color: palette.accent }]}>{label}</Text>
    </Pressable>
  );
}

const iconStyles = StyleSheet.create({
  btn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  text: { fontSize: 20, fontWeight: '600' },
});

const createStyles = (c: Palette) =>
  StyleSheet.create({
    pane: {
      position: 'absolute',
      start: 0,
      end: 0,
      bottom: 0,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      borderTopStartRadius: radius.lg,
      borderTopEndRadius: radius.lg,
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: -2 },
      elevation: 8,
    },
    grabberArea: { height: GRABBER_HEIGHT, alignItems: 'center', justifyContent: 'center', userSelect: 'none' },
    grabber: { width: 44, height: 4, borderRadius: 2, backgroundColor: c.border },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingStart: spacing.lg,
      paddingEnd: spacing.sm,
      paddingBottom: spacing.xs,
      gap: 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    kicker: { fontSize: 15, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    where: { fontSize: 12, color: c.textMuted, writingDirection: 'rtl' },
    followBtn: {
      paddingHorizontal: spacing.sm,
      height: 28,
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.accent,
      marginHorizontal: spacing.xs,
    },
    followText: { fontSize: 12, fontWeight: '600', color: c.accent },
    message: { textAlign: 'center', marginTop: spacing.lg, fontSize: 15, color: c.textMuted },
    scroll: { paddingBottom: spacing.xl },
    group: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    blockBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.surfaceMuted,
    },
    chevron: { width: 14, textAlign: 'center', fontSize: 15, color: c.accent },
    groupName: { flex: 1, fontSize: 16, fontWeight: '700', color: c.accent, writingDirection: 'rtl' },
    typeTag: {
      fontSize: 11,
      color: c.textMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    groupCount: {
      minWidth: 22,
      textAlign: 'center',
      fontSize: 12,
      fontWeight: '700',
      color: c.accent,
      backgroundColor: c.accentSoft,
      borderRadius: 11,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: 'hidden',
    },
    entry: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 2 },
    entryMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    entryPath: { flex: 1, fontSize: 12, color: c.textMuted, writingDirection: 'rtl' },
    openBtn: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: c.accentSoft },
    openText: { fontSize: 12, fontWeight: '600', color: c.accent },
    entryText: { color: c.text, writingDirection: 'rtl', textAlign: 'justify' },
  });
