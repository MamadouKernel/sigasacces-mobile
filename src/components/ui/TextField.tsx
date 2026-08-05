import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, radius, spacing } from '@/theme/tokens';

interface Props extends TextInputProps {
  label: string;
  hint?: string;
  ref?: React.Ref<TextInput>;
}

export function TextField({ label, hint, style, onFocus, onBlur, ref, ...rest }: Props) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={ref}
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        style={[styles.input, focused && styles.inputFocused, style]}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...rest}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  label: { fontSize: 12, fontWeight: '600', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.8 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputFocused: { borderColor: colors.amber },
  hint: { fontSize: 12, color: colors.muted },
});
