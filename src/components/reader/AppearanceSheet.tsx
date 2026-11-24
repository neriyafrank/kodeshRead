/**
 * `Aa` panel: theme (בהיר / ספיה / כהה), reader font (טעמי פרנק default, ... מערכת), size,
 * line height and the live niqqud / te'amim toggles. Every control writes straight to the
 * persisted settings store, so the reader behind the sheet re-renders live. The line-height
 * slider sets plain-text leading; visible marks add their own room (shared/typography.js).
 */
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useIsTanakhBook } from '../../db/useIsTanakhBook';
import { READER_FONTS, readerFont } from '../../fonts';
import { FONT_SIZE, LINE_HEIGHT, effectiveLineHeight, useSettings, type ThemeName } from '../../state/settingsStore';
import { palettes, radius, spacing, useThemedStyles, type Palette } from '../../theme';
import { prepareDisplayText } from '../../../shared/reader';
import { alignRight } from '../../lib/direction';
import { BottomSheet } from '../Overlay';
import { Slider } from '../Slider';

/** Genesis 1:5 — stacked te'amim above and below (פזר, רביע, זקף, טפחא, מונח, אתנחתא). */
const PREVIEW = 'וַיִּקְרָ֨א אֱלֹהִ֤ים ׀ לָאוֹר֙ י֔וֹם וְלַחֹ֖שֶׁךְ קָ֣רָא לָ֑יְלָה וַֽיְהִי־עֶ֥רֶב וַֽיְהִי־בֹ֖קֶר י֥וֹם אֶחָֽד׃';
const FONT_SAMPLE = 'בְּרֵאשִׁ֖ית';

const THEMES: { name: ThemeName; label: string }[] = [
  { name: 'light', label: 'בהיר' },
  { name: 'sepia', label: 'ספיה' },
  { name: 'dark', label: 'כהה' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The open book: the טעמים switch is shown only for Tanakh books (the saved preference is kept for them). */
  bookId?: number | null;
}

export function AppearanceSheet({ visible, onClose, bookId }: Props) {
  const isTanakh = useIsTanakhBook(bookId, visible) === true;
  const s = useThemedStyles(createStyles);
  const fontFamily = useSettings((x) => x.fontFamily);
  const fontSize = useSettings((x) => x.fontSize);
  const lineHeight = useSettings((x) => x.lineHeight);
  const theme = useSettings((x) => x.theme);
  const showNikkud = useSettings((x) => x.showNikkud);
  const showCantillation = useSettings((x) => x.showCantillation);
  const set = useSettings((x) => x.set);
  const reset = useSettings((x) => x.reset);
  const font = readerFont(fontFamily);
  const marks = { showNikkud, showCantillation };
  const effective = effectiveLineHeight({ lineHeight, ...marks });
  const extra = Math.round((effective - lineHeight) * 100) / 100;

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
          style={[s.preview, { fontFamily: font.regular, fontSize, lineHeight: Math.ceil(fontSize * effective) }]}
          numberOfLines={2}
          testID="appearance-preview"
        >
          {prepareDisplayText(PREVIEW, marks)}
        </Text>

        <Text style={s.label}>ערכת צבעים</Text>
        <View style={s.themeRow} accessibilityRole="radiogroup">
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
                aria-checked={active}
                accessibilityLabel={`ערכת צבעים ${t.label}`}
                testID={`theme-${t.name}`}
              >
                <Text style={[s.themeSample, { color: p.text, fontFamily: font.regular }]}>אב</Text>
                <Text style={[s.themeLabel, { color: p.textMuted }]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

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
                aria-checked={active}
                accessibilityLabel={`גופן ${f.hebrewLabel}`}
                testID={`font-${f.key}`}
              >
                <Text style={[s.fontSample, { fontFamily: readerFont(f.key).regular }, active && s.chipActiveText]} numberOfLines={1}>
                  {f.hebrewLabel} <Text style={s.fontSampleMarks}>{prepareDisplayText(FONT_SAMPLE, marks)}</Text>
                </Text>
                <Text style={s.fontName}>{f.label}</Text>
                {f.biblical ? <Text style={s.fontTag}>מותאם לטעמים ולניקוד</Text> : null}
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
          <Text style={s.value} testID="line-height-value">
            {effective.toFixed(2)}
            {extra > 0 ? ` (${lineHeight.toFixed(2)} + ${extra.toFixed(2)} ${marks.showNikkud && showCantillation ? 'טעמים' : 'ניקוד'})` : ''}
          </Text>
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

        <View style={s.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>ניקוד</Text>
            <Text style={s.hint}>{isTanakh ? 'הצגת נקודות התנועה (כיבוי מסתיר גם את הטעמים)' : 'הצגת נקודות התנועה'}</Text>
          </View>
          <Switch
            value={showNikkud}
            onValueChange={(v) => set({ showNikkud: v })}
            accessibilityLabel="ניקוד"
            testID="niqqud-switch"
            {...switchColors(s.palette)}
          />
        </View>

        {isTanakh ? (
          <View style={[s.switchRow, !showNikkud && { opacity: 0.45 }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>טעמים</Text>
              <Text style={s.hint}>הסתרת הטעמים בלבד (הניקוד נשאר) — גם בחלונית המפרשים</Text>
            </View>
            <Switch
              value={showNikkud && showCantillation}
              disabled={!showNikkud}
              onValueChange={(v) => set({ showCantillation: v })}
              accessibilityLabel="טעמי המקרא"
              testID="cantillation-switch"
              {...switchColors(s.palette)}
            />
          </View>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

function switchColors(c: Palette) {
  return {
    trackColor: { false: c.border, true: c.accent },
    thumbColor: c.surface,
    ios_backgroundColor: c.border,
    // react-native-web colours the "on" thumb with its own prop (default teal).
    ...(Platform.OS === 'web' ? ({ activeThumbColor: c.surface } as object) : null),
  };
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
    fontSample: { fontSize: 19, lineHeight: 34, color: c.text },
    fontSampleMarks: { color: c.textMuted },
    fontName: { fontSize: 11, color: c.textMuted, marginTop: 2, ...alignRight },
    fontTag: { fontSize: 11, color: c.accent, fontWeight: '600', marginTop: 1, ...alignRight },
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
