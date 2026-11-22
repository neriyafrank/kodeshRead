/**
 * `Aa` panel: font family, size, line height, theme and live Niqqud toggle.
 * Every control writes straight to the persisted settings store, so the reader
 * behind the sheet re-renders live.
 */
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { READER_FONTS, readerFont } from '../../fonts';
import { FONT_SIZE, LINE_HEIGHT, useSettings, type ThemeName } from '../../state/settingsStore';
import { palettes, radius, spacing, useThemedStyles, type Palette } from '../../theme';
import { BottomSheet } from '../Overlay';
import { Slider } from '../Slider';

const THEMES: { name: ThemeName; label: string }[] = [
  { name: 'light', label: 'בהיר' },
  { name: 'sepia', label: 'ספיה' },
  { name: 'dark', label: 'כהה (OLED)' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function AppearanceSheet({ visible, onClose }: Props) {
  const s = useThemedStyles(createStyles);
  const fontFamily = useSettings((x) => x.fontFamily);
  const fontSize = useSettings((x) => x.fontSize);
  const lineHeight = useSettings((x) => x.lineHeight);
  const theme = useSettings((x) => x.theme);
  const showNiqqud = useSettings((x) => x.showNiqqud);
  const set = useSettings((x) => x.set);
  const reset = useSettings((x) => x.reset);
  const font = readerFont(fontFamily);

  return (
    <BottomSheet visible={visible} onClose={onClose} testID="appearance-sheet">
      <ScrollView contentContainerStyle={s.content} bounces={false}>
        <View style={s.titleRow}>
          <Text style={s.title}>תצוגה</Text>
          <Pressable onPress={reset} hitSlop={8} accessibilityRole="button">
            <Text style={s.link}>ברירת מחדל</Text>
          </Pressable>
        </View>

        <Text
          style={[s.preview, { fontFamily: font.regular, fontSize, lineHeight: fontSize * lineHeight }]}
          numberOfLines={2}
        >
          {showNiqqud ? 'בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ' : 'בראשית ברא אלהים את השמים ואת הארץ'}
        </Text>

        <Text style={s.label}>גופן</Text>
        <View style={s.fontGrid}>
          {READER_FONTS.map((f) => {
            const active = f.key === fontFamily;
            return (
              <Pressable
                key={f.key}
                onPress={() => set({ fontFamily: f.key })}
                style={[s.fontChip, active && s.chipActive]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                testID={`font-${f.key}`}
              >
                <Text style={[s.fontSample, { fontFamily: readerFont(f.key).regular }, active && s.chipActiveText]}>אבג {f.hebrewLabel}</Text>
                <Text style={s.fontName}>{f.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={s.labelRow}>
          <Text style={s.label}>גודל גופן</Text>
          <Text style={s.value}>{fontSize}</Text>
        </View>
        <View style={s.sliderRow}>
          <Pressable onPress={() => set({ fontSize: fontSize - 1 })} hitSlop={8} accessibilityLabel="הקטן גופן" style={s.stepBtn}>
            <Text style={[s.stepText, { fontSize: 14 }]}>א</Text>
          </Pressable>
          <Slider
            value={fontSize}
            min={FONT_SIZE.min}
            max={FONT_SIZE.max}
            step={FONT_SIZE.step}
            onChange={(v) => set({ fontSize: v })}
            accessibilityLabel="גודל גופן"
            testID="font-size-slider"
          />
          <Pressable onPress={() => set({ fontSize: fontSize + 1 })} hitSlop={8} accessibilityLabel="הגדל גופן" style={s.stepBtn}>
            <Text style={[s.stepText, { fontSize: 22 }]}>א</Text>
          </Pressable>
        </View>

        <View style={s.labelRow}>
          <Text style={s.label}>ריווח שורות</Text>
          <Text style={s.value}>{lineHeight.toFixed(2)}</Text>
        </View>
        <View style={s.sliderRow}>
          <Pressable onPress={() => set({ lineHeight: lineHeight - LINE_HEIGHT.step })} hitSlop={8} accessibilityLabel="הקטן ריווח" style={s.stepBtn}>
            <Text style={s.stepText}>≡</Text>
          </Pressable>
          <Slider
            value={lineHeight}
            min={LINE_HEIGHT.min}
            max={LINE_HEIGHT.max}
            step={LINE_HEIGHT.step}
            onChange={(v) => set({ lineHeight: v })}
            accessibilityLabel="ריווח שורות"
            testID="line-height-slider"
          />
          <Pressable onPress={() => set({ lineHeight: lineHeight + LINE_HEIGHT.step })} hitSlop={8} accessibilityLabel="הגדל ריווח" style={s.stepBtn}>
            <Text style={[s.stepText, { letterSpacing: 2 }]}>☰</Text>
          </Pressable>
        </View>

        <Text style={s.label}>ערכת צבעים</Text>
        <View style={s.themeRow}>
          {THEMES.map((t) => {
            const p = palettes[t.name];
            const active = t.name === theme;
            return (
              <Pressable
                key={t.name}
                onPress={() => set({ theme: t.name })}
                style={[s.themeChip, { backgroundColor: p.background, borderColor: active ? p.accent : p.border }, active && s.themeActive]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                testID={`theme-${t.name}`}
              >
                <Text style={[s.themeSample, { color: p.text, fontFamily: font.regular }]}>אב</Text>
                <Text style={[s.themeLabel, { color: p.textMuted }]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={s.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>ניקוד וטעמים</Text>
            <Text style={s.hint}>הצגת נקודות וטעמי המקרא</Text>
          </View>
          <Switch
            value={showNiqqud}
            onValueChange={(v) => set({ showNiqqud: v })}
            accessibilityLabel="ניקוד וטעמים"
            testID="niqqud-switch"
            {...switchColors(s.palette)}
          />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

function switchColors(c: Palette) {
  return { trackColor: { false: c.border, true: c.accent }, thumbColor: c.surface, ios_backgroundColor: c.border };
}

const createStyles = (c: Palette) => ({
  palette: c,
  ...StyleSheet.create({
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    link: { color: c.accent, fontSize: 14 },
    preview: {
      color: c.text,
      backgroundColor: c.background,
      borderRadius: radius.md,
      padding: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      writingDirection: 'rtl',
    },
    label: { fontSize: 15, fontWeight: '600', color: c.text, marginTop: spacing.sm },
    labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
    value: { fontSize: 13, color: c.textMuted, fontVariant: ['tabular-nums'] },
    hint: { fontSize: 12, color: c.textMuted },
    fontGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    fontChip: {
      flexBasis: '47%',
      flexGrow: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: c.background,
    },
    chipActive: { borderColor: c.accent, backgroundColor: c.accentSoft, borderWidth: 1.5 },
    chipActiveText: { color: c.accent },
    fontSample: { fontSize: 19, color: c.text },
    fontName: { fontSize: 11, color: c.textMuted, marginTop: 2 },
    sliderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    stepBtn: { width: 32, alignItems: 'center' },
    stepText: { color: c.accent, fontSize: 18, fontWeight: '700' },
    themeRow: { flexDirection: 'row', gap: spacing.sm },
    themeChip: { flex: 1, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', paddingVertical: spacing.sm },
    themeActive: { borderWidth: 2 },
    themeSample: { fontSize: 22 },
    themeLabel: { fontSize: 12, marginTop: 2 },
    switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
  }),
});
