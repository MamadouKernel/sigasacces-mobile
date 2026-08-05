import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, radius } from '@/theme/tokens';

interface Props {
  label: string;
  onPress: () => void;
  active?: boolean;
  color?: string;
}

/** Petit bouton bordé de l'en-tête (liste, direction, haptique…). */
export function IconButton({ label, onPress, active, color }: Props) {
  const tint = color ?? colors.text;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.btn,
        { borderColor: active ? tint : colors.line },
        active && { backgroundColor: `${tint}1F` },
        pressed && { opacity: 0.7 },
      ]}>
      <Text style={[styles.label, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    borderWidth: 1,
    borderRadius: radius.sm,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 7,
    justifyContent: 'center',
  },
  label: { fontSize: 12, fontWeight: '600' },
});
