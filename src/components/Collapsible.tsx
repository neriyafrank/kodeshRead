/**
 * A toolbar region that can be folded away to give the text more room.
 *
 * Opening mounts the content and fades / slides it in; closing fades it out and then unmounts it
 * (so collapsed controls are not in the tree, and screen readers skip them). The surrounding
 * layout changes once per toggle rather than per animation frame: resizing a FlashList viewport
 * on every frame makes the text jump.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';

interface Props {
  open: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Collapsible({ open, children, style, testID }: Props) {
  const [progress] = useState(() => new Animated.Value(open ? 1 : 0));
  const [mounted, setMounted] = useState(open);
  // Mount synchronously when opening (derived state); unmount after the close animation.
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: open ? 170 : 120,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
      // Lists below (FlashList / commentaries) must not wait for it to render.
      isInteraction: false,
    });
    anim.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => anim.stop();
  }, [open, progress]);
  if (!mounted) return null;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] });
  return (
    <Animated.View style={[style, { opacity: progress, transform: [{ translateY }] }]} testID={testID}>
      {children}
    </Animated.View>
  );
}
