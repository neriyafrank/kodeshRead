/**
 * "ספרייה מוכנה מהענן": the multi-part complete cloud library (GitHub Release `library-latest`). Reads its
 * library-manifest.json, shows what will be downloaded (books, size, build date), warns when the free storage
 * is below zip + extracted DB + 500 MB, and starts the resumable part download
 * (progress: "חלק 2 מתוך 3 · 1.4 GB / 3.2 GB · 44%" in the job card above). One action: download or update.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { LIBRARY_INCLUDES, LIBRARY_TITLE, libraryAction } from '../../../shared/libraryRelease';
import { formatBytes, type CloudManifest } from '../../../shared/multipart';
import { useLibrary } from '../../db/LibraryContext';
import { isWeb } from '../../db/library';
import { alignRight, isolateLtr } from '../../lib/direction';
import { countPartsOnDisk, defaultCloudManifestUrl, fetchCloudManifest, isPreviewCloudDownload, storageVerdict } from '../../services/cloudLibrary';
import { useLibraryActions } from '../../services/libraryActions';
import { useLibraryJobs } from '../../state/libraryJobs';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';

type State = { status: 'loading' } | { status: 'ready'; manifest: CloudManifest } | { status: 'error'; message: string };

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('he-IL');
};

/** Alert.alert is a no-op on react-native-web. */
function confirmAnyway(title: string, message: string, ok: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(message)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: 'ביטול', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: onOk },
  ]);
}

/**
 * The complete cloud library with its live size and book count from its manifest. One button: download (nothing
 * installed), update (a newer cloud version, or an older smaller build is installed) or re-download.
 */
export function CloudLibraryCard() {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const lib = useLibrary();
  const actions = useLibraryActions();
  const busy = useLibraryJobs((x) => !!x.job);
  const manifestUrl = defaultCloudManifestUrl();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // Subscribes to the manifest fetch; state is only set from the promise callbacks.
  useEffect(() => {
    let live = true;
    fetchCloudManifest(manifestUrl).then(
      (manifest) => live && setState({ status: 'ready', manifest }),
      (e) => live && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [manifestUrl, attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  const manifest = state.status === 'ready' ? state.manifest : null;
  const installedVersion = lib.core?.info?.version ?? null;
  const action = manifest ? libraryAction({ installedScope: lib.core?.info?.scope ?? null, installedVersion, manifest }) : 'install';
  const verdict = manifest ? storageVerdict(manifest) : null;
  const onDisk = manifest ? countPartsOnDisk(manifest) : 0;
  const canDownload = !busy && (!isWeb || isPreviewCloudDownload());

  const go = () => manifest && void actions.downloadCloud(manifest, manifestUrl);
  const start = () => {
    if (!manifest) return;
    if (verdict && !verdict.ok) confirmAnyway('אין מספיק מקום פנוי', `${verdict.message ?? ''}\n\nלהמשיך בכל זאת?`, 'המשך', go);
    else go();
  };

  const label = action === 'update' ? '☁︎  עדכן ספרייה' : action === 'current' ? '☁︎  הורד שוב' : `☁︎  הורד ${LIBRARY_TITLE}`;

  return (
    <View style={s.wrap} testID="cloud-library-card">
      <Text style={s.title}>ספרייה מוכנה מהענן</Text>
      <Text style={s.body}>
        ספריית אוצריא המלאה מאונדקסת לחיפוש, נבנית בענן ומורדת במספר חלקים. אפשר להפסיק ולהמשיך: חלקים שכבר ירדו תקינים לא יורדים שוב.
      </Text>
      <View style={s.card} testID="cloud-edition">
        <Text style={s.cardTitle} testID="cloud-title">
          {LIBRARY_TITLE}
        </Text>
        <Text style={s.body}>{LIBRARY_INCLUDES}</Text>

        {state.status === 'loading' ? <ActivityIndicator color={c.accent} testID="cloud-loading" /> : null}
        {state.status === 'error' ? (
          <View style={s.gap}>
            <Text style={s.error} testID="cloud-error">
              {state.message}
            </Text>
            <Pressable onPress={retry} accessibilityRole="button" testID="cloud-retry">
              <Text style={s.link}>נסה שוב</Text>
            </Pressable>
          </View>
        ) : null}

        {manifest ? (
          <View style={s.info} testID="cloud-info">
            <Row label="ספרים" value={manifest.bookCount.toLocaleString('he-IL')} testID="cloud-books" />
            <Row label="גודל הורדה" value={`${formatBytes(manifest.totalZipBytes)} · ${manifest.parts.length} חלקים`} testID="cloud-size" />
            <Row label="אחרי חילוץ" value={formatBytes(manifest.uncompressedDbBytes)} />
            <Row label="נבנתה" value={fmtDate(manifest.builtAt)} />
            <Row label="גרסה" value={`⁦${manifest.version}⁩`} />
          </View>
        ) : null}

        {action === 'current' ? <Text style={s.ok}>✓ הגרסה המותקנת זהה לגרסה בענן</Text> : null}
        {action === 'update' ? (
          <Text style={s.update} testID="cloud-update">
            קיים עדכון בענן
          </Text>
        ) : null}
        {onDisk > 0 && manifest && action !== 'current' ? (
          <Text style={s.hint} testID="cloud-resume-hint">
            {isolateLtr(`כבר ירדו ${onDisk} מתוך ${manifest.parts.length} חלקים — ההורדה תמשיך משם.`)}
          </Text>
        ) : null}
        {verdict && !verdict.ok ? (
          <Text style={s.warn} testID="cloud-storage-warning">
            ⚠ {isolateLtr(verdict.message ?? '')}
          </Text>
        ) : null}

        <Pressable
          onPress={start}
          disabled={!canDownload || !manifest}
          style={({ pressed }) => [s.primary, (!canDownload || !manifest) && s.disabled, pressed && s.pressed]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canDownload || !manifest }}
          testID="cloud-download"
        >
          <Text style={s.primaryText}>{label}</Text>
          {manifest ? <Text style={s.hintOnAccent}>{isolateLtr(`${formatBytes(manifest.totalZipBytes)} · ${manifest.bookCount.toLocaleString('he-IL')} ספרים`)}</Text> : null}
        </Pressable>
      </View>
      {isWeb && !isPreviewCloudDownload() ? <Text style={s.hint}>ההורדה זמינה באפליקציית Android בלבד.</Text> : null}
    </View>
  );
}

function Row({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const s = useThemedStyles(createStyles);
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue} testID={testID}>
        {isolateLtr(value)}
      </Text>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { gap: spacing.md, marginBottom: spacing.lg },
    cardTitle: { fontSize: 16, fontWeight: '800', color: c.text, ...alignRight },
    update: { color: c.accent, fontSize: 14, fontWeight: '700', ...alignRight },
    card: { backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: spacing.lg, gap: spacing.md },
    title: { fontSize: 18, fontWeight: '800', color: c.text, ...alignRight },
    body: { fontSize: 14, lineHeight: 21, color: c.textMuted, ...alignRight },
    gap: { gap: spacing.xs },
    info: { backgroundColor: c.surfaceMuted, borderRadius: radius.sm, padding: spacing.md, gap: 4 },
    row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    rowLabel: { fontSize: 13, color: c.textMuted, ...alignRight },
    rowValue: { fontSize: 14, fontWeight: '600', color: c.text, ...alignRight },
    error: { color: c.danger, fontSize: 14, ...alignRight },
    warn: { color: c.danger, fontSize: 14, fontWeight: '700', lineHeight: 20, backgroundColor: c.accentSoft, borderRadius: radius.sm, padding: spacing.sm, ...alignRight },
    ok: { color: c.text, fontSize: 14, fontWeight: '600', ...alignRight },
    hint: { color: c.textMuted, fontSize: 13, ...alignRight },
    link: { color: c.accent, fontSize: 14, fontWeight: '600', ...alignRight },
    primary: { backgroundColor: c.accent, borderRadius: radius.md, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
    primaryText: { color: c.surface, fontSize: 17, fontWeight: '700', ...alignRight },
    hintOnAccent: { color: c.surface, opacity: 0.85, fontSize: 13, ...alignRight },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.8 },
  });
