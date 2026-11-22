import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadBookIndex } from '../../shared/quickJump';
import { openLibraryDatabase, toAdapter } from '../db/library';
import { LibraryContext, type Library } from '../db/LibraryContext';
import { ensureRTL } from '../lib/rtl';
import { useLibraryUi } from '../state/libraryStore';
import { fontAssets, setFontsAvailable } from '../fonts';
import { useSettings } from '../state/settingsStore';
import { useTabs } from '../state/tabsStore';
import { useHydrated } from '../state/useHydrated';
import { colors, useAppTheme } from '../theme';

// Web preview: no I18nManager.forceRTL, so flip the document direction instead.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  document.documentElement.dir = 'rtl';
  document.documentElement.lang = 'he';
}

const PERSISTED_STORES = [useSettings, useTabs, useLibraryUi];

type BootState = { status: 'loading' } | { status: 'reloading' } | { status: 'ready'; library: Library } | { status: 'error'; message: string };

export default function RootLayout() {
  const [state, setState] = useState<BootState>({ status: 'loading' });
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  const storesHydrated = useHydrated(PERSISTED_STORES);
  const theme = useAppTheme();

  useEffect(() => {
    if (fontError) {
      console.warn('font loading failed, using system font', fontError);
      setFontsAvailable(false);
    }
  }, [fontError]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (await ensureRTL()) {
          if (alive) setState({ status: 'reloading' });
          return;
        }
        const db = await openLibraryDatabase();
        const adapter = toAdapter(db);
        const bookIndex = await loadBookIndex(adapter);
        if (alive) setState({ status: 'ready', library: { db, adapter, bookIndex } });
      } catch (e) {
        console.error(e);
        if (alive) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const ready = state.status === 'ready' && storesHydrated && (fontsLoaded || !!fontError);

  return (
    <SafeAreaProvider>
      <View style={[styles.root, { backgroundColor: theme.background }]}>
        <StatusBar style={theme.statusBar} />
        {state.status === 'ready' && ready ? (
          <LibraryContext.Provider value={state.library}>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: theme.background },
                headerTintColor: theme.accent,
                headerTitleStyle: { color: theme.text, fontWeight: '700' },
                headerShadowVisible: theme.name !== 'dark',
                contentStyle: { backgroundColor: theme.background },
              }}
            />
          </LibraryContext.Provider>
        ) : (
          <View style={styles.center}>
            {state.status === 'error' ? (
              <>
                <Text style={styles.errorTitle}>שגיאה בטעינת הספרייה</Text>
                <Text style={styles.errorText}>{state.message}</Text>
              </>
            ) : (
              <>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.loading}>טוען ספרייה…</Text>
              </>
            )}
          </View>
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  loading: { color: colors.textMuted, fontSize: 16 },
  errorTitle: { color: colors.danger, fontSize: 18, fontWeight: '700' },
  errorText: { color: colors.text, fontSize: 14, textAlign: 'center' },
});
