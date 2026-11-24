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
 *    תרגומים -> ראשונים -> אחרונים -> מחברי זמננו -> alphabetical. The order is the only sign of
 *    priority: every commentator card / pill looks the same (no עיקריים / נוספים groups or badges);
 *    only another content role is badged: תרגומים, מקבילים (⇄) and the base text (מקור);
 *  - only favorites + the top 3 open by default; the rest are one-line headers (the user's own
 *    open / close choices stick while moving between verses);
 *  - a sticky tools header: name filter that understands abbreviations ("מ"ב", "אב"ע", "תוס"),
 *    open-all / collapse-all, and a horizontal strip of
 *    commentator pills — one tap scrolls to a commentator and opens it. It is folded away by
 *    default (the commentaries start right under the title bar) and toggled by the "סינון"
 *    button in the title bar, which carries a dot while a name filter is active.
 *    Picking a commentator collapses the chip strip + filter row together (reading space); the same
 *    toggle reopens both; a long-press multi-select keeps them open; `?` explains the long-press.
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
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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

import { formatCopy } from '../../../shared/copyFormat';
import { fetchLinkedEntries, groupLinkedEntries, mergeParallelGroups, parallelGroups, type CommentaryGroup, type LinkedEntry } from '../../../shared/commentary';
import { defaultExpandedKeys, filterCommentaries, kindCounts, rankCommentaries, selectCommentaries, type Ranked } from '../../../shared/commentaryRank';
import { findParallels, type ParallelResult } from '../../../shared/parallelWorks';
import { prepareDisplayText } from '../../../shared/reader';
import { lineHeightPx } from '../../../shared/typography';
import { useLibrary } from '../../db/LibraryContext';
import { readerFont } from '../../fonts';
import { alignRight, inputAlignRight, nativeDir, setWebDir } from '../../lib/direction';
import { useCommentaryPrefs } from '../../state/commentaryStore';
import { COMMENTARY_RATIO, useSettings } from '../../state/settingsStore';
import { radius, spacing, useAppTheme, type Palette } from '../../theme';
import { Collapsible } from '../Collapsible';
import { ParagraphToolbar, useCopyMode, useCopyToast } from './CopyToolbar';
import { SlidersIcon } from '../Icons';
import { RichText } from '../RichText';

type RankedGroup = Ranked<CommentaryGroup>;

const GRABBER_HEIGHT = 12;

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
  const selection = useCommentaryPrefs((x) => x.selection);
  const selectChip = useCommentaryPrefs((x) => x.selectChip);
  const clearSelection = useCommentaryPrefs((x) => x.clearSelection);

  // --- data --------------------------------------------------------------------
  const [data, setData] = useState<{ key: string; groups: CommentaryGroup[]; coordinate: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${bookId}:${line}`;
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchLinkedEntries(adapter, bookId, line),
      // Parallel works (shared/parallelWorks.js): resolved from the TOCs; never blocks the commentaries.
      findParallels(adapter, bookId, line).catch((): ParallelResult | null => null),
    ]).then(
      ([entries, par]: [LinkedEntry[], ParallelResult | null]) => {
        if (!alive) return;
        setError(null);
        setData({ key, groups: mergeParallelGroups(groupLinkedEntries(entries), parallelGroups(par)), coordinate: par?.coordinate?.label ?? null });
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
  const [query, setQuery] = useState('');
  // Chip-bar selection (sticky across verses); keys this passage lacks simply match nothing.
  const selected = useMemo(() => selectCommentaries(ranked, selection), [ranked, selection]);
  const selecting = selection.length > 0;
  // Counts for the title ("מפרשים (2) · מקבילים (1)"). The chip strip has no category buttons: commentators,
  // translations and parallel works are all plain chips (sorted by priority).
  const counts = useMemo(() => kindCounts(ranked), [ranked]);
  const visible = useMemo(() => filterCommentaries(selected, { query }), [selected, query]);
  // Name(s) of the active commentator selection, shown in the sticky header (one name, or "name +N").
  const activeNames = selecting ? selected.map((g) => g.displayName) : [];
  const activeLabel = activeNames.length ? (activeNames.length === 1 ? activeNames[0] : `${activeNames[0]} +${activeNames.length - 1}`) : '';
  const hasOwn = visible.some((g) => !g.isParallel);
  // One commentator isolated in the chip bar: ultra-compact reading mode (no card header).
  const focusMode = selection.length === 1 && visible.length === 1;
  const defaults = useMemo(() => defaultExpandedKeys(ranked), [ranked]);
  // A narrow name filter opens what it found (as if tapped, so it can still be collapsed).
  const narrowKeys = query.trim() && visible.length <= 3 ? visible.map((g) => g.key).join('\n') : '';
  useEffect(() => {
    if (narrowKeys) setExpanded(Object.fromEntries(narrowKeys.split('\n').map((k) => [k, true])));
  }, [narrowKeys, setExpanded]);
  // Chosen commentators read open, stacked one after another; הכל keeps the smart default.
  const isExpanded = (g: RankedGroup) => expandedOverrides[g.key] ?? (selecting || defaults.has(g.key));
  const allExpanded = visible.length > 0 && visible.every(isExpanded);
  const toggleAll = () => setExpanded(Object.fromEntries(visible.map((g) => [g.key, !allExpanded])));
  const filtering = !!query.trim();
  const showTools = ranked.length >= TOOLS_MIN_GROUPS || !!query;
  // The controls panel = the commentator chip strip + the name filter / open-all row, opened and closed
  // together by the toolbar toggle. 'auto': the strip is there while nothing is selected (to pick one),
  // the filter row stays folded; picking a commentator collapses everything (reading space);
  // 'open': strip + filter row (also kept while a long-press multi-select is in progress); 'closed'.
  const [panel, setPanel] = useState<'auto' | 'open' | 'closed'>('auto');
  const stripOpen = panel === 'open' || (panel === 'auto' && !selecting);
  const toolsOpen = panel === 'open';
  // The toolbar toggle is "on" while the whole panel (strip + filter row) is open.
  const panelOn = toolsOpen;
  const [helpOpen, setHelpOpen] = useState(false);
  const onChip = (g: RankedGroup, gesture: 'tap' | 'longpress') => {
    selectChip(g.key, gesture);
    setExpanded({ [g.key]: true });
    // A tap that isolates a commentator (from הכל / another single) is "done picking": collapse.
    // Long-press (multi-select) and taps inside a 2+ selection keep the panel open.
    if (gesture === 'tap' && selection.length < 2) setPanel(selection.includes(g.key) ? 'auto' : 'closed');
    else if (gesture === 'longpress') setPanel('open');
  };
  const togglePanel = () => {
    setHelpOpen(false);
    // Nothing selected: the chip strip always stays (to pick from), the toggle shows / hides the filter row.
    // A selection is active: the toggle shows / hides strip + filter row together.
    setPanel(panelOn ? (selecting ? 'closed' : 'auto') : 'open');
  };

  // --- scrolling ---------------------------------------------------------------------
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Back to the top of the list whenever the drawer moves to another paragraph or selection.
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [key, selection]);

  // Chip bar: LTR strip with reversed items, so the first (top-priority) chip sits at the right
  // edge on every platform; kept scrolled to that edge.
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
  // Compact location for the title row: the chapter / daf level (parent of the verse), else the leaf.
  const where = crumbs.length ? crumbs[crumbs.length > 1 ? crumbs.length - 2 : 0] : `שורה ${line}`;
  // Same vocalization-aware leading as the reader (commentaries quote vocalized verses).
  const entryTextStyle = [s.entryText, { fontFamily: font.regular, fontSize: entrySize, lineHeight: lineHeightPx(entrySize, lineHeight, { showNikkud, showCantillation }) }];

  // --- long-press toolbar (open in book / copy with or without citation / select) ------------------
  const copyMode = useCopyMode();
  const copyToast = useCopyToast();
  const entryKey = (e: { book_id: number; line: number }) => `${e.book_id}:${e.line}`;
  /** Entries of the open cards, in reading order. */
  const openEntries = () => visible.filter((g) => focusMode || isExpanded(g)).flatMap((g) => g.entries);
  const entryOrder = () => openEntries().map(entryKey);
  const copyEntries = (keys: string[]) => {
    const want = new Set(keys);
    return openEntries()
      .filter((e) => want.has(entryKey(e)))
      .map((e) => ({ bookTitle: e.book_title, tocPath: e.toc_path, html: prepareDisplayText(e.display_text ?? '', { showNikkud, showCantillation }) }));
  };
  const copyKeys = copyMode.state.mode === 'actions' ? [copyMode.state.key] : copyMode.state.mode === 'select' ? copyMode.state.keys : [];
  const doCopy = (citation: boolean) => {
    void copyToast.copy(formatCopy(copyEntries(copyKeys), { citation }));
    copyMode.reset();
  };
  const actionEntry = copyMode.state.mode === 'actions' ? openEntries().find((e) => entryKey(e) === (copyMode.state as { key: string }).key) : undefined;

  const openGroup = (g: RankedGroup) => {
    // A parallel work opens at the start of its סימן / פרק / פרשה (no whole-unit highlight).
    if (g.isParallel && g.block) onOpenEntry({ bookId: g.bookId, bookTitle: g.bookTitle, line: g.block.start });
    else if (g.block) onOpenEntry({ bookId: g.bookId, bookTitle: g.bookTitle, line: g.block.start, endLine: g.block.end });
    else if (g.entries[0]) onOpenEntry({ bookId: g.bookId, bookTitle: g.bookTitle, line: g.entries[0].line });
  };

  /** The commentary's own heading path ("דף ב. · שורה ה"); the book name is already visible. */
  const blockLabel = (g: RankedGroup) =>
    g.isParallel && g.block ? g.block.refKey : g.block ? (g.entries[0]?.toc_path ?? g.block.refKey.replace(/\|/g, ' > ')).split(' > ').join(' · ') : '';

  const pinButton = (g: RankedGroup) => (
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
  );
  const openButton = (g: RankedGroup) => (
    <Pressable
      onPress={() => openGroup(g)}
      hitSlop={6}
      style={g.isParallel ? s.openBtnParallel : s.openBtn}
      accessibilityRole="button"
      accessibilityLabel={g.block ? `פתח את ${g.bookTitle} ב${g.block.refKey.split('|').join(' ')}` : `פתח את ${g.bookTitle} בכרטיסייה`}
      testID={g.isParallel ? 'parallel-open' : g.block ? 'commentary-open-block' : 'commentary-open-group'}
    >
      <Text style={g.isParallel ? s.openTextParallel : s.openText}>פתח בספר ↗</Text>
    </Pressable>
  );

  // `focus`: one commentator isolated in the chip bar -> no card chrome and no repeated name;
  // just a slim location + actions row above the text.
  const renderCard = (g: RankedGroup, focus: boolean) => {
    const open = focus || isExpanded(g);
    const label = blockLabel(g);
    const par = !!g.isParallel;
    return (
      <View key={g.bookId} style={focus ? s.cardFocus : [s.card, par && s.cardParallel]} testID={par ? 'parallel-group' : 'commentary-group'}>
        {focus ? (
          <View style={s.focusRow} accessibilityLabel={g.displayName} testID={par ? 'parallel-focus-row' : 'commentary-focus-row'}>
            {par ? (
              <Text style={s.focusLabel} numberOfLines={1} testID="parallel-block">
                {`⇄ ${g.displayName} · ${label}`}
              </Text>
            ) : g.block ? (
              <Text style={s.focusLabel} numberOfLines={1} testID="commentary-block">
                {label}
              </Text>
            ) : (
              <Text style={s.focusLabel} numberOfLines={1}>
                {g.entries.length} קטעים
              </Text>
            )}
            {pinButton(g)}
            {openButton(g)}
          </View>
        ) : (
          <View style={s.cardHeader}>
            <Pressable
              onPress={() => setExpanded({ [g.key]: !open })}
              style={s.cardToggle}
              accessibilityRole="button"
              aria-expanded={open}
              accessibilityState={{ expanded: open }}
              accessibilityLabel={par ? `${g.displayName}, ספר מקביל, ${label}` : g.kind === 'targum' || g.isSource ? `${g.displayName}, ${g.tier}, ${g.entries.length}` : `${g.displayName}, ${g.entries.length}`}
              testID={par ? 'parallel-group-header' : 'commentary-group-header'}
            >
              <Text style={s.chevron}>{open ? '⌄' : '‹'}</Text>
              <Text style={[s.groupName, { fontFamily: font.bold }]} numberOfLines={1} testID={par ? 'parallel-group-name' : 'commentary-group-name'}>
                {g.displayName}
              </Text>
              {/* Only a different ROLE is badged (מקבילים / תרגומים / מקור); every commentator looks the same. */}
              {par || g.kind === 'targum' || g.isSource ? (
                <Text style={[s.tierTag, par ? s.tierParallel : s.tierRole]} numberOfLines={1} testID={par ? 'parallel-tier' : 'commentary-tier'}>
                  {par ? '⇄ מקביל' : g.tier}
                </Text>
              ) : null}
              {(open || par) && g.block ? (
                // A parallel work always shows WHICH unit it is (or סימן יב / פרק א / פרשת נח).
                <Text style={s.inlineLabel} numberOfLines={1} testID={par ? 'parallel-block' : 'commentary-block'}>
                  {label}
                </Text>
              ) : (
                <View style={{ flex: 1 }} />
              )}
              {par ? null : <Text style={s.groupCount}>{g.entries.length}</Text>}
            </Pressable>
            {pinButton(g)}
            {openButton(g)}
          </View>
        )}
        {open
          ? g.entries.map((e) => (
              <Pressable
                key={`${e.book_id}:${e.line}`}
                // A tap never opens the toolbar (reading / scrolling); only a long-press does. While selecting a tap toggles.
                onPress={() => (copyMode.selecting ? copyMode.toggle(entryKey(e)) : copyMode.state.mode === 'actions' ? copyMode.reset() : undefined)}
                onLongPress={() => (copyMode.selecting ? copyMode.rangeTo(entryKey(e), entryOrder()) : copyMode.openActions(entryKey(e)))}
                delayLongPress={450}
                style={[s.entry, g.block && e.direct ? { borderStartWidth: 3, borderStartColor: c.accent } : null, copyMode.marked(entryKey(e)) && { backgroundColor: c.accentSoft }]}
                testID={par ? 'parallel-entry' : e.direct && g.block ? 'commentary-entry-direct' : 'commentary-entry'}
              >
                {/* A block / parallel unit is named once in the card header: never repeated per paragraph. */}
                {g.block || par ? null : (
                  <Text style={s.entryPath} numberOfLines={1}>
                    {e.toc_path ? e.toc_path.split(' > ').join(' · ') : g.bookTitle}
                  </Text>
                )}
                <View style={s.entryRow}>
                  <RichText
                    html={prepareDisplayText(e.display_text ?? '—', { showNikkud, showCantillation })}
                    fontSize={entrySize}
                    boldFamily={font.bold}
                    style={[entryTextStyle, { flex: 1 }]}
                    selectable={copyMode.selecting}
                  />
                </View>
              </Pressable>
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
        <Text style={s.title} numberOfLines={1} testID="commentary-title">
          {activeLabel ? (
            <Text testID="commentary-active-name" accessibilityLabel={`מפרש פעיל: ${activeLabel}`}>{`מפרשים · ${activeLabel}`}</Text>
          ) : (
            <>
              {/* "מפרשים (2) · מקבילים (1)"; a passage with parallel works only: "מקבילים (1)". */}
              {counts.commentary + counts.targum || !counts.parallel ? `מפרשים${counts.commentary + counts.targum ? ` (${counts.commentary + counts.targum})` : ''}` : ''}
              {counts.parallel ? `${counts.commentary + counts.targum ? ' · ' : ''}מקבילים (${counts.parallel})` : ''}
            </>
          )}
          {where ? ` · ${where}` : ''}
        </Text>
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
        {(showTools || ranked.length >= 2) && !error ? (
          <Pressable
            onPress={togglePanel}
            hitSlop={6}
            style={[s.toolsToggle, panelOn && { backgroundColor: c.accentSoft }]}
            accessibilityRole="button"
            aria-expanded={panelOn}
            accessibilityState={{ expanded: panelOn }}
            accessibilityLabel={`${panelOn ? 'הסתר' : 'הצג'} בחירת מפרשים וסינון${filtering ? ' (סינון פעיל)' : ''}`}
            testID="commentary-tools-toggle"
          >
            <SlidersIcon size={16} />
            {filtering && !panelOn ? <View style={[s.toolsDot, { borderColor: c.surface }]} testID="commentary-tools-badge" /> : null}
          </Pressable>
        ) : null}
        <IconButton label="✕" a11y="סגור מפרשים" onPress={onClose} palette={c} testID="commentary-close" />
      </View>

      {ranked.length >= 2 && !error && stripOpen ? (
        <View style={s.chipRow} testID="commentary-chipstrip">
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
          testID="commentary-chipbar"
        >
          {ranked
            .slice()
            .reverse()
            .map((g) => {
              const on = selection.includes(g.key);
              const par = !!g.isParallel;
              return (
                <Pressable
                  key={g.bookId}
                  onPress={() => onChip(g, 'tap')}
                  onLongPress={() => onChip(g, 'longpress')}
                  delayLongPress={450}
                  style={[s.pill, par ? s.pillParallel : null, on && s.pillOn]}
                  accessibilityRole="button"
                  aria-pressed={on}
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={par ? `${g.displayName} (ספר מקביל, ${blockLabel(g)}): הקשה להצגה` : `${g.displayName}: הקשה למפרש בודד, לחיצה ארוכה להוספה לבחירה`}
                  testID={par ? 'commentary-chip-parallel' : 'commentary-chip'}
                >
                  <Text style={[s.pillText, par ? s.pillTextParallel : null, on && s.pillTextOn]} numberOfLines={1}>
                    {g.pinned ? '★ ' : ''}
                    {par ? '⇄ ' : ''}
                    {g.displayName}
                  </Text>
                </Pressable>
              );
            })
            .concat(
              <Pressable
                key="all"
                onPress={() => {
                  clearSelection();
                  setPanel('auto');
                }}
                style={[s.pill, s.pillCore, !selecting && s.pillOn]}
                accessibilityRole="button"
                aria-pressed={!selecting}
                accessibilityState={{ selected: !selecting }}
                testID="commentary-chip-all"
              >
                <Text style={[s.pillText, s.pillTextCore, !selecting && s.pillTextOn]} numberOfLines={1}>
                  הכל
                </Text>
              </Pressable>,
            )}
        </ScrollView>
        <Pressable
          onPress={() => setHelpOpen((v) => !v)}
          hitSlop={6}
          style={[s.helpBtn, helpOpen && { backgroundColor: c.accentSoft }]}
          accessibilityRole="button"
          accessibilityLabel="עזרה: בחירת כמה פרשנים"
          aria-expanded={helpOpen}
          accessibilityState={{ expanded: helpOpen }}
          testID="commentary-help"
        >
          <Text style={s.helpText}>?</Text>
        </Pressable>
        </View>
      ) : null}
      {ranked.length >= 2 && !error && stripOpen && helpOpen ? (
        <Pressable onPress={() => setHelpOpen(false)} style={s.hint} accessibilityRole="button" accessibilityLabel="סגור את ההסבר" testID="commentary-help-hint">
          <Text style={s.hintText}>לחיצה ארוכה על פרשן מאפשרת לבחור אותו בנוסף לפרשנים אחרים</Text>
        </Pressable>
      ) : null}

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
      </Collapsible>

      {copyMode.state.mode !== 'idle' ? (
        <ParagraphToolbar
          style={s.copyBar}
          info={copyMode.state.mode === 'select' ? `${copyMode.state.keys.length} נבחרו` : null}
          actions={[
            ...(copyMode.state.mode === 'actions' && actionEntry
              ? [
                  {
                    key: 'open',
                    label: 'פתח בספר',
                    onPress: () => {
                      onOpenEntry({ bookId: actionEntry.book_id, bookTitle: actionEntry.book_title, line: actionEntry.line });
                      copyMode.reset();
                    },
                    testID: 'copy-open-in-book',
                    primary: true,
                  },
                ]
              : []),
            { key: 'plain', label: 'העתק', onPress: () => doCopy(false), testID: 'copy-plain' },
            { key: 'cite', label: 'העתק עם מקור', onPress: () => doCopy(true), testID: 'copy-with-citation', primary: copyMode.state.mode === 'select' },
            ...(copyMode.state.mode === 'actions' ? [{ key: 'select', label: 'בחירת טקסט', onPress: copyMode.startSelect, testID: 'copy-select' }] : []),
          ]}
          closeLabel={copyMode.state.mode === 'select' ? 'סיום' : undefined}
          onClose={copyMode.reset}
        />
      ) : null}

      {error ? (
        <Text style={s.message}>{error}</Text>
      ) : loading && !data ? (
        <ActivityIndicator style={{ marginTop: spacing.lg }} color={c.accent} />
      ) : !ranked.length ? (
        <Text style={s.message}>אין מפרשים לפסקה זו</Text>
      ) : !visible.length ? (
        <View style={{ alignItems: 'center' }}>
          <Text style={s.message} testID="commentary-empty">
            {selecting && !query.trim() ? 'אין פירוש של המפרשים שנבחרו לקטע זה' : 'אין פרשנים תואמים'}
          </Text>
          <Pressable
            onPress={() => {
              setQuery('');
              clearSelection();
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
          {visible.map((g, i) => (
            <Fragment key={g.bookId}>
              {g.isParallel && !focusMode && (i === 0 || !visible[i - 1].isParallel) ? (
                // Parallel works are independent books, not commentators: their own labelled section.
                <View style={s.sectionRow} testID="parallel-section">
                  <Text style={s.sectionTitle} numberOfLines={1}>
                    {`⇄ מקבילים${data?.coordinate ? ' · ' + data.coordinate : ''}`}
                  </Text>
                  {hasOwn ? <Text style={s.sectionHint}>ספרים עצמאיים</Text> : null}
                </View>
              ) : null}
              {renderCard(g, focusMode)}
            </Fragment>
          ))}
        </ScrollView>
      )}
      {copyToast.toast}
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
      paddingEnd: spacing.xs,
      height: 36,
      gap: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    title: { flex: 1, fontSize: 14, fontWeight: '700', color: c.text, ...alignRight },
    followBtn: {
      paddingHorizontal: spacing.sm,
      height: 24,
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.accent,
      marginHorizontal: 2,
    },
    followText: { fontSize: 11, fontWeight: '600', color: c.accent },
    toolsToggle: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    toolsDot: { position: 'absolute', top: 3, end: 3, width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.5, backgroundColor: c.accent },
    message: { textAlign: 'center', marginTop: spacing.lg, fontSize: 15, color: c.textMuted },
    scroll: { paddingHorizontal: spacing.xs, paddingTop: spacing.xs, paddingBottom: spacing.lg, gap: spacing.xs },
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
    chipRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, backgroundColor: c.surface },
    helpBtn: { width: 22, height: 22, marginHorizontal: spacing.xs, borderRadius: 11, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    helpText: { fontSize: 12, fontWeight: '700', color: c.textMuted },
    hint: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, backgroundColor: c.accentSoft },
    hintText: { fontSize: 12, color: c.text, ...alignRight },
    pillsScroll: { flexGrow: 1, flexShrink: 1, backgroundColor: c.surface },
    pills: { gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: 3, alignItems: 'center', justifyContent: 'flex-end', flexDirection: 'row' },
    pill: {
      height: 28,
      maxWidth: 150,
      paddingHorizontal: spacing.sm,
      borderRadius: 14,
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surfaceMuted,
    },
    pillCore: { backgroundColor: c.accentSoft, borderColor: c.accentSoft },
    pillParallel: { backgroundColor: c.surface, borderColor: c.accent, borderStyle: 'dashed', borderWidth: 1 },
    pillTextParallel: { color: c.accent },
    pillOn: { backgroundColor: c.accent, borderColor: c.accent },
    pillText: { fontSize: 13, fontWeight: '600', color: c.textMuted, writingDirection: 'rtl' },
    pillTextCore: { color: c.accent, fontWeight: '700' },
    pillTextOn: { color: c.surface },
    card: {
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
      overflow: 'hidden',
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceMuted, height: 34, paddingEnd: spacing.xs, gap: 2 },
    cardFocus: { backgroundColor: c.surface },
    cardParallel: { borderStyle: 'dashed', borderColor: c.accent },
    sectionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, height: 22, paddingHorizontal: spacing.sm, marginTop: spacing.xs },
    sectionTitle: { flex: 1, fontSize: 12, fontWeight: '700', color: c.accent, ...alignRight },
    sectionHint: { fontSize: 11, color: c.textMuted },
    focusRow: { flexDirection: 'row', alignItems: 'center', height: 28, paddingHorizontal: spacing.sm, gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    focusLabel: { flex: 1, fontSize: 12, fontWeight: '600', color: c.textMuted, ...alignRight },
    inlineLabel: { flex: 1, fontSize: 11, color: c.textMuted, ...alignRight },
    cardToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, paddingStart: spacing.sm, height: 34, minWidth: 0 },
    chevron: { width: 14, textAlign: 'center', fontSize: 15, color: c.accent },
    groupName: { flexShrink: 0, maxWidth: '55%', fontSize: 15, fontWeight: '700', color: c.accent, writingDirection: 'rtl' },
    tierTag: {
      fontSize: 11,
      color: c.textMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    tierRole: { color: c.textMuted, borderColor: c.border },
    tierParallel: { color: c.accent, borderColor: c.accent, borderStyle: 'dashed' },
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
    pinBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    pinText: { fontSize: 17, color: c.textMuted },
    entry: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, gap: 2 },
    entryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
    entryPath: { flex: 1, fontSize: 12, color: c.textMuted, ...alignRight },
    copyBar: { marginHorizontal: spacing.sm, marginVertical: spacing.xs },
    openBtn: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: c.accentSoft },
    openText: { fontSize: 12, fontWeight: '600', color: c.accent },
    // Parallel works: the prominent action is to open the parallel סימן / פרק / פרשה itself.
    openBtnParallel: { paddingHorizontal: spacing.sm, height: 24, justifyContent: 'center', borderRadius: radius.sm, backgroundColor: c.accent },
    openTextParallel: { fontSize: 12, fontWeight: '700', color: c.surface },
    entryText: { color: c.text, writingDirection: 'rtl', textAlign: 'justify', includeFontPadding: true },
  });
