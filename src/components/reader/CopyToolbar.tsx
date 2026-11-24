/**
 * Long-press paragraph toolbar + copy toast, shared by the reader (BookReader) and the commentary drawer.
 *
 *  - `useCopyMode()`: idle -> actions (one paragraph, after a long-press) -> select (multi-paragraph
 *    selection: tap toggles a paragraph, long-press selects the range from the last one).
 *  - `ParagraphToolbar`: compact row of actions for the current mode (+ ✕ / סיום).
 *  - `useCopyToast()`: writes to the clipboard and flashes "הועתק ללוח".
 * Text formatting is shared/copyFormat.js.
 */
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { alignRight } from '../../lib/direction';
import { radius, spacing, useThemedStyles, type Palette } from '../../theme';

export type CopyMode = { mode: 'idle' } | { mode: 'actions'; key: string } | { mode: 'select'; keys: string[]; anchor: string };

/** Keys (in reading order) between `a` and `b`, inclusive. */
function between(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export function useCopyMode() {
  const [state, setState] = useState<CopyMode>({ mode: 'idle' });
  const ref = useRef(state);
  useEffect(() => {
    ref.current = state;
  }, [state]);
  const reset = useCallback(() => setState({ mode: 'idle' }), []);
  const openActions = useCallback((key: string) => setState({ mode: 'actions', key }), []);
  /** actions -> select, the long-pressed paragraph pre-selected. */
  const startSelect = useCallback(() => setState((s) => (s.mode === 'actions' ? { mode: 'select', keys: [s.key], anchor: s.key } : s)), []);
  const toggle = useCallback((key: string) => {
    setState((s) => {
      if (s.mode !== 'select') return s;
      const keys = s.keys.includes(key) ? s.keys.filter((k) => k !== key) : [...s.keys, key];
      return { mode: 'select', keys, anchor: key };
    });
  }, []);
  /** Long-press while selecting: everything from the last tapped paragraph to `key`. */
  const rangeTo = useCallback((key: string, order: string[]) => {
    setState((s) => (s.mode === 'select' ? { mode: 'select', keys: [...new Set([...s.keys, ...between(order, s.anchor, key)])], anchor: key } : s));
  }, []);
  const marked = (key: string) => (state.mode === 'actions' ? state.key === key : state.mode === 'select' ? state.keys.includes(key) : false);
  return { state, ref, reset, openActions, startSelect, toggle, rangeTo, marked, selecting: state.mode === 'select' };
}

/** Clipboard + the brief "הועתק ללוח" pill. Render `toast` inside a relatively positioned container. */
export function useCopyToast(): { copy: (text: string) => Promise<boolean>; toast: ReactElement | null } {
  const s = useThemedStyles(createStyles);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = useCallback(async (text: string) => {
    let ok = true;
    try {
      ok = (await Clipboard.setStringAsync(text)) !== false;
    } catch (e) {
      console.warn('clipboard unavailable', e);
      ok = false;
    }
    setMsg(ok ? 'הועתק ללוח' : 'ההעתקה נכשלה');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 1600);
    return ok;
  }, []);
  const toast = msg ? (
    <View pointerEvents="none" style={s.toastWrap}>
      <Text style={s.toast} accessibilityLiveRegion="polite" testID="copy-toast">
        {msg}
      </Text>
    </View>
  ) : null;
  return { copy, toast };
}

export interface ToolbarAction {
  key: string;
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
}

interface Props {
  actions: ToolbarAction[];
  /** "3 נבחרו" while selecting. */
  info?: string | null;
  onClose: () => void;
  closeLabel?: string;
  style?: ViewStyle;
}

export function ParagraphToolbar({ actions, info, onClose, closeLabel, style }: Props) {
  const s = useThemedStyles(createStyles);
  return (
    <View style={[s.bar, style]} accessibilityRole="toolbar" accessibilityLabel="פעולות על הפסקה" testID="para-toolbar">
      {info ? (
        <Text style={s.info} testID="para-toolbar-info">
          {info}
        </Text>
      ) : null}
      {actions.map((a) => (
        <Pressable key={a.key} onPress={a.onPress} style={({ pressed }) => [s.btn, a.primary && s.btnPrimary, pressed && s.pressed]} accessibilityRole="button" testID={a.testID}>
          <Text style={[s.btnText, a.primary && s.btnTextPrimary]} numberOfLines={1}>
            {a.label}
          </Text>
        </Pressable>
      ))}
      <Pressable onPress={onClose} hitSlop={6} style={s.close} accessibilityRole="button" accessibilityLabel={closeLabel ?? 'סגור'} testID="para-toolbar-close">
        <Text style={s.closeText}>{closeLabel ?? '✕'}</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.xs + 2,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs + 2,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.md,
    },
    info: { fontSize: 12, fontWeight: '700', color: c.textMuted, paddingHorizontal: spacing.xs, ...alignRight },
    btn: { paddingHorizontal: spacing.sm + 2, height: 30, justifyContent: 'center', borderRadius: radius.sm, backgroundColor: c.accentSoft },
    btnPrimary: { backgroundColor: c.accent },
    btnText: { fontSize: 13, fontWeight: '600', color: c.accent },
    btnTextPrimary: { color: c.surface },
    close: { paddingHorizontal: spacing.sm, height: 30, justifyContent: 'center', marginStart: 'auto' },
    closeText: { fontSize: 14, color: c.textMuted, fontWeight: '600' },
    pressed: { opacity: 0.75 },
    toastWrap: { position: 'absolute', start: 0, end: 0, bottom: spacing.lg, alignItems: 'center', zIndex: 40 },
    toast: { backgroundColor: c.text, color: c.surface, fontSize: 13, fontWeight: '600', paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: 16, overflow: 'hidden' },
  });
