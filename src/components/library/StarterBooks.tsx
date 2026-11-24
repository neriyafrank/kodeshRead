/**
 * Instant cloud starter (Library screen while no full library is installed): the well-known
 * base books of starter-catalog.json in canonical order, each loadable in ~1 second with its primary
 * commentaries. A book that was opened once is stored in starter_library.db and works offline.
 *
 *   ┌ ספריית התחלה מהענן · להורדת ספרייה לאופליין וחיפוש מלא: בסיסית (ללא אחרוני זמננו) או מלאה   [הורד ספרייה מלאה] ┐
 *   תנ"ך                                                     (section heading)
 *     בראשית   תורה · עם רש"י, אונקלוס                    ☁ · 165 KB
 *     במדבר    תורה                                         ✓ זמין לא מקוון
 */
import { useRouter } from 'expo-router';
import type { ReactElement } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatBytes } from '../../../shared/multipart';
import type { StarterCatalogEntry } from '../../../shared/starterPacks';
import { alignRight, isolateLtr } from '../../lib/direction';
import { useLoadedStarterPaths, useOpenStarterBook, useStarterCatalog } from '../../services/starterLibrary';
import { useStarter, type StarterPhase } from '../../state/starterStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';

interface Props {
  onOpenBook: (bookId: number, title: string) => void;
  /** Rendered after the list (the onboarding card with the import option). */
  footer?: ReactElement | null;
  /** Share the screen with the personal library: the list scrolls inside a bounded height. */
  compact?: boolean;
}

/** Catalog order is the canonical order; consecutive books of one category share a heading. */
function groupByCategory(books: StarterCatalogEntry[]): { category: string; books: StarterCatalogEntry[] }[] {
  const out: { category: string; books: StarterCatalogEntry[] }[] = [];
  for (const b of books) {
    const last = out[out.length - 1];
    if (last && last.category === b.category) last.books.push(b);
    else out.push({ category: b.category, books: [b] });
  }
  return out;
}

const PHASE_TEXT: Record<StarterPhase, (title: string) => string> = {
  download: (t) => `טוען את ${t} מהענן…`,
  verify: (t) => `טוען את ${t} מהענן…`,
  import: (t) => `מכין את ${t} לקריאה…`,
};

export function StarterBooks({ onOpenBook, footer, compact }: Props) {
  const s = useThemedStyles(createStyles);
  const colors = useAppTheme();
  const router = useRouter();
  const { status, catalog, stale, error, retry } = useStarterCatalog(true);
  const loaded = useLoadedStarterPaths();
  const busy = useStarter((x) => x.busy);
  const failed = useStarter((x) => x.failed);
  const open = useOpenStarterBook();

  const tap = (entry: StarterCatalogEntry) => {
    if (busy[entry.slug]) return;
    open(entry).then(
      (r) => onOpenBook(r.bookId, r.title),
      () => undefined, // the row shows the error and a retry
    );
  };

  const groups = catalog ? groupByCategory(catalog.books) : [];

  return (
    <ScrollView style={compact ? s.compact : s.flex} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" testID="starter-books">
      <View style={s.banner} testID="starter-upgrade-banner">
        <Text style={s.bannerText}>ספריית התחלה מהענן · להורדת ספרייה לאופליין וחיפוש מלא: בסיסית (ללא אחרוני זמננו) או מלאה</Text>
        <Pressable onPress={() => router.navigate('/library-manager')} style={({ pressed }) => [s.bannerBtn, pressed && s.pressed]} accessibilityRole="button" testID="starter-upgrade-button">
          <Text style={s.bannerBtnText}>הורד ספרייה מלאה</Text>
        </Pressable>
      </View>

      {status === 'loading' && !catalog ? (
        <View style={s.status} testID="starter-catalog-loading">
          <ActivityIndicator color={colors.accent} />
          <Text style={s.muted}>טוען את רשימת הספרים מהענן…</Text>
        </View>
      ) : null}
      {status === 'error' && !catalog ? (
        <View style={s.status} testID="starter-catalog-error">
          <Text style={s.error}>{error ?? 'לא ניתן לטעון את רשימת הספרים'}</Text>
          <Pressable onPress={retry} accessibilityRole="button" testID="starter-retry">
            <Text style={s.link}>נסה שוב</Text>
          </Pressable>
        </View>
      ) : null}
      {stale && catalog ? (
        <View style={s.status} testID="starter-stale">
          <Text style={s.muted}>מוצגת רשימה שמורה{error ? ` · ${error}` : ''}.</Text>
          <Pressable onPress={retry} accessibilityRole="button" testID="starter-retry">
            <Text style={s.link}>נסה שוב</Text>
          </Pressable>
        </View>
      ) : null}

      {groups.map((g, gi) => (
        <View key={`${g.category}-${gi}`} style={s.group} testID={`starter-section-${gi}`}>
          <Text style={s.heading}>{g.category}</Text>
          {g.books.map((b) => {
            const isLoaded = loaded.has(b.filePath);
            const phase = busy[b.slug];
            const err = failed[b.slug];
            const sub = [b.subcategory, b.bundledCommentaries.length ? `עם ${b.bundledCommentaries.map((c) => c.name).join(', ')}` : ''].filter(Boolean).join(' · ');
            return (
              <Pressable
                key={b.slug}
                onPress={() => tap(b)}
                disabled={!!phase}
                style={({ pressed }) => [s.row, pressed && s.pressed]}
                accessibilityRole="button"
                accessibilityState={{ busy: !!phase }}
                testID={`starter-book-${b.slug}`}
              >
                <View style={s.rowText}>
                  <Text style={s.title} numberOfLines={2}>
                    {b.title}
                  </Text>
                  {phase ? (
                    <Text style={s.loading} testID={`starter-loading-${b.slug}`}>
                      {PHASE_TEXT[phase](b.title)}
                    </Text>
                  ) : sub ? (
                    <Text style={s.sub} numberOfLines={2}>
                      {sub}
                    </Text>
                  ) : null}
                  {err ? (
                    <Text style={s.error} testID={`starter-error-${b.slug}`}>
                      {err} · לחצו לנסות שוב
                    </Text>
                  ) : null}
                </View>
                {phase ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Text style={[s.badge, isLoaded && s.badgeOn]} testID={`starter-badge-${b.slug}`}>
                    {isLoaded ? '✓ זמין לא מקוון' : isolateLtr(`☁ · ${formatBytes(b.sizeBytes)}`)}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
      {footer}
    </ScrollView>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    compact: { maxHeight: 300, flexGrow: 0 },
    content: { padding: spacing.lg, gap: spacing.md },
    banner: { backgroundColor: c.accentSoft, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm, borderWidth: 1, borderColor: c.border },
    bannerText: { color: c.text, fontSize: 14, lineHeight: 20, fontWeight: '600', ...alignRight },
    bannerBtn: { alignSelf: 'flex-start', backgroundColor: c.accent, borderRadius: radius.sm, paddingVertical: 6, paddingHorizontal: spacing.md },
    bannerBtnText: { color: c.surface, fontSize: 14, fontWeight: '700' },
    status: { gap: spacing.xs, alignItems: 'stretch' },
    muted: { color: c.textMuted, fontSize: 14, ...alignRight },
    link: { color: c.accent, fontSize: 14, fontWeight: '600', ...alignRight },
    error: { color: c.danger, fontSize: 13, ...alignRight },
    group: { gap: spacing.xs },
    heading: { color: c.textMuted, fontSize: 13, fontWeight: '800', paddingTop: spacing.sm, ...alignRight },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: c.surface, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
    rowText: { flex: 1, gap: 2 },
    title: { color: c.text, fontSize: 17, fontWeight: '700', ...alignRight },
    sub: { color: c.textMuted, fontSize: 13, ...alignRight },
    loading: { color: c.accent, fontSize: 13, fontWeight: '600', ...alignRight },
    badge: { color: c.textMuted, fontSize: 12, fontWeight: '600' },
    badgeOn: { color: c.accent },
    pressed: { opacity: 0.8 },
  });
