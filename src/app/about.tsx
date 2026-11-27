/**
 * "אודות": app description + version, and the license attribution of the library (source repository, CC BY-NC-SA 4.0,
 * indication of modifications, non-commercial / share-alike terms, no endorsement, no warranty).
 * URLs and the license name come from shared/about.js. Header Back = normal stack back.
 */
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ABOUT } from '../../shared/about';
import { HomeBackButton } from '../components/HomeBackButton';
import { alignRight } from '../lib/direction';
import { useAppNav } from '../lib/appNav';
import { radius, spacing, useThemedStyles, type Palette } from '../theme';

/** Latin names, versions and URLs keep their order inside a Hebrew line. */
const ltr = (text: string) => `⁦${text}⁩`;

export default function AboutScreen() {
  const nav = useAppNav();
  const s = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const version = Constants.expoConfig?.version ?? '—';

  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.content, { paddingBottom: spacing.xl + insets.bottom }]} testID="about-screen">
      <Stack.Screen options={{ title: 'אודות', headerBackVisible: false, headerLeft: () => <HomeBackButton onPress={nav.back} /> }} />

      <Section title="על האפליקציה" testID="about-app">
        <P>{`${ltr('kodeshRead')} היא אפליקציה לקריאה ולחיפוש בספרי קודש. ספרים שכבר נמצאים במכשיר זמינים גם ללא חיבור לאינטרנט.`}</P>
        <Text style={s.muted} testID="about-version">{`גרסה ${ltr(version)}`}</Text>
      </Section>

      <Section title="מקור הספרייה ורישיון" testID="about-license">
        <P>{`הספרייה המוכנה להורדה באפליקציה מיובאת ממאגר הספרייה הישן של פרויקט אוצריא (${ltr('Otzaria')}), ולא מהמאגר החדש, שתנאי הרישיון שלו מחמירים יותר.`}</P>
        <P>{`קרדיט: פרויקט אוצריא (${ltr('Otzaria')}) והתורמים לו, וכן המקורות שמהם נאספו הטקסטים, ובהם ספריא (${ltr('Sefaria')}), דיקטה (${ltr('Dicta')}), אורייתא, ויקיטקסט ואחרים.`}</P>
        <LinkRow label="מאגר המקור ב־GitHub" url={ABOUT.sourceUrl} testID="about-source-link" />

        <Text style={s.label}>רישיון</Text>
        <P>{ltr(ABOUT.licenseName)}</P>
        <LinkRow label="נוסח הרישיון" url={ABOUT.licenseUrl} testID="about-license-link" />
        <LinkRow label="תקציר הרישיון בעברית" url={ABOUT.licenseDeedHeUrl} testID="about-deed-link" />
        <P>טקסטים שמקורם בגופים חיצוניים נשארים כפופים לרישיונות המקור שלהם, שעשויים להיות שונים ואף מגבילים יותר. הרישיון שלעיל אינו מחליף אותם.</P>
        <P>ספרים שייבאתם בעצמכם, או ספרייה שבניתם במכשיר או הורדתם מכתובת אחרת, כפופים לתנאים של המקור שממנו הגיעו.</P>
      </Section>

      <Section title="פירוט שינויים" testID="about-changes">
        <P>הטקסטים המקוריים עובדו טכנית עבור האפליקציה:</P>
        <Bullet>המרה מקובצי טקסט למסד נתונים מקומי מסוג SQLite. קבצים מסוגים אחרים וקובצי הקישורים של המאגר לא יובאו.</Bullet>
        <Bullet>הסרת תגיות עיצוב שאינן נתמכות, רווחים כפולים ושורות ריקות.</Bullet>
        <Bullet>יצירת אינדקס לחיפוש ללא אינטרנט (כולל עותק של הטקסט ללא ניקוד, טעמים וסימני פיסוק), תוכן עניינים וקישורים אוטומטיים בין ספרים למפרשיהם.</Bullet>
        <Bullet>חלוקה לחבילות להורדה (ספרי התחלה, ספריית יסוד והרחבה).</Bullet>
        <Bullet>התאמת התצוגה לקריאה בטלפון.</Bullet>
        <P>העיבוד נעשה על ידי מפתחי האפליקציה ולא על ידי פרויקט אוצריא.</P>
      </Section>

      <Section title="תנאי שימוש ושיתוף זהה" testID="about-terms">
        <Bullet>תוכן הספרייה ומסד הנתונים המעובד מיועדים לשימוש לא מסחרי בלבד.</Bullet>
        <Bullet>{`מסד הנתונים המעובד משותף תחת אותו רישיון, ${ltr('CC BY-NC-SA 4.0')}, בכפוף לרישיונות המקור של הטקסטים. המשתף אותו, או עיבוד שלו, חייב לתת קרדיט, לציין שינויים ולשמור על אותו רישיון.`}</Bullet>
        <Bullet>הודעות זכויות יוצרים ורישיון המופיעות בגוף הספרים נשמרות, ואין להסירן.</Bullet>
      </Section>

      <Section title="הסתייגות" testID="about-disclaimer">
        <P>זוהי אפליקציה עצמאית. היא אינה קשורה לפרויקט אוצריא, לתורמיו או למקורות הטקסטים, ואינה מאושרת או נתמכת על ידם.</P>
        <P>{`הטקסטים מסופקים כמות שהם (${ltr('AS IS')}), ללא אחריות מכל סוג, לרבות לדיוק, לשלמות או להתאמה למטרה מסוימת. ייתכנו בהם שגיאות, ויש לבדוק במקור מוסמך לפני שמסתמכים עליהם.`}</P>
      </Section>
    </ScrollView>
  );
}

function Section({ title, testID, children }: { title: string; testID: string; children: ReactNode }) {
  const s = useThemedStyles(createStyles);
  return (
    <View testID={testID}>
      <Text style={s.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

function P({ children }: { children: string }) {
  const s = useThemedStyles(createStyles);
  return <Text style={s.text}>{children}</Text>;
}

function Bullet({ children }: { children: string }) {
  const s = useThemedStyles(createStyles);
  return (
    <View style={s.bullet}>
      <Text style={s.text}>•</Text>
      <Text style={[s.text, s.bulletText]}>{children}</Text>
    </View>
  );
}

/** The URL is printed (and selectable) so the attribution stays usable when no browser can open it. */
function LinkRow({ label, url, testID }: { label: string; url: string; testID: string }) {
  const s = useThemedStyles(createStyles);
  const open = () => {
    Linking.openURL(url).catch((e) => console.warn('could not open link', url, e));
  };
  return (
    <View>
      <Pressable onPress={open} hitSlop={6} accessibilityRole="link" accessibilityLabel={label} testID={testID}>
        <Text style={s.link}>{label}</Text>
      </Pressable>
      <Text style={s.url} selectable>
        {ltr(url)}
      </Text>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    content: { padding: spacing.lg, gap: spacing.lg },
    title: { ...alignRight, color: c.text, fontSize: 17, fontWeight: '700', marginBottom: spacing.sm },
    card: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
    label: { ...alignRight, color: c.textMuted, fontSize: 13, fontWeight: '700' },
    text: { ...alignRight, color: c.text, fontSize: 15, lineHeight: 23 },
    muted: { ...alignRight, color: c.textMuted, fontSize: 14 },
    bullet: { flexDirection: 'row', gap: spacing.sm },
    bulletText: { flex: 1 },
    link: { ...alignRight, color: c.accent, fontSize: 15, fontWeight: '600', textDecorationLine: 'underline' },
    url: { ...alignRight, color: c.textMuted, fontSize: 12, marginTop: 2 },
  });
