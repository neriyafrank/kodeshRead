import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LibraryProvider } from '../db/LibraryContext';
import { IngestionLifecycle } from '../services/ingestionLifecycle';
import { ensureRTL } from '../lib/rtl';
import { useLibrarySettings, useLibraryUi } from '../state/libraryStore';
import { useSearch } from '../state/searchStore';
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

const PERSISTED_STORES = [useSettings, useTabs, useLibraryUi, useSearch, useLibrarySettings];

type BootState = { status: 'loading' } | { status: 'reloading' } | { status: 'ready' };

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
        if (alive) setState({ status: 'ready' });
      } catch (e) {
        console.error(e);
        if (alive) setState({ status: 'ready' });
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
        {ready ? (
          <LibraryProvider fallback={(error) => <BootScreen error={error} />}>
            <IngestionLifecycle />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: theme.background },
                headerTintColor: theme.accent,
                headerTitleStyle: { color: theme.text, fontWeight: '700' },
                headerShadowVisible: theme.name !== 'dark',
                contentStyle: { backgroundColor: theme.background },
              }}
            >
              <Stack.Screen name="library-manager" options={{ presentation: 'modal', title: 'ניהול ספרייה ועדכונים' }} />
            </Stack>
          </LibraryProvider>
        ) : (
          <BootScreen error={null} />
        )}
      </View>
    </SafeAreaProvider>
  );
}

function BootScreen({ error }: { error: string | null }) {
  return (
    <View style={styles.center}>
      {error ? (
        <>
          <Text style={styles.errorTitle}>שגיאה בטעינת הספרייה</Text>
          <Text style={styles.errorText}>{error}</Text>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loading}>טוען ספרייה…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  loading: { color: colors.textMuted, fontSize: 16 },
  errorTitle: { color: colors.danger, fontSize: 18, fontWeight: '700' },
  errorText: { color: colors.text, fontSize: 14, textAlign: 'center' },
});
