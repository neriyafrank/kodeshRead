/**
 * First launch (no core_library.db yet): welcome card with the two ways to get books.
 */
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { isWeb } from '../../db/library';
import { useLibraryJobs } from '../../state/libraryJobs';
import { useLibrarySettings } from '../../state/libraryStore';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';

export function OnboardingCard({ hasUserBooks, starter }: { hasUserBooks: boolean; starter?: boolean }) {
  const s = useThemedStyles(createStyles);
  const router = useRouter();
  const busy = useLibraryJobs((x) => !!x.job);
  const dismiss = useLibrarySettings((x) => x.dismissOnboarding);

  // The multi-GB cloud library starts from the manager's cloud card, after it showed the size, the
  // build date and the free-storage check.
  const download = () => router.navigate('/library-manager');

  return (
    <View style={[s.card, starter && s.cardInList]} testID="onboarding-card">
      <View style={s.headRow}>
        <Text style={s.title}>{starter ? 'רוצים את כל הספרייה?' : 'ברוכים הבאים!'}</Text>
        {hasUserBooks ? (
          <Pressable onPress={() => dismiss()} hitSlop={10} accessibilityRole="button" accessibilityLabel="הסתר">
            <Text style={s.close}>✕</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={s.body}>
        {starter
          ? 'ספרי ההתחלה למעלה נטענים מהענן בלחיצה. לספרייה המלאה (חיפוש בכל הספרים, כל המפרשים, בלי חיבור) בחרו אחת מהדרכים — אפשר תמיד לשנות בהמשך ממסך ״ניהול ספרייה ועדכונים״.'
          : 'הספרייה אינה כלולה בהתקנה כדי שהאפליקציה תישאר קלה. בחרו איך להביא ספרים — אפשר תמיד לשנות בהמשך ממסך ״ניהול ספרייה ועדכונים״.'}
      </Text>
      <Pressable onPress={download} disabled={busy} style={({ pressed }) => [s.primary, busy && s.disabled, pressed && s.pressed]} accessibilityRole="button" testID="onboarding-download">
        <Text style={s.primaryText}>☁︎  הורד ספרייה מוכנה מהענן</Text>
        <Text style={s.hint}>ספריית אוצריא מאונדקסת לחיפוש — מורדת בחלקים, אפשר להמשיך אחרי הפסקה</Text>
      </Pressable>
      <Pressable onPress={() => router.navigate('/library-manager')} style={({ pressed }) => [s.secondary, pressed && s.pressed]} accessibilityRole="button" testID="onboarding-import">
        <Text style={s.secondaryText}>📁  ייבא ספרים מהמכשיר</Text>
        <Text style={s.hintMuted}>קובצי ‎.txt או תיקייה שלמה (גם תיקיית אוצריא)</Text>
      </Pressable>
      {isWeb ? <Text style={s.hintMuted}>בתצוגה המקדימה בדפדפן מוצגת ספריית הדוגמה בלבד.</Text> : null}
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    card: { margin: spacing.lg, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: spacing.md },
    cardInList: { marginHorizontal: 0, marginTop: spacing.md, marginBottom: 0 },
    headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 20, fontWeight: '800', color: c.text, writingDirection: 'rtl' },
    close: { color: c.textMuted, fontSize: 16 },
    body: { fontSize: 15, lineHeight: 22, color: c.textMuted, writingDirection: 'rtl' },
    primary: { backgroundColor: c.accent, borderRadius: radius.md, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
    primaryText: { color: c.surface, fontSize: 17, fontWeight: '700', writingDirection: 'rtl' },
    hint: { color: c.surface, opacity: 0.85, fontSize: 13, writingDirection: 'rtl' },
    secondary: { borderRadius: radius.md, borderWidth: 1.5, borderColor: c.accent, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
    secondaryText: { color: c.accent, fontSize: 17, fontWeight: '700', writingDirection: 'rtl' },
    hintMuted: { color: c.textMuted, fontSize: 13, writingDirection: 'rtl' },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.8 },
  });
