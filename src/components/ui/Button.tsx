import React from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { colors, radius, spacing } from '@/theme/tokens';

type Variant = 'primary' | 'accent' | 'outline' | 'danger';

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  style?: ViewStyle;
}

export function Button({ label, onPress, variant = 'primary', disabled, style }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}>
      <Text style={[styles.label, styles[`${variant}Label`]]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.sm,
    minHeight: 48,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.45 },
  label: { fontSize: 15, fontWeight: '600' },

  primary: { backgroundColor: colors.navy },
  primaryLabel: { color: '#fff' },
  accent: { backgroundColor: colors.amber },
  accentLabel: { color: colors.navy, fontWeight: '700' },
  outline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line },
  outlineLabel: { color: colors.text },
  danger: { backgroundColor: colors.no },
  dangerLabel: { color: '#fff' },
});
