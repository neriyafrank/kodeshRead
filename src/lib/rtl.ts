/**
 * Forces an RTL layout from the very first launch.
 *
 * I18nManager.forceRTL only takes effect after the JS bundle reloads, so on the
 * first launch we flip the flag and immediately reload with expo-updates
 * (falling back to DevSettings.reload in development). A persisted marker
 * prevents a reload loop if the platform refuses RTL.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DevSettings, I18nManager, Platform } from 'react-native';
import * as Updates from 'expo-updates';

const RTL_RELOAD_KEY = 'kodeshread.rtlReloadAttempted';

/** Returns true if the app is about to reload (render nothing meanwhile). */
export async function ensureRTL(): Promise<boolean> {
  if (Platform.OS === 'web') return false; // web uses `direction: rtl` styling instead
  if (I18nManager.isRTL) {
    AsyncStorage.removeItem(RTL_RELOAD_KEY).catch(() => undefined);
    return false;
  }
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
  I18nManager.swapLeftAndRightInRTL(true);

  const attempted = await AsyncStorage.getItem(RTL_RELOAD_KEY).catch(() => null);
  if (attempted) return false; // already tried once; continue LTR rather than loop forever
  await AsyncStorage.setItem(RTL_RELOAD_KEY, '1').catch(() => undefined);
  try {
    await Updates.reloadAsync();
  } catch {
    if (__DEV__) DevSettings.reload();
    else return false;
  }
  return true;
}
