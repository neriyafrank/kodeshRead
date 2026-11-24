/**
 * Scoped wake lock: keeps the screen / CPU awake while `fn` runs and always releases it in `finally`.
 * A platform without keep-awake support only logs a warning: the guarded work still runs.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

export async function withKeepAwake<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  await activateKeepAwakeAsync(tag).catch((e) => console.warn('keep-awake unavailable', e));
  try {
    return await fn();
  } finally {
    await deactivateKeepAwake(tag).catch(() => undefined);
  }
}
