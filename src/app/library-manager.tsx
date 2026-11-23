/**
 * "ניהול ספרייה ועדכונים" (Library & Updates Manager):
 *  - core library: installed version/stats, release URL, check for updates, download with
 *    progress + verification + atomic swap, rebuild from an Otzaria folder on the device, remove
 *  - personal books: import .txt files or a folder into user_library.db; the list (lazy,
 *    per folder, paged) and deletion live in components/library/PersonalBooks.tsx
 */
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { USER_ROOT_NAME } from '../../shared/sources';
import { JobStatus } from '../components/library/JobStatus';
import { PersonalBooks } from '../components/library/PersonalBooks';
import { ResumeCards } from '../components/library/ResumeCard';
import { useLibrary } from '../db/LibraryContext';
import { isWeb } from '../db/library';
import { cleanupDownloads, defaultManifestUrl, type ReleaseInfo } from '../services/coreLibrary';
import { useLibraryActions, useManifestUrl } from '../services/libraryActions';
import { formatMB, useLibraryJobs } from '../state/libraryJobs';
import { useLibrarySettings } from '../state/libraryStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../theme';

/** Alert.alert is a no-op on react-native-web. */
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

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('he-IL');
};
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('he-IL'));

type Check = { status: 'idle' } | { status: 'checking' } | { status: 'done'; release: ReleaseInfo } | { status: 'error'; message: string };

export default function LibraryManagerScreen() {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const lib = useLibrary();
  const actions = useLibraryActions();
  const busy = useLibraryJobs((x) => !!x.job);
  const manifestUrl = useManifestUrl();
  const customUrl = useLibrarySettings((x) => x.manifestUrl);
  const setManifestUrl = useLibrarySettings((x) => x.setManifestUrl);
  const [urlDraft, setUrlDraft] = useState(manifestUrl);
  const [check, setCheck] = useState<Check>({ status: 'idle' });

  const [urlSource, setUrlSource] = useState(manifestUrl);
  if (urlSource !== manifestUrl) {
    // The saved URL changed (e.g. reset to default): show it in the input.
    setUrlSource(manifestUrl);
    setUrlDraft(manifestUrl);
  }

  useEffect(() => cleanupDownloads(), []);

  const info = lib.core?.info ?? null;

  const onCheck = useCallback(async () => {
    const url = urlDraft.trim();
    if (url !== manifestUrl) setManifestUrl(url === defaultManifestUrl() ? null : url);
    setCheck({ status: 'checking' });
    try {
      setCheck({ status: 'done', release: await actions.checkForUpdate(url) });
    } catch (e) {
      setCheck({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [actions, manifestUrl, setManifestUrl, urlDraft]);

  const release = check.status === 'done' ? check.release : null;
  const upToDate = !!(release?.manifest && info && release.manifest.version === info.version);

  const onDownload = () => {
    if (info && release && !upToDate) {
      void actions.downloadCore(release);
      return;
    }
    if (info && upToDate) {
      confirm('להוריד שוב?', 'הגרסה המותקנת זהה לגרסה שפורסמה.', 'הורד שוב', () => void actions.downloadCore(release ?? undefined));
      return;
    }
    void actions.downloadCore(release ?? undefined);
  };

  const onBuild = () =>
    confirm(
      'בניית ספרייה מהמכשיר',
      'בחרו את תיקיית אוצריא (התיקייה שמכילה את "אוצריא" ו-"links", או תיקיית ספרים). הבנייה של ספרייה מלאה עשויה להימשך זמן רב; ההתקדמות נשמרת אחרי כל קבוצת ספרים, כך שאפשר להשהות ולהמשיך גם אחרי סגירת האפליקציה. הספרייה הנוכחית תוחלף רק בסיום מוצלח.',
      'בחר תיקייה',
      () => void actions.buildCoreFromDevice(),
    );

  const onRemoveCore = () =>
    confirm('הסרת ספריית הליבה', 'הספרייה הראשית תימחק מהמכשיר. הספרים האישיים יישארו.', 'הסר', () => void actions.removeCore());

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" testID="library-manager">
      <Stack.Screen options={{ title: 'ניהול ספרייה ועדכונים' }} />

      <JobStatus />
      <View style={s.resumeWrap}>
        <ResumeCards />
      </View>

      {/* ---------------- core library ---------------- */}
      <Text style={s.sectionTitle}>ספריית הליבה</Text>
      <View style={s.card}>
        {info ? (
          <View style={s.stats} testID="core-info">
            <Stat label="גרסה" value={info.version} />
            <Stat label="נבנתה" value={fmtDate(info.builtAt)} />
            <Stat label="מקור" value={info.source ?? '—'} />
            <Stat label="ספרים" value={num(info.books)} />
            <Stat label="פסקאות" value={num(info.paragraphs)} />
            <Stat label="קישורי פרשנים" value={num(info.links)} />
            {info.size != null ? <Stat label="גודל" value={`${formatMB(info.size)} MB`} /> : null}
          </View>
        ) : (
          <Text style={s.empty}>לא מותקנת ספריית ליבה. הורידו ספרייה מוכנה או בנו אחת מתיקייה במכשיר.</Text>
        )}

        <Text style={s.label}>כתובת הגרסה (manifest.json או קובץ ‎.gz / ‎.zip / ‎.db)</Text>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          style={s.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={defaultManifestUrl()}
          placeholderTextColor={c.textMuted}
          testID="manifest-url"
        />
        {customUrl ? (
          <Pressable onPress={() => setManifestUrl(null)} hitSlop={6}>
            <Text style={s.link}>איפוס לכתובת ברירת המחדל</Text>
          </Pressable>
        ) : null}

        <View style={s.btnRow}>
          <Button label="בדוק עדכונים" onPress={onCheck} disabled={busy || check.status === 'checking' || isWeb} kind="secondary" testID="check-update" />
          <Button label={info ? 'הורד והתקן' : 'הורד ספרייה מוכנה'} onPress={onDownload} disabled={busy || isWeb} testID="download-core" />
        </View>

        {check.status === 'checking' ? <ActivityIndicator color={c.accent} style={{ marginTop: spacing.sm }} /> : null}
        {check.status === 'error' ? <Text style={s.error}>{check.message}</Text> : null}
        {release ? (
          <View style={s.release} testID="release-info">
            {release.manifest ? (
              <>
                <Text style={s.releaseTitle}>{upToDate ? '✓ הספרייה מעודכנת' : info ? 'גרסה חדשה זמינה' : 'גרסה זמינה להורדה'}</Text>
                <Text style={s.releaseText}>
                  גרסה {release.manifest.version} · {fmtDate(release.manifest.builtAt)} · {num(release.manifest.books)} ספרים
                </Text>
                <Text style={s.releaseText}>
                  הורדה {formatMB(release.size)} MB{release.manifest.dbSize ? ` · אחרי חילוץ ${formatMB(release.manifest.dbSize)} MB` : ''}
                </Text>
              </>
            ) : (
              <Text style={s.releaseText}>קובץ ישיר ({release.compression === 'none' ? 'db' : release.compression}) — ללא בדיקת SHA-256</Text>
            )}
          </View>
        ) : null}

        <View style={s.divider} />
        <Button label="בנה ספרייה מתיקיית אוצריא במכשיר" onPress={onBuild} disabled={busy || isWeb} kind="secondary" testID="build-core" />
        {info ? <Button label="הסר את ספריית הליבה" onPress={onRemoveCore} disabled={busy} kind="danger" testID="remove-core" /> : null}
      </View>

      {/* ---------------- personal books ---------------- */}
      <Text style={s.sectionTitle}>ספרים אישיים</Text>
      <View style={s.card}>
        <Text style={s.empty}>
          ספרים שתייבאו נשמרים בנפרד (בתיקייה ״{USER_ROOT_NAME}״) ואינם מושפעים מעדכוני ספריית הליבה. כותרות (h1–h4) בקובץ יוצרות תוכן עניינים.
        </Text>
        <View style={s.btnRow}>
          <Button label={'ייבוא קובץ ספר (\u200E.txt\u200E)'} onPress={() => void actions.importFiles()} disabled={busy || isWeb} testID="import-files" />
          <Button label="ייבוא תיקיית ספרים" onPress={() => void actions.importFolder()} disabled={busy || isWeb} kind="secondary" testID="import-folder" />
        </View>
        <PersonalBooks />
      </View>
      {isWeb ? <Text style={s.empty}>הורדה וייבוא זמינים באפליקציית Android בלבד; בתצוגה המקדימה בדפדפן מוצגת ספריית הדוגמה.</Text> : null}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const s = useThemedStyles(createStyles);
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Button({ label, onPress, disabled, kind = 'primary', testID }: { label: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'danger'; testID?: string }) {
  const s = useThemedStyles(createStyles);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.btn, kind === 'secondary' && s.btnSecondary, kind === 'danger' && s.btnDanger, disabled && s.btnDisabled, pressed && s.btnPressed]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
    >
      <Text style={[s.btnText, kind !== 'primary' && s.btnTextAlt, kind === 'danger' && s.btnTextDanger]}>{label}</Text>
    </Pressable>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    // ResumeCard carries the Library screen's side margins; the manager already has padding.
    resumeWrap: { marginHorizontal: -spacing.lg },
    content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
    sectionTitle: { fontSize: 18, fontWeight: '800', color: c.text, marginTop: spacing.sm, marginBottom: spacing.sm, writingDirection: 'rtl' },
    card: { backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: spacing.lg, gap: spacing.md, marginBottom: spacing.lg },
    stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    stat: { minWidth: '30%', flexGrow: 1, backgroundColor: c.surfaceMuted, borderRadius: radius.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
    statLabel: { fontSize: 12, color: c.textMuted, writingDirection: 'rtl' },
    statValue: { fontSize: 15, color: c.text, fontWeight: '600', writingDirection: 'rtl' },
    empty: { fontSize: 14, color: c.textMuted, lineHeight: 20, writingDirection: 'rtl' },
    label: { fontSize: 13, color: c.textMuted, writingDirection: 'rtl' },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, color: c.text, backgroundColor: c.background, fontSize: 13, textAlign: 'left', writingDirection: 'ltr' },
    link: { color: c.accent, fontSize: 13 },
    btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    btn: { flexGrow: 1, backgroundColor: c.accent, borderRadius: radius.md, paddingVertical: spacing.md, paddingHorizontal: spacing.md, alignItems: 'center' },
    btnSecondary: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: c.accent },
    btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.danger },
    btnDisabled: { opacity: 0.45 },
    btnPressed: { opacity: 0.8 },
    btnText: { color: c.surface, fontSize: 15, fontWeight: '700' },
    btnTextAlt: { color: c.accent },
    btnTextDanger: { color: c.danger },
    error: { color: c.danger, fontSize: 14, writingDirection: 'rtl' },
    release: { backgroundColor: c.accentSoft, borderRadius: radius.sm, padding: spacing.md, gap: 2 },
    releaseTitle: { fontSize: 15, fontWeight: '700', color: c.text, writingDirection: 'rtl' },
    releaseText: { fontSize: 13, color: c.text, writingDirection: 'rtl' },
    divider: { height: 1, backgroundColor: c.border },
  });
