/**
 * Parallel commentaries drawer (Otzaria-style split view).
 *
 * A non-modal panel docked under the text: the reader stays scrollable above it.
 * It shows everything linked to the selected paragraph, one collapsible card per commentator
 * book, rendered with the active theme, typography, niqqud and cantillation settings.
 *
 * Built for passages with 40-100+ commentaries:
 *  - cards are ordered by priority (shared/commentaryRank.js): ⭐ favorites, the base text,
 *    the corpus' canonical core list (רש"י, רמב"ן, ... / משנה ברורה, מגן אברהם, ...), then
 *    תרגומים -> ראשונים -> אחרונים -> מחברי זמננו -> alphabetical; each card has a tier badge;
 *  - only favorites + the top 3 open by default; the rest are one-line headers (the user's own
 *    open / close choices stick while moving between verses);
 *  - a sticky tools header: name filter that understands abbreviations ("מ"ב", "אב"ע", "תוס"),
 *    view chips (הכל / עיקריים / מועדפים ⭐), open-all / collapse-all, and a horizontal strip of
 *    commentator pills — one tap scrolls to a commentator and opens it. It is folded away by
 *    default (the commentaries start right under the title bar) and toggled by the "סינון"
 *    button in the title bar, which carries a dot while a name filter or a view chip is active.
 *
 * Content of a card:
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
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type ScrollViewInstance,
} from 'react-native';

import { fetchLinkedEntries, groupLinkedEntries, type CommentaryGroup, type LinkedEntry } from '../../../shared/commentary';
import { defaultExpandedKeys, filterCommentaries, rankCommentaries, type Ranked } from '../../../shared/commentaryRank';
import { prepareDisplayText } from '../../../shared/reader';
import { useLibrary } from '../../db/LibraryContext';
import { readerFont } from '../../fonts';
import { alignRight, inputAlignRight, nativeDir, setWebDir } from '../../lib/direction';
import { useCommentaryPrefs } from '../../state/commentaryStore';
import { COMMENTARY_RATIO, useSettings } from '../../state/settingsStore';
import { radius, spacing, useAppTheme, type Palette } from '../../theme';
import { Collapsible } from '../Collapsible';
import { SlidersIcon } from '../Icons';
import { RichText } from '../RichText';

type RankedGroup = Ranked<CommentaryGroup>;

const GRABBER_HEIGHT = 22;

/** Committed drawer height for a reader area (the text area above is shrunk by this). */
export function commentaryPaneHeight(areaHeight: number, ratio: number): number {
  const minH = Math.round(areaHeight * COMMENTARY_RATIO.min);
  const maxH = Math.round(areaHeight * COMMENTARY_RATIO.max);
  return Math.min(maxH, Math.max(minH, Math.round(areaHeight * ratio)));
}
/** Below this many commentators the filter / chips / pills header is not needed. */
const TOOLS_MIN_GROUPS = 4;

interface Props {
  bookId: number;
  /** Title of the book being read (helps pick the corpus' core commentator list). */
  bookTitle?: string;
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

export function CommentaryPane({ bookId, bookTitle, line, tocPath, areaHeight, hasPrev, hasNext, onPrev, onNext, onClose, onOpenEntry, onDragging }: Props) {
  const c = useAppTheme();
  const s = useMemo(() => createStyles(c), [c]);
  const { adapter } = useLibrary();
  const ratio = useSettings((x) => x.commentaryRatio);
  const follow = useSettings((x) => x.commentaryFollow);
  const setCommentary = useSettings((x) => x.setCommentary);
  const fontSize = useSettings((x) => x.fontSize);
  const lineHeight = useSettings((x) => x.lineHeight);
  const fontFamily = useSettings((x) => x.fontFamily);
  const showNikkud = useSettings((x) => x.showNikkud);
  const showCantillation = useSettings((x) => x.showCantillation);
  const font = readerFont(fontFamily);
  const pinned = useCommentaryPrefs((x) => x.pinned);
  const togglePinned = useCommentaryPrefs((x) => x.togglePinned);
  const expandedOverrides = useCommentaryPrefs((x) => x.expanded);
  const setExpanded = useCommentaryPrefs((x) => x.setExpanded);
  const view = useCommentaryPrefs((x) => x.view);
  const setView = useCommentaryPrefs((x) => x.setView);

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
  const groups = data?.groups;

  // --- priority, filter, expansion ------------------------------------------------
  const ranked = useMemo(() => rankCommentaries(groups ?? [], { pinned, context: { title: bookTitle } }), [groups, pinned, bookTitle]);
  const total = ranked.reduce((n, g) => n + g.entries.length, 0);
  const pinnedCount = ranked.filter((g) => g.pinned).length;
  const coreCount = ranked.filter((g) => g.core || g.isSource).length;
  const [query, setQuery] = useState('');
  // The ⭐ chip is offered only while the passage has favorites.
  const activeView = view === 'pinned' && !pinnedCount ? 'all' : view;
  const visible = useMemo(() => filterCommentaries(ranked, { view: activeView, query }), [ranked, activeView, query]);
  const defaults = useMemo(() => defaultExpandedKeys(ranked), [ranked]);
  // A narrow name filter opens what it found (as if tapped, so it can still be collapsed).
  const narrowKeys = query.trim() && visible.length <= 3 ? visible.map((g) => g.key).join('\n') : '';
  useEffect(() => {
    if (narrowKeys) setExpanded(Object.fromEntries(narrowKeys.split('\n').map((k) => [k, true])));
  }, [narrowKeys, setExpanded]);
  const isExpanded = (g: RankedGroup) => expandedOverrides[g.key] ?? defaults.has(g.key);
  const allExpanded = visible.length > 0 && visible.every(isExpanded);
  const toggleAll = () => setExpanded(Object.fromEntries(visible.map((g) => [g.key, !allExpanded])));
  const filtering = !!query.trim() || activeView !== 'all';
  const showTools = ranked.length >= TOOLS_MIN_GROUPS || !!query || activeView !== 'all';
  // The tools header starts folded; the toggle in the title bar opens it.
  const [toolsOpen, setToolsOpen] = useState(false);

  // --- scrolling ---------------------------------------------------------------------
  const scrollRef = useRef<ScrollViewInstance>(null);
  const cardY = useRef(new Map<string, number>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // Back to the top of the list whenever the drawer moves to another paragraph.
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [key]);
  useEffect(() => {
    if (!focusKey) return;
    const t = setTimeout(() => setFocusKey(null), 1600);
    return () => clearTimeout(t);
  }, [focusKey]);
  /** Pill tap: open the commentator and bring its card to the top of the list. */
  const jumpTo = (g: RankedGroup) => {
    setExpanded({ [g.key]: true });
    setFocusKey(g.key);
    // Opening a card never moves its own top, so the measured position stays valid.
    requestAnimationFrame(() => {
      const y = cardY.current.get(g.key);
      if (y != null) scrollRef.current?.scrollTo({ y, animated: true });
    });
  };

  // Commentator pills: LTR strip with reversed items, so the first (top-priority) pill sits at
  // the right edge on every platform; kept scrolled to that edge.
  const pillsRef = useRef<ScrollViewInstance | null>(null);
  const [pillsWidth, setPillsWidth] = useState(0);

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
  const entryTextStyle = [s.entryText, { fontFamily: font.regular, fontSize: entrySize, lineHeight: Math.round(entrySize * lineHeight) }];

  const openGroup = (g: RankedGroup) => {
    if (g.block) onOpenEntry({ bookId: g.bookId, bookTitle: g.bookTitle, line: g.block.start, endLine: g.block.end });
    else if (g.entries[0]) onOpenEntry({ bookId: g.bookId, bookTitle: g.bookTitle, line: g.entries[0].line });
  };

  const renderCard = (g: RankedGroup) => {
    const open = isExpanded(g);
    const focused = focusKey === g.key;
    return (
      <View
        key={g.bookId}
        style={[s.card, focused && { borderColor: c.accent, borderWidth: 1.5 }]}
        onLayout={(e) => cardY.current.set(g.key, e.nativeEvent.layout.y)}
        testID="commentary-group"
      >
        <View style={s.cardHeader}>
          <Pressable
            onPress={() => setExpanded({ [g.key]: !open })}
            style={s.cardToggle}
            accessibilityRole="button"
            aria-expanded={open}
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${g.displayName}, ${g.tier}, ${g.entries.length}`}
            testID="commentary-group-header"
          >
            <Text style={s.chevron}>{open ? '⌄' : '‹'}</Text>
            <Text style={[s.groupName, { fontFamily: font.bold }]} numberOfLines={1} testID="commentary-group-name">
              {g.displayName}
            </Text>
            <Text style={[s.tierTag, g.core || g.isSource ? s.tierCore : null]} numberOfLines={1} testID="commentary-tier">
              {g.tier}
            </Text>
            <Text style={s.groupCount}>{g.entries.length}</Text>
          </Pressable>
          <Pressable
            onPress={() => togglePinned(g.key)}
            hitSlop={6}
            style={s.pinBtn}
            accessibilityRole="button"
            aria-pressed={g.pinned}
            accessibilityState={{ selected: g.pinned }}
            accessibilityLabel={g.pinned ? `הסר את ${g.displayName} מהמועדפים` : `הוסף את ${g.displayName} למועדפים`}
            testID="commentary-pin"
          >
            <Text style={[s.pinText, g.pinned && { color: c.accent }]}>{g.pinned ? '★' : '☆'}</Text>
          </Pressable>
          <Pressable
            onPress={() => openGroup(g)}
            hitSlop={6}
            style={s.openBtn}
            accessibilityRole="button"
            accessibilityLabel={g.block ? `פתח את ${g.bookTitle} ב${g.block.refKey.split('|').join(' ')}` : `פתח את ${g.bookTitle} בכרטיסייה`}
            testID={g.block ? 'commentary-open-block' : 'commentary-open-group'}
          >
            <Text style={s.openText}>פתח בספר ↗</Text>
          </Pressable>
        </View>
        {open && g.block ? (
          <Text style={s.blockPath} numberOfLines={1} testID="commentary-block">
            {/* The book's own headings (the canonical ref_key is normalized for matching). */}
            {g.bookTitle} ‹ {(g.entries[0]?.toc_path ?? g.block.refKey.replace(/\|/g, ' > ')).split(' > ').join(' ‹ ')}
          </Text>
        ) : null}
        {open
          ? g.entries.map((e) => (
              <View
                key={`${e.book_id}:${e.line}`}
                style={[s.entry, g.block && e.direct ? { borderStartWidth: 3, borderStartColor: c.accent } : null]}
                testID={e.direct && g.block ? 'commentary-entry-direct' : 'commentary-entry'}
              >
                {g.block ? null : (
                  <Text style={s.entryPath} numberOfLines={1}>
                    {g.bookTitle}
                    {e.toc_path ? ` ‹ ${e.toc_path.split(' > ').join(' ‹ ')}` : ''}
                  </Text>
                )}
                <View style={s.entryRow}>
                  <RichText
                    html={prepareDisplayText(e.display_text ?? '—', { showNikkud, showCantillation })}
                    fontSize={entrySize}
                    boldFamily={font.bold}
                    style={[entryTextStyle, { flex: 1 }]}
                  />
                  <Pressable
                    onPress={() => onOpenEntry({ bookId: e.book_id, bookTitle: e.book_title, line: e.line })}
                    hitSlop={8}
                    style={s.entryOpen}
                    accessibilityRole="button"
                    accessibilityLabel={`פתח את ${e.book_title} בשורה זו`}
                    testID="commentary-open"
                  >
                    <Text style={s.entryOpenText}>↗</Text>
                  </Pressable>
                </View>
              </View>
            ))
          : null}
      </View>
    );
  };

  return (
    <View style={[s.pane, { height }]} testID="commentary-pane">
      <View {...grabberHandlers} style={s.grabberArea} accessibilityRole="adjustable" accessibilityLabel="שינוי גובה חלונית המפרשים" testID="commentary-grabber">
        <View style={s.grabber} />
      </View>

      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.kicker} numberOfLines={1}>
            מפרשים וקישורים{ranked.length ? ` · ${ranked.length}` : ''}
          </Text>
          <Text style={s.where} numberOfLines={1}>
            {crumbs.length ? crumbs.join(' ‹ ') : `שורה ${line}`}
            {total ? ` · ${total} קטעים` : ''}
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
        {showTools && !error ? (
          <Pressable
            onPress={() => setToolsOpen((v) => !v)}
            hitSlop={6}
            style={[s.toolsToggle, toolsOpen && { backgroundColor: c.accentSoft }]}
            accessibilityRole="button"
            aria-expanded={toolsOpen}
            accessibilityState={{ expanded: toolsOpen }}
            accessibilityLabel={`${toolsOpen ? 'הסתר' : 'הצג'} כלי סינון מפרשים${filtering ? ' (סינון פעיל)' : ''}`}
            testID="commentary-tools-toggle"
          >
            <SlidersIcon size={16} />
            {filtering && !toolsOpen ? <View style={[s.toolsDot, { borderColor: c.surface }]} testID="commentary-tools-badge" /> : null}
          </Pressable>
        ) : null}
        <IconButton label="✕" a11y="סגור מפרשים" onPress={onClose} palette={c} testID="commentary-close" />
      </View>

      <Collapsible open={showTools && !error && toolsOpen} style={s.tools} testID="commentary-tools">
          <View style={s.toolsRow}>
            <View style={s.filterBox}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="חפש פרשן..."
                placeholderTextColor={c.textMuted}
                style={s.filterInput}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                onSubmitEditing={() => visible[0] && jumpTo(visible[0])}
                accessibilityLabel="חפש פרשן"
                testID="commentary-filter"
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="נקה סינון" testID="commentary-filter-clear">
                  <Text style={s.clearText}>✕</Text>
                </Pressable>
              ) : null}
            </View>
            <Pressable
              onPress={toggleAll}
              disabled={!visible.length}
              style={s.toggleAll}
              accessibilityRole="button"
              accessibilityLabel={allExpanded ? 'כווץ את כל המפרשים' : 'פתח את כל המפרשים'}
              testID="commentary-toggle-all"
            >
              <Text style={s.toggleAllText}>{allExpanded ? 'כווץ הכל' : 'פתח הכל'}</Text>
            </Pressable>
          </View>
          <View style={s.chips}>
            <Chip label={`הכל · ${ranked.length}`} active={activeView === 'all'} onPress={() => setView('all')} palette={c} testID="commentary-chip-all" />
            {coreCount ? (
              <Chip label={`עיקריים · ${coreCount}`} active={activeView === 'core'} onPress={() => setView('core')} palette={c} testID="commentary-chip-core" />
            ) : null}
            {pinnedCount ? (
              <Chip label={`מועדפים ⭐ · ${pinnedCount}`} active={activeView === 'pinned'} onPress={() => setView('pinned')} palette={c} testID="commentary-chip-pinned" />
            ) : null}
          </View>
          {visible.length > 1 ? (
            <ScrollView
              ref={(n) => {
                pillsRef.current = n;
                setWebDir(n, 'ltr');
              }}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={[s.pillsScroll, nativeDir('ltr')]}
              contentContainerStyle={[s.pills, nativeDir('ltr'), { minWidth: pillsWidth }]}
              onLayout={(e) => setPillsWidth(Math.round(e.nativeEvent.layout.width))}
              onContentSizeChange={() => pillsRef.current?.scrollToEnd({ animated: false })}
              keyboardShouldPersistTaps="handled"
              testID="commentary-pills"
            >
              {visible
                .slice()
                .reverse()
                .map((g) => (
                  <Pressable
                    key={g.bookId}
                    onPress={() => jumpTo(g)}
                    style={[s.pill, g.core || g.isSource ? s.pillCore : null, focusKey === g.key && s.pillFocus]}
                    accessibilityRole="button"
                    accessibilityLabel={`עבור אל ${g.displayName}`}
                    testID="commentary-pill"
                  >
                    <Text style={[s.pillText, g.core || g.isSource ? s.pillTextCore : null]} numberOfLines={1}>
                      {g.pinned ? '★ ' : ''}
                      {g.displayName}
                    </Text>
                  </Pressable>
                ))}
            </ScrollView>
          ) : null}
      </Collapsible>

      {error ? (
        <Text style={s.message}>{error}</Text>
      ) : loading && !data ? (
        <ActivityIndicator style={{ marginTop: spacing.lg }} color={c.accent} />
      ) : !ranked.length ? (
        <Text style={s.message}>אין מפרשים לפסקה זו</Text>
      ) : !visible.length ? (
        <View style={{ alignItems: 'center' }}>
          <Text style={s.message}>אין פרשנים תואמים</Text>
          <Pressable
            onPress={() => {
              setQuery('');
              setView('all');
            }}
            style={[s.openBtn, { marginTop: spacing.sm }]}
            accessibilityRole="button"
            testID="commentary-filter-reset"
          >
            <Text style={s.openText}>הצג את כל המפרשים</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1, opacity: loading ? 0.5 : 1 }}
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          testID="commentary-list"
        >
          {visible.map(renderCard)}
        </ScrollView>
      )}
    </View>
  );
}

function Chip({ label, active, onPress, palette, testID }: { label: string; active: boolean; onPress: () => void; palette: Palette; testID: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={[chipStyles.chip, { borderColor: palette.accent }, active && { backgroundColor: palette.accent }]}
      accessibilityRole="button"
      aria-selected={active}
      accessibilityState={{ selected: active }}
      testID={testID}
    >
      <Text style={[chipStyles.text, { color: active ? palette.surface : palette.accent }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const chipStyles = StyleSheet.create({
  chip: { height: 26, paddingHorizontal: spacing.sm + 2, borderRadius: 13, borderWidth: 1, justifyContent: 'center' },
  text: { fontSize: 12, fontWeight: '700', writingDirection: 'rtl' },
});

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
    kicker: { fontSize: 15, fontWeight: '700', color: c.text, ...alignRight },
    where: { fontSize: 12, color: c.textMuted, ...alignRight },
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
    toolsToggle: { width: 34, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    toolsDot: { position: 'absolute', top: 3, end: 3, width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.5, backgroundColor: c.accent },
    message: { textAlign: 'center', marginTop: spacing.lg, fontSize: 15, color: c.textMuted },
    scroll: { paddingHorizontal: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.xl, gap: spacing.xs + 2 },
    tools: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.xs + 2,
      paddingBottom: spacing.xs,
      gap: spacing.xs + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    toolsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    filterBox: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      height: 32,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.surfaceMuted,
      gap: spacing.xs,
    },
    filterInput: { flex: 1, fontSize: 14, color: c.text, paddingVertical: 0, height: 32, ...inputAlignRight },
    clearText: { fontSize: 13, color: c.textMuted, paddingHorizontal: 2 },
    toggleAll: { height: 32, paddingHorizontal: spacing.sm, justifyContent: 'center', borderRadius: radius.md, backgroundColor: c.accentSoft },
    toggleAllText: { fontSize: 12, fontWeight: '700', color: c.accent },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + 2 },
    pillsScroll: { flexGrow: 0 },
    pills: { gap: spacing.xs + 2, alignItems: 'center', justifyContent: 'flex-end', flexDirection: 'row', paddingVertical: 2 },
    pill: {
      height: 28,
      maxWidth: 150,
      paddingHorizontal: spacing.sm + 2,
      borderRadius: 14,
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surfaceMuted,
    },
    pillCore: { backgroundColor: c.accentSoft, borderColor: c.accentSoft },
    pillFocus: { borderColor: c.accent, borderWidth: 1.5 },
    pillText: { fontSize: 13, fontWeight: '600', color: c.textMuted, writingDirection: 'rtl' },
    pillTextCore: { color: c.accent, fontWeight: '700' },
    card: {
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
      overflow: 'hidden',
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceMuted, paddingEnd: spacing.sm, gap: 2 },
    cardToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingStart: spacing.md, paddingVertical: spacing.sm, minWidth: 0 },
    chevron: { width: 14, textAlign: 'center', fontSize: 15, color: c.accent },
    groupName: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: c.accent, writingDirection: 'rtl' },
    tierTag: {
      fontSize: 11,
      color: c.textMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    tierCore: { color: c.accent, borderColor: c.accent },
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
    pinBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    pinText: { fontSize: 19, color: c.textMuted },
    blockPath: { fontSize: 12, color: c.textMuted, ...alignRight, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
    entry: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, gap: 2 },
    entryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
    entryPath: { flex: 1, fontSize: 12, color: c.textMuted, ...alignRight },
    entryOpen: { paddingHorizontal: 4, paddingTop: 2 },
    entryOpenText: { fontSize: 13, color: c.accent, opacity: 0.7 },
    openBtn: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.sm, backgroundColor: c.accentSoft },
    openText: { fontSize: 12, fontWeight: '600', color: c.accent },
    entryText: { color: c.text, writingDirection: 'rtl', textAlign: 'justify' },
  });
