/**
 * Personal-books list for the library manager.
 *
 * A personal library can hold thousands of books (a whole Otzaria folder imported as
 * personal books). Loading and rendering all of them when the screen opened froze the JS
 * thread and crashed the app, so this list is lazy and bounded:
 *  - nothing is queried until the user opens the list (the count comes from the in-memory
 *    book index);
 *  - opening it loads one summary row per folder (GROUP BY), shown a page at a time;
 *  - a folder's books are loaded only when that folder is expanded, a page at a time.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { USER_ROOT_NAME } from '../../../shared/sources';
import { useLibrary } from '../../db/LibraryContext';
import { useLibraryActions } from '../../services/libraryActions';
import { listUserBookIdsInFolder, listUserBooksInFolder, listUserFolders, type UserBookRow, type UserFolderRow } from '../../services/localIndexer';
import { useLibraryJobs } from '../../state/libraryJobs';
import { spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';

const FOLDER_PAGE = 30;
const BOOK_PAGE = 50;

const num = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('he-IL'));

function confirm(title: string, message: string, ok: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: 'ביטול', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: onOk },
  ]);
}

function folderName(path: string | null): string {
  const p = path ?? '';
  if (p === USER_ROOT_NAME) return USER_ROOT_NAME;
  return p.startsWith(`${USER_ROOT_NAME}/`) ? p.slice(USER_ROOT_NAME.length + 1) : p || USER_ROOT_NAME;
}

export function PersonalBooks() {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const lib = useLibrary();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ generation: number; folders: UserFolderRow[]; error: string | null } | null>(null);
  const [shown, setShown] = useState(FOLDER_PAGE);
  // Rows of an older library generation (before an import / delete) are stale: show the spinner.
  const current = data?.generation === lib.generation ? data : null;

  useEffect(() => {
    if (!open || data?.generation === lib.generation) return;
    let alive = true;
    const generation = lib.generation;
    listUserFolders(lib.user).then(
      (folders) => alive && setData({ generation, folders, error: null }),
      (e) => {
        console.warn('personal folders unreadable', e);
        if (alive) setData({ generation, folders: [], error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [open, data, lib.user, lib.generation]);

  if (lib.userBookCount === 0) return <Text style={s.empty}>עדיין לא יובאו ספרים.</Text>;

  return (
    <View style={s.wrap}>
      <Pressable onPress={() => setOpen((o) => !o)} style={({ pressed }) => [s.toggle, pressed && s.pressed]} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="toggle-user-books">
        <Text style={s.toggleText}>
          {open ? '▾' : '◂'} {num(lib.userBookCount)} ספרים אישיים — {open ? 'הסתר רשימה' : 'הצג רשימה'}
        </Text>
      </Pressable>

      {!open ? null : current == null ? (
        <ActivityIndicator color={c.accent} />
      ) : current.error ? (
        <Text style={s.error}>{current.error}</Text>
      ) : (
        <>
          {current.folders.slice(0, shown).map((f) => (
            <FolderRow key={`${f.category_id ?? 'none'}-${current.generation}`} folder={f} />
          ))}
          {current.folders.length > shown ? (
            <Pressable onPress={() => setShown((n) => n + FOLDER_PAGE)} hitSlop={6} testID="more-folders">
              <Text style={s.link}>הצג עוד תיקיות ({num(current.folders.length - shown)} נותרו)</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

function FolderRow({ folder }: { folder: UserFolderRow }) {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const lib = useLibrary();
  const actions = useLibraryActions();
  const busy = useLibraryJobs((x) => !!x.job);
  const [expanded, setExpanded] = useState(false);
  const [books, setBooks] = useState<UserBookRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const name = folderName(folder.category_path);
  const count = Number(folder.book_count) || 0;

  const loadMore = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const page = await listUserBooksInFolder(lib.user, folder.category_id, BOOK_PAGE, books?.length ?? 0);
      setBooks((prev) => [...(prev ?? []), ...page]);
    } catch (e) {
      console.warn('personal books unreadable', e);
      setBooks((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [books, folder.category_id, lib.user, loading]);

  const onToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && books == null) void loadMore();
  };

  const onDeleteFolder = () =>
    confirm('מחיקת תיקייה', `למחוק את כל ${num(count)} הספרים בתיקייה "${name}"?`, 'מחק הכול', () => {
      listUserBookIdsInFolder(lib.user, folder.category_id)
        .then((ids) => {
          if (ids.length) void actions.deleteUserBooks(ids);
        })
        .catch((e) => console.warn('folder delete failed', e));
    });

  const onDeleteBook = (b: UserBookRow) => confirm('מחיקת ספר', `למחוק את "${b.title}" מהספרים האישיים?`, 'מחק', () => void actions.deleteUserBooks([b.id]));

  return (
    <View style={s.group}>
      <View style={s.groupHead}>
        <Pressable onPress={onToggle} style={s.groupToggle} hitSlop={6} accessibilityRole="button" accessibilityState={{ expanded }}>
          <Text style={s.groupTitle} numberOfLines={1}>
            {expanded ? '▾' : '◂'} 📁 {name}
          </Text>
          <Text style={s.groupMeta}>
            {num(count)} ספרים · {num(folder.total_lines)} שורות
          </Text>
        </Pressable>
        {count > 1 ? (
          <Pressable onPress={onDeleteFolder} disabled={busy} hitSlop={6}>
            <Text style={[s.dangerLink, busy && s.disabled]}>מחק תיקייה</Text>
          </Pressable>
        ) : null}
      </View>

      {expanded ? (
        <>
          {(books ?? []).map((b) => (
            <View key={b.id} style={s.bookRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.bookTitle} numberOfLines={1}>
                  {b.title}
                </Text>
                <Text style={s.bookMeta}>{num(b.total_lines)} שורות</Text>
              </View>
              <Pressable onPress={() => onDeleteBook(b)} disabled={busy} hitSlop={8} accessibilityRole="button" accessibilityLabel={`מחק ${b.title}`} testID={`delete-book-${b.id}`}>
                <Text style={[s.dangerLink, busy && s.disabled]}>מחק</Text>
              </Pressable>
            </View>
          ))}
          {loading ? <ActivityIndicator color={c.accent} /> : null}
          {!loading && books != null && books.length < count ? (
            <Pressable onPress={() => void loadMore()} hitSlop={6}>
              <Text style={[s.link, s.indent]}>הצג עוד ספרים ({num(count - books.length)} נותרו)</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { gap: spacing.sm },
    empty: { fontSize: 14, color: c.textMuted, lineHeight: 20, writingDirection: 'rtl' },
    error: { color: c.danger, fontSize: 14, writingDirection: 'rtl' },
    toggle: { paddingVertical: spacing.sm },
    toggleText: { fontSize: 15, fontWeight: '700', color: c.accent, writingDirection: 'rtl' },
    pressed: { opacity: 0.7 },
    link: { color: c.accent, fontSize: 13, writingDirection: 'rtl' },
    indent: { paddingStart: spacing.lg },
    group: { gap: spacing.xs },
    groupHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
    groupToggle: { flex: 1 },
    groupTitle: { fontSize: 15, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    groupMeta: { fontSize: 12, color: c.textMuted, writingDirection: 'rtl' },
    bookRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingStart: spacing.lg, paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    bookTitle: { fontSize: 15, color: c.text, writingDirection: 'rtl' },
    bookMeta: { fontSize: 12, color: c.textMuted },
    dangerLink: { color: c.danger, fontSize: 14, fontWeight: '600' },
    disabled: { opacity: 0.45 },
  });
