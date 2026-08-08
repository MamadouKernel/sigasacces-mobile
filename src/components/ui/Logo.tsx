import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { colors } from '@/theme/tokens';

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <Text style={[styles.logo, { fontSize: size }]}>
      SIGAS<Text style={styles.accent}>ACCÈS</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  logo: { fontWeight: '700', letterSpacing: 1, color: colors.text },
  accent: { color: colors.amber },
});
