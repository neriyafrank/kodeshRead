import { Pressable, Text } from 'react-native';

import { useAppTheme } from '../theme';

/** Header Back for stack screens: ALWAYS goes Home (and empties the back stack); Android system Back is separate. */
export function HomeBackButton({ onPress }: { onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel="חזרה לספרייה" testID="header-back" style={{ paddingHorizontal: 8 }}>
      <Text style={{ color: theme.accent, fontSize: 22, fontWeight: '700' }}>→</Text>
    </Pressable>
  );
}
