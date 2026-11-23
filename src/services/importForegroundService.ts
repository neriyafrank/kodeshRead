/**
 * JS side of the Android import foreground service (modules/import-foreground-service,
 * manifest entries from plugins/withImportForegroundService.js).
 *
 * While a library import runs, a real Android foreground service (type dataSync) with an
 * ongoing progress notification ("מייבא ספרייה: 1,240 / 7,674") and a partial WakeLock keeps
 * the process alive, so indexing continues with the app in the background or the screen off.
 *
 * Every call is a safe no-op where the native module does not exist (web preview, Playwright,
 * iOS, Expo Go): `start()` then resolves false and callers fall back to pausing on background.
 */
import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

interface NativeImportService {
  start(title: string, text: string, current: number, total: number): Promise<boolean>;
  update(title: string, text: string, current: number, total: number): Promise<boolean>;
  stop(): Promise<boolean>;
  isRunning(): boolean;
}

const native: NativeImportService | null = Platform.OS === 'android' ? requireOptionalNativeModule<NativeImportService>('ImportForegroundService') : null;

let active = false;
let lastUpdate = 0;
let pending: { title: string; text: string; current: number; total: number } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Android rate-limits notification updates; one every UPDATE_MS is plenty for a progress bar. */
const UPDATE_MS = 700;

const toInt = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** True when the foreground service can run on this platform / build. */
export function isAvailable(): boolean {
  return !!native;
}

/** True while this session's foreground service is running (imports survive backgrounding). */
export function isActive(): boolean {
  return active;
}

/**
 * Android 13+ needs the POST_NOTIFICATIONS runtime permission to show the progress notification.
 * Asked once before a bulk import; a refusal is fine (the service still runs, Android just hides
 * its notification from the shade).
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || !native) return false;
  if (Number(Platform.Version) < 33) return true;
  try {
    const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(perm)) return true;
    return (await PermissionsAndroid.request(perm)) === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) {
    console.warn('notification permission request failed', e);
    return false;
  }
}

/** Starts the service with its first notification. Resolves false where unavailable or refused. */
export async function start(title: string, text: string, current = 0, total = 0): Promise<boolean> {
  if (!native) return false;
  try {
    await native.start(title, text, toInt(current), toInt(total));
    active = true;
    lastUpdate = Date.now();
    return true;
  } catch (e) {
    // e.g. ForegroundServiceStartNotAllowedException when started from the background.
    console.warn('import foreground service unavailable', e);
    active = false;
    return false;
  }
}

async function flush() {
  flushTimer = null;
  const p = pending;
  pending = null;
  if (!p || !native || !active) return;
  lastUpdate = Date.now();
  try {
    await native.update(p.title, p.text, p.current, p.total);
  } catch (e) {
    console.warn('import notification update failed', e);
  }
}

/** Updates the notification (throttled; the latest values always win). */
export function update(title: string, text: string, current = 0, total = 0): void {
  if (!native || !active) return;
  pending = { title, text, current: toInt(current), total: toInt(total) };
  const wait = UPDATE_MS - (Date.now() - lastUpdate);
  if (wait <= 0) void flush();
  else if (!flushTimer) flushTimer = setTimeout(() => void flush(), wait);
}

/** Stops the service, its notification and the wake lock. */
export async function stop(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pending = null;
  if (!native || !active) return;
  active = false;
  try {
    await native.stop();
  } catch (e) {
    console.warn('import foreground service stop failed', e);
  }
}

/** "1,240 / 7,674" with thousands separators. */
export function formatCount(current: number | null | undefined, total: number | null | undefined): string {
  if (current == null || !total) return '';
  return `${toInt(current).toLocaleString('en-US')} / ${toInt(total).toLocaleString('en-US')}`;
}
