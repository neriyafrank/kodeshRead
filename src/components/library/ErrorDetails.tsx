/**
 * Diagnostic line of a failed library job (exact sub-step + native error, e.g.
 * "finalize:swap_file · Destination already exists [ERR_FILE_EXISTS]") with a
 * "העתק פרטי שגיאה" button, so an error on a real device can be pasted into a bug report.
 */
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { alignRight } from '../../lib/direction';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';

/** The text the button copies: the diagnostic plus where / when it happened. */
export function errorReport(diagnostic: string, context?: string | null): string {
  return [
    `kodeshRead error: ${diagnostic}`,
    context ? `context: ${context}` : null,
    `platform: ${Platform.OS} ${String(Platform.Version ?? '')}`.trim(),
    `time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function ErrorDetails({ diagnostic, context, testID = 'error-details' }: { diagnostic: string; context?: string | null; testID?: string }) {
  const s = useThemedStyles(createStyles);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      const ok = await Clipboard.setStringAsync(errorReport(diagnostic, context));
      setCopied(ok === false ? 'fail' : 'ok');
    } catch (e) {
      console.warn('clipboard unavailable', e);
      setCopied('fail');
    }
  };

  return (
    <View style={s.box} testID={testID}>
      <Text style={s.label}>פרטי השגיאה:</Text>
      {/* Technical text (step names, native messages): left-to-right, selectable. */}
      <Text style={s.code} selectable testID={`${testID}-text`}>
        {diagnostic}
      </Text>
      <Pressable onPress={() => void copy()} style={({ pressed }) => [s.button, pressed && s.pressed]} accessibilityRole="button" testID={`${testID}-copy`}>
        <Text style={s.buttonText}>{copied === 'ok' ? 'הועתק ✓' : copied === 'fail' ? 'ההעתקה נכשלה — סמנו את הטקסט ידנית' : 'העתק פרטי שגיאה'}</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    box: { marginTop: spacing.sm, padding: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceMuted, gap: spacing.xs },
    label: { fontSize: 12, fontWeight: '700', color: c.textMuted, ...alignRight },
    code: { fontSize: 12, color: c.text, writingDirection: 'ltr', fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },
    button: { alignSelf: 'flex-start', borderWidth: 1, borderColor: c.danger, borderRadius: radius.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.md },
    buttonText: { fontSize: 13, fontWeight: '700', color: c.danger },
    pressed: { opacity: 0.8 },
  });
