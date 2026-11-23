/**
 * Animated modal surfaces built on RN's Modal + Animated (no extra native deps):
 *  - <BottomSheet>: slides up from the bottom (Aa panel)
 *  - <SideDrawer>: slides over from the reading-start edge (right in RTL) (TOC)
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, I18nManager, Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, useAppTheme } from '../theme';

const DURATION = 220;

/** Keeps the Modal mounted while the close animation runs. */
function useAnimatedVisibility(visible: boolean) {
  const [progress] = useState(() => new Animated.Value(0));
  const [mounted, setMounted] = useState(visible);
  // Mount synchronously when opening (derived state); unmount after the close animation.
  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: DURATION,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, progress]);
  return { progress, mounted };
}

interface OverlayProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  testID?: string;
  /** SideDrawer: widest size in dp (default 380) and share of the screen (default 0.86). */
  maxWidth?: number;
  widthRatio?: number;
  /** SideDrawer: fit-to-content width (clamped to the bounds above); changes animate. */
  width?: number;
}

export function BottomSheet({ visible, onClose, children, testID }: OverlayProps) {
  const c = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { progress, mounted } = useAnimatedVisibility(visible);
  if (!mounted) return null;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [height * 0.6, 0] });
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.backdrop, opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="סגור" />
      </Animated.View>
      <Animated.View
        testID={testID}
        style={[
          styles.sheet,
          { backgroundColor: c.surface, borderColor: c.border, paddingBottom: insets.bottom + 12, maxHeight: height * 0.85, transform: [{ translateY }] },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: c.border }]} />
        {children}
      </Animated.View>
    </Modal>
  );
}

/** Follows `target`, animating every change after the first value. */
function useAnimatedNumber(target: number) {
  const [value] = useState(() => new Animated.Value(target));
  useEffect(() => {
    // Not an "interaction": lists inside (FlatList) would otherwise hold back rendering until it ends.
    const anim = Animated.timing(value, { toValue: target, duration: DURATION, easing: Easing.out(Easing.cubic), useNativeDriver: false, isInteraction: false });
    anim.start();
    return () => anim.stop();
  }, [target, value]);
  return value;
}

export function SideDrawer({ visible, onClose, children, testID, maxWidth = 380, widthRatio = 0.86, width: fitWidth }: OverlayProps) {
  const c = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { progress, mounted } = useAnimatedVisibility(visible);
  const drawerWidth = Math.min(maxWidth, width * widthRatio);
  // Width is a layout prop (JS-driven) while the slide is native-driven: separate views.
  const animatedWidth = useAnimatedNumber(Math.round(fitWidth != null ? Math.min(drawerWidth, fitWidth) : drawerWidth));
  if (!mounted) return null;
  // The drawer is anchored at `start` (right edge in RTL); hidden = pushed past that edge.
  // The web preview flips the document direction instead of I18nManager, where `start` still
  // resolves to the left: anchor it to the right explicitly there.
  const rtl = I18nManager.isRTL || Platform.OS === 'web';
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [rtl ? drawerWidth : -drawerWidth, 0] });
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.backdrop, opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="סגור" />
      </Animated.View>
      <Animated.View
        testID={testID}
        style={[
          Platform.OS === 'web' ? styles.drawerWeb : styles.drawer,
          { backgroundColor: c.surface, borderColor: c.border, paddingTop: insets.top, paddingBottom: insets.bottom, transform: [{ translateX }] },
        ]}
      >
        <Animated.View style={{ flex: 1, width: animatedWidth }}>{children}</Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
    borderTopStartRadius: radius.lg * 1.4,
    borderTopEndRadius: radius.lg * 1.4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 8 },
  drawer: { position: 'absolute', top: 0, bottom: 0, start: 0, borderEndWidth: StyleSheet.hairlineWidth },
  drawerWeb: { position: 'absolute', top: 0, bottom: 0, right: 0, borderLeftWidth: StyleSheet.hairlineWidth },
});
