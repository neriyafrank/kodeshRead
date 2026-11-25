/**
 * The PRIMARY card of "ניהול ספרייה ועדכונים": what is installed (human-readable stage, book count, size, build date),
 * one primary action and "בדוק עדכונים". Technical rows (cloud package sizes, version hash) are exported as
 * `CloudPackageDetails` for the manager's collapsed "מתקדם / ייבוא ידני" section. The two-stage cloud library (GitHub Release `library-latest`, shared/coreLibrary.js). Reads its
 * library-manifest.json and offers, by what is installed (shared/libraryRelease.js libraryAction):
 *   nothing installed   ספריית יסוד (core only, small) | ספרייה מלאה (core + extended in ONE flow, combined size)
 *   core installed      "הרחב לספרייה מלאה": downloads ONLY the extended pack (its exact size)
 *   newer cloud build   update (the stages that are installed)
 * Every size is the exact size from the manifest. Progress: "ספריית יסוד · חלק 2 מתוך 3 · 1.4 GB / 3.2 GB · 44%" in
 * the job card above (one bar for the whole flow). Warns when the free storage is below zips + DBs + 500 MB.
 *
 * An unfinished download (paused, failed, or cut by a kill / reboot; cloud-download.json) shows its saved progress with
 * "המשך הורדה" (continues from the saved bytes; with a newer cloud build it starts that one instead) and "בטל הורדה".
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { libraryAction, libraryState, STAGE_TITLES, type Plan } from '../../../shared/libraryRelease';
import { formatBytes, packageOf, planPackages, type CloudManifest } from '../../../shared/multipart';
import { useLibrary } from '../../db/LibraryContext';
import { isWeb } from '../../db/library';
import { alignRight, isolateLtr } from '../../lib/direction';
import { countPartsOnDisk, defaultCloudManifestUrl, fetchCloudManifest, isPreviewCloudDownload, pendingCloudDownload, storageVerdict, type PendingCloudDownload } from '../../services/cloudLibrary';
import { useLibraryActions } from '../../services/libraryActions';
import { useLibraryJobs } from '../../state/libraryJobs';
import { useLibrarySettings } from '../../state/libraryStore';
import { radius, spacing, useAppTheme, useThemedStyles, type Palette } from '../../theme';
import { ErrorDetails } from './ErrorDetails';
import { ProgressBar } from './JobStatus';

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

/** Short Hebrew description of a stage. */
const DESCRIPTIONS = {
  core: 'תנ"ך, משנה, בבלי, משנה תורה ושולחן ערוך עם המפרשים העיקריים. אפשר להרחיב בהמשך.',
  full: 'כל מאגר אוצריא בהורדה אחת.',
  extended: 'כל שאר הספרים והמפרשים. יורדת רק ההרחבה.',
} as const;

export type CloudManifestState = ReturnType<typeof useCloudManifest>;

/** Fetches the cloud manifest once and on `retry()` ("בדוק עדכונים"). */
export function useCloudManifest() {
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
  return { state, retry, manifestUrl };
}

export function CloudLibraryCard({ cloud }: { cloud: CloudManifestState }) {
  const c = useAppTheme();
  const s = useThemedStyles(createStyles);
  const lib = useLibrary();
  const actions = useLibraryActions();
  const busy = useLibraryJobs((x) => !!x.job);
  const generation = useLibraryJobs((x) => x.checkpointGeneration);
  const [pending, setPending] = useState<PendingCloudDownload | null>(null);
  const recorded = useLibrarySettings((x) => x.installedCloud);
  const { state, retry, manifestUrl } = cloud;

  // The saved, unfinished download (re-read whenever a job ends: paused, failed, cancelled, done).
  useEffect(() => {
    if (busy) return;
    let live = true;
    pendingCloudDownload().then(
      (p) => live && setPending(p),
      () => live && setPending(null),
    );
    return () => {
      live = false;
    };
  }, [busy, generation]);

  const manifest = state.status === 'ready' ? state.manifest : null;
  const installed = libraryState({ coreInfo: lib.core?.info ?? null, extendedInfo: lib.extended?.info ?? null, recorded });
  const action = manifest ? libraryAction({ state: installed, manifest }) : null;
  const canDownload = !busy && (!isWeb || isPreviewCloudDownload());

  const start = (plan: Plan) => {
    if (!manifest) return;
    const go = () => void actions.downloadCloud(manifest, manifestUrl, plan);
    const verdict = storageVerdict(manifest, plan);
    if (!verdict.ok) confirmAnyway('אין מספיק מקום פנוי', `${verdict.message ?? ''}\n\nלהמשיך בכל זאת?`, 'המשך', go);
    else go();
  };

  /** "המשך הורדה": the saved plan from its bytes; a newer cloud build replaces the saved one (its old bytes are dropped). */
  const resume = () => {
    if (!pending) return;
    const m = manifest ?? pending.manifest;
    const plan: Plan = pending.plan !== 'core' && !m.extended ? 'core' : pending.plan;
    void actions.downloadCloud(m, pending.manifestUrl, plan);
  };
  const discard = () =>
    confirmAnyway('לבטל את ההורדה?', 'כל מה שירד עד עכשיו יימחק.', 'בטל הורדה', () => {
      void actions.discardCloudDownload().then(() => setPending(null));
    });


  const info = lib.core?.info ?? null;
  const ext = lib.extended?.info ?? null;
  const stageLine =
    installed.stage === 'none'
      ? 'לא מותקנת ספרייה'
      : installed.stage === 'core'
        ? `מותקנת: ${STAGE_TITLES.core}`
        : installed.stage === 'partial'
          ? 'מותקנת ספרייה חלקית מגרסה קודמת'
          : `מותקנת: ${STAGE_TITLES.full}`;
  const books = info ? (info.books ?? 0) + (ext?.books ?? 0) : 0;
  const bytes = info?.size != null ? info.size + (ext?.size ?? 0) : null;
  const meta = info ? [`${books.toLocaleString('he-IL')} ספרים`, bytes != null ? formatBytes(bytes) : null, info.builtAt ? `נבנתה ${fmtDate(info.builtAt)}` : null].filter(Boolean).join(' · ') : '';
  const checking = state.status === 'loading';

  return (
    <View style={s.wrap} testID="cloud-library-card">
      <Text style={s.title}>הספרייה</Text>
      <View style={s.card} testID="cloud-edition">
        <View style={s.gap} testID="cloud-info">
          <Text style={s.installedLine} testID="cloud-installed-stage">
            {stageLine}
          </Text>
          {meta ? (
            <Text style={s.hint} testID="cloud-meta">
              {isolateLtr(meta)}
            </Text>
          ) : null}
        </View>
        <Text style={s.body}>
          {installed.stage === 'none' ? 'הורידו ספרייה מוכנה: אפשר להתחיל בספריית יסוד קטנה ולהרחיב בכל שלב.' : 'ההורדה ניתנת להפסקה והמשך: חלקים שכבר ירדו לא יורדים שוב.'}
        </Text>
        {checking ? <ActivityIndicator color={c.accent} testID="cloud-loading" /> : null}
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

        {pending && !busy ? <PendingDownload pending={pending} newer={!!manifest && manifest.version !== pending.manifest.version} onResume={resume} onDiscard={discard} disabled={!canDownload} /> : null}

        {action?.mode === 'current' ? <Text style={s.ok}>✓ הגרסה המותקנת זהה לגרסה בענן</Text> : null}
        {action?.mode === 'update' ? (
          <Text style={s.update} testID="cloud-update">
            קיים עדכון בענן
          </Text>
        ) : null}

        {manifest && action
          ? action.plans.map((plan) => {
              const p = planPackages(manifest, plan);
              const verdict = storageVerdict(manifest, plan);
              const { onDisk, total } = countPartsOnDisk(manifest, plan);
              const label =
                action.mode === 'expand'
                  ? `☁︎  הרחב לספרייה מלאה`
                  : action.mode === 'update'
                    ? `☁︎  ${plan === 'full' ? 'עדכן לספרייה מלאה' : 'עדכן ספרייה'}`
                    : plan === 'core'
                      ? `☁︎  הורד ${STAGE_TITLES.core}`
                      : `☁︎  הורד ספרייה מלאה`;
              const testID = action.mode === 'expand' ? 'cloud-download-expand' : action.mode === 'update' ? `cloud-download-update-${plan}` : `cloud-download-${plan}`;
              return (
                <View key={plan} style={s.gap}>
                  <Text style={s.body}>{DESCRIPTIONS[plan]}</Text>
                  {onDisk > 0 ? (
                    <Text style={s.hint} testID={`cloud-resume-hint-${plan}`}>
                      {isolateLtr(`כבר ירדו ${onDisk} מתוך ${total} חלקים — ההורדה תמשיך משם.`)}
                    </Text>
                  ) : null}
                  {!verdict.ok ? (
                    <Text style={s.warn} testID={`cloud-storage-warning-${plan}`}>
                      ⚠ {isolateLtr(verdict.message ?? '')}
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={() => start(plan)}
                    disabled={!canDownload}
                    style={({ pressed }) => [s.primary, !canDownload && s.disabled, pressed && s.pressed]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canDownload }}
                    testID={testID}
                  >
                    <Text style={s.primaryText}>{label}</Text>
                    <Text style={s.hintOnAccent} testID={`${testID}-size`}>
                      {isolateLtr(`${formatBytes(p.totalZipBytes)} · ${p.bookCount.toLocaleString('he-IL')} ספרים`)}
                    </Text>
                  </Pressable>
                </View>
              );
            })
          : null}
        {manifest && action?.mode === 'current' ? (
          <Pressable
            onPress={() => start(installed.stage === 'core' ? 'core' : manifest.extended ? 'full' : 'core')}
            disabled={!canDownload}
            style={({ pressed }) => [s.secondary, !canDownload && s.disabled, pressed && s.pressed]}
            accessibilityRole="button"
            testID="cloud-download-again"
          >
            <Text style={s.secondaryText}>☁︎  הורד שוב</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={retry}
          disabled={busy || checking}
          style={({ pressed }) => [s.secondary, (busy || checking) && s.disabled, pressed && s.pressed]}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || checking }}
          testID="check-update"
        >
          <Text style={s.secondaryText}>בדוק עדכונים</Text>
        </Pressable>
      </View>
      {isWeb && !isPreviewCloudDownload() ? <Text style={s.hint}>ההורדה זמינה באפליקציית Android בלבד.</Text> : null}
    </View>
  );
}

/** Technical rows for the collapsed "מתקדם" section: cloud package sizes, build date and version. */
export function CloudPackageDetails({ cloud }: { cloud: CloudManifestState }) {
  const s = useThemedStyles(createStyles);
  const manifest = cloud.state.status === 'ready' ? cloud.state.manifest : null;
  const core = manifest ? packageOf(manifest, 'core') : null;
  const ext = manifest?.extended ? packageOf(manifest, 'extended') : null;
  if (!manifest || !core) return null;
  return (
    <View style={s.info} testID="cloud-details">
      <Row label={STAGE_TITLES.core} value={`${formatBytes(core.totalZipBytes)} · ${core.bookCount.toLocaleString('he-IL')} ספרים`} testID="cloud-size-core" />
      {ext ? <Row label={STAGE_TITLES.extended} value={`${formatBytes(ext.totalZipBytes)} · ${ext.bookCount.toLocaleString('he-IL')} ספרים`} testID="cloud-size-extended" /> : null}
      <Row label="ספרים בענן" value={(core.bookCount + (ext?.bookCount ?? 0)).toLocaleString('he-IL')} testID="cloud-books" />
      <Row label="נבנתה בענן" value={fmtDate(manifest.builtAt)} />
      <Row label="גרסת הענן" value={`\u2066${manifest.version}\u2069`} />
    </View>
  );
}

function PendingDownload({ pending, newer, onResume, onDiscard, disabled }: { pending: PendingCloudDownload; newer: boolean; onResume: () => void; onDiscard: () => void; disabled: boolean }) {
  const s = useThemedStyles(createStyles);
  const done = pending.progress?.done ?? 0;
  const total = pending.progress?.total ?? 0;
  const fraction = total > 0 ? Math.min(1, done / total) : null;
  const title = pending.status === 'paused' ? 'ההורדה מושהית' : pending.status === 'error' ? '⚠ ההורדה נעצרה' : 'ההורדה נקטעה — אפשר להמשיך';
  return (
    <View style={s.pending} testID="cloud-pending">
      <Text style={s.pendingTitle} testID="cloud-pending-status">
        {title}
      </Text>
      {total > 0 ? (
        <>
          <ProgressBar fraction={fraction} />
          <Text style={s.hint} testID="cloud-pending-progress">
            {isolateLtr(`${formatBytes(done)} / ${formatBytes(total)} · ${Math.floor((fraction ?? 0) * 100)}%`)}
          </Text>
        </>
      ) : null}
      {pending.error ? (
        <View style={s.gap}>
          <Text style={s.error} testID="cloud-pending-error">
            {pending.error.message}
          </Text>
          <ErrorDetails diagnostic={pending.error.diagnostic} context="cloud download" testID="cloud-pending-details" />
        </View>
      ) : null}
      {newer ? <Text style={s.hint}>בענן יש גרסה חדשה יותר: ״המשך״ יוריד אותה (החלקים של הגרסה הקודמת יימחקו).</Text> : null}
      <Pressable onPress={onResume} disabled={disabled} style={({ pressed }) => [s.primary, disabled && s.disabled, pressed && s.pressed]} accessibilityRole="button" testID="cloud-resume">
        <Text style={s.primaryText}>▶  המשך הורדה</Text>
      </Pressable>
      <Pressable onPress={onDiscard} disabled={disabled} accessibilityRole="button" testID="cloud-discard">
        <Text style={s.link}>בטל הורדה ומחק את מה שירד</Text>
      </Pressable>
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
    pending: { gap: spacing.sm, borderWidth: 1, borderColor: c.accent, borderRadius: radius.md, padding: spacing.md, backgroundColor: c.accentSoft },
    pendingTitle: { fontSize: 15, fontWeight: '800', color: c.text, ...alignRight },
    installedLine: { fontSize: 14, fontWeight: '700', color: c.text, ...alignRight },
    secondary: { borderWidth: 1, borderColor: c.accent, borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
    secondaryText: { color: c.accent, fontSize: 15, fontWeight: '700', ...alignRight },
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
